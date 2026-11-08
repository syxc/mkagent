// Delegate host execution to the public ToolTask phases while retaining the native task and journal owner.
import { isDeepStrictEqual } from 'node:util';
import { copyJson, type Context, type JsonRepresentation, type JsonValue } from '@earendil-works/chord';
import {
  defineDoc, LiveDoc, NestedCallDoc, ToolTask,
  type JsonObject, type NestedToolExecutionResult, type RunningTask, type TaskId, type TaskRuntime, type ToolDiagnostic,
  type ToolExecutionResult, type ToolHooks, type ToolRegistration,
  type ToolTaskCheckpoint, type ToolTaskInput, type ToolTaskResult,
} from '@earendil-works/pi-durable';
import type { AgentToolUpdateCallback } from './agent-runtime.ts';
import { currentCodingToolInvocation } from './durable-coding/engine.ts';
import type { CodingToolTaskRuntime } from './durable-coding/tool-task.ts';
import type { HostControlledToolResult } from './host-tool-controls.ts';
import { isHostUsageAccounted, markHostUsageAccounted, withoutHostUsageMarker } from './host-tool-usage.ts';

type Packet = {
  result: HostControlledToolResult;
  native?: true;
  diagnostics?: readonly ToolDiagnostic[];
  usageAccounted?: true;
};
type StoredExecution = {
  version: number;
  input: ToolTaskInput;
  checkpoint: ToolTaskCheckpoint;
  result?: Packet;
  failure?: { message: string };
};
type Runtime = TaskRuntime<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>;
type Scope = ReturnType<typeof currentCodingToolInvocation>;
// A slash cannot collide with a public executeTool() key.
const resultKey = 'mkagent/host-result';
export const hostToolExecution = Symbol('mkagent.host-tool-execution');
const running = new WeakSet<CodingToolTaskRuntime>();

const HostExecutionDoc = defineDoc<{ execution?: JsonRepresentation<StoredExecution> }>({
  kind: 'mkagent.coding.host-tool-execution', version: 1, scope: 'task',
  initial: () => ({}), checkpointWhen: () => false,
});

/** An existing SDK intent must be resolved by the SDK even when its tool is unsafe now. */
export async function hasHostToolExecution(runtime: CodingToolTaskRuntime, context: Context): Promise<boolean> {
  return (await runtime.snapshot(HostExecutionDoc, runtime.taskId, context))?.execution !== undefined;
}

/** A completed SDK result survives a crash before the native outcome checkpoint. */
export async function completedHostToolResult(
  runtime: CodingToolTaskRuntime, context: Context,
): Promise<HostControlledToolResult | undefined> {
  const packet = (await runtime.snapshot(HostExecutionDoc, runtime.taskId, context))?.execution?.result;
  return packet && restore(packet as unknown as Packet);
}

/** Preserve SDK failure semantics when the native owner eventually settles. */
export async function failedHostToolExecution(runtime: CodingToolTaskRuntime, context: Context) {
  return (await runtime.snapshot(HostExecutionDoc, runtime.taskId, context))?.execution?.failure;
}

/** The joined native abort invocation lets the SDK settle slots and owned nested calls. */
export async function abortHostToolExecution(runtime: CodingToolTaskRuntime, context: Context): Promise<void> {
  const stored = (await runtime.snapshot(HostExecutionDoc, runtime.taskId, context))?.execution;
  if (!stored || stored.result || stored.input.kind !== 'nested') return;
  await executeHostToolTask({
    name: stored.input.call.name, description: '', parameters: {},
    execute: async () => { throw new Error('An abort must not execute the host tool'); },
  }, stored.input.call.arguments, currentCodingToolInvocation(), context, result => ({
    result: { content: result.output ?? [], details: result.details, isError: result.isError },
  }), undefined, true);
}

/** The SDK owns execution, output pacing, nested calls, replay policy, and owned-call cleanup. */
export async function executeHostToolTask(
  tool: ToolRegistration<any>, args: JsonValue, scope: Scope, context: Context,
  project: (result: ToolExecutionResult) => Packet,
  update?: AgentToolUpdateCallback<unknown>, abort = false,
): Promise<HostControlledToolResult> {
  if (running.has(scope.runtime)) throw new Error('Host execution is already running for this coding invocation');
  running.add(scope.runtime);
  try { return await runHostToolTask(tool, args, scope, context, project, update, abort); }
  finally { running.delete(scope.runtime); }
}

