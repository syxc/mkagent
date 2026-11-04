// Executes one preflighted native tool without changing the model transcript.
import { copyJson, type Context } from '@earendil-works/chord';
import type { AssistantMessage, JsonValue } from '@earendil-works/pi-ai';
import {
  defineTask, type ConversationId, type NextTaskState, type PhaseHandler, type RunningTask,
  type Task, type TaskId, type TaskRuntime, type Tx, type ToolControl,
} from '@earendil-works/pi-durable';
import type {
  AfterToolCallResult, AgentContext, AgentEvent, AgentLoopConfig, AgentTool,
  AgentToolCall, AgentToolResult,
} from '../agent-runtime.ts';
import type { HostControlledToolResult } from '../host-tool-controls.ts';

/** Arguments have already passed preparation, schema validation, and permission hooks. */
export interface CodingToolTaskInput {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: JsonValue;
  parentTaskId?: TaskId;
}

/** Complete native outcome; the owning run delivers tool-result messages in source order. */
export interface CodingToolTaskResult {
  toolCall: AgentToolCall;
  result: AgentToolResult<unknown>;
  isError: boolean;
  durationMs?: number;
  executionArguments?: JsonValue;
  control?: ToolControl;
}

/** Durable boundaries distinguish unknown effects and unknown hook/event delivery. */
export type CodingToolTaskCheckpoint =
  | { phase: 'call' }
  | { phase: 'execute'; replay: 'safe' | 'never' }
  | { phase: 'finalize'; outcome: CodingToolTaskResult }
  | { phase: 'after'; outcome: CodingToolTaskResult }
  | { phase: 'deliver'; outcome: CodingToolTaskResult }
  | { phase: 'emit'; outcome: CodingToolTaskResult };

export type CodingToolTaskRuntime = TaskRuntime<CodingToolTaskInput, CodingToolTaskCheckpoint, CodingToolTaskResult, object>;

/** Invocation scope lets the host bind nested tooling to the current durable task. */
export interface CodingToolInvocation {
  input: CodingToolTaskInput;
  runtime: CodingToolTaskRuntime;
  context: Context;
}

/** Live host services are resolved for the task's conversation at each durable boundary. */
export interface CodingToolTaskBindings {
  getTool(name: string): AgentTool<any> | undefined;
  context(): AgentContext;
  afterToolCall?: AgentLoopConfig['afterToolCall'];
  emit(event: AgentEvent): Promise<void>;
  withInvocation?<T>(invocation: CodingToolInvocation, run: () => Promise<T>): Promise<T>;
  /** Flush staged native metadata through this transaction; never run tools or user hooks here. */
  commit?(tx: Tx): Promise<void>;
  finalArguments?(scope: CodingToolInvocation): Promise<unknown>;
}

export type ResolveCodingToolBindings = (
  conversationId: ConversationId,
  input: CodingToolTaskInput,
) => CodingToolTaskBindings | Promise<CodingToolTaskBindings>;

type OutcomeCheckpoint = Extract<CodingToolTaskCheckpoint, { phase: 'finalize' | 'deliver' }>;
type Phase = CodingToolTaskCheckpoint['phase'];
type ScopedPhase<P extends Phase> = (
  task: RunningTask<CodingToolTaskInput, Extract<CodingToolTaskCheckpoint, { phase: P }>, CodingToolTaskResult>,
  runtime: CodingToolTaskRuntime,
  bindings: CodingToolTaskBindings,
  context: Context,
) => Promise<void>;

