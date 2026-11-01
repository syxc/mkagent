import { calculateCost, type Api, type Context as ModelContext, type Message, type Model, type Models, type ModelsSimpleStreamOptions, type Usage } from '@earendil-works/pi-ai';
import { getProviderEnvValue } from '@earendil-works/pi-ai/utils/provider-env';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { LiveDoc, ProviderDoc, UsageDoc, type Conversation, type GenerationCheckpoint, type Harness, type HookApi, type TaskId } from '@earendil-works/pi-durable';

type Request = {
  model: Model<Api>;
  context: ModelContext;
  options: ModelsSimpleStreamOptions;
  models: Models;
  delay: number;
  ttl: number;
  conversation: Conversation;
  taskId: TaskId;
  startedAt: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  deadline?: number;
};

/** Keep the latest main-session prompt cache alive until the run settles. */
export class CacheWarmer {
  private current: Request | undefined;
  private latestPromptTokens = 0;
  private revision = 0;

  constructor(
    private readonly conversation: () => Conversation | null,
    private readonly harness: () => Harness | null,
    private readonly isCurrent: (taskId: TaskId, model: Model<Api>, options: ModelsSimpleStreamOptions) => Promise<boolean>,
  ) {}

  async capture(request: { readonly messages: readonly Message[] }, api: HookApi, context: Context): Promise<void> {
    const conversation = this.conversation();
    const harness = this.harness();
    if (!conversation || !harness || conversation.id !== api.conversationId) return;
    this.stop();
    const revision = this.revision;
    const [agent, provider, live, task] = await Promise.all([
      conversation.agent(context),
      api.snapshot(ProviderDoc, api.conversationId, context),
      api.snapshot(LiveDoc, api.conversationId, context),
      harness.getTask(api.taskId, context),
    ]);
    if (revision !== this.revision || context.abortSignal?.aborted || live?.run?.taskId !== api.taskId) return;
    const checkpoint = task?.state.checkpoint as GenerationCheckpoint | undefined;
    if (checkpoint?.phase !== 'request' || agent.model?.provider !== checkpoint.model.provider
      || agent.model.modelId !== checkpoint.model.modelId || agent.thinkingLevel !== checkpoint.thinkingLevel) return;
    const model = api.models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
    if (!model || !provider) return;
    const view = await conversation.context(context);
    if (revision !== this.revision || context.abortSignal?.aborted) return;
    this.latestPromptTokens = 0;
    for (let index = view.messages.length - 1; index >= 0; index--) {
      const message = view.messages[index]!;
      if (message.role === 'assistant') {
        this.observe(message.usage);
        break;
      }
    }
    const options: ModelsSimpleStreamOptions = {
      ...checkpoint.streamOptions,
      sessionId: provider.sessionId,
      ...(checkpoint.thinkingLevel === 'off' ? {} : { reasoning: checkpoint.thinkingLevel }),
    };
    this.start(api.models, model, { messages: [...request.messages] }, options, conversation, api.taskId);
  }

  observe(usage: Usage): void {
    this.latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  }

  private start(models: Models, model: Model<Api>, context: ModelContext, options: ModelsSimpleStreamOptions, conversation: Conversation, taskId: TaskId): void {
    this.stop();
    if (model.api === 'anthropic-messages' && options.reasoning
      && (!model.compat || !('forceAdaptiveThinking' in model.compat) || model.compat.forceAdaptiveThinking !== true)) return;
    const retention = options.cacheRetention ?? (getProviderEnvValue('PI_CACHE_RETENTION', options.env) === 'long' ? 'long' : 'short');
    const ttl = retention === 'none' ? undefined : model.promptCache?.[retention];
    if (ttl === undefined || ttl * 1_000 <= 10_000) return;
    const ttlMs = ttl * 1_000;
    const run: Request = {
      models, model, context, options, conversation, taskId, ttl: ttlMs,
      delay: Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000))),
      startedAt: Date.now(), controller: new AbortController(),
    };
    this.current = run;
    this.schedule(run);
  }

  stop(): void {
    this.revision++;
    const run = this.current;
    this.current = undefined;
    if (!run) return;
    if (run.timer) clearTimeout(run.timer);
    run.controller.abort();
  }

  private schedule(run: Request): void {
    const now = Date.now();
    const next = now + run.delay;
    if (next > run.startedAt + 60 * 60_000 || now >= run.startedAt + 60 * 60_000) {
      this.stop();
      return;
    }
    run.deadline = next + Math.floor((run.ttl - run.delay) / 2);
    run.timer = setTimeout(() => void this.refresh(run), run.delay);
    run.timer.unref?.();
  }

  private async refresh(run: Request): Promise<void> {
    run.timer = undefined;
    if (this.current !== run) return;
    if (Date.now() > run.deadline!) return this.stop();
    try {
      if (!await this.isCurrent(run.taskId, run.model, run.options)) {
        if (this.current === run) this.stop();
        return;
      }
    } catch {
      if (this.current === run) this.stop();
      return;
    }
    if (this.current !== run || Date.now() > run.deadline!) return;
    const tokens = this.latestPromptTokens;
    const price = (parts: Partial<Usage>): number => calculateCost(run.model, {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...parts,
    }).total;
    const hit = price({ cacheRead: tokens });
    const miss = price(run.model.cost.cacheWrite > 0 ? { cacheWrite: tokens } : { input: tokens });
    const warm = price({ cacheRead: tokens, output: 1 });
    if (!tokens || (!hit && !miss) || Math.max(0, miss - hit) - warm < 0.05) return this.stop();

    try {
      const message = await run.models.streamSimple(run.model, run.context, {
        ...run.options, maxTokens: 1, maxRetries: 0, signal: run.controller.signal,
      }).result();
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
      const conversation = run.conversation;
      await conversation.commit(async tx => {
        const totals = (await tx.doc(UsageDoc, conversation.id)).models;
        const key = `${message.provider}/${message.model}`;
        const usage = JSON.parse(JSON.stringify(message.usage)) as Usage;
        const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
        if (!total) Object.defineProperty(totals, key, { value: usage, enumerable: true, writable: true, configurable: true });
        else {
          total.input += usage.input;
          total.output += usage.output;
          total.cacheRead += usage.cacheRead;
          total.cacheWrite += usage.cacheWrite;
          total.totalTokens += usage.totalTokens;
          if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
          if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
          total.cost.input += usage.cost.input;
          total.cost.output += usage.cost.output;
          total.cost.cacheRead += usage.cost.cacheRead;
          total.cost.cacheWrite += usage.cost.cacheWrite;
          total.cost.total += usage.cost.total;
        }
        await tx.appendEntry(conversation.id, {
          kind: 'mkagent.usage',
          data: { kind: 'cache_warm', provider: message.provider, model: message.responseModel ?? message.model, usage: usage as unknown as JsonValue },
        });
      }, BACKGROUND_CONTEXT);
    } catch {
      // Warming is best-effort and must not affect the active run.
    } finally {
      if (this.current === run) this.schedule(run);
    }
  }
}
