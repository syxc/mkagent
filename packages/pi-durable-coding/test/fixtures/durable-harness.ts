/** Deterministic provider and real durable storage for coding adapter tests. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream, createProvider, InMemoryCredentialStore,
  type AssistantMessage, type TranscriptContext,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { Harness, createRegistry, type HarnessSettings, type Report } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

export function response(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }], stopReason,
    api: 'faux', provider: 'faux', model: 'local', timestamp: 1,
    ...(stopReason === 'error' ? { errorMessage: text } : {}),
    usage: {
      input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export async function durableFixture(answers: AssistantMessage[], settings: HarnessSettings = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'durable-boundary-'));
  const calls: TranscriptContext[] = [];
  const requestedModels: Array<{ provider: string; id: string }> = [];
  const reports: Report[] = [];
  const models = builtinModels({ credentials: new InMemoryCredentialStore() });
  models.setProvider(createProvider({
    id: 'faux', name: 'Local',
    models: [{
      id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
      reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    auth: { apiKey: { name: 'Local', resolve: async () => ({ auth: { apiKey: 'local-test-placeholder' } }) } },
    api: { faux: {
      stream: () => { throw new Error('Unexpected non-simple stream'); },
      streamSimple: (model, context) => {
        requestedModels.push({ provider: model.provider, id: model.id });
        calls.push(context);
        const message = answers.shift();
        if (!message) throw new Error('Unexpected model request');
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            stream.push({ type: 'error', reason: message.stopReason, error: message });
          } else {
            stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
          }
        });
        return stream;
      },
    } },
  }));
  const registry = createRegistry();
  const options = {
    registry, models, settings: { retry: { enabled: false }, compaction: { enabled: false }, ...settings },
    onReport: (report: Report) => reports.push(report),
  };
  const open = () => openNodeJsonlStorage(directory, BACKGROUND_CONTEXT)
    .then(storage => Harness.open(storage, options, BACKGROUND_CONTEXT));
  const harness = await open();
  const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: 'local' } } });
  return { directory, registry, harness, conversation, calls, requestedModels, reports, open, models };
}
