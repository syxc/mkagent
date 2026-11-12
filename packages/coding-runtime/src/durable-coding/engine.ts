/** Bind native Agent callbacks to a pi-durable session and task registry. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { restoreHostUsageOutcome } from '../host-tool-usage.ts';
import { wrapAgentTool } from '../host-tools.ts';
import { hostToolExecution } from '../host-tool-task.ts';
import { copyJson, type Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-coding-agent';
import { AuthStorage, InMemoryCodingAgentModelsStore, ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  Harness, MemoryStorage, createRegistry, type Conversation, type EntryDraft,
  type Registry, type Report, type Storage, type Tx, type TaskId, type TaskRuntime, type ToolExecutionApi,
} from '@earendil-works/pi-durable';
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentToolCall, AgentToolCallOutcome, StreamFn } from '../agent-runtime.ts';
import type { RunToolCallOptions } from '../durable-loop.ts';
import { getDefaultStreamFn } from '../stream-fn.ts';
import type { AgentEventSink } from '../native-operations.ts';
import { createCodingRunTask, type LoopExecution, type LoopInput } from './run-task.ts';
import type { CodingToolInvocation, CodingToolTaskBindings, CodingToolTaskInput } from './tool-task.ts';
import { createSingleToolTask } from './single-tool-task.ts';
import { ToolBatchStarts } from './tool-batch.ts';
import { codingTasks } from './task-registry.ts';
import type { NativeSessionJournal } from './session-journal.ts';
import { NativeMessageIdentities } from './message-identities.ts';
import { NativeSessionBinding, type NativeSessionLifecycle } from './session-binding.ts';
import type { CodingSessionAction, CodingSessionCompletion, CodingSessionTaskInput } from './session-task.ts';
import { NativeInputQueues, type InputQueueSnapshot, type QueuedInput } from './input-queues.ts';
import { NativeSummaryBinding } from './summary-binding.ts';
import type { SummaryProducer } from './summary-task.ts';
import { NativeCodemodeForwarders, type NativeCodemodeForwardHandler, type NativeCodemodeForwardLease } from './codemode-forward.ts';

export interface DurableLoopOptions {
  /** A supplied kernel remains owned by its mkagent host. */
  kernel?: { harness: Harness; conversation: Conversation; registry: Registry };
  storage?: Storage;
  models?: Models;
  context?: Context;
  /** Native AgentSession owns transcript entries; include them in each task checkpoint transaction. */
  journal?: NativeSessionJournal;
  /** Save native queues and lifecycle metadata in the same transaction as each run transition. */
  commitState?(tx: Tx): Promise<void>;
  /** Await committed product input before publishing an assistant message. */
  beforeAssistantMessage?(): Promise<void>;
  finalArguments?(scope: CodingToolInvocation): Promise<unknown>;
  activateTools?(names: string[]): void;
  onSessionComplete?(completion: CodingSessionCompletion): void;
}

export interface LoopBackend {
  harness: Harness;
  conversation: Conversation;
  registry: Registry;
  context: Context;
  reports: Report[];
}