/** Creates the stable pi.coding.tool v1 definition; install it in the Harness registry. */
export function createCodingToolTask(
  resolveBindings: ResolveCodingToolBindings,
): Task<CodingToolTaskInput, CodingToolTaskCheckpoint, CodingToolTaskResult, object> {
  // A run cannot commit after an abort mark. Hand its settled result to the joined abort invocation;
  // this is only a same-process handoff, never evidence used to replay an effect after a crash.
  const cancelling = new Map<TaskId, OutcomeCheckpoint>();
  function scoped<P extends Phase>(
    handler: ScopedPhase<P>,
  ): PhaseHandler<CodingToolTaskInput, Extract<CodingToolTaskCheckpoint, { phase: P }>, CodingToolTaskCheckpoint, CodingToolTaskResult, object> {
    return async (task, runtime, context) => {
      try {
        const bindings = await resolveBindings(runtime.conversationId, task.input);
        const run = () => handler(task, runtime, bindings, context);
        if (bindings.withInvocation) await bindings.withInvocation({ input: task.input, runtime, context }, run);
        else await run();
      } finally {
        // An abort invocation consumes its volatile handoff even if resolution or persistence fails.
        if (task.abortRequested) cancelling.delete(task.id);
      }
    };
  }
  return defineTask<CodingToolTaskInput, CodingToolTaskCheckpoint, CodingToolTaskResult>({
    name: 'pi.coding.tool',
    version: 1,
    initial: () => ({ phase: 'call' }),
    phases: {
      call: scoped<'call'>(async (task, runtime, bindings, context) => {
        const tool = bindings.getTool(task.input.toolCall.name);
        if (!tool) {
          await checkpoint(runtime, bindings, { phase: 'deliver', outcome: failure(task.input, `Tool ${task.input.toolCall.name} not found`) }, context);
          return;
        }
        // Continue in this invocation: entering execute as a phase always means recovery.
        await checkpoint(runtime, bindings, { phase: 'execute', replay: tool.replay ?? 'never' }, context);
        await execute(tool, task.input, bindings, runtime, cancelling, context);
      }),
      execute: scoped<'execute'>(async (task, runtime, bindings, context) => {
        const tool = bindings.getTool(task.input.toolCall.name);
        if (task.state.checkpoint.replay === 'safe' && tool?.replay === 'safe') {
          await execute(tool, task.input, bindings, runtime, cancelling, context);
          return;
        }
        await checkpoint(runtime, bindings, {
          phase: 'finalize',
          outcome: failure(task.input, `Tool ${task.input.toolCall.name} was interrupted and may have partially run; it was not executed again`),
        }, context);
      }),
      finalize: scoped<'finalize'>(async (task, runtime, bindings, context) => {
        const outcome = await finalize(task.input, task.state.checkpoint.outcome, bindings, runtime, context);
        await persistOutcome(runtime, bindings, { phase: 'deliver', outcome }, cancelling, context);
      }),
      after: scoped<'after'>(async (task, runtime, bindings, context) => {
        await checkpoint(runtime, bindings, {
          phase: 'deliver',
          outcome: failure(task.input, `afterToolCall for ${task.input.toolCall.name} was interrupted; the hook was not invoked again`, task.state.checkpoint.outcome.durationMs),
        }, context);
      }),
      deliver: scoped<'deliver'>(async (task, runtime, bindings, context) => {
        const outcome = task.state.checkpoint.outcome;
        await checkpoint(runtime, bindings, { phase: 'emit', outcome }, context);
        try {
          await emitEnd(bindings, outcome);
        } catch (error) {
          await failDelivery(runtime, bindings, outcome, error, context);
          return;
        }
        await commitState(runtime, bindings, { status: 'terminal', outcome: { status: 'completed', result: outcome } }, context);
      }),
      emit: scoped<'emit'>(async (task, runtime, bindings, context) => {
        // An arbitrary event sink cannot be atomically committed with durable state.
        await failDelivery(runtime, bindings, task.state.checkpoint.outcome,
          new Error(`tool_execution_end delivery for ${task.input.toolCall.name} was interrupted; delivery is uncertain`), context);
      }),
    },
    abort: scoped<Phase>(async (task, runtime, bindings, context) => {
      const state = task.state.checkpoint;
      const settled = cancelling.get(task.id);
      cancelling.delete(task.id);
      // The scheduler joins execute() and its pending progress before this handler starts.
      let outcome = settled?.outcome ?? (
        state.phase === 'deliver' || state.phase === 'emit'
          ? state.outcome
          : failure(task.input, 'Operation aborted', 'outcome' in state ? state.outcome.durationMs : undefined)
      );
      if (settled?.phase !== 'deliver' && (state.phase === 'execute' || state.phase === 'finalize')) {
        outcome = await finalize(task.input, state.phase === 'finalize' ? state.outcome : outcome, bindings, runtime, context);
      }
      if (state.phase !== 'emit') {
        await checkpoint(runtime, bindings, { phase: 'deliver', outcome }, context);
        await checkpoint(runtime, bindings, { phase: 'emit', outcome }, context);
        try {
          await emitEnd(bindings, outcome);
        } catch (error) {
          await failDelivery(runtime, bindings, outcome, error, context);
          return;
        }
      }
      await commitState(runtime, bindings, {
        status: 'terminal',
        outcome: { status: 'aborted', result: outcome },
      }, context);
    }),
  });
}

async function checkpoint(
  runtime: CodingToolTaskRuntime, bindings: CodingToolTaskBindings, value: CodingToolTaskCheckpoint, context: Context,
): Promise<void> {
  await commitState(runtime, bindings, { status: 'running', checkpoint: value }, context);
}

async function commitState(
  runtime: CodingToolTaskRuntime, bindings: CodingToolTaskBindings,
  state: NextTaskState<CodingToolTaskCheckpoint, CodingToolTaskResult>, context: Context,
): Promise<void> {
  await runtime.commit(async tx => {
    await bindings.commit?.(tx);
    return state;
  }, context);
}

async function persistOutcome(
  runtime: CodingToolTaskRuntime, bindings: CodingToolTaskBindings,
  value: OutcomeCheckpoint, cancelling: Map<TaskId, OutcomeCheckpoint>,
  context: Context,
): Promise<void> {
  try {
    await checkpoint(runtime, bindings, value, context);
    cancelling.delete(runtime.taskId);
  } catch (error) {
    if (runtime.signal.aborted) cancelling.set(runtime.taskId, value);
    throw error;
  }
}

