// Admit host nested calls into the official durable ToolTask graph.
import { copyJson, type Context, type Draft, type JsonValue } from '@earendil-works/chord';
import {
  LiveDoc, NestedCallDoc, ToolTask, type JsonObject, type NestedToolExecutionResult,
  type NestedToolSlot, type TaskId, type ToolExecutionApi, type ToolTaskInput, type ToolTaskResult, type Tx,
} from '@earendil-works/pi-durable';
import type { CodingToolTaskRuntime } from './durable-coding/tool-task.ts';

/** Official nested-call admission and result semantics, bound to the calling coding task. */
export function nestedHostTools(
  runtime: CodingToolTaskRuntime, callId: string, replaySafe: boolean,
  commit: ToolExecutionApi['commit'], context: Context,
) {
  // Ported from pi-durable f9a2636 packages/durable/src/harness/tool.ts:
  // startNestedCall, checkKey, fallbackResult, and settle's owned-call cleanup.
  // Policy, hooks, validation, progress, and usage remain in the public ToolTask.
  let sequence = 0;
  let madeNested: Promise<unknown> | undefined;
  const admissions: Promise<TaskId<ToolTaskResult>>[] = [];

  const executeTool: ToolExecutionApi['executeTool'] = async (name, args, callContext, options = {}) => {
    const key = options.key ?? String(++sequence);
    if (options.key !== undefined &&
      (key === '' || key.includes('/') || key === '__proto__' || /^[1-9][0-9]*$/.test(key))) {
      throw new Error(`Nested call key ${JSON.stringify(key)} must be non-empty, without "/", not "__proto__", and not a positive integer`);
    }
    madeNested ??= runtime.memo('pi.tool.madeNestedCalls', true, callContext).catch(error => {
      madeNested = undefined;
      throw error;
    });
    const admission = madeNested.then(() => admit(name, args, key, options.progress, callContext));
    admissions.push(admission);
    const id = await admission;
    const settled = await runtime.waitForTask(id, callContext);
    const stored = (await runtime.snapshot(NestedCallDoc, runtime.taskId, key, callContext))?.result;
    if (stored !== undefined) return copyJson(stored) as unknown as NestedToolExecutionResult;
    const outcome = settled.state.outcome;
    const message = outcome.status === 'faulted' ? `Tool ${name} failed: ${outcome.error.message}`
      : outcome.status === 'orphaned' ? `Tool ${name} could not resume: ${outcome.reason}`
      : `Tool ${name} ended without a result`;
    return { taskId: id, isError: true, diagnostics: [{ severity: 'error', code: outcome.status, message }] };
  };

  async function admit(
    name: string, args: JsonObject, key: string, progress: boolean | undefined, callContext: Context,
  ): Promise<TaskId<ToolTaskResult>> {
    const call = {
      type: 'toolCall' as const, id: `${callId}/${key}`, name,
      arguments: copyJson(args, { omitUndefinedProperties: true }) as JsonObject,
    };
    let replayed = false;
    const id = await commit(async tx => {
      const state = await tx.doc(NestedCallDoc, runtime.taskId, key, null);
      if (state.taskId !== undefined) {
        const record = await tx.task(state.taskId);
        const input = record?.input as ToolTaskInput | undefined;
        // A durable replay key must refer to exactly this owner's admitted call.
        if (record?.kind !== ToolTask.definition.name || record.owner !== runtime.taskId ||
          record.conversationId !== runtime.conversationId || input?.kind !== 'nested' ||
          input.parent !== runtime.taskId || input.parentCallId !== callId || input.key !== key ||
          input.call.id !== call.id || input.call.name !== name ||
          !jsonEqual(input.call.arguments as JsonValue, call.arguments as JsonValue)) {
          throw new Error(`Nested call ${call.id} was already made with another tool or other arguments`);
        }
        replayed = state.result !== undefined;
        return state.taskId as TaskId<ToolTaskResult>;
      }
      const input: ToolTaskInput = {
        kind: 'nested', parent: runtime.taskId, parentCallId: callId, key, call,
        ...(progress === false ? { progress: false } : {}),
      };
      const created = await tx.createTask(ToolTask, input, {
        ownership: { kind: 'task', taskId: runtime.taskId }, abandonOnRestart: !replaySafe,
      });
      state.taskId = created;
      const live = await tx.doc(LiveDoc, runtime.conversationId);
      live.nestedTools ??= [];
      const slot: NestedToolSlot = {
        callId: call.id, parentCallId: callId, parentTaskId: runtime.taskId,
        name, taskId: created, arguments: call.arguments, status: 'pending',
      };
      live.nestedTools.push(slot as Draft<NestedToolSlot>);
      return created;
    }, callContext);
    if (replayed) callContext.telemetry.addEvent('pi.durable.replay', { 'tool.name': name });
    return id;
  }

  return {
    executeTool,
    async close() {
      await Promise.allSettled(admissions);
      // Include calls an earlier safe attempt admitted but this attempt never reattached to.
      const owned = (await runtime.ownedTasks(context)).filter(record =>
        record.kind === ToolTask.definition.name && (record.input as ToolTaskInput).kind === 'nested');
      await Promise.all(owned.map(record => runtime.abortOwned(record.id, context)));
      if (await runtime.memo('pi.tool.madeNestedCalls', context)) {
        await commit(async (tx: Tx) => {
          const live = await tx.doc(LiveDoc, runtime.conversationId);
          if (!live.nestedTools) return;
          const removed = new Set<TaskId>([runtime.taskId]);
          for (const slot of live.nestedTools) {
            if (removed.has(slot.parentTaskId)) removed.add(slot.taskId);
          }
          for (let index = live.nestedTools.length - 1; index >= 0; index--) {
            if (removed.has(live.nestedTools[index].parentTaskId)) live.nestedTools.splice(index, 1);
          }
          if (!live.nestedTools.length) delete live.nestedTools;
        }, context);
      }
    },
  };
}

function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]));
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}
