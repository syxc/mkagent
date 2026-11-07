/** Bind request credentials at execution time; only model identities and summary text cross storage. */
import { copyJson } from '@earendil-works/chord';
import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { TaskId, Tx } from '@earendil-works/pi-durable';
import type { StreamFn } from '../agent-runtime.ts';
import type { LoopBackend } from './engine.ts';
import type { CodingTasks } from './task-registry.ts';
import type { CodingSummaryBindings, CodingSummaryInput, CodingSummaryResult, SummaryProducer } from './summary-task.ts';
import type { CodingSessionTaskRuntime } from './session-task.ts';

interface SummaryBindingOptions {
  backend(): Promise<LoopBackend>;
  tasks(): CodingTasks;
  owner(): CodingSessionTaskRuntime | undefined;
  commit(tx: Tx): Promise<void>;
}

export class NativeSummaryBinding {
  private producer?: SummaryProducer;
  private readonly requests = new Map<string, CodingSummaryBindings['produce']>();

  constructor(private readonly options: SummaryBindingOptions) {}

  bind(producer: SummaryProducer): void { this.producer = producer; }

  bindings(): CodingSummaryBindings {
    return { produce: (input, signal) => {
      const request = this.requests.get(input.bindingKey);
      if (!request) throw new Error('Native summary requester was interrupted; its model request was not repeated');
      return request(input, signal);
    } };
  }

  readonly stream: StreamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const failure = (stopReason: 'aborted' | 'error', errorMessage?: string): AssistantMessage => ({
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason, ...(errorMessage ? { errorMessage } : {}),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const publish = (response: AssistantMessage) => {
      if (response.stopReason === 'pending') {
        stream.push({ type: 'error', reason: 'error', error: failure('error', 'Native summary returned an unfinished response') });
      } else if (response.stopReason === 'aborted' || response.stopReason === 'error') {
        stream.push({ type: 'error', reason: response.stopReason, error: response });
      } else stream.push({ type: 'done', reason: response.stopReason, message: response });
    };
    const bindingKey = randomUUID();
    const producer = this.producer;
    if (producer) this.requests.set(bindingKey, (input, signal) =>
      producer(model, input.context, { ...options, cacheRetention: 'none',
        signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal }));
    const input: CodingSummaryInput = {
      bindingKey,
      model: { provider: model.provider, modelId: model.id }, context,
      // Keep request routing, auth and callbacks only in the live request closure.
      options: { reasoning: options?.reasoning, cacheRetention: 'none', sessionId: options?.sessionId },
    };
    const request = this.request(input, options?.signal).finally(() => { this.requests.delete(bindingKey); });
    void request.then(result => {
      publish('response' in result && !options?.signal?.aborted ? result.response : failure('aborted'));
    }, error => publish(failure(options?.signal?.aborted ? 'aborted' : 'error',
      error instanceof Error ? error.message : String(error))));
    return stream;
  };

  private async request(input: CodingSummaryInput, signal?: AbortSignal): Promise<CodingSummaryResult> {
    if (signal?.aborted) return { aborted: true };
    const backend = await this.options.backend();
    const owner = this.options.owner();
    const stored = copyJson(input, { omitUndefinedProperties: true }) as unknown as CodingSummaryInput;
    let id!: TaskId<CodingSummaryResult>;
    const create = async (tx: Tx) => {
      await this.options.commit(tx);
      id = await tx.createTask(this.options.tasks().summary, stored, {
        ownership: owner === undefined ? { kind: 'conversation' } : { kind: 'task', taskId: owner.taskId },
      });
      return undefined;
    };
    if (owner) await owner.commit(create, backend.context);
    else await backend.conversation.commit(create, backend.context);
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => {
      cancellation = backend.harness.abortTask(id, backend.context);
      void cancellation.catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const receipt = owner ? await owner.waitForTask(id, backend.context)
        : await backend.harness.waitForTask(id, backend.context);
      const outcome = receipt.state.outcome;
      if ((outcome.status === 'completed' || outcome.status === 'aborted') && outcome.result) return outcome.result;
      throw new Error('error' in outcome && outcome.error ? outcome.error.message : `Native summary ${outcome.status}`);
    } finally {
      signal?.removeEventListener('abort', cancel);
      await cancellation;
    }
  }
}
