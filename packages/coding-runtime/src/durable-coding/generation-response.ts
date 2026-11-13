/** Bind the SDK request executor to the real native run owner and its journal transaction. */
import { copyJson, type Context, type JsonValue } from '@earendil-works/chord';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-coding-agent';
import {
  defineDoc, GenerationResponseTask,
  type ConversationStreamOptions, type GenerationHooks, type GenerationResponseCheckpoint, type GenerationResponseInput, type GenerationResponseResult,
  type JsonObject, type NextTaskState, type RunningTask, type TaskId, type TaskRuntime, type Tx,
} from '@earendil-works/pi-durable';
import { streamAssistantResponse } from '../native-operations.ts';
import type { LoopCheckpoint, LoopExecution, LoopInput } from './run-task.ts';

type Runtime = TaskRuntime<LoopInput, LoopCheckpoint, import('../agent-runtime.ts').AgentMessage[], object>;
type SDKRuntime = TaskRuntime<GenerationResponseInput, GenerationResponseCheckpoint, GenerationResponseResult, GenerationHooks>;
type Execution = {
  version: number;
  input: GenerationResponseInput;
  checkpoint: GenerationResponseCheckpoint;
  result?: GenerationResponseResult;
  failure?: { message: string };
  aborted?: true;
};
type Accept = (message: AssistantMessage, tx: Tx) => Promise<NextTaskState<LoopCheckpoint, import('../agent-runtime.ts').AgentMessage[]>>;

export const GenerationResponseDoc = defineDoc<{ execution?: JsonObject }>({
  kind: 'mkagent.coding.generation-response', version: 1, scope: 'task',
  initial: () => ({}), checkpointWhen: () => false,
});

/** Core owns protocol events; the SDK owns streaming and drains progress before message_end. */
export async function requestGenerationResponse(
  host: LoopExecution, runtime: Runtime, context: Context, signal: AbortSignal,
  streamOptions: ConversationStreamOptions | undefined,
  accept: Accept,
): Promise<void> {
  const relay = new NativeStream();
  const stopping = new AbortController();
  const requestSignal = AbortSignal.any([signal, stopping.signal]);
  let native!: Promise<AssistantMessage>;
  let nativeMessage: AssistantMessage | undefined;
  let execution = Promise.resolve();
  let started = false;
  native = streamAssistantResponse(host.context, host.config, requestSignal, host.emit, (model, transcript, options) => {
    if (started) throw new Error('A native request cannot start more than one SDK execution');
    started = true;
    // Only the prepared messages and model identity are persisted. Auth, headers, callbacks,
    // and provider options remain in the core stream binding for this invocation.
    const stored: Execution = {
      version: GenerationResponseTask.definition.version,
      input: copyJson({ model: { provider: model.provider, modelId: model.id }, messages: transcript.messages,
        thinkingLevel: host.config.reasoning }, { omitUndefinedProperties: true }) as unknown as GenerationResponseInput,
      checkpoint: GenerationResponseTask.definition.initial({} as GenerationResponseInput),
    };
    let source: PreparedStream | undefined;
    const sdk: SDKRuntime = {
      ...responseRuntime(runtime, stored, async (_message, tx) => {
        if (!nativeMessage) throw new Error('SDK settled before native message delivery');
        return accept(nativeMessage, tx);
      }),
      models: {
      ...runtime.models,
      getModel: (provider, id) => provider === model.provider && id === model.id ? model : runtime.models.getModel(provider, id),
      streamSimple: () => {
        source = new PreparedStream(Promise.resolve().then(() => host.streamFn(model, transcript, { ...options, ...streamOptions })));
        return source;
      },
      },
      hooks: { each: async (name, invoke) => {
      if (name !== 'codingStream') return;
      const forward: GenerationHooks['codingStream'] = async frame => {
        if (frame.type === 'event') {
          if (frame.event.type !== 'done' && frame.event.type !== 'error') await relay.deliver(frame.event);
        } else if (source?.message) {
          // streamResponse has joined its last partial commit before this callback.
          relay.end(source.message);
          nativeMessage = await native;
        }
      };
      await invoke(forward as NonNullable<GenerationHooks[typeof name]>);
      } },
    };
    execution = (async () => {
      const task = await runtime.getTask(runtime.taskId, context);
      await GenerationResponseTask.definition.phases.request({ ...task, input: stored.input,
        state: { status: 'running', checkpoint: stored.checkpoint },
      } as unknown as RunningTask<GenerationResponseInput, GenerationResponseCheckpoint, GenerationResponseResult>, sdk, context);
      if (!stored.result) throw new Error(stored.failure?.message ?? 'SDK request ended without a response');
    })();
    void execution.catch(error => relay.fail(error));
    return relay;
  });
  try {
    await native;
    await execution;
  } catch (error) {
    stopping.abort(error);
    relay.fail(error);
    await execution.catch(() => {});
    throw error;
  }
}

