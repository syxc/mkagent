/** Nested and SDK tool calls use the same owned durable execution task as model calls. */
import { copyJson } from '@earendil-works/chord';
import {
  defineTask, type ConversationId, type TaskId, type TaskRuntime, type Tx,
} from '@earendil-works/pi-durable';
import type { AgentToolCall, AgentToolCallOutcome } from '../agent-runtime.ts';
import type { RunToolCallOptions } from '../durable-loop.ts';
import { createErrorToolResult, prepareToolCall } from '../native-operations.ts';
import type { ToolScheduler } from './run-task.ts';

export interface SingleToolInput {
  toolCall: AgentToolCall;
  bindingKey: string;
}

type Checkpoint =
  | { phase: 'prepare' }
  | { phase: 'preparing' }
  | { phase: 'collect'; child: TaskId<AgentToolCallOutcome> };

export interface SingleToolExecution {
  options: RunToolCallOptions;
  commit(tx: Tx): Promise<void>;
  phase<T>(runtime: TaskRuntime<SingleToolInput, Checkpoint, AgentToolCallOutcome, object>, work: () => Promise<T>): Promise<T>;
}

export function createSingleToolTask(
  resolve: (input: SingleToolInput, owner: TaskId, conversation: ConversationId) => SingleToolExecution,
  tools: ToolScheduler,
) {
  return defineTask<SingleToolInput, Checkpoint, AgentToolCallOutcome>({
    name: 'pi.coding.call', version: 1,
    initial: () => ({ phase: 'prepare' }),
    phases: {
      prepare: async (task, runtime, context) => {
        const host = resolve(task.input, runtime.taskId, runtime.conversationId);
        await host.phase(runtime, async () => {
          await runtime.commit(async tx => {
            await host.commit(tx);
            return { status: 'running', checkpoint: { phase: 'preparing' } };
          }, context);
          const options = host.options;
          const signal = options.signal ? AbortSignal.any([options.signal, runtime.signal]) : runtime.signal;
          const prepared = await prepareToolCall(options.context, options.assistantMessage,
            task.input.toolCall, options, signal, options.tools);
          await runtime.commit(async tx => {
            await host.commit(tx);
            if (prepared.kind === 'immediate') return {
              status: 'terminal',
              outcome: { status: 'completed', result: {
                toolCall: task.input.toolCall, result: prepared.result, isError: prepared.isError,
              } },
            };
            const child = await tools.create(tx, runtime.taskId, options.assistantMessage, task.input.toolCall,
              copyJson(prepared.args, { omitUndefinedProperties: true }));
            return { status: 'waiting', on: [child], policy: 'allSettled', checkpoint: { phase: 'collect', child } };
          }, context);
        });
      },
      preparing: async (task, runtime, context) => {
        // Permission hooks may have side effects. An uncertain preflight is not invoked twice.
        await runtime.commit(() => ({
          status: 'terminal', outcome: { status: 'completed', result: {
            toolCall: task.input.toolCall, isError: true,
            result: createErrorToolResult('Tool preflight was interrupted; it was not invoked again'),
          } },
        }), context);
      },
      collect: async (task, runtime, context) => {
        const [outcome] = await runtime.outcomes([task.state.checkpoint.child], context);
        if (outcome.status !== 'completed' && outcome.status !== 'aborted') {
          throw new Error('error' in outcome && outcome.error ? outcome.error.message : `Tool task ${outcome.status}`);
        }
        const result = outcome.result ?? {
          toolCall: task.input.toolCall, result: createErrorToolResult('Operation aborted'), isError: true,
        };
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: {
        status: 'aborted', result: {
          toolCall: task.input.toolCall, result: createErrorToolResult('Operation aborted'), isError: true,
        },
      } }), context);
    },
  });
}
