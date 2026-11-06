// Bridge host approval wrappers and native tools inside the owning CodingToolTask.
import { copyJson, type Context, type JsonValue } from '@earendil-works/chord';
import { awaitWithContext } from '@earendil-works/chord/context';
import {
  boundOutput, OutputBuffer, Progress, PROGRESS_BYTES_PER_SECOND, utf8ByteLength, type OutputLimits,
} from '@earendil-works/chord/output';
import {
  defineDoc, type CommitOptions, type JsonObject, type Task, type TaskId, type TaskOptions,
  type ToolDiagnostic, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration, type Tx,
} from '@earendil-works/pi-durable';
import type { AgentTool, AgentToolUpdateCallback } from './agent-runtime.ts';
import type { ToolDefinition } from './pi/core/extensions/types.ts';
import { currentCodingToolInvocation, withCodingHostToolApi } from './durable-coding/engine.ts';
import { nestedHostTools } from './host-tool-nested.ts';
import type { HostControlledToolResult } from './host-tool-controls.ts';

type NativeTool = AgentTool<any, unknown> & Pick<ToolDefinition<any>,
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

/** Run a host registration in the current CodingToolTask, using its real runtime and environment. */
export function hostToolToAgent(registration: HostTool): NativeTool {
  return {
    ...registration,
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
      const invocation = await hostInvocation(registration, callId, onUpdate, scope, context);
      let result: ToolExecutionResult | undefined;
      let executionError: { error: unknown } | undefined;
      try {
        context.abortSignal?.throwIfAborted();
        result = await withCodingHostToolApi(invocation.api, context,
          () => registration.execute(args, invocation.api, context));
      } catch (error) {
        executionError = { error };
      } finally {
        invocation.end();
      }
      const failures = await invocation.close();
      if (executionError) failures.unshift(executionError.error);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Host tool execution or progress failed');
      return invocation.result(result!);
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
      // Enumerable symbol properties survive the production wrapper's {...result}.
      // Unknown native details are checked at the durable task's finite-JSON boundary.
      return {
        output: settled.content,
        details: settled.details as JsonValue,
        ...(tool.outputSchema === undefined || settled.structuredContent === undefined
          ? {} : { structuredOutput: settled.structuredContent }),
        ...(settled.isError === undefined ? {} : { isError: settled.isError }),
        ...(settled.usage === undefined ? {} : { usage: settled.usage }),
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

async function hostInvocation(
  tool: HostTool, callId: string, onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  scope: ReturnType<typeof currentCodingToolInvocation>, context: Context,
) {
  const { runtime, flush } = scope;
  const limits: OutputLimits = {
    maxBytes: tool.outputLimits?.maxBytes ?? 50 * 1024,
    maxLines: tool.outputLimits?.maxLines ?? 2000,
    retain: tool.outputLimits?.retain ?? 'head',
  };
  const output = new OutputBuffer(limits);
  const diagnostics: ToolDiagnostic[] = [];
  const failures: unknown[] = [];
  const pending = new Set<Promise<void>>();
  let details: JsonValue | undefined;
  let live = true;
  let deliveries = Promise.resolve();
  const assertLive = () => {
    if (!live) throw new Error(`Tool call ${callId} has settled`);
    context.abortSignal?.throwIfAborted();
  };
  function observe<T>(promise: Promise<T>): Promise<T> {
    const joined = promise.then(() => {}, error => { failures.push(error); });
    pending.add(joined);
    void joined.then(() => pending.delete(joined));
    return promise;
  }
  const commit: ToolExecutionApi['commit'] = async <T>(
    change: (tx: Tx) => T | Promise<T>, commitContext: Context, options?: CommitOptions,
  ): Promise<T> => {
    let value!: T;
    await runtime.commit(async tx => {
      await flush(tx);
      value = await scope.runInScope(() => withCodingHostToolApi(api, context, () => change(tx)));
      await flush(tx);
      return undefined;
    }, commitContext, options);
    return value;
  };
  function publish(partial: NativeResult, updateContext: Context = context): Promise<void> {
    const stored = copyJson(partial, { omitUndefinedProperties: true });
    const delivered = deliveries.then(async () => {
      await commit(async tx => {
        const state = await tx.doc(HostProgressDoc, runtime.taskId);
        state.result = stored;
      }, updateContext);
      await onUpdate?.(partial);
    });
    // A failed callback must not prevent later callbacks or escape as an unhandled rejection.
    deliveries = delivered.catch(() => {});
    return observe(delivered);
  }
  const runningResult = (): NativeResult => ({
    content: output.snapshot().text === '' ? [] : [{ type: 'text', text: output.snapshot().text }],
    details,
    ...(diagnostics.length ? { diagnostics: [...diagnostics] } : {}),
  });
  // Host byte streams coalesce through Chord's bounded progress writer. Native callbacks
  // use publish directly so complete native results, including images, remain intact.
  let hostDirty = false;
  const progress = new Progress(async () => {
    hostDirty = false;
    const partial = runningResult();
    await publish(partial);
    return utf8ByteLength(JSON.stringify(partial));
  }, error => { failures.push(error); }, runtime.settings.progress.outputIntervalMs, {
    now: () => runtime.now(),
    setTimer: (callback, delay) => runtime.setTimer(callback, delay),
  });
  const nested = nestedHostTools(runtime, callId, tool.replay === 'safe', commit, context);
  const env = await runtime.env(context);
  const api: NativeApi = {
    taskId: runtime.taskId,
    conversationId: runtime.conversationId,
    callId,
    registry: runtime.registry,
    agent: (...args) => { assertLive(); return runtime.agent(...args); },
    get models() { assertLive(); return runtime.models; },
    get env() { assertLive(); return env; },
    now: () => { assertLive(); return runtime.now(); },
    output: (chunk, skipped) => {
      assertLive();
      if (output.push(chunk, skipped)) {
        hostDirty = true;
        progress.mark();
      }
    },
    outputWindow: limits.retain === 'tail' ? {
      maxBytes: limits.maxBytes, maxLines: limits.maxLines,
      minIntervalMs: runtime.settings.progress.outputIntervalMs, bytesPerSecond: PROGRESS_BYTES_PER_SECOND,
    } : undefined,
    retainedOutput: () => {
      assertLive();
      const retained = output.snapshot();
      return { text: retained.text, truncated: retained.droppedBytes > 0 };
    },
    diagnostic: diagnostic => {
      assertLive();
      diagnostics.push(copyJson(diagnostic, { omitUndefinedProperties: true }) as ToolDiagnostic);
      hostDirty = true;
      progress.mark();
    },
    details: (value, detailsContext) => {
      assertLive();
      detailsContext.abortSignal?.throwIfAborted();
      details = copyJson(value, { omitUndefinedProperties: true });
      hostDirty = true;
      return awaitWithContext(observe(progress.markAndWait()), detailsContext);
    },
    commit: (change, commitContext, options) => {
      assertLive();
      return observe(commit(change, commitContext, options));
    },
    memo: ((name: string, valueOrContext: JsonValue | Context, memoContext?: Context) => {
      assertLive();
      return memoContext === undefined
        ? runtime.memo(name, valueOrContext as Context)
        : observe(commit(() => {}, memoContext).then(() => runtime.memo(name, valueOrContext as JsonValue, memoContext)));
    }) as ToolExecutionApi['memo'],
    createTask: <I, S extends { phase: string }, R, H extends object>(
      definition: Task<I, S, R, H>, input: I, options: Omit<TaskOptions, 'conversationId'>, taskContext: Context,
    ): Promise<TaskId<R>> => {
      assertLive();
      const child = options.ownership.kind === 'task' && tool.replay !== 'safe'
        ? { abandonOnRestart: true, ...options } : options;
      return observe(commit(tx => tx.createTask(definition, input, child), taskContext));
    },
    getTask: (...args) => { assertLive(); return runtime.getTask(...args); },
    waitForTask: (...args) => { assertLive(); return runtime.waitForTask(...args); },
    conversation: (...args) => { assertLive(); return runtime.conversation(...args); },
    snapshot: ((...args: unknown[]) => {
      assertLive();
      return Reflect.apply(runtime.snapshot, runtime, args);
    }) as ToolExecutionApi['snapshot'],
    snapshotAsOf: ((...args: unknown[]) => {
      assertLive();
      return Reflect.apply(runtime.snapshotAsOf, runtime, args);
    }) as ToolExecutionApi['snapshotAsOf'],
    watchDoc: ((...args: unknown[]) => {
      assertLive();
      return Reflect.apply(runtime.watchDoc, runtime, args);
    }) as ToolExecutionApi['watchDoc'],
    executeTool: (...args) => {
      assertLive();
      const result = nested.executeTool(...args);
      // A detached wait may reject during owned-call cleanup; admission is joined separately.
      void result.catch(() => {});
      return result;
    },
    [nativeUpdate]: partial => {
      if (live) void publish(partial);
    },
  };
  return {
    api,
    end() { live = false; output.end(); },
    async close() {
      try { await nested.close(); } catch (error) { failures.push(error); }
      const waiters = await progress.stop();
      try {
        if (hostDirty) await publish(runningResult());
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        failures.push(error);
        for (const waiter of waiters) waiter.reject(error);
      }
      await deliveries;
      await Promise.all(pending);
      return [...new Set(failures)];
    },
    result(result: CarriedResult): NativeResult {
      const original = result[nativeResult];
      const retained = output.snapshot();
      const content = result.output ?? (retained.text ? [{ type: 'text' as const, text: retained.text }] : []);
      // Preserve complete native outputs. Only host-origin output gets durable's text limit.
      const bounded = original ? { content, droppedBytes: 0, droppedLines: 0 } : boundContent(content, limits);
      const remarks = [...diagnostics, ...(result.diagnostics ?? [])];
      const dropped = result.output === undefined ? retained : bounded;
      if (dropped.droppedBytes) remarks.push({
        severity: 'warn', code: 'truncated',
        message: `Output truncated to its ${limits.retain === 'head' ? 'beginning' : 'end'}: ${dropped.droppedLines} lines, ${dropped.droppedBytes} bytes dropped`,
      });
      return {
        ...original,
        content: remarks.length ? [...bounded.content, {
          type: 'text', text: `<harness>\n${remarks.map(item => `[${item.severity}] ${item.message}`).join('\n')}\n</harness>`,
        }] : bounded.content,
        details: result.details === undefined ? (original?.details ?? details) : result.details,
        ...(result.structuredOutput === undefined ? {} : { structuredContent: result.structuredOutput }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.control?.terminate === undefined ? {} : { terminate: result.control.terminate }),
        ...(result.control === undefined ? {} : { durableHostControl: result.control }),
      };
    },
  };
}

function boundContent(
  content: NativeResult['content'], limits: OutputLimits,
): { content: NativeResult['content']; droppedBytes: number; droppedLines: number } {
  const texts = content.filter(item => item.type === 'text');
  const bounded = boundOutput(texts.map(item => item.text).join(''), limits);
  if (!bounded.droppedBytes) return { ...bounded, content };
  const keep = limits.retain === 'head' ? texts[0] : texts.at(-1);
  return {
    ...bounded,
    content: content.flatMap<NativeResult['content'][number]>(item => item.type !== 'text' ? [item] :
      item === keep ? [{ ...item, text: bounded.text }] : []),
  };
}
