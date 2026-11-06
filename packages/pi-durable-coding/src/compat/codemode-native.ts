import { extname } from 'node:path';
import { copyJson } from '@earendil-works/chord';
import { withAbortSignal } from '@earendil-works/chord/context';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { parseCodemodeSource } from '@earendil-works/pi-codemode/source';
import { NestedCallDoc, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from '@earendil-works/pi-durable';
import { createCodemodeTool, createModelTools, formatCodemodeResult } from '@earendil-works/pi-durable/codemode';
import {
  currentCodingHostToolApi, currentCodingToolInvocation, runDurableToolCall,
} from '../durable-coding/engine.ts';
import { NATIVE_CODEMODE_FORWARD } from '../durable-coding/codemode-forward.ts';
import { agentToolToHost, hostToolToAgent, markHostUsageAccounted } from '../host-tools.ts';
import type { ExtensionToolContext } from '../pi/core/extensions/types.ts';
import type { SessionEntry } from '../pi/core/session-manager.ts';
import { formatSize } from '../pi/core/tools/truncate.ts';
import {
  CODEMODE_STORE_ENTRY_TYPE, getCodemodeCallableTools, type CodemodeStoreEntryData,
  type CodemodeToolDetails, type CodemodeToolInput, type CodemodeToolOptions,
} from '../pi/extensions/codemode/tool.ts';
import { writeOutputFile } from '../pi/utils/output-files.ts';
import { NativeCodemodeCalls, nativeCodemodeModels, nativeResultText } from './codemode-calls.ts';
import { createNativeCodemodeDiscovery } from './codemode-discovery.ts';
import { CodemodeAdmissionError, leaseNativeCodemodeSandbox } from './codemode-sandbox.ts';

/** Native branch entries remain the sole source of the script's session store. */
export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, unknown> {
  const store = new Map<string, unknown>();
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== CODEMODE_STORE_ENTRY_TYPE ||
        typeof entry.data !== 'object' || entry.data === null) continue;
    const { set, delete: deleted } = entry.data as Partial<CodemodeStoreEntryData>;
    if (typeof set !== 'object' || set === null || !Array.isArray(deleted) ||
        !deleted.every(key => typeof key === 'string')) continue;
    for (const key of deleted) store.delete(key);
    for (const [key, value] of Object.entries(set)) store.set(key, value);
  }
  return Object.fromEntries(store);
}

type Result = AgentToolResult<CodemodeToolDetails>;
type Scope = NonNullable<ReturnType<typeof currentCodingHostToolApi>>;

function admissionResult(error: CodemodeAdmissionError, started: number, details: CodemodeToolDetails): Result {
  return {
    content: [
      { type: 'text', text: `Script failed\nWall time ${((performance.now() - started) / 1000).toFixed(1)} seconds\nOutput:\n` },
      { type: 'text', text: `Script error:\n${error.message}\n\nThe script did not start.` },
    ],
    details, isError: true,
  };
}

