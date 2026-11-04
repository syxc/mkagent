/** Own the complete native coding session while the supplied durable kernel owns execution. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { copyJson, type JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { InMemoryCredentialStore, type AssistantMessage, type Models, type Model, type Api } from '@earendil-works/pi-ai';
import {
  AgentDoc, defineDoc, type Conversation, type Harness, type Registry, type ToolRegistration, type Tx,
} from '@earendil-works/pi-durable';
import { DurableLoopBinding, NativeSessionJournal } from '@mkagent/pi-durable-coding/durable';
import type { AgentTool } from '@mkagent/pi-durable-coding/agent';
import {
  createAgentSession, createHostResources, initializeExtensionModels, hostToolToAgent, wrapAgentTool, ModelRuntime, SessionManager,
  type AgentSession, type AgentSessionEvent, type ExtensionCommandContextActions, type HostResourceOptions,
  type ModelRuntimeCredentials, type PromptOptions, type SourceInfo,
} from '@mkagent/pi-durable-coding/native';
import { LegacyCodingAdoption } from './storage/coding-recovery.ts';

export type KernelCodingOptions = Omit<HostResourceOptions, 'cwd' | 'getSystemPrompt'>;

export interface CodingHostBindings {
  harness: Harness;
  conversation: Conversation;
  registry: Registry<ToolRegistration>;
  cwd: string;
  sessionPath: string;
  id: string;
  profile: KernelCodingOptions;
  models(): Models;
  credentials?: ModelRuntimeCredentials;
  autoCompactWindow?: number;
  model(models: Models): Model<Api> | undefined | Promise<Model<Api> | undefined>;
  thinkingLevel(): string;
  selection(model: Model<Api> | undefined, thinkingLevel: AgentSession['thinkingLevel']): void;
  shutdown(): void;
  getSystemPrompt(): string | undefined;
  commands: ExtensionCommandContextActions;
  wrapTool(tool: ToolRegistration): ToolRegistration;
  publishTools(tools: ToolRegistration[]): void;
  event(event: AgentSessionEvent | Record<string, unknown>): void;
  error(error: { extensionPath: string; event: string; error: string }): void;
}

const State = defineDoc<{ owner: number; state: JsonValue | null }>({
  kind: 'mkagent.coding.session-state', version: 1, scope: 'conversation',
  history: 'rewindable', fork: 'asOf',
  initial: () => ({ owner: 0, state: null }), checkpointWhen: () => false,
});

export class CodingHost {
  readonly journal: NativeSessionJournal;
  readonly models: ModelRuntime;
  session!: AgentSession;
  private readonly durable: DurableLoopBinding;
  private readonly nativeTools = new Map<string, ToolRegistration>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly actionScope = new AsyncLocalStorage<{ job?: Promise<void> }>();
  private readonly anchors: Array<{ message: AssistantMessage; id: string; nativeId?: string }> = [];
  private readonly stopAnchors: () => void;
  private stopEvents?: () => void;
  private closed = false;
  private legacy?: LegacyCodingAdoption;

  private constructor(private readonly host: CodingHostBindings, journal: NativeSessionJournal, models: ModelRuntime) {
    this.journal = journal;
    this.models = models;
    this.durable = new DurableLoopBinding({
      kernel: host, journal, models,
      commitState: tx => this.persistState(tx),
      finalArguments: scope => scope.runtime.memo('mkagent.tool.approved-arguments', scope.context),
      activateTools: names => this.session.setActiveToolsByName([...this.session.getActiveToolNames(), ...names]),
      onSessionComplete: completion => this.legacy?.onSettled(completion),
    });
    this.stopAnchors = journal.observeMessages({
      appended: (message, nativeId) => {
        const anchor = this.anchors.find(value => value.nativeId === undefined && value.message === message);
        if (anchor) anchor.nativeId = nativeId;
      },
      committed: (nativeId, durableId) => {
        const pending = this.anchors.findIndex(value => value.nativeId === nativeId);
        if (pending < 0) return;
        const [anchor] = this.anchors.splice(pending, 1);
        host.event({ type: 'pi_turn_anchor', sdkMessageId: anchor!.id, sdkTurnAnchor: String(durableId) });
      },
      discarded: nativeId => {
        const pending = this.anchors.findIndex(value => value.nativeId === nativeId);
        if (pending >= 0) this.anchors.splice(pending, 1);
      },
    });
  }

  static async load(host: CodingHostBindings, reason: Parameters<CodingHost['start']>[0]): Promise<CodingHost> {
    // Programmatic anonymous providers need no file-backed store. Production supplies its existing shared port.
    const credentials = host.credentials ?? ModelRuntime.createCredentials(new InMemoryCredentialStore());
    const models = await ModelRuntime.bind({ models: host.models, credentials });
    const journal = await NativeSessionJournal.open({
      harness: host.harness, conversation: host.conversation, context: BACKGROUND_CONTEXT, cwd: host.cwd,
      header: SessionManager.inMemory(host.cwd, { id: host.id }).getHeader()!,
      onObserverError: error => host.error({
        extensionPath: '<host>', event: 'journal', error: error instanceof Error ? error.message : String(error),
      }),
    });
    const coding = new CodingHost(host, journal, models);
    try {
      const resources = createHostResources({ ...host.profile, cwd: host.cwd, getSystemPrompt: host.getSystemPrompt });
      resources.settingsManager.setHostAutoCompactWindow(host.autoCompactWindow);
      await resources.resourceLoader.reload();
      for (const error of resources.resourceLoader.getExtensions().errors) {
        host.error({ extensionPath: error.path, event: 'resources', error: error.error });
      }
      for (const diagnostic of await initializeExtensionModels(resources.resourceLoader, models)) {
        host.error({ extensionPath: '<resources>', event: diagnostic.type, error: diagnostic.message });
      }
      const tools = Object.fromEntries(host.registry.snapshot().tools().map(({ tool }) => [tool.name, hostToolToAgent(tool)]));
      const modelTools = Object.entries(tools).filter(([, tool]) =>
        (tool.exposure === 'direct' || tool.exposure === 'model-only') && tool.defaultActive !== false)
        .map(([name]) => `+${name}`);
      const created = await createAgentSession({
        ...resources, cwd: host.cwd, agentDir: host.profile.agentDir,
        modelRuntime: models, model: await host.model(models), durable: coding.durable,
        sessionStartEvent: { type: 'session_start', reason },
        sessionManager: journal.manager, baseToolsOverride: tools,
        // A modifier extends the host catalog while retaining all native extension exposures.
        tools: modelTools.length ? modelTools : undefined,
        thinkingLevel: host.thinkingLevel() as AgentSession['thinkingLevel'],
        wrapTool: (tool, source) => coding.wrapTool(tool, source),
        onAction: work => coding.action(work),
        onToolsChanged: tools => host.publishTools(tools.flatMap(tool => {
          const registration = coding.nativeTools.get(tool.name);
          return registration ? [registration] : [];
        })),
      });
      coding.session = created.session;
      const saved = await host.harness.snapshot(State, host.conversation.id, BACKGROUND_CONTEXT);
      if (saved?.owner === host.conversation.id && saved.state) {
        // Versioned state is written only by exportDurableState at this boundary.
        coding.session.restoreDurableState(saved.state as unknown as ReturnType<AgentSession['exportDurableState']>);
      }
      await coding.durable.restoreSessionState();
      coding.stopEvents = coding.session.subscribe(event => {
        if (event.type === 'agent_start') coding.legacy?.onStart();
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const id = randomUUID();
          coding.anchors.push({ message: event.message, id });
          const messageEnd: Record<string, unknown> = { ...event, sdkMessageId: id };
          coding.publishEvent(messageEnd);
        } else coding.publishEvent(event);
      });
      await coding.durable.backend();
      coding.legacy = new LegacyCodingAdoption(host.harness, host.conversation, coding.session, journal, coding.durable);
      await coding.legacy.restore();
      return coding;
    } catch (error) {
      coding.stopAnchors();
      journal.close();
      throw error;
    }
  }

  private wrapTool(tool: AgentTool, source?: SourceInfo): AgentTool {
    if (source?.source === 'builtin') {
      this.nativeTools.delete(tool.name);
      return tool;
    }
    const wrapped = wrapAgentTool(tool, this.host.wrapTool,
      (api, context, work) => this.durable.withHostToolScope(api, context, work));
    this.nativeTools.set(tool.name, wrapped.registration);
    return wrapped.tool;
  }

  async start(reason: 'startup' | 'resume' | 'fork' | 'reload' | 'new'): Promise<void> {
    await this.session.bindExtensions({
      mode: 'print', commandContextActions: this.host.commands,
      shutdownHandler: this.host.shutdown, onError: this.host.error,
    });
    await this.legacy?.adopt();
    await this.flush();
    const pending = await this.durable.pendingSession();
    if (pending !== undefined) this.host.event({ type: 'agent_start' });
    if (reason === 'resume' || pending !== undefined) {
      const bound = Promise.withResolvers<void>();
      const recovery = this.session.recoverDurable(() => bound.resolve()).then(async () => {
        bound.resolve();
        await this.flush();
      });
      this.track(recovery);
      void recovery.catch(error => bound.reject(error));
      await bound.promise;
    }
  }

  get systemPrompt(): string { return this.session.agent.state.systemPrompt; }

  contextUsagePayload() {
    const { enabled, reserveTokens } = this.session.settingsManager.getCompactionSettings(this.session.model);
    return { contextUsage: this.session.getContextUsage(), compactionSettings: { enabled, reserveTokens } };
  }

  private publishEvent(event: AgentSessionEvent | Record<string, unknown>): void {
    let usage: ReturnType<CodingHost['contextUsagePayload']> | undefined;
    // Native message_end precedes projection persistence. Later boundaries include the finished turn.
    if (event.type === 'turn_end' || event.type === 'agent_end' || event.type === 'agent_settled'
      || event.type === 'compaction_start' || event.type === 'compaction_end') {
      try { usage = this.contextUsagePayload(); }
      catch (error) {
        this.host.error({ extensionPath: '<host>', event: 'context_usage',
          error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.host.event(usage ? { ...event, ...usage } : event);
  }

  /** Admit input after native command, input and before-agent-start processing; retain its running promise. */
  async submit(text: string, options: PromptOptions): Promise<void> {
    const admitted = Promise.withResolvers<void>();
    const run = this.action(() => this.session.prompt(text, { ...options, preflightResult: () => admitted.resolve() }));
    void run.catch(error => admitted.reject(error));
    await admitted.promise;
    if (!this.closed) await this.flush();
  }

  private action(work: () => Promise<void>): Promise<void> {
    const scope: { job?: Promise<void> } = {};
    const job = this.actionScope.run(scope, work);
    scope.job = job;
    this.track(job);
    return job;
  }

  private track(job: Promise<void>): void {
    this.jobs.add(job);
    void job.catch(error => this.host.error({
      extensionPath: '<host>', event: 'action', error: error instanceof Error ? error.message : String(error),
    })).finally(() => { this.jobs.delete(job); });
  }

  private async persistState(tx: Tx): Promise<void> {
    if (!this.session) return;
    const state = await tx.doc(State, this.host.conversation.id);
    state.owner = this.host.conversation.id;
    state.state = copyJson(this.session.exportDurableState(), { omitUndefinedProperties: true });
    await this.persistSelection(tx);
    await this.legacy?.commit(tx);
  }

  private async persistSelection(tx: Tx): Promise<void> {
    const agent = await tx.doc(AgentDoc, this.host.conversation.id);
    const model = this.session.model;
    if (model) agent.model = { provider: model.provider, modelId: model.id };
    agent.thinkingLevel = this.session.thinkingLevel;
    agent.modelTools = this.session.getActiveToolNames();
  }

  /** Idle/plugin writes and queue admissions use the same journal, without starting another executor. */
  async flush(): Promise<void> {
    await this.journal.phase(() => this.host.harness.commit(async tx => {
      if (this.durable.hasSessionActivity()) {
        await this.durable.commitChanges(tx);
        await this.persistSelection(tx);
      } else await this.durable.commitSession(tx);
    }, BACKGROUND_CONTEXT));
    this.host.selection(this.session.model, this.session.thinkingLevel);
  }

  async waitForIdle(): Promise<void> {
    const current = this.actionScope.getStore();
    const pending = () => [...this.jobs].filter(job => job !== current?.job);
    do {
      await this.session.waitForIdle();
      await Promise.all(pending());
    } while (pending().length || this.session.isStreaming);
    await this.flush();
  }

  async abort(): Promise<void> {
    await this.session.abort();
    await this.waitForIdle();
  }

  updateTools(tools: ToolRegistration[]): void {
    this.session.setBaseTools(Object.fromEntries(tools.map(tool => [tool.name, hostToolToAgent(tool)])));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.abort();
    await this.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    await this.flush();
    this.stopEvents?.();
    this.stopAnchors();
    this.legacy?.close();
    this.anchors.length = 0;
    this.session.dispose();
    await this.durable.close();
    this.journal.close();
    this.closed = true;
  }
}
