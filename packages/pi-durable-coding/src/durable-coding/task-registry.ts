/** One set of task definitions routes callbacks to their conversation's live binding. */
import { copyJson } from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord';
import type { ConversationId, Registry, TaskId, ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable';
import { nativeCodemodeForwardTool, type NativeCodemodeForwardInput } from './codemode-forward.ts';
import { createCodingRunTask, type LoopExecution } from './run-task.ts';
import { createCodingToolTask, type CodingToolTaskBindings, type CodingToolTaskInput } from './tool-task.ts';
import { createSingleToolTask, type SingleToolExecution, type SingleToolInput } from './single-tool-task.ts';
import { createCodingSessionTask, type CodingSessionTaskBindings } from './session-task.ts';
import { createCodingSummaryTask, type CodingSummaryBindings } from './summary-task.ts';

export interface CodingTaskBinding {
  execution(): LoopExecution;
  tool(input: CodingToolTaskInput): CodingToolTaskBindings;
  call(input: SingleToolInput, owner: TaskId): SingleToolExecution;
  session(): CodingSessionTaskBindings;
  summary(): CodingSummaryBindings;
  forward(input: NativeCodemodeForwardInput, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult>;
}

export interface CodingTasks {
  run: ReturnType<typeof createCodingRunTask>;
  call: ReturnType<typeof createSingleToolTask>;
  session: ReturnType<typeof createCodingSessionTask>;
  summary: ReturnType<typeof createCodingSummaryTask>;
  bind(conversation: ConversationId, binding: CodingTaskBinding): () => void;
}

const registries = new WeakMap<Registry, CodingTasks>();

/** Install stable definitions once, including when several Agents share a Harness. */
export function codingTasks(registry: Registry): CodingTasks {
  const installed = registries.get(registry);
  if (installed) return installed;
  const bindings = new Map<ConversationId, CodingTaskBinding>();
  const resolve = (id: ConversationId) => {
    const binding = bindings.get(id);
    if (!binding) throw new Error(`Coding callbacks have not been bound for conversation ${id}`);
    return binding;
  };
  const tool = createCodingToolTask((id, input) => resolve(id).tool(input));
  const scheduler = {
    create: (tx, owner, assistantMessage, toolCall, args) => tx.createTask(tool, {
      assistantMessage, toolCall, args: copyJson(args, { omitUndefinedProperties: true }), parentTaskId: owner,
    }, { ownership: { kind: 'task', taskId: owner } }),
  } satisfies Parameters<typeof createCodingRunTask>[1];
  const run = createCodingRunTask(id => resolve(id).execution(), scheduler);
  const call = createSingleToolTask((input, owner, conversation) => resolve(conversation).call(input, owner), scheduler);
  const session = createCodingSessionTask(id => resolve(id).session());
  const summary = createCodingSummaryTask(id => resolve(id).summary());
  registry.install({
    name: 'pi.coding', tasks: [session, run, call, tool, summary],
    tools: [nativeCodemodeForwardTool(resolve)],
  });
  const tasks: CodingTasks = {
    run, call, session, summary,
    bind: (conversation, binding) => {
      if (bindings.has(conversation)) throw new Error(`Coding conversation ${conversation} already has an Agent`);
      bindings.set(conversation, binding);
      return () => {
        if (bindings.get(conversation) === binding) bindings.delete(conversation);
      };
    },
  };
  registries.set(registry, tasks);
  return tasks;
}