interface Invocation {
  host: LoopExecution;
  drafts: EntryDraft[];
  runTool(call: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome>;
  tool?: CodingToolInvocation;
  hostTool?: { api: ToolExecutionApi; context: Context };
  registerCodemodeForward(api: ToolExecutionApi, context: Context, handler: NativeCodemodeForwardHandler): Promise<NativeCodemodeForwardLease>;
}

interface ToolOwner {
  taskId: TaskId;
  commit(work: (tx: Tx) => Promise<undefined>, context: Context): Promise<void>;
  waitForTask: ToolExecutionApi['waitForTask'];
}

const invocation = new AsyncLocalStorage<Invocation>();

/** Bind an existing tool API without changing its task owner. */
export function withCodingHostToolApi<T>(api: ToolExecutionApi, context: Context, work: () => T): T {
  const scope = invocation.getStore();
  if (!scope) throw new Error('Host tool API requires a durable coding invocation');
  return invocation.run({ ...scope, hostTool: { api, context } }, work);
}

/** Capture either an official ToolTask API or the API backed by a CodingToolTask. */
export function currentCodingHostToolApi() {
  const scope = invocation.getStore();
  if (!scope?.hostTool) return undefined;
  const resume = AsyncLocalStorage.snapshot();
  const { api, context } = scope.hostTool;
  return {
    api, context, runInScope: <T>(work: () => T): T => resume(work),
    registerCodemodeForward: (handler: NativeCodemodeForwardHandler) => scope.registerCodemodeForward(api, context, handler),
  };
}

/** The real durable tool phase used by the host approval and execution adapters. */
export function currentCodingToolInvocation(): CodingToolInvocation & {
  flush(tx: Tx): Promise<void>;
  runInScope<T>(work: () => T): T;
} {
  const scope = invocation.getStore();
  if (!scope?.tool) throw new Error('Host tool execution requires a durable coding tool invocation');
  // Worker messages and progress timers can invoke the host API without this async context.
  const resume = AsyncLocalStorage.snapshot();
  return {
    ...scope.tool,
    flush: tx => resume(() => scope.host.commit(tx)),
    runInScope: work => resume(work),
  };
}

/** A stable execution owner for all prompts, continuations and child calls of one Agent. */
export class DurableLoopBinding {
  private readonly options: DurableLoopOptions;
  private opening?: Promise<LoopBackend>;
  private execution?: LoopExecution;
  private runTask?: ReturnType<typeof createCodingRunTask>;
  private singleTask?: ReturnType<typeof createSingleToolTask>;
  private closed = false;
  private seeded = false;
  private readonly models = new Map<string, AgentLoopConfig['model']>();
  private readonly tools = new Map<string, NonNullable<AgentContext['tools']>[number]>();
  private readonly callBindings = new Map<string, RunToolCallOptions>();
  private readonly callOwners = new Map<TaskId, string>();
  private readonly batchStarts = new ToolBatchStarts();
  private unbind?: () => void;
  private restoreMessages?: (messages: AgentMessage[]) => void;
  private readonly sessionBinding: NativeSessionBinding;
  private readonly inputQueues?: NativeInputQueues;
  private readonly summaries: NativeSummaryBinding;
  private readonly codemodeForwards = new NativeCodemodeForwarders(
    (api, context, work) => this.withHostToolScope(api, context, work),
    () => {
      const api = currentCodingHostToolApi()?.api;
      if (!api) throw new Error('Native codemode child has no host API');
      return api;
    },
  );

  constructor(options: DurableLoopOptions = {}) {
    this.options = options;
    if (options.journal) this.inputQueues = new NativeInputQueues(options.journal);
    this.sessionBinding = new NativeSessionBinding({
      backend: () => this.backend(), tasks: () => codingTasks(this.options.kernel?.registry ?? this.registry!),
      commit: tx => this.commitSession(tx),
      phase: work => this.options.journal ? this.options.journal.phase(work) : work(),
      complete: options.onSessionComplete,
    });
    this.summaries = new NativeSummaryBinding({
      backend: () => this.backend(), tasks: () => codingTasks(this.options.kernel?.registry ?? this.registry!),
      owner: () => this.sessionBinding.current(),
      commit: tx => this.commitSession(tx),
    });
  }

  private registry?: Registry;

  bindSummary(producer: SummaryProducer): void { this.summaries.bind(producer); }
  get summaryStream(): StreamFn { return this.summaries.stream; }

  bindSessionState(capture: () => unknown, restore: (state: unknown) => void): void {
    this.sessionBinding.bindState(capture, restore);
  }