async function execute(
  tool: AgentTool<any>, input: CodingToolTaskInput, bindings: CodingToolTaskBindings,
  runtime: CodingToolTaskRuntime, cancelling: Map<TaskId, OutcomeCheckpoint>, context: Context,
): Promise<void> {
  let acceptingUpdates = true;
  let updates = Promise.resolve();
  let deliveryFailure: { error: unknown } | undefined;
  let durationMs: number | undefined;
  let outcome: CodingToolTaskResult;
  const args = structuredClone(input.args);
  try {
    // A tool must settle its own cleanup; racing execute() against abort would detach effects.
    runtime.signal.throwIfAborted();
    const run = async () => {
      const startedAt = performance.now();
      try {
        return await tool.execute(input.toolCall.id, args, runtime.signal, partialResult => {
          if (!acceptingUpdates) return;
          // Native update callbacks return void, so explicitly join and serialize their deliveries.
          updates = updates.then(async () => {
            try {
              await bindings.emit({
                type: 'tool_execution_update',
                toolCallId: input.toolCall.id,
                toolName: input.toolCall.name,
                args: input.toolCall.arguments,
                partialResult,
              });
            } catch (error) {
              deliveryFailure ??= { error };
            }
          });
        });
      } finally {
        acceptingUpdates = false;
        durationMs = Math.round(performance.now() - startedAt);
      }
    };
    const { durableHostControl: control, ...result } = await run() as HostControlledToolResult;
    outcome = durableOutcome({
      toolCall: input.toolCall, result, isError: result.isError === true, durationMs, executionArguments: args,
      ...(control === undefined ? {} : { control }),
    });
  } catch (error) {
    outcome = { ...failure(input, errorMessage(error), durationMs), executionArguments: args };
  } finally {
    acceptingUpdates = false;
  }
  await updates;
  // Keep the native effect's output, but fail the task if its required event delivery failed.
  if (deliveryFailure) {
    await failDelivery(runtime, bindings, outcome, deliveryFailure.error, context);
    return;
  }
  await persistOutcome(runtime, bindings, { phase: 'finalize', outcome }, cancelling, context);
}

async function failDelivery(
  runtime: CodingToolTaskRuntime, bindings: CodingToolTaskBindings,
  result: CodingToolTaskResult, error: unknown, context: Context,
): Promise<void> {
  await commitState(runtime, bindings, {
    status: 'terminal', outcome: { status: 'failed', error: { message: errorMessage(error) }, result },
  }, context);
}

async function finalize(
  input: CodingToolTaskInput, executed: CodingToolTaskResult, bindings: CodingToolTaskBindings,
  runtime: CodingToolTaskRuntime, context: Context,
): Promise<CodingToolTaskResult> {
  const hook = bindings.afterToolCall;
  if (!hook) return executed;
  // A hook can itself mutate external state. Its uncertain invocation is never replayed.
  await checkpoint(runtime, bindings, { phase: 'after', outcome: executed }, context);
  try {
    const override = await hook({
      assistantMessage: input.assistantMessage,
      toolCall: input.toolCall,
      args: await bindings.finalArguments?.({ input, runtime, context }) ?? executed.executionArguments ?? input.args,
      result: executed.result,
      isError: executed.isError,
      context: bindings.context(),
    }, runtime.signal);
    return durableOutcome(mergeAfter(executed, override));
  } catch (error) {
    return failure(input, errorMessage(error), executed.durationMs);
  }
}

function durableOutcome(outcome: CodingToolTaskResult): CodingToolTaskResult {
  // Native details are unknown; the persistence boundary accepts finite JSON only.
  return copyJson(outcome, { omitUndefinedProperties: true }) as unknown as CodingToolTaskResult;
}

function failure(input: CodingToolTaskInput, message: string, durationMs?: number): CodingToolTaskResult {
  return {
    toolCall: input.toolCall,
    result: { content: [{ type: 'text', text: message }], details: {} },
    isError: true,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeAfter(
  executed: CodingToolTaskResult, override: AfterToolCallResult | undefined,
): CodingToolTaskResult {
  if (!override) return executed;
  const structuredContent = override.structuredContent ?? (override.content ? undefined : executed.result.structuredContent);
  const result = {
    ...executed.result,
    content: override.content ?? executed.result.content,
    details: override.details ?? executed.result.details,
    usage: override.usage ?? executed.result.usage,
    terminate: override.terminate ?? executed.result.terminate,
  };
  if (structuredContent === undefined) delete result.structuredContent;
  else result.structuredContent = structuredContent;
  return { ...executed, result, isError: override.isError ?? executed.isError };
}

async function emitEnd(bindings: CodingToolTaskBindings, outcome: CodingToolTaskResult): Promise<void> {
  await bindings.emit({
    type: 'tool_execution_end',
    toolCallId: outcome.toolCall.id,
    toolName: outcome.toolCall.name,
    result: outcome.result,
    isError: outcome.isError,
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
  });
}