/** The scheduler joins the interrupted phase before this fresh abort invocation. */
export async function abortGenerationResponse(runtime: Runtime, context: Context): Promise<void> {
  await settleGenerationResponse(runtime, context, true);
}

/** Resolve the SDK intent without repeating a request whose native events are uncertain. */
export async function interruptGenerationResponse(runtime: Runtime, context: Context): Promise<void> {
  await settleGenerationResponse(runtime, context, false);
}

async function settleGenerationResponse(runtime: Runtime, context: Context, abort: boolean): Promise<void> {
  const saved = (await runtime.snapshot(GenerationResponseDoc, runtime.taskId, context))?.execution;
  if (!saved || saved.result || saved.failure || saved.aborted) return;
  const stored = copyJson(saved) as unknown as Execution;
  if (stored.version !== GenerationResponseTask.definition.version) throw new Error(`Unsupported generation response version ${stored.version}`);
  if (!stored.checkpoint.started) throw new Error('An interrupted SDK request has no committed start intent');
  const record = await runtime.getTask(runtime.taskId, context);
  const task = { ...record, input: stored.input, state: { status: 'running' as const, checkpoint: stored.checkpoint },
  } as unknown as RunningTask<GenerationResponseInput, GenerationResponseCheckpoint, GenerationResponseResult>;
  const sdk = responseRuntime(runtime, stored);
  if (abort) await GenerationResponseTask.definition.abort!(task, sdk, context);
  else await GenerationResponseTask.definition.phases.request(task, sdk, context);
}

function responseRuntime(runtime: Runtime, stored: Execution, accept?: Accept): SDKRuntime {
  return {
    ...runtime,
    taskId: runtime.taskId as unknown as TaskId<GenerationResponseResult>,
    get settings() { return runtime.settings; },
    models: runtime.models,
    hooks: { each: async () => {} },
    sleepUntil: async () => { throw new Error('A prepared generation cannot sleep inside a native request'); },
    commit: async (change, context, options) => {
      let candidate = stored;
      await runtime.commit(async (tx, current) => {
        const next = await change(tx, { ...current, input: stored.input,
          state: { status: 'running', checkpoint: stored.checkpoint },
        } as unknown as RunningTask<GenerationResponseInput, GenerationResponseCheckpoint, GenerationResponseResult>);
        if (next?.status === 'running') candidate = { ...stored, checkpoint: next.checkpoint };
        else if (next?.status === 'terminal') {
          if (next.outcome.status === 'completed') candidate = { ...stored, result: next.outcome.result };
          else if (next.outcome.status === 'failed') candidate = { ...stored, failure: next.outcome.error };
          else if (next.outcome.status === 'aborted') candidate = { ...stored, aborted: true };
          else throw new Error(`Unexpected generation response outcome ${next.outcome.status}`);
        } else if (next !== undefined) throw new Error(`Unexpected generation response state ${next.status}`);
        (await tx.doc(GenerationResponseDoc, runtime.taskId)).execution = copyJson(candidate as unknown as JsonValue, {
          omitUndefinedProperties: true,
        }) as JsonObject;
        if (candidate.result && accept) return accept(candidate.result.message, tx);
        return undefined;
      }, context, options);
      Object.assign(stored, candidate);
    },
  };
}

/** Await an asynchronous core StreamFn while keeping the SDK Models stream contract synchronous. */
class PreparedStream extends AssistantMessageEventStream {
  message?: AssistantMessage;
  constructor(private readonly source: Promise<AssistantMessageEventStream>) { super(); }
  override async *[Symbol.asyncIterator]() { yield* await this.source; }
  override async result() { return this.message = await (await this.source).result(); }
}

/** Preserve event backpressure and propagate stream failures through core's iterator. */
class NativeStream extends AssistantMessageEventStream {
  private acknowledgements: Array<() => void> = [];
  private failure?: { error: unknown };
  async deliver(event: AssistantMessageEvent): Promise<void> {
    const accepted = new Promise<void>(resolve => { this.acknowledgements.push(resolve); });
    this.push(event);
    await accepted;
    if (this.failure) throw this.failure.error;
  }
  fail(error: unknown) {
    this.failure = { error };
    this.end();
    for (const accept of this.acknowledgements.splice(0)) accept();
  }
  override async *[Symbol.asyncIterator]() {
    try {
      for await (const event of { [Symbol.asyncIterator]: () => super[Symbol.asyncIterator]() }) {
        try { yield event; } finally { this.acknowledgements.shift()?.(); }
      }
      if (this.failure) throw this.failure.error;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
}
