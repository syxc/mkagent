/** Bind Pi's coding resources and extension runner to the existing durable host. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageContent, Model, Api, Models, ModelThinkingLevel as ThinkingLevel, UserMessage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Conversation, EntryDraft, Harness, Registry, ToolRegistration } from '@earendil-works/pi-durable';
import {
  DurableCodingSessionStore, NativeCodingRuntime, NativeModelRegistry, loadCodingResources, mergeCodingSettings,
  type CodingResourceOptions, type CodingResources, type NativeRuntimeOptions, type ResourceSettings,
} from '@mkagent/pi-durable-coding';
import { buildSystemPrompt, type BuildSystemPromptOptions } from '@mkagent/pi-durable-coding/compat';

export type KernelCodingOptions = Omit<CodingResourceOptions, 'cwd'>;

export interface CodingHostBindings {
  harness: Harness;
  conversation: Conversation;
  registry: Registry<ToolRegistration>;
  cwd: string;
  sessionPath: string;
  id: string;
  profile: KernelCodingOptions;
  models(): Models;
  model(): Model<Api> | undefined;
  thinkingLevel(): ThinkingLevel;
  setModel(model: Model<Api>): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  busy(): boolean;
  signal(): AbortSignal | undefined;
  abort(): Promise<void>;
  shutdown(): void;
  getSystemPrompt(): string | undefined;
  compact(options?: unknown): void;
  commands: NativeRuntimeOptions['commandActions'];
  publishTools(tools: ToolRegistration[]): void;
  submit(content: UserMessage['content'], mode: 'steer' | 'followUp', options: { expandPromptTemplates: boolean }): Promise<void>;
  error(error: { extensionPath: string; event: string; error: string }): void;
}

interface CustomMessage {
  customType: string;
  content?: UserMessage['content'];
  display: boolean;
  details?: unknown;
}

interface Delivery {
  triggerTurn?: boolean;
  deliverAs?: 'steer' | 'followUp' | 'nextTurn';
}

export class CodingHost {
  readonly models: NativeModelRegistry;
  readonly store: DurableCodingSessionStore;
  runtime!: NativeCodingRuntime;
  private resources!: CodingResources;
  private settings: Record<string, unknown> = {};
  private promptOptions: BuildSystemPromptOptions | undefined;
  private active: string[] = [];
  private jobs = new Set<Promise<void>>();
  private nextTurnJobs = new Set<Promise<void>>();
  private pendingMessages: UserMessage[] = [];

  private constructor(private readonly host: CodingHostBindings) {
    this.models = new NativeModelRegistry(host.models);
    this.store = new DurableCodingSessionStore({
      id: host.id, cwd: host.cwd, sessionPath: host.sessionPath,
      conversation: () => host.conversation, context: BACKGROUND_CONTEXT,
    });
  }

  static async load(host: CodingHostBindings): Promise<CodingHost> {
    const coding = new CodingHost(host);
    const settings = (path: string): ResourceSettings => existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8')) : {};
    const globalSettings = host.profile.globalSettings ?? settings(join(host.profile.agentDir, 'settings.json'));
    const projectSettings = host.profile.projectTrusted
      ? host.profile.projectSettings ?? settings(join(host.cwd, '.pi', 'settings.json')) : {};
    coding.settings = mergeCodingSettings(globalSettings, projectSettings);
    coding.resources = await loadCodingResources({
      ...host.profile, cwd: host.cwd, globalSettings, projectSettings,
    });
    for (const diagnostic of coding.resources.diagnostics) {
      host.error({ extensionPath: diagnostic.path ?? '<resources>', event: 'resources', error: diagnostic.message });
    }
    coding.active = host.registry.snapshot().tools().map(({ tool }) => tool.name);
    coding.runtime = await NativeCodingRuntime.load({
      resources: coding.resources, store: coding.store, modelRegistry: coding.models.registry,
      mode: 'print', onError: host.error,
      abortToolTask: (id, context) => host.harness.abortTask(id, context),
      commandActions: host.commands,
      core: {
        sendMessage: (message, options) => {
          const delivery = options as Delivery | undefined;
          coding.schedule(coding.sendCustomMessage(message as CustomMessage, delivery),
            delivery?.deliverAs === 'nextTurn' ? coding.nextTurnJobs : coding.jobs);
        },
        sendUserMessage: (content, options) => {
          const delivery = options as (Delivery & { expandPromptTemplates?: boolean }) | undefined;
          coding.schedule(coding.sendUser(content, delivery?.deliverAs === 'followUp' ? 'followUp' : 'steer',
            delivery?.expandPromptTemplates ?? false));
        },
        getActiveTools: () => coding.active,
        getAllTools: () => host.registry.snapshot().tools().map(({ tool }) => tool),
        getSettings: () => structuredClone(coding.settings),
        setActiveTools: names => {
          const all = host.registry.snapshot().tools().map(({ tool }) => tool);
          const tools = names.map(name => {
            const tool = all.find(tool => tool.name === name);
            if (!tool) throw new Error(`Unknown tool: ${name}`);
            return tool;
          });
          coding.active = [...names];
          coding.schedule(host.conversation.configure({ tools }, BACKGROUND_CONTEXT));
        },
        refreshTools: () => coding.publishTools(),
        setModel: host.setModel,
        getThinkingLevel: host.thinkingLevel,
        setThinkingLevel: level => coding.schedule(host.setThinkingLevel(level)),
      },
      context: {
        getModel: host.model, getScopedModels: () => [], isIdle: () => !host.busy(),
        isProjectTrusted: () => host.profile.projectTrusted === true,
        getSignal: host.signal, abort: () => coding.schedule(host.abort()),
        hasPendingMessages: () => coding.pendingMessages.length > 0,
        getPendingMessages: () => coding.pendingMessages,
        shutdown: host.shutdown, compact: host.compact,
        getContextUsage: () => {
          const contextWindow = host.model()?.contextWindow;
          if (!contextWindow) return undefined;
          const tokens = coding.runtime.session.contextTokens();
          return { tokens, contextWindow, percent: tokens / contextWindow * 100 };
        },
        getSystemPrompt: () => coding.systemPrompt,
        getSystemPromptOptions: () => coding.basePromptOptions(),
      },
    });
    host.registry.install(coding.runtime.extension);
    coding.publishTools();
    await coding.models.refreshSnapshot();
    return coding;
  }

  async start(reason: 'startup' | 'resume' | 'fork' | 'reload' | 'new'): Promise<void> {
    await this.runtime.start(reason);
    await this.drain();
  }

  get systemPrompt(): string {
    return buildSystemPrompt(this.promptOptions ?? this.basePromptOptions());
  }

  async input(text: string, images: ImageContent[] | undefined, mode: 'steer' | 'followUp',
    options: { source?: 'interactive' | 'extension'; expandPromptTemplates?: boolean } = {}) {
    return this.runtime.input(text, images, options.source ?? 'interactive', this.host.busy() ? mode : undefined, options);
  }

  async beforeAgentStart(prompt: string, images?: ImageContent[]) {
    const result = await this.runtime.beforeAgentStart(prompt, images);
    this.promptOptions = result.systemPromptOptions;
    while (this.nextTurnJobs.size) await Promise.all([...this.nextTurnJobs]);
    const pending = await this.store.pendingNextTurn();
    const messages = [...pending.map(item => item.message as unknown as CustomMessage), ...result.messages];
    const entries: EntryDraft[] = this.store.compile(this.runtime.session.preview(messages.map((message: CustomMessage) => ({
      type: 'custom_message', ...message, content: message.content ?? [],
    }))).entries);
    return { entries, queuedIds: pending.map(item => item.id) };
  }

  private basePromptOptions(): BuildSystemPromptOptions {
    const base = this.host.getSystemPrompt();
    return {
      cwd: this.host.cwd,
      customPrompt: this.resources.systemPrompt === undefined ? base
        : [base, this.resources.systemPrompt].filter(Boolean).join('\n\n'),
      appendSystemPrompt: this.resources.appendSystemPrompt.join('\n\n'),
      selectedTools: this.active,
      contextFiles: this.resources.contextFiles,
      skills: this.resources.skills,
    };
  }

  private publishTools(): void {
    const native = this.runtime.tools;
    this.host.publishTools(native);
    this.active = [...new Set([...this.active, ...native.filter(tool => tool.callers?.length !== 0).map(tool => tool.name)])];
  }

  private async sendUser(content: UserMessage['content'], mode: 'steer' | 'followUp', expandPromptTemplates: boolean): Promise<void> {
    const pending: UserMessage = { role: 'user', content, timestamp: Date.now() };
    this.pendingMessages.push(pending);
    try { await this.host.submit(content, mode, { expandPromptTemplates }); }
    finally { this.pendingMessages = this.pendingMessages.filter(message => message !== pending); }
  }

  private async sendCustomMessage(message: CustomMessage, options: Delivery = {}): Promise<void> {
    if (options.deliverAs === 'nextTurn') {
      await this.store.queueNextTurn({ ...message, content: message.content ?? [] });
      return;
    }
    await this.runtime.session.refresh();
    const entry = this.runtime.session.preview([{
      type: 'custom_message', ...message, content: message.content ?? [],
    }]).entries[0]!;
    const draft = this.store.compile([entry])[0]!;
    if (options.triggerTurn || this.host.busy() && options.triggerTurn !== false) {
      await this.host.conversation.submit({
        type: 'input', content: draft.model![0]!.content as UserMessage['content'],
        entry: { kind: draft.kind, data: draft.data }, whenBusy: options.deliverAs === 'followUp' ? 'followUp' : 'steer',
      }, BACKGROUND_CONTEXT);
    } else {
      await this.host.conversation.submit({ type: 'write', entry: draft }, BACKGROUND_CONTEXT);
    }
  }

  private schedule(job: Promise<void>, queue = this.jobs): void {
    this.jobs.add(job);
    queue.add(job);
    void job.catch(error => this.host.error({
      extensionPath: '<host>', event: 'action', error: error instanceof Error ? error.message : String(error),
    })).finally(() => { this.jobs.delete(job); queue.delete(job); });
  }

  async drain(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }

  async close(): Promise<void> {
    await this.drain();
    await this.runtime.close();
    this.host.registry.uninstall(this.runtime.extension);
  }
}
