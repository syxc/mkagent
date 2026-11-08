// Bridge host approval wrappers and native tools inside the owning CodingToolTask.
import { copyJson, type Context, type JsonValue } from '@earendil-works/chord';
import {
  defineDoc, type JsonObject, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { AgentTool } from './agent-runtime.ts';
import type { ToolDefinition } from './pi/core/extensions/types.ts';
import { currentCodingToolInvocation, withCodingHostToolApi } from './durable-coding/engine.ts';
import { executeHostToolTask, hostToolExecution } from './host-tool-task.ts';
import type { HostControlledToolResult } from './host-tool-controls.ts';
import { isHostUsageAccounted } from './host-tool-usage.ts';
export { markHostUsageAccounted } from './host-tool-usage.ts';

type NativeTool = AgentTool<any, unknown> & { [hostToolExecution]?: true } & Pick<ToolDefinition<any>,
  'exposure' | 'namespace' | 'annotations' | 'reachesTools' | 'defaultActive' | 'promptSnippet' | 'promptGuidelines'>;
type HostTool = ToolRegistration<any>;
type NativeResult = HostControlledToolResult;
const nativeResult = Symbol('mkagent.native-tool-result');
const nativeUpdate = Symbol('mkagent.native-tool-update');
type CarriedResult = ToolExecutionResult & { [nativeResult]?: NativeResult };
type NativeApi = ToolExecutionApi & { [nativeUpdate]?: (result: NativeResult) => void };

/** Both views of one wrapped tool; publish registration for host executeTool() discovery. */
export interface HostToolBridge {
  tool: NativeTool;
  registration: HostTool;
}

export type HostToolScope = <T>(api: ToolExecutionApi, context: Context, work: () => Promise<T>) => Promise<T>;

/** Run a host registration through ToolTask, keeping the native task's durable owner. */
export function hostToolToAgent(registration: HostTool): NativeTool {
  return {
    ...registration,
    [hostToolExecution]: true,
    label: registration.name,
    exposure: registration.callers?.length === 0 ? 'hidden'
      : registration.callers?.includes('model') === false ? 'codemode'
      : registration.deferred ? 'deferred'
      : registration.callers?.includes('tools') === false ? 'model-only' : 'direct',
    outputSchema: registration.structuredOutputSchema,
    replay: registration.replay === 'safe' ? 'safe' : 'never',
    execute: async (callId, args, signal, onUpdate) => {
      const scope = currentCodingToolInvocation();
      if (scope.input.toolCall.id !== callId) throw new Error('Host tool call does not own this coding invocation');
      if (registration.callers) {
        const parent = scope.input.parentTaskId === undefined ? undefined
          : await scope.runtime.getTask(scope.input.parentTaskId, scope.context);
        const caller = parent?.kind === 'pi.coding.run' ? 'model' : 'tools';
        if (!registration.callers.includes(caller)) throw new Error(`Tool ${registration.name} does not allow ${caller} calls`);
      }
      const context: Context = {
        abortSignal: signal ?? scope.runtime.signal,
        telemetry: scope.context.telemetry,
        value: scope.context.value.bind(scope.context),
        toString: () => scope.context.toString(),
      };
      let returned: CarriedResult | undefined;
      let updates = Promise.resolve();
      const failures: unknown[] = [];
      const project = (result: CarriedResult) => failures.length ? {
        native: true as const,
        result: { content: [{ type: 'text' as const, text: String((failures[0] as Error)?.message ?? failures[0]) }], details: {}, isError: true },
      } : {
        result: nativeHostResult(result),
        ...(result[nativeResult] ? { native: true as const, diagnostics: result.diagnostics } : {}),
      };
      const pending = new Set<Promise<void>>();
      function observe<T>(promise: Promise<T>): Promise<T> {
        const joined = promise.then(() => {}, error => { failures.push(error); });
        pending.add(joined);
        void joined.then(() => pending.delete(joined));
        return promise;
      }
      const delegated: HostTool = {
        ...registration,
        execute: async (prepared, api) => {
          // External cancellation stops the effect; SDK settlement keeps its own live task context.
          const sdkContext = context;
          let live = true;
          const assertLive = () => {
            if (!live) throw new Error(`Tool call ${callId} has settled`);
            context.abortSignal?.throwIfAborted();
          };
          const guard = <T extends object>(target: T): T => new Proxy(target, {
            get(target, key, receiver) {
              if (key === 'models' || key === 'env') assertLive();
              const value = Reflect.get(target, key, receiver);
              if (typeof value !== 'function') return value;
              const invoke = (...args: unknown[]) => {
                assertLive();
                const result = Reflect.apply(value, target, args);
                return key === 'conversation'
                  ? Promise.resolve(result).then(handle => handle && guard(handle)) : result;
              };
              return key === 'executeTool' ? async (...args: unknown[]) => invoke(...args) : invoke;
            },
          });
          const nativeApi: NativeApi = guard({
            ...api,
            get models() { return api.models; },
            commit: (change, ctx, options) => observe(api.commit(
              tx => scope.runInScope(() => withCodingHostToolApi(nativeApi, sdkContext, () => change(tx))), ctx, options,
            )),
            memo: ((name: string, valueOrContext: JsonValue | Context, memoContext?: Context) => memoContext === undefined
              ? api.memo(name, valueOrContext as Context)
              : observe(nativeApi.commit(() => undefined, memoContext).then(() => api.memo(name, valueOrContext as JsonValue, memoContext)))) as ToolExecutionApi['memo'],
            [nativeUpdate]: partial => {
              const stored = copyJson(partial, { omitUndefinedProperties: true });
              const delivery = updates.then(async () => {
                await nativeApi.commit(async tx => {
                  (await tx.doc(HostProgressDoc, api.taskId)).result = stored;
                }, sdkContext);
                await onUpdate?.(partial);
              });
              updates = delivery.catch(() => {});
              observe(delivery);
            },
          });
          try {
            returned = await withCodingHostToolApi(nativeApi, sdkContext,
              () => registration.execute(prepared, nativeApi, sdkContext));
          } finally {
            try {
              await updates;
              await Promise.all(pending);
            } finally { live = false; }
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length) throw new AggregateError(failures, 'Host tool execution or progress failed');
          return returned;
        },
      };
      try {
        return await executeHostToolTask(delegated, args, scope, scope.context, project, onUpdate);
      } catch (error) {
        // The SDK joins execute before aborting. Preserve a result returned during cleanup
        // for the native task's existing same-process cancellation handoff.
        if (context.abortSignal?.aborted && returned && !failures.length) return project(returned).result;
        throw error;
      }
    },
  };
}

/** Expose a native tool to the host without erasing its result through wrapper spreads. */
export function agentToolToHost(tool: NativeTool, scope?: HostToolScope): HostTool {
  return {
    ...tool,
    callers: tool.exposure === 'hidden' ? [] : tool.exposure === 'model-only' ? ['model']
      : tool.exposure === 'codemode' ? ['tools'] : undefined,
    ...(tool.exposure === 'deferred' ? { deferred: true as const } : {}),
    replay: tool.replay === 'safe' ? 'safe' : 'unsafe',
    structuredOutputSchema: tool.outputSchema,
    execute: async (args, api: NativeApi, context) => {
      const execute = async () => {
      let live = true;
      let updates = Promise.resolve();
      const failures: unknown[] = [];
      let previousText = '';
      let result: NativeResult | undefined;
      try {
        result = await tool.execute(api.callId, args, context.abortSignal, partial => {
          if (!live) return;
          if (api[nativeUpdate]) {
            api[nativeUpdate](partial);
            return;
          }
          // Official ToolTask has a text progress channel and a JSON details channel.
          // Its final result still receives the full content below.
          const text = partial.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
          const added = text.startsWith(previousText) ? text.slice(previousText.length) : text;
          previousText = text;
          updates = updates.then(async () => {
            if (added) api.output(added);
            if (partial.details !== undefined) {
              await api.details(copyJson(partial.details, { omitUndefinedProperties: true }), context);
            }
          }).catch(error => { failures.push(error); });
        });
      } catch (error) {
        failures.push(error);
      } finally {
        live = false;
      }
      await updates;
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'Native tool execution or progress failed');
      const settled = result!;
      // Symbols remain local to the wrapper; the SDK bridge persists a finite JSON envelope.
      return {
        output: settled.content,
        details: settled.details as JsonValue,
        ...(tool.outputSchema === undefined || settled.structuredContent === undefined
          ? {} : { structuredOutput: settled.structuredContent }),
        ...(settled.isError === undefined ? {} : { isError: settled.isError }),
        ...(settled.usage === undefined || isHostUsageAccounted(settled) ? {} : { usage: settled.usage }),
        ...(settled.terminate === undefined ? {} : { control: { terminate: settled.terminate } }),
        [nativeResult]: settled,
      } as CarriedResult;
      };
      return scope ? scope(api, context, execute) : execute();
    },
  };
}

/** Apply the same production approval wrapper to a native tool and expose both executable views. */
export function wrapAgentTool(
  tool: NativeTool, wrapRegistration: (registration: HostTool) => HostTool, scope?: HostToolScope,
): HostToolBridge {
  const registration = wrapRegistration(agentToolToHost(tool, scope));
  return {
    registration,
    tool: {
      ...tool,
      ...hostToolToAgent(registration),
      exposure: tool.exposure,
      label: tool.label,
    },
  };
}

const HostProgressDoc = defineDoc<JsonObject>({
  kind: 'mkagent.coding.host-tool-progress', version: 1, scope: 'task',
  initial: () => ({}), checkpointWhen: () => false,
});

function nativeHostResult(result: CarriedResult): NativeResult {
  const original = result[nativeResult];
  return {
    ...original,
    content: result.output ?? [],
    details: result.details === undefined ? original?.details : result.details,
    ...(result.structuredOutput === undefined ? {} : { structuredContent: result.structuredOutput }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.control?.terminate === undefined ? {} : { terminate: result.control.terminate }),
    ...(result.control === undefined ? {} : { durableHostControl: result.control }),
  };
}
