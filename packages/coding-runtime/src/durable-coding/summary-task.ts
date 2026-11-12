/** Native summary requests use durable ownership without entering the conversation's model context. */
import { copyJson } from '@earendil-works/chord';
import type { AssistantMessage, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-coding-agent';
import { defineTask, type ConversationId } from '@earendil-works/pi-durable';
import type { StreamFn } from '../agent-runtime.ts';

export interface CodingSummaryInput {
  bindingKey: string;
  model: { provider: string; modelId: string };
  context: TranscriptContext;
  options: Pick<SimpleStreamOptions, 'reasoning' | 'cacheRetention' | 'sessionId'>;
}

export type CodingSummaryResult = { response: AssistantMessage } | { aborted: true };
export type SummaryProducer = (...args: Parameters<StreamFn>) => Promise<AssistantMessage>;

export interface CodingSummaryBindings {
  produce(input: CodingSummaryInput, signal: AbortSignal): Promise<AssistantMessage>;
}

export function createCodingSummaryTask(resolve: (id: ConversationId) => CodingSummaryBindings) {
  return defineTask<CodingSummaryInput, { phase: 'request' | 'requesting' }, CodingSummaryResult>({
    name: 'pi.coding.summary', version: 1,
    initial: () => ({ phase: 'request' }),
    phases: {
      request: async (task, runtime, context) => {
        const host = resolve(runtime.conversationId);
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'requesting' } }), context);
        const response = await host.produce(task.input, runtime.signal);
        runtime.signal.throwIfAborted();
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed',
          result: { response: copyJson(response, { omitUndefinedProperties: true }) as unknown as AssistantMessage } } }), context);
      },
      requesting: async () => {
        throw new Error('Native summary request was interrupted; model delivery is uncertain and was not repeated');
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({
        status: 'terminal', outcome: { status: 'aborted', result: { aborted: true } },
      }), context);
    },
  });
}
