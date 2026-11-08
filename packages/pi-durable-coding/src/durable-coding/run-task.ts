/** Pi turn semantics expressed as durable phases and owned tool tasks. */
import { copyJson, type Context } from '@earendil-works/chord';
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import {
  defineTask, type ConversationId, type RunningTask,
  type TaskId, type TaskRuntime, type Tx, type ConversationStreamOptions,
} from '@earendil-works/pi-durable';
import type {
  AgentContext, AgentLoopConfig, AgentLoopTurnUpdate, AgentMessage, AgentToolCall,
  AgentToolCallOutcome, PrepareNextTurnContext, StreamFn,
} from '../agent-runtime.ts';
import {
  createErrorToolResult, createToolResultMessage, declareToolChanges, emitToolExecutionEnd,
  emitToolResultMessage, prepareToolCall, shouldTerminateToolBatch, streamAssistantResponse,
  type AgentEventSink,
} from '../native-operations.ts';
import type { MessageReferences } from './message-identities.ts';
import type { CodingToolTaskResult } from './tool-task.ts';

export interface LoopInput {
  messages: AgentMessage[];
  prompts: AgentMessage[];
  tools: string[];
  model: { provider: string; modelId: string };
  reasoning: AgentLoopConfig['reasoning'];
  messageReferences?: MessageReferences;
  /** A validated legacy continuation enters after the callbacks already committed by its prior scheduler. */
  resume?: {
    phase: 'initialize' | 'prepare' | 'request' | 'finish';
    notBefore?: number;
    streamOptions?: ConversationStreamOptions;
    lastTurn?: { message: AssistantMessage; toolResults: ToolResultMessage[] };
    newMessages?: AgentMessage[];
    prepareAgentStart?: { content: UserMessage['content']; placed: boolean; tag?: string };
  };
}

interface Call {
  toolCall: AgentToolCall;
  args?: unknown;
  taskId?: TaskId<AgentToolCallOutcome>;
  outcome?: AgentToolCallOutcome & Pick<CodingToolTaskResult, 'control'>;
}

interface Payload extends LoopInput {
  newMessages: AgentMessage[];
  pending: AgentMessage[];
  lastTurn?: { message: AssistantMessage; toolResults: ToolResultMessage[] };
  message?: AssistantMessage;
  calls: Call[];
  cursor: number;
  parallel: boolean;
  toolResults: ToolResultMessage[];
  revision: number;
  inFlight?: Phase;
  messageReferences?: MessageReferences;
}

type Phase = 'initialize' | 'resume-wait' | 'prepare' | 'request' | 'preflight' | 'wait-tools' | 'deliver-tools' | 'finish' | 'settle';
export type LoopCheckpoint = { [P in Phase]: Payload & { phase: P } }[Phase];
type Runtime = TaskRuntime<LoopInput, LoopCheckpoint, AgentMessage[], object>;
type Running = RunningTask<LoopInput, LoopCheckpoint, AgentMessage[]>;

export interface LoopExecution {
  live?: { taskId: TaskId; state: LoopCheckpoint };
  config: AgentLoopConfig;
  context: AgentContext;
  streamFn: StreamFn;
  signal?: AbortSignal;
  emit: AgentEventSink;
  resolveModel(provider: string, id: string): Model<any> | undefined;
  resolveTool(name: string): NonNullable<AgentContext['tools']>[number] | undefined;
  prepareToolBatch(owner: TaskId, callIds: string[]): void;
  activateTools?(names: string[]): void;
  handoff?(message: UserMessage): void;
  captureMessageReferences?(state: LoopCheckpoint): MessageReferences;
  restoreCheckpoint?(state: LoopCheckpoint): void;
  beforeMessageEnd?(): Promise<void>;
  /** Includes the session's staged writes in the task's own transaction. */
  commit(tx: Tx): Promise<void>;
  phase<T>(runtime: Runtime, work: () => Promise<T>): Promise<T>;
}

export interface ToolScheduler {
  create(
    tx: Tx, owner: TaskId, assistantMessage: AssistantMessage, call: AgentToolCall, args: unknown,
  ): Promise<TaskId<AgentToolCallOutcome>>;
}

