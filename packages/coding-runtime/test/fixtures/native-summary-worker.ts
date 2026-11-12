/** Synthetic summaries never read user resources or make network requests. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore, normalizeContext, type Model } from '@earendil-works/pi-ai';
import { createRegistry, Harness, type TaskId } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { DurableLoopBinding } from '../../src/durable-coding/engine.ts';
import { response } from './durable-harness.ts';

const [mode, directory, point] = process.argv.slice(2);
if (!directory || !['initial', 'resume'].includes(mode!)) throw new Error('Invalid summary recovery fixture input');
globalThis.fetch = async () => { throw new Error('Summary recovery test forbids network'); };
const effect = (value: string) => appendFileSync(join(directory, 'effects.jsonl'), JSON.stringify(value) + '\n');
const kill = () => { process.kill(process.pid, 'SIGKILL'); };
const models = createModels({ credentials: new InMemoryCredentialStore() });
const registry = createRegistry();
const harness = await Harness.open(await openNodeJsonlStorage(join(directory, 'store'), context), {
  registry, models, settings: { retry: { enabled: false }, compaction: { enabled: false } },
}, context);
const conversation = await harness.root(context);
const binding = new DurableLoopBinding({ kernel: { harness, conversation, registry } });
binding.bindSummary(async () => {
  effect(mode === 'initial' ? 'request' : 'repeated request');
  if (mode === 'initial' && point === 'request') kill();
  return response('saved summary');
});
await binding.backend();
try {
  if (mode === 'initial') {
    const wait = harness.waitForTask.bind(harness);
    harness.waitForTask = async (id, ctx) => {
      writeFileSync(join(directory, 'task.json'), JSON.stringify(id));
      if (point === 'admitted') kill();
      const receipt = await wait(id, ctx);
      if (point === 'committed') kill();
      return receipt;
    };
    const model: Model<'faux'> = {
      id: 'local', name: 'Local', provider: 'faux', api: 'faux', baseUrl: 'http://unused.invalid',
      input: ['text'], reasoning: false, contextWindow: 100_000, maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    await (await binding.summaryStream(model, normalizeContext({ messages: [
      { role: 'user', content: 'summary history', timestamp: 1 },
    ] }))).result();
    throw new Error('Expected synthetic summary crash boundary was not reached');
  }
  const id = JSON.parse(readFileSync(join(directory, 'task.json'), 'utf8')) as TaskId;
  const receipt = await harness.waitForTask(id, context);
  process.stdout.write(JSON.stringify(receipt.state.outcome));
} finally {
  await harness.close(context);
  await binding.close();
}