/** A direct SDK call needs a real task owner, but never a model request or transcript entry. */
export async function executeNativeCodemode(
  callId: string, input: CodemodeToolInput, signal: AbortSignal | undefined,
  onUpdate: ((result: Result) => void) | undefined, ctx: ExtensionToolContext | undefined,
  options: CodemodeToolOptions = {},
): Promise<Result> {
  const started = performance.now();
  parseCodemodeSource(input.code);
  const scope = currentCodingHostToolApi();
  if (signal?.aborted) {
    onUpdate?.({ content: [], details: { calls: [] } });
    return admissionResult(new CodemodeAdmissionError(
      `Script aborted: ${signal.reason instanceof Error ? signal.reason.message : 'Execution aborted'}`), started, { calls: [] });
  }
  if (scope) return scope.runInScope(() => executeScoped(scope, callId, input, signal, onUpdate, ctx, options, started));
  let result: Result | undefined;
  let failure: { error: unknown } | undefined;
  const bootstrap: ToolRegistration = {
    name: 'codemode', description: 'Native codemode execution owner',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    execute: async () => {
      const captured = currentCodingHostToolApi();
      if (!captured) throw new Error('Native codemode has no durable task owner');
      try {
        result = await executeScoped(captured, callId, input, signal, onUpdate, ctx, options, started);
        return { output: result.content, details: copyJson(result.details), ...(result.isError ? { isError: true } : {}) };
      } catch (error) { failure = { error }; throw error; }
    },
  };
  const tool = hostToolToAgent(bootstrap);
  let native;
  try { native = currentCodingToolInvocation(); } catch { /* Direct SDK invocation. */ }
  if (native) {
    await tool.execute(callId, input, signal);
  } else {
    // Context carrier only: runTool schedules a tool task and does not stream this message.
    const assistant: AssistantMessage = {
      role: 'assistant', content: [], api: 'openai-completions', provider: 'native-codemode', model: 'context',
      stopReason: 'stop', timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    await runDurableToolCall({ type: 'toolCall', id: callId, name: tool.name, arguments: input }, {
      tools: [tool], assistantMessage: assistant, context: { messages: [], tools: [tool] },
    });
  }
  if (failure) throw failure.error;
  if (!result) throw new Error('Native codemode task did not return a result');
  return result;
}

async function executeScoped(
  scope: Scope, callId: string, input: CodemodeToolInput, signal: AbortSignal | undefined,
  onUpdate: ((result: Result) => void) | undefined, ctx: ExtensionToolContext | undefined,
  options: CodemodeToolOptions, started: number,
): Promise<Result> {
  const tools = ctx ? getCodemodeCallableTools(ctx.tools) : [];
  // Prefixing is injective and does not depend on the current catalog or another memo.
  const nativeNames = new Map(tools.map(tool => [`mkagent.native:${tool.name}`, tool.name]));
  const registeredNames = new Map([...nativeNames].map(([registered, name]) => [name, registered]));
  const aliases = Object.fromEntries(nativeNames);
  const calls = new NativeCodemodeCalls(callId, () => onUpdate?.({ content: [], details: calls.snapshot() }),
    options.models && ctx ? ctx.modelRegistry : undefined, name => nativeNames.get(name) ?? name);
  onUpdate?.({ content: [], details: calls.snapshot() });
  const discovery = createNativeCodemodeDiscovery(tools, options);
  const registrations = tools.map(tool => ({
    ...agentToolToHost(tool), description: discovery.declarations.get(tool.name)?.description ?? tool.description,
    name: registeredNames.get(tool.name)!,
  }));
  const effects = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  let preparation = Promise.resolve();
  let stopping = false;
  const context = withAbortSignal(signal
    ? AbortSignal.any([signal, ...(scope.context.abortSignal ? [scope.context.abortSignal] : [])])
    : scope.context.abortSignal ?? effects.signal, scope.context);
  const forward = await scope.registerCodemodeForward(async (call, child, childContext) => {
    const active = withAbortSignal(AbortSignal.any([
      effects.signal, ...(childContext.abortSignal ? [childContext.abortSignal] : []),
    ]), childContext);
    const execution = (async (): Promise<ToolExecutionResult> => {
      if (stopping) throw effects.signal.reason;
      try {
        const prepared = calls.model(call.vmId);
        if (prepared) {
          const result = await prepared.execute(active);
          calls.finishModel(call.vmId, child.taskId, result);
          return calls.receipt(call.vmId, result);
        }
        const name = nativeNames.get(call.name) ?? call.name;
        const tool = tools.find(candidate => candidate.name === name);
        if (!ctx || !tool) throw new Error(`Tool "${call.name}" is not callable`);
        const outcome = await ctx.executeTool(tool.name, call.args, { signal: active.abortSignal });
        calls.finishTool(call.vmId, outcome, active.abortSignal?.aborted ?? false);
        const result = await agentToolToHost({
          ...tool, execute: async () => ({ ...outcome.result, isError: outcome.isError }),
        }).execute(call.args ?? {}, child, active);
        const text = nativeResultText(outcome.result);
        if (outcome.isError && result.structuredOutput === undefined) {
          return calls.receipt(call.vmId, { ...result, diagnostics: [
            { severity: 'error', message: text || `Tool "${tool.name}" failed` },
          ] });
        }
        // The one forwarding tool accepts either Native's structured value or its text fallback.
        return calls.receipt(call.vmId, result.structuredOutput !== undefined
          ? result : { ...result, structuredOutput: text });
      } catch (error) {
        calls.fail(call.vmId, error, active.abortSignal?.aborted ?? false);
        if (stopping && !Object.is(error, active.abortSignal?.reason) &&
            !(error instanceof Error && error.name === 'AbortError')) failures.push(error);
        throw error;
      }
    })();
    pending.add(execution);
    void execution.then(() => pending.delete(execution), () => pending.delete(execution));
    return execution;
  });
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    stopping = true;
    effects.abort(new Error('The script has ended'));
    await preparation;
    await Promise.allSettled([...pending]);
    try { await forward.join(); } catch (error) { failures.push(error); }
    calls.stop();
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Native codemode cleanup failed');
  })();
  const api: ToolExecutionApi = {
    ...scope.api,
    get models() {
      return options.models && ctx ? nativeCodemodeModels(ctx.modelRegistry, scope.api.models) : scope.api.models;
    },
    agent: async agentContext => {
      const agent = await scope.api.agent(agentContext);
      const internal = agent.callable.find(tool => tool.name === NATIVE_CODEMODE_FORWARD);
      if (!internal) throw new Error('The native codemode forwarding tool is not callable in this conversation');
      return { ...agent, callable: [
        ...registrations, ...(options.models && ctx ? createModelTools() : []), internal,
      ] };
    },
    executeTool: async (name, args, callContext, execution) => {
      const match = /^c([1-9]\d*)$/.exec(execution?.key ?? '');
      if (!match) throw new Error('Native codemode requires a stable VM call key');
      const id = Number(match[1]);
      const result = await forward.execute(id, name, args, callContext);
      calls.restore({ id, name, args }, result);
      return result;
    },
    getTask: async (id, taskContext) => {
      const record = await scope.api.getTask(id, taskContext);
      const nested = record?.input;
      if (!record || record.owner !== scope.api.taskId || !nested || typeof nested !== 'object' ||
          Array.isArray(nested) || nested.kind !== 'nested' || !nested.call ||
          typeof nested.call !== 'object' || Array.isArray(nested.call) ||
          nested.call.name !== NATIVE_CODEMODE_FORWARD) return record;
      const args = nested.call.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.name !== 'string') return record;
      // Only the call envelope is projected. The task ID, owner and receipt remain official.
      return { ...record, input: { ...nested, call: { ...nested.call, name: args.name, arguments: args.args ?? {} } } };
    },
  };
  const timeoutMs = parseCodemodeSource(input.code).options.timeoutMs;
  let failure: { error: unknown } | undefined;
  try {
    const result = await createCodemodeTool({
      models: options.models === true && ctx !== undefined,
      globals: discovery.globals,
      aliases,
      cancellation: 'result',
      prepareCall: call => {
        const next = preparation.then(async () => {
          if (stopping) throw effects.signal.reason;
          const previous = await scope.api.snapshot(NestedCallDoc, scope.api.taskId, `c${call.id}`, scope.context)
            .catch(error => { failures.push(error); throw error; });
          if (previous?.result) calls.restore(call, previous.result);
          else calls.prepare(call);
        });
        preparation = next.catch(() => {});
        return next;
      },
      onCallStart: call => calls.start(call),
      sandbox: (_api, leaseContext, deadline) => leaseNativeCodemodeSandbox({
        signal: leaseContext.abortSignal, deadline, timeoutMs, now: () => api.now(), stop,
      }),
      store: {
        read: () => {
          const values = copyJson(ctx ? readCodemodeStore(ctx.sessionManager.getBranch()) : {});
          if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid Native codemode store');
          return values;
        },
        write: (_tx, writes) => { options.appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, writes); },
      },
      formatResult: async (raw, info) => {
        calls.stop();
        const formatted = await formatCodemodeResult(raw, {
          ...info, calls: calls.snapshot().calls, limits: false, imageSize: formatSize,
          wallMs: () => performance.now() - started,
          write: async (name, data) => {
            try { return { path: await writeOutputFile('pi-codemode', extname(name), data) }; }
            catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
          },
        });
        return {
          output: formatted.content, details: copyJson({ ...calls.snapshot(),
            ...(formatted.fullOutputPath ? { fullOutputPath: formatted.fullOutputPath } : {}) }),
          ...(calls.usage ? { usage: calls.usage } : {}), ...(raw.ok ? {} : { isError: true }),
        };
      },
    }).execute(input, api, context);
    return markHostUsageAccounted({
      content: result.output ?? [], details: result.details as unknown as CodemodeToolDetails,
      ...(result.usage ? { usage: result.usage } : {}), ...(result.isError ? { isError: true } : {}),
    });
  } catch (error) {
    if (error instanceof CodemodeAdmissionError) return admissionResult(error, started, calls.snapshot());
    failure = { error };
    throw error;
  } finally {
    try { await stop(); }
    catch (error) {
      if (failure && !Object.is(failure.error, error)) {
        throw new AggregateError([failure.error, error], 'Native codemode execution and cleanup failed');
      }
      throw error;
    } finally { forward.dispose(); }
  }
}