/** The durable scheduler, rather than a second promise loop, selects every next phase. */
export function createCodingRunTask(
  resolve: (id: ConversationId) => LoopExecution,
  tools: ToolScheduler,
) {
  const execute = (
    body: (state: LoopCheckpoint, host: LoopExecution, runtime: Runtime, context: Context) => Promise<void>,
  ) => async (task: Running, runtime: Runtime, context: Context) => {
    const host = resolve(runtime.conversationId);
    // Pi associates persisted entry IDs with message objects. Retain native identities while this
    // process owns the exact committed checkpoint; after recovery rebuild from durable data.
    const cached = host.live;
    const live = cached?.taskId === runtime.taskId && cached.state.revision === task.state.checkpoint.revision;
    const state = live ? cached.state : structuredClone(task.state.checkpoint);
    if (!live && state.inFlight)
      throw new Error(`Native run ${state.inFlight} was interrupted; hook and event delivery is uncertain and was not repeated`);
    if (!live) host.restoreCheckpoint?.(state);
    host.live = { taskId: runtime.taskId, state };
    host.context = {
      messages: state.messages,
      tools: state.tools.flatMap(name => {
        const tool = host.resolveTool(name);
        return tool ? [tool] : [];
      }),
    };
    const model = host.resolveModel(state.model.provider, state.model.modelId);
    if (!model) throw new Error(`Unavailable run model ${state.model.provider}/${state.model.modelId}`);
    host.config = { ...host.config, model, reasoning: state.reasoning };
    const recordIntent = async () => {
      if (state.inFlight) return;
      await runtime.commit(() => ({ status: 'running',
        checkpoint: checkpoint(state, state.phase, host, state.phase) }), context);
    };
    host.beforeMessageEnd = state.phase === 'request' ? recordIntent : undefined;
    try {
      await host.phase(runtime, async () => {
        if (!['resume-wait', 'wait-tools'].includes(state.phase)) await recordIntent();
        await body(state, host, runtime, context);
      });
    } catch (error) {
      host.live = undefined;
      throw error;
    }
  };
  return defineTask<LoopInput, LoopCheckpoint, AgentMessage[]>({
    name: 'pi.coding.run',
    version: 1,
    initial: input => {
      const lastTurn = input.resume?.lastTurn;
      return stored({
        ...input, phase: input.resume?.notBefore ? 'resume-wait' : input.resume?.phase ?? 'initialize',
        newMessages: input.resume?.newMessages ?? [], pending: [],
        message: lastTurn?.message, lastTurn,
        calls: lastTurn?.message.content.flatMap(part => part.type === 'toolCall' ? [{
          toolCall: part,
          outcome: { toolCall: part, result: { content: [], details: {} }, isError: false },
        }] : []) ?? [],
        cursor: 0, parallel: true, toolResults: lastTurn?.toolResults ?? [], revision: 0,
      });
    },
    phases: {
      'resume-wait': execute(async (state, host, runtime, context) => {
        const phase = state.resume?.phase ?? 'prepare';
        const next = checkpoint(state, phase, host);
        const until = state.resume?.notBefore ?? 0;
        await runtime.commit(async tx => {
          await host.commit(tx);
          return until > runtime.now() ? { status: 'sleeping', until, checkpoint: next }
            : { status: 'running', checkpoint: next };
        }, context);
      }),
      initialize: execute(async (state, host, runtime, context) => {
        const initial = declareToolChanges(host.context, state.prompts);
        host.context.messages.push(...initial);
        await host.emit({ type: 'agent_start' });
        await host.emit({ type: 'turn_start' });
        for (const message of initial) {
          await host.emit({ type: 'message_start', message });
          await host.emit({ type: 'message_end', message });
        }
        state.newMessages.push(...initial);
        state.pending = await host.config.getSteeringMessages?.() ?? [];
        await advance(state, 'prepare', host, runtime, context);
      }),
      prepare: execute(async (state, host, runtime, context) => {
        let prepared: AgentMessage[] = [];
        if (!state.lastTurn && state.resume?.phase === 'prepare' && !state.pending.length)
          state.pending = await host.config.getSteeringMessages?.() ?? [];
        if (state.lastTurn) {
          const update = await host.config.prepareNextTurn?.(turn(state, host));
          if (update) {
            applyUpdate(update, host);
            prepared = update.messages ?? [];
          }
          if (!state.pending.length) state.pending = await host.config.getSteeringMessages?.() ?? [];
          await host.emit({ type: 'turn_start' });
        }
        for (const message of declareToolChanges(host.context, [...prepared, ...state.pending])) {
          await host.emit({ type: 'message_start', message });
          await host.emit({ type: 'message_end', message });
          host.context.messages.push(message);
          state.newMessages.push(message);
        }
        state.pending = [];
        const update = await host.config.prepareRequest?.({
          context: host.context, model: host.config.model, thinkingLevel: host.config.reasoning ?? 'off',
        }, signal(host, runtime));
        if (update) applyUpdate(update, host);
        await advance(state, 'request', host, runtime, context);
      }),
      request: execute(async (state, host, runtime, context) => {
        const streamOptions = state.resume?.streamOptions;
        state.message = await streamAssistantResponse(
          host.context, host.config, signal(host, runtime), host.emit,
          streamOptions ? (model, request, options) => host.streamFn(model, request, { ...options, ...streamOptions }) : host.streamFn,
        );
        state.resume = undefined;
        state.newMessages.push(state.message);
        state.calls = state.message.content.flatMap(part => part.type === 'toolCall' ? [{ toolCall: part }] : []);
        state.cursor = 0;
        state.toolResults = [];
        state.parallel = host.config.toolExecution !== 'sequential' && !state.calls.some(call =>
          host.context.tools?.find(tool => tool.name === call.toolCall.name)?.executionMode === 'sequential');
        const failed = state.message.stopReason === 'error' || state.message.stopReason === 'aborted';
        await advance(state, failed || !state.calls.length ? 'finish' : 'preflight', host, runtime, context);
      }),
      preflight: execute(async (state, host, runtime, context) => {
        const call = state.calls[state.cursor];
        const assistant = state.message!;
        await host.emit({
          type: 'tool_execution_start', toolCallId: call.toolCall.id,
          toolName: call.toolCall.name, args: call.toolCall.arguments,
        });
        if (assistant.stopReason === 'length') {
          call.outcome = {
            toolCall: call.toolCall, isError: true,
            result: createErrorToolResult(`Tool call "${call.toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`),
          };
        } else {
          const preparation = await prepareToolCall(host.context, assistant, call.toolCall, host.config, signal(host, runtime));
          if (preparation.kind === 'immediate') {
            call.outcome = { toolCall: call.toolCall, result: preparation.result, isError: preparation.isError };
          } else {
            call.args = preparation.args;
          }
        }
        if (call.outcome) await emitToolExecutionEnd(call.outcome, host.emit);
        state.cursor++;
        // A truncated response emits each failed artifact immediately, even in parallel mode.
        if (!state.parallel || assistant.stopReason === 'length') {
          if (call.outcome) {
            await deliver(call.outcome, state, host);
            await afterSequential(state, host, runtime, context);
          } else {
            await runtime.commit(async tx => {
              call.taskId = await tools.create(tx, runtime.taskId, assistant, call.toolCall, call.args);
              await host.commit(tx);
              return { status: 'waiting', on: [call.taskId], policy: 'allSettled', checkpoint: checkpoint(state, 'deliver-tools', host) };
            }, context);
          }
          return;
        }
        if (state.cursor < state.calls.length && !signal(host, runtime).aborted) {
          await advance(state, 'preflight', host, runtime, context);
          return;
        }
        // Aborting preflight stops admitting subsequent calls, while prepared calls still receive an aborted result.
        state.calls = state.calls.slice(0, state.cursor);
        const aborted = signal(host, runtime).aborted;
        if (aborted) for (const prepared of state.calls) {
          if (prepared.outcome) continue;
          prepared.outcome = { toolCall: prepared.toolCall, result: createErrorToolResult('Operation aborted'), isError: true };
          await emitToolExecutionEnd(prepared.outcome, host.emit);
        }
        host.prepareToolBatch(runtime.taskId, state.calls.filter(call => !call.outcome).map(call => call.toolCall.id));
        await runtime.commit(async tx => {
          const children: TaskId[] = [];
          for (const prepared of state.calls) {
            if (prepared.outcome) continue;
            prepared.taskId = await tools.create(tx, runtime.taskId, assistant, prepared.toolCall, prepared.args);
            children.push(prepared.taskId);
          }
          state.cursor = 0;
          await host.commit(tx);
          return children.length
            ? { status: 'waiting', on: children, policy: 'allSettled', checkpoint: checkpoint(state, 'wait-tools', host) }
            : { status: 'running', checkpoint: checkpoint(state, 'deliver-tools', host) };
        }, context);
      }),
      'wait-tools': execute(async (state, host, runtime, context) => {
        for (const call of state.calls) {
          if (!call.taskId) continue;
          call.outcome = await toolOutcome(call.taskId, call.toolCall, runtime, context);
        }
        await advance(state, 'deliver-tools', host, runtime, context);
      }),
      'deliver-tools': execute(async (state, host, runtime, context) => {
        if (state.parallel) {
          const call = state.calls[state.cursor++];
          await deliver(call.outcome!, state, host);
          await advance(state, state.cursor < state.calls.length ? 'deliver-tools' : 'finish', host, runtime, context);
        } else {
          const call = state.calls[state.cursor - 1];
          call.outcome = await toolOutcome(call.taskId!, call.toolCall, runtime, context);
          await deliver(call.outcome, state, host);
          await afterSequential(state, host, runtime, context);
        }
      }),
      finish: execute(async (state, host, runtime, context) => {
        const added = state.calls.flatMap(call => call.outcome?.control?.addTools ?? []);
        if (added.length) host.activateTools?.(added);
        state.lastTurn = { message: state.message!, toolResults: state.toolResults };
        const decision = await host.config.finishTurn?.(turn(state, host), signal(host, runtime));
        await host.emit({ type: 'turn_end', message: state.message!, toolResults: state.toolResults });
        const handoff = [...state.calls].reverse().find(call => call.outcome?.control?.handoff !== undefined)
          ?.outcome?.control?.handoff;
        if (handoff !== undefined) {
          const message: UserMessage = { role: 'user', content: handoff, timestamp: runtime.now() };
          if (!host.handoff) throw new Error('The durable coding host cannot apply a tool handoff');
          host.handoff(message);
          state.newMessages.push(message);
        }
        const stop = state.message!.stopReason;
        if (decision?.action === 'end' || stop === 'error' || stop === 'aborted') {
          await advance(state, 'settle', host, runtime, context);
          return;
        }
        state.pending = await host.config.getSteeringMessages?.() ?? [];
        const moreTools = state.calls.length > 0 && !shouldTerminateToolBatch(state.calls.flatMap(call => call.outcome ? [call.outcome] : []));
        if (!moreTools && !state.pending.length) state.pending = await host.config.getFollowUpMessages?.() ?? [];
        const next = moreTools || state.pending.length > 0 || decision?.action === 'continue';
        await advance(state, next ? 'prepare' : 'settle', host, runtime, context);
      }),
      settle: execute(async (state, host, runtime, context) => {
        await host.emit({ type: 'agent_end', messages: state.newMessages });
        await runtime.commit(async tx => {
          await host.commit(tx);
          return { status: 'terminal', outcome: { status: 'completed', result: stored(state.newMessages) } };
        }, context);
      }),
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
    },
  });
}