async function runHostToolTask(
  tool: ToolRegistration<any>, args: JsonValue, scope: Scope, context: Context,
  project: (result: ToolExecutionResult) => Packet,
  update: AgentToolUpdateCallback<unknown> | undefined, abort: boolean,
): Promise<HostControlledToolResult> {
  const { runtime, flush } = scope;
  let stored = (await runtime.snapshot(HostExecutionDoc, runtime.taskId, context))?.execution as unknown as StoredExecution | undefined;
  const call = { type: 'toolCall' as const, id: scope.input.toolCall.id, name: tool.name,
    arguments: copyJson(args, { omitUndefinedProperties: true }) as JsonObject };
  if (stored && (stored.input.kind !== 'nested' || !isDeepStrictEqual(stored.input.call, call))) {
    throw new Error('Host execution belongs to another tool or other arguments');
  }
  if (stored?.result) return restore(stored.result);
  if (!stored) {
    stored = {
      version: ToolTask.definition.version,
      input: {
        kind: 'nested', parent: runtime.taskId, parentCallId: scope.input.toolCall.id, key: resultKey,
        call,
      },
      checkpoint: { phase: 'call' },
    };
  } else if (stored.version !== ToolTask.definition.version) {
    if (stored.version > ToolTask.definition.version || !ToolTask.definition.migrate) {
      throw new Error(`Unsupported host ToolTask version ${stored.version}`);
    }
    const migrated = ToolTask.definition.migrate(
      copyJson(stored.input as unknown as JsonValue), copyJson(stored.checkpoint as unknown as JsonValue), stored.version,
    );
    stored = { ...stored, ...migrated, version: ToolTask.definition.version };
  }
  let execution = stored;
  let previousProgress = '';
  // The nested receipt omits control and uses details for this private native envelope.
  // Its schema-less value retains the SDK's bounded host output and truncation diagnostics.
  const delegated: ToolRegistration<any> = {
    ...tool, prepareArguments: undefined, structuredOutputSchema: undefined,
    replay: scope.replay === 'safe' && tool.replay === 'safe' ? 'safe' : 'unsafe',
  };
  const sdk: Runtime = {
    ...runtime,
    taskId: runtime.taskId as unknown as TaskId<ToolTaskResult>,
    sleepUntil: async () => { throw new Error('ToolTask cannot sleep inside a native tool invocation'); },
    get settings() { return runtime.settings; },
    get models() { return runtime.models; },
    agent: async ctx => {
      const agent = await runtime.agent(ctx);
      return { ...agent, callable: [...agent.callable.filter(item => item.name !== tool.name), delegated] };
    },
    hooks: {
      each: async (name, invoke) => {
        if (name !== 'afterTool') return;
        const encode: ToolHooks['afterTool'] = async (_call, result) => {
          const packet = project(result);
          if (isHostUsageAccounted(packet.result)) packet.usageAccounted = true;
          packet.result = withoutHostUsageMarker(packet.result);
          // Native afterToolCall can replace usage. Its owning task accounts for that
          // final value; official nested children have already accounted for theirs.
          return { ...result, usage: undefined, structuredOutput: undefined,
            details: copyJson(packet as unknown as JsonValue, { omitUndefinedProperties: true }) };
        };
        await invoke(encode as NonNullable<ToolHooks[typeof name]>);
      },
    },
    commit: async (change, commitContext, options) => {
      let next = execution;
      let partial: HostControlledToolResult | undefined;
      await runtime.commit(async (tx, current) => {
        await flush(tx);
        const doc = await tx.doc(HostExecutionDoc, runtime.taskId);
        if (doc.execution && (doc.execution.input.kind !== 'nested' || !isDeepStrictEqual(copyJson(doc.execution.input.call), call))) {
          throw new Error('Host execution belongs to another tool or other arguments');
        }
        // Progress may overlap an intent commit; read the latest checkpoint inside the transaction.
        const active = doc.execution?.version === execution.version
          ? copyJson(doc.execution) as unknown as StoredExecution : execution;
        next = active;
        if (active.result) return undefined;
        const nested = await tx.doc(NestedCallDoc, runtime.taskId, resultKey, null);
        nested.taskId ??= runtime.taskId as unknown as TaskId<ToolTaskResult>;
        const live = await tx.doc(LiveDoc, runtime.conversationId);
        if (!live.nestedTools?.some(item => item.taskId === runtime.taskId)) {
          (live.nestedTools ??= []).push({
            taskId: runtime.taskId, parentTaskId: scope.input.parentTaskId ?? runtime.taskId,
            parentCallId: scope.input.toolCall.id, callId: scope.input.toolCall.id,
            name: tool.name, arguments: args as JsonObject, status: 'pending',
          });
        }
        const task = { ...current, input: active.input,
          state: { status: 'running' as const, checkpoint: active.checkpoint } } as unknown as RunningTask<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult>;
        const state = await change(tx, task);
        if (state?.status === 'running') next = { ...active, checkpoint: state.checkpoint };
        else if (state?.status === 'terminal') {
          const receipt = nested.result && copyJson(nested.result) as unknown as NestedToolExecutionResult | undefined;
          if (!receipt?.details) throw new Error('Host ToolTask settled without a native result');
          const packet = copyJson(receipt.details) as unknown as Packet;
          const output = packet.native ? packet.result.content : receipt.structuredOutput;
          const content = typeof output === 'string' ? (output ? [{ type: 'text' as const, text: output }] : [])
            : Array.isArray(output) ? output as unknown as HostControlledToolResult['content']
            : output && typeof output === 'object' && output.type === 'image'
              ? [output] as unknown as HostControlledToolResult['content'] : [];
          const diagnostics = packet.native ? packet.diagnostics ?? [] : receipt.diagnostics;
          const result = { ...packet.result, content: diagnostics.length ? [...content, {
            type: 'text' as const, text: `<harness>\n${diagnostics.map(item => `[${item.severity}] ${item.message}`).join('\n')}\n</harness>`,
          }] : content };
          next = { ...active, result: { ...packet, result },
            ...(state.outcome.status === 'failed' ? { failure: { message: state.outcome.error.message } } : {}) };
          if (previousProgress) partial = { content, details: packet.result.details,
            ...(diagnostics.length ? { diagnostics: copyJson(diagnostics) } : {}) };
          live.nestedTools = live.nestedTools?.filter(item => item.taskId !== runtime.taskId);
          if (!live.nestedTools?.length) delete live.nestedTools;
        } else if (state !== undefined) throw new Error(`Unexpected host ToolTask state ${state.status}`);
        doc.execution = copyJson(next as unknown as JsonValue, {
          omitUndefinedProperties: true,
        }) as JsonRepresentation<StoredExecution>;
        const progress = live.nestedTools?.find(item => item.taskId === runtime.taskId);
        if (progress?.status === 'running' && (progress.output !== undefined || progress.details !== undefined || progress.diagnostics?.length)) {
          partial = copyJson({
            content: progress.output ? [{ type: 'text', text: progress.output }] : [],
            ...(progress.details === undefined ? {} : { details: progress.details }),
            ...(progress.diagnostics?.length ? { diagnostics: progress.diagnostics } : {}),
          }) as unknown as HostControlledToolResult;
        }
        await flush(tx);
        return undefined;
      }, commitContext, options);
      execution = next;
      if (partial && JSON.stringify(partial) !== previousProgress) {
        previousProgress = JSON.stringify(partial);
        await update?.(partial);
      }
    },
  };
  // Persist the receipt index before execution without adding a second transcript.
  await sdk.commit(() => undefined, context);
  const record = await runtime.getTask(runtime.taskId, context);
  const task = { ...record, input: execution.input,
    state: { status: 'running' as const, checkpoint: execution.checkpoint } } as unknown as RunningTask<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult>;
  if (abort) {
    await ToolTask.definition.abort!(task, sdk, context);
  } else if (task.state.checkpoint.phase === 'call') {
    await ToolTask.definition.phases.call(task as RunningTask<ToolTaskInput, { phase: 'call' }, ToolTaskResult>, sdk, context);
  } else {
    await ToolTask.definition.phases.execute(task as RunningTask<ToolTaskInput, Extract<ToolTaskCheckpoint, { phase: 'execute' }>, ToolTaskResult>, sdk, context);
  }
  if (!execution.result) throw new Error('Host ToolTask returned without a native result');
  return restore(execution.result);
}

function restore(packet: Packet): HostControlledToolResult {
  const result = structuredClone(packet.result);
  return packet.usageAccounted ? markHostUsageAccounted(result) : result;
}