  pendingSession(): Promise<TaskId | undefined> { return this.sessionBinding.pending(); }
  async restoreSessionState(): Promise<void> {
    await this.sessionBinding.restoreState();
    if (this.inputQueues) {
      const backend = await this.backend();
      await this.inputQueues.restore(backend.harness, backend.conversation.id, backend.context,
        (await backend.harness.inspect(backend.context)).tasks);
    }
  }
  settleSession(callbacks: NativeSessionLifecycle, onBound?: () => void): Promise<void> {
    return this.sessionBinding.settle({
      ...callbacks,
      finalize: async completion => {
        try {
          await callbacks.finalize(completion);
        } catch (error) {
          this.options.onSessionComplete?.({
            status: 'failed', stage: 'finalize', message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        this.options.onSessionComplete?.(completion);
      },
    }, onBound);
  }
  deferSessionAction(action: CodingSessionAction): Promise<boolean> { return this.sessionBinding.defer(action); }
  inSessionPhase(): boolean { return this.sessionBinding.current() !== undefined; }
  hasSessionActivity(): boolean { return this.sessionBinding.isRunning(); }
  preparedSessionInput(): LoopInput | undefined { return this.sessionBinding.current()?.preparedInput(); }
  admitSession(tx: Tx, input: CodingSessionTaskInput): Promise<TaskId> { return this.sessionBinding.admit(tx, input); }
  tagMessage(message: AgentMessage, tag: string): void { this.options.journal?.tagMessage(message, tag); }
  messageTag(message: AgentMessage): string | undefined { return this.options.journal?.messageTag(message); }
  tagEntry(message: AgentMessage, nativeId: string): void { this.options.journal?.tagEntry(message, nativeId); }
  identifyQueuedMessage(message: AgentMessage): void {
    if (!this.messageTag(message)) this.tagMessage(message, randomUUID());
  }

  bindInputQueues(restore: (inputs: QueuedInput[], cancelled: string[]) => void): void { this.inputQueues?.bind(restore); }
  discardQueuedInputs(messages: AgentMessage[]): void { this.inputQueues?.discard(messages); }

  async commitQueuedInputs(tx: Tx, snapshot: InputQueueSnapshot): Promise<void> {
    if (!this.inputQueues) return;
    const inputs = this.inputQueues.capture(snapshot, message => this.identifyQueuedMessage(message));
    await this.inputQueues.accept(tx, (await this.backend()).conversation.id, inputs);
  }

  async persistQueuedInputs(snapshot: InputQueueSnapshot): Promise<void> {
    if (!this.inputQueues) return;
    const inputs = this.inputQueues.capture(snapshot, message => this.identifyQueuedMessage(message));
    const backend = await this.backend();
    // Admission owns only this document. It must neither publish a partial native phase
    // nor retain an event handler's task runtime after that handler returns.
    await backend.harness.commit(tx => this.inputQueues!.accept(tx, backend.conversation.id, inputs), backend.context);
  }

  async commitChanges(tx: Tx, fullSnapshot = false): Promise<void> {
    await this.options.journal?.commit(tx);
    if (this.inputQueues) await this.inputQueues.commit(tx, (await this.backend()).conversation.id, fullSnapshot);
  }

  /** Include native journal, accepted queues and lifecycle state in the caller's transaction. */
  async commitSession(tx: Tx): Promise<void> {
    await this.commitChanges(tx, true);
    await this.sessionBinding.persistState(tx);
    await this.options.commitState?.(tx);
  }

  /** Agent binds its state facade once so recovered checkpoint aliases become its live transcript. */
  setMessageRestorer(restore: (messages: AgentMessage[]) => void): void {
    this.restoreMessages = restore;
  }

  async pendingRun(): Promise<TaskId | undefined> {
    const backend = await this.backend();
    const tasks = (await backend.harness.inspect(backend.context)).tasks.filter(({ record }) =>
      record.conversationId === backend.conversation.id && record.kind === 'pi.coding.run');
    if (tasks.length > 1) throw new Error('Several coding runs cannot own the same native Agent');
    return tasks[0]?.record.id;
  }

  /** Rebind callbacks before enabling the scheduler, then join the existing task instead of creating a run. */
  async recover(
    initial: AgentContext, config: AgentLoopConfig, emit: AgentEventSink,
    signal: AbortSignal | undefined, streamFn: StreamFn, onBound?: () => void, taskId?: TaskId,
  ): Promise<void> {
    if (this.execution) throw new Error('Durable Agent is already running');
    const backend = await this.backend();
    const id = taskId ?? await this.pendingRun();
    if (id === undefined) return;
    const task = await backend.harness.getTask(id, backend.context);
    if (!task) throw new Error(`Task ${id} does not exist`);
    if (task.conversationId !== backend.conversation.id || task.kind !== 'pi.coding.run') {
      throw new Error(`Task ${id} is not a coding run for this Agent`);
    }
    // The persisted run already contains this binding's initial transcript.
    this.seeded = true;
    this.remember(config, initial);
    const host = await this.createExecution(initial, config, emit, signal, streamFn, true);
    this.execution = host;
    try {
      onBound?.();
      const receipt = await backend.harness.waitForTask(id, backend.context);
      const outcome = receipt.state.outcome;
      if (outcome.status !== 'completed') {
        throw new Error('error' in outcome ? outcome.error?.message : `Durable Agent task ${outcome.status}`);
      }
    } finally {
      if (host.live) this.batchStarts.release(host.live.taskId);
      this.execution = undefined;
    }
  }

  /** Lazily create an isolated in-memory kernel, or attach to the supplied durable kernel. */
  backend(): Promise<LoopBackend> {
    if (this.closed) return Promise.reject(new Error('Durable Agent is closed'));
    this.opening ??= this.open();
    return this.opening;
  }

  /** Schedule a native prompt or continuation as one durable run task. */
  async run(
    prompts: AgentMessage[], initial: AgentContext, config: AgentLoopConfig, emit: AgentEventSink,
    signal: AbortSignal | undefined, streamFn: StreamFn,
  ): Promise<AgentMessage[]> {
    if (this.execution) throw new Error('Durable Agent is already running');
    const backend = await this.backend();
    if (await this.pendingRun() !== undefined) throw new Error('Resume the pending durable run before starting a new prompt');
    this.remember(config, initial);
    const host = await this.createExecution(initial, config, emit, signal, streamFn);
    this.execution = host;
    try {
      if (!this.options.journal && !this.seeded) {
        await backend.conversation.commit(async tx => {
          for (const message of initial.messages) {
            if (message.role === 'system' || message.role === 'user' ||
              message.role === 'assistant' || message.role === 'toolResult') {
              await tx.appendEntry(backend.conversation.id, {
                kind: 'pi.coding.message', model: [message],
                data: copyJson({ message }, { omitUndefinedProperties: true }),
              });
            }
          }
        }, backend.context);
        this.seeded = true;
      }
      const input: LoopInput = {
        prompts, messages: initial.messages, tools: initial.tools?.map(tool => tool.name) ?? [],
        model: { provider: config.model.provider, modelId: config.model.id },
        reasoning: config.reasoning,
      };
      // Native messages cross into the kernel as JSON; credentials and executable callbacks stay in the binding.
      const session = this.sessionBinding.current();
      const prepared = session?.preparedInput();
      const source = prepared?.resume?.prepareAgentStart
        ? { ...prepared, messages: input.messages, prompts: input.prompts, tools: input.tools,
          model: input.model, reasoning: input.reasoning, resume: { ...prepared.resume, phase: 'initialize' as const } }
        : prepared ?? input;
      const references = { ...source.messageReferences };
      for (const key of ['prompts', 'messages'] as const) source[key].forEach((message, index) => {
        const tag = this.options.journal?.messageTag(message);
        if (tag) references[`${key}.${index}`] = { ...references[`${key}.${index}`], tag };
      });
      const persistedInput = copyJson({ ...source, messageReferences: references },
        { omitUndefinedProperties: true }) as unknown as LoopInput;
      const taskId = session
        ? await session.admitChild((tx, owner) =>
          tx.createTask(this.runTask!, persistedInput, { ownership: { kind: 'task', taskId: owner } }))
        : await backend.conversation.commit(tx =>
          tx.createTask(this.runTask!, persistedInput, { ownership: { kind: 'conversation' } }), backend.context);
      // admitChild persists an untyped ID; this call created the fixed pi.coding.run definition above.
      const runId = taskId as TaskId<AgentMessage[]>;
      const receipt = session ? await session.waitForTask(runId, backend.context)
        : await backend.harness.waitForTask(runId, backend.context);
      const outcome = receipt.state.outcome;
      if (outcome.status !== 'completed') {
        const message = 'error' in outcome ? outcome.error?.message : undefined;
        throw new Error(message ?? `Durable Agent task ${outcome.status}`);
      }
      return outcome.result;
    } finally {
      if (host.live) this.batchStarts.release(host.live.taskId);
      this.execution = undefined;
    }
  }

  /** Execute a standalone SDK call. Nested calls use their current task's owner scope. */
  async runTool(call: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
    if (this.execution) throw new Error('Durable Agent is already running');
    const assistant = options.assistantMessage;
    const model = {
      id: assistant.model, name: assistant.model, provider: assistant.provider, api: assistant.api,
      baseUrl: '', reasoning: false, input: [], contextWindow: 0, maxTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } satisfies AgentLoopConfig['model'];
    this.execution = await this.createExecution(options.context, {
      model, convertToLlm: () => [],
    }, async () => {}, options.signal, (...args) => getDefaultStreamFn()(...args));
    try {
      return await this.startTool(call, options);
    } finally {
      this.execution = undefined;
    }
  }

  private async createExecution(
    initial: AgentContext, config: AgentLoopConfig, emit: AgentEventSink,
    signal: AbortSignal | undefined, streamFn: StreamFn, recovering = false,
  ): Promise<LoopExecution> {
    const backend = await this.backend();
    const identities = this.options.journal && new NativeMessageIdentities(this.options.journal,
      messages => this.restoreMessages?.(messages));
    const host: LoopExecution = {
      config, context: initial, streamFn, signal,
      emit: async event => {
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          await this.options.beforeAssistantMessage?.();
        }
        if (event.type === 'message_end') await host.beforeMessageEnd?.();
        await emit(event);
        if (this.options.journal) {
          if (event.type === 'message_end') identities?.appended(event.message);
          return;
        }
        if (event.type !== 'message_end') return;
        const message = event.message;
        const modelMessage = message.role === 'system' || message.role === 'user' ||
          message.role === 'assistant' || message.role === 'toolResult' ? message : undefined;
        const scope = invocation.getStore();
        if (!scope || scope.host !== host) throw new Error('Agent event outside a durable task phase');
        scope.drafts.push({
          kind: 'pi.coding.message', data: copyJson({ message }, { omitUndefinedProperties: true }),
          ...(modelMessage ? { model: [modelMessage] } : {}),
        });
      },
      resolveModel: (provider, id) => this.options.models?.getModel(provider, id) ??
        this.models.get(`${provider}\0${id}`),
      resolveTool: name => this.tools.get(name),
      prepareToolBatch: (owner, callIds) => this.batchStarts.prepare(owner, callIds),
      activateTools: this.options.activateTools,
      handoff: message => {
        if (this.options.journal) {
          this.options.journal.manager.resetLeaf();
          this.options.journal.manager.appendMessage(message);
          identities?.appended(message);
        } else {
          const scope = invocation.getStore();
          if (!scope || scope.host !== host) throw new Error('Tool handoff outside a durable task phase');
          scope.drafts.push({ kind: 'pi.coding.handoff', head: 'self', model: [message] });
        }
        host.context = { ...host.context, messages: [message] };
        this.restoreMessages?.(host.context.messages);
      },
      captureMessageReferences: identities && (state => identities.capture(state)),
      restoreCheckpoint: state => {
        if (identities) identities.restore(state);
        // Agent and task append independently while retaining the same message objects.
        else if (recovering) this.restoreMessages?.([...state.messages]);
      },
      commit: async tx => {
        const scope = invocation.getStore();
        if (!scope || scope.host !== host) throw new Error('Agent commit outside a durable task phase');
        await this.commitSession(tx);
        for (const draft of scope.drafts) await tx.appendEntry(backend.conversation.id, draft);
        scope.drafts.length = 0;
      },
      phase: async (runtime, work) => this.withPhase(host, runtime, work),
    };
    return host;
  }

  private async withPhase<I, S extends { phase: string }, R, T>(
    host: LoopExecution, runtime: TaskRuntime<I, S, R, object>, work: () => Promise<T>,
  ): Promise<T> {
    const phase = () => invocation.run({
      host, drafts: [], runTool: (call, options) => this.startTool(call, options, runtime),
      registerCodemodeForward: (api, context, handler) => this.codemodeForwards.register(api, context, handler),
    }, async () => {
      try {
        return await work();
      } finally {
        this.remember(host.config, host.context);
      }
    });
    return this.options.journal ? this.options.journal.phase(phase) : phase();
  }

  /** Official ToolTasks enter through their own API, never an inherited, ended task invocation. */
  async withHostToolScope<T>(api: ToolExecutionApi, context: Context, work: () => Promise<T>): Promise<T> {
    const existing = invocation.getStore();
    if (existing?.tool?.runtime.taskId === api.taskId && existing.host === this.execution) {
      return withCodingHostToolApi(api, context, work);
    }
    const backend = await this.backend();
    if (api.conversationId !== backend.conversation.id || !this.execution) {
      throw new Error('Host tool does not belong to the active durable coding session');
    }
    const host = this.execution;
    const owner: ToolOwner = {
      taskId: api.taskId,
      commit: (change, commitContext) => api.commit(change, commitContext),
      waitForTask: (id, waitContext) => api.waitForTask(id, waitContext),
    };
    const phase = () => invocation.run({
      host, drafts: [], runTool: (call, options) => this.startTool(call, options, owner),
      registerCodemodeForward: (api, context, handler) => this.codemodeForwards.register(api, context, handler),
    }, async () => {
      const resume = AsyncLocalStorage.snapshot();
      const scopedApi: ToolExecutionApi = {
        ...api,
        get models() { return api.models; },
        commit: (change, commitContext, options) => api.commit(async tx => {
          await resume(() => host.commit(tx));
          const result = await resume(() => withCodingHostToolApi(scopedApi, context, () => change(tx)));
          await resume(() => host.commit(tx));
          return result;
        }, commitContext, options),
      };
      return withCodingHostToolApi(scopedApi, context, async () => {
        const result = await work();
        await scopedApi.commit(() => undefined, context);
        return result;
      });
    });
    // Context cancellation remains owned by the official ToolTask.
    context.abortSignal?.throwIfAborted();
    return this.options.journal ? this.options.journal.phase(phase) : phase();
  }

  private async startTool(
    toolCall: AgentToolCall, options: RunToolCallOptions, owner?: ToolOwner,
  ): Promise<AgentToolCallOutcome> {
    const backend = await this.backend();
    const bindingKey = randomUUID();
    this.callBindings.set(bindingKey, options);
    let taskId: TaskId<AgentToolCallOutcome> | undefined;
    try {
      const create = async (tx: Tx) => {
        taskId = await tx.createTask(this.singleTask!, { toolCall, bindingKey }, {
          ownership: owner ? { kind: 'task', taskId: owner.taskId } : { kind: 'conversation' },
        });
      };
      if (owner) await owner.commit(async tx => {
        await this.execution!.commit(tx);
        await create(tx);
        return undefined;
      }, backend.context);
      else await backend.conversation.commit(create, backend.context);
      const receipt = owner ? await owner.waitForTask(taskId!, backend.context)
        : await backend.harness.waitForTask(taskId!, backend.context);
      const outcome = receipt.state.outcome;
      if ((outcome.status !== 'completed' && outcome.status !== 'aborted') || !outcome.result) {
        throw new Error('error' in outcome && outcome.error ? outcome.error.message : `Tool call ${outcome.status}`);
      }
      return restoreHostUsageOutcome(outcome.result);
    } finally {
      this.callBindings.delete(bindingKey);
      if (taskId) this.callOwners.delete(taskId);
    }
  }

  /** Close a standalone kernel after its work drains; shared host kernels retain their owner. */
  async close(): Promise<void> {
    if (this.closed) return;
    const backend = this.opening && await this.opening;
    if (backend && !this.options.kernel) await backend.harness.close(backend.context);
    this.unbind?.();
    this.closed = true;
  }

  private remember(config: AgentLoopConfig, context: AgentContext) {
    this.models.set(`${config.model.provider}\0${config.model.id}`, config.model);
    for (const tool of context.tools ?? []) this.tools.set(tool.name, tool);
  }

  private async open(): Promise<LoopBackend> {
    const reports: Report[] = [];
    const registry = this.options.kernel?.registry ?? createRegistry();
    this.registry = registry;
    const context = this.options.context ?? BACKGROUND_CONTEXT;
    const execution = () => {
      if (!this.execution) throw new Error('Durable Agent callbacks have not been bound');
      return this.execution;
    };
    const definitions = codingTasks(registry);
    this.runTask = definitions.run;
    this.singleTask = definitions.call;
    const harness = this.options.kernel?.harness ?? await Harness.open(this.options.storage ?? new MemoryStorage(), {
      registry, models: this.options.models ?? await ModelRuntime.create({
        credentials: AuthStorage.inMemory(), modelsStore: new InMemoryCodingAgentModelsStore(),
        modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      }),
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
      onReport: report => { reports.push(report); },
    }, context);
    const conversation = this.options.kernel?.conversation ?? await harness.root(context);
    this.unbind = definitions.bind(conversation.id, {
      execution,
      session: () => this.sessionBinding.bindings(),
      summary: () => this.summaries.bindings(),
      forward: (input, api, context) => this.codemodeForwards.forward(input, api, context),
      tool: input => this.toolBindings(input),
      call: (input, owner) => {
        const host = execution();
        const options = this.callBindings.get(input.bindingKey);
        if (!options) throw new Error('SDK tool callbacks have not been rebound');
        this.callOwners.set(owner, input.bindingKey);
        return {
          options, commit: host.commit,
          phase: (runtime, work) => this.withPhase(host, runtime, work),
        };
      },
    });
    return { harness, conversation, registry, context, reports };
  }

  private toolBindings(input: CodingToolTaskInput): CodingToolTaskBindings {
      const host = this.execution;
      if (!host) throw new Error('Durable Agent callbacks have not been bound');
      const key = input.parentTaskId && this.callOwners.get(input.parentTaskId);
      const override = key ? this.callBindings.get(key) : undefined;
      return {
        getTool: name => {
          const tool = override?.tools.find(tool => tool.name === name) ?? host.resolveTool(name);
          if (!tool) {
            if (input.parentTaskId !== undefined) this.batchStarts.release(input.parentTaskId);
            return undefined;
          }
          return {
            ...tool,
            [hostToolExecution]: true,
            execute: async (callId, args, signal, update) => {
              const combined = signal && host.signal ? AbortSignal.any([signal, host.signal]) : signal ?? host.signal;
              if (input.parentTaskId) await this.batchStarts.arrive(input.parentTaskId, callId, combined);
              if (Object.getOwnPropertyDescriptor(tool, hostToolExecution)?.value === true) {
                return tool.execute(callId, args, combined, update);
              }
              const delegated = wrapAgentTool(tool, registration => registration,
                (api, context, work) => this.withHostToolScope(api, context, work)).tool;
              return delegated.execute(callId, args, combined, update);
            },
          };
        },
        context: () => override?.context ?? host.context,
        afterToolCall: async (call, signal) => {
          const hook = override?.afterToolCall ?? host.config.afterToolCall;
          try {
            return await hook?.(call, signal);
          } finally {
            if (input.parentTaskId && !override) this.batchStarts.finalized(input.parentTaskId, input.toolCall.id);
          }
        },
        emit: async event => {
          if (override) {
            if (event.type === 'tool_execution_update') await override.onUpdate?.(event.partialResult);
          } else if (event.type === 'tool_execution_end' && input.parentTaskId) {
            const resume = AsyncLocalStorage.snapshot();
            await this.batchStarts.deliver(input.parentTaskId, input.toolCall.id,
              () => resume(async () => { await host.emit(event); }));
          } else await host.emit(event);
        },
        withInvocation: async (scope, work) => {
          try {
            return await this.withPhase(host, scope.runtime, async () => {
              invocation.getStore()!.tool = scope;
              return work();
            });
          } catch (error) {
            if (input.parentTaskId !== undefined) this.batchStarts.release(input.parentTaskId);
            throw error;
          }
        },
        onFailure: () => {
          if (input.parentTaskId !== undefined) this.batchStarts.release(input.parentTaskId);
        },
        commit: host.commit,
        finalArguments: this.options.finalArguments,
      };
  }
}

/** Use the current task for nested calls; standalone callers get an isolated durable kernel. */
export async function runDurableToolCall(
  call: AgentToolCall, options: RunToolCallOptions,
): Promise<AgentToolCallOutcome> {
  const scope = invocation.getStore();
  if (scope) return scope.runTool(call, options);
  const binding = new DurableLoopBinding();
  try {
    return await binding.runTool(call, options);
  } finally {
    await binding.close();
  }
}