function signal(host: LoopExecution, runtime: Runtime): AbortSignal {
  return host.signal ? AbortSignal.any([host.signal, runtime.signal]) : runtime.signal;
}

function applyUpdate(update: AgentLoopTurnUpdate, host: LoopExecution) {
  if (update.context) host.context = update.context;
  host.config = {
    ...host.config, model: update.model ?? host.config.model,
    reasoning: update.thinkingLevel === undefined ? host.config.reasoning
      : update.thinkingLevel === 'off' ? undefined : update.thinkingLevel,
  };
}

function turn(state: LoopCheckpoint, host: LoopExecution): PrepareNextTurnContext {
  return { ...state.lastTurn!, context: host.context, newMessages: state.newMessages };
}

function stored<T>(value: T): T {
  // This is the native protocol to JSON persistence boundary. Undefined optional fields are omitted.
  return copyJson(value, { omitUndefinedProperties: true }) as T;
}

function checkpoint(state: LoopCheckpoint, phase: Phase, host: LoopExecution, inFlight?: Phase): LoopCheckpoint {
  Object.assign(state, {
    phase, messages: host.context.messages,
    tools: host.context.tools?.map(tool => tool.name) ?? [],
    model: { provider: host.config.model.provider, modelId: host.config.model.id },
    reasoning: host.config.reasoning,
    revision: state.revision + 1,
    inFlight,
  });
  state.messageReferences = host.captureMessageReferences?.(state);
  return stored(state);
}

async function advance(
  state: LoopCheckpoint, phase: Phase, host: LoopExecution, runtime: Runtime, context: Context,
) {
  await runtime.commit(async tx => {
    await host.commit(tx);
    return { status: 'running', checkpoint: checkpoint(state, phase, host) };
  }, context);
}

async function deliver(outcome: AgentToolCallOutcome, state: LoopCheckpoint, host: LoopExecution) {
  const message = createToolResultMessage(outcome);
  await emitToolResultMessage(message, host.emit);
  state.toolResults.push(message);
  host.context.messages.push(message);
  state.newMessages.push(message);
}

async function afterSequential(state: LoopCheckpoint, host: LoopExecution, runtime: Runtime, context: Context) {
  if (signal(host, runtime).aborted) state.calls = state.calls.slice(0, state.cursor);
  const phase = state.cursor < state.calls.length ? 'preflight' : 'finish';
  await advance(state, phase, host, runtime, context);
}

async function toolOutcome(
  id: TaskId<AgentToolCallOutcome>, call: AgentToolCall, runtime: Runtime, context: Context,
): Promise<AgentToolCallOutcome> {
  const [outcome] = await runtime.outcomes([id], context);
  if (outcome.status !== 'completed' && outcome.status !== 'aborted' &&
    !(outcome.status === 'failed' && (outcome.result as CodingToolTaskResult | undefined)?.hostExecutionFailed)) {
    throw new Error('error' in outcome && outcome.error ? outcome.error.message : `Tool task ${outcome.status}`);
  }
  if (outcome.result) return outcome.result;
  return {
    toolCall: call, result: createErrorToolResult(`Tool task ${outcome.status}`),
    isError: true,
  };
}
