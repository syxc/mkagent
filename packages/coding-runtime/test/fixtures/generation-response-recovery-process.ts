/** Crash boundaries use only a local deterministic stream and a task-owned JSONL store. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import { LiveDoc } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { Agent } from '../../src/agent-runtime.ts';
import { DurableLoopBinding } from '../../src/durable-coding/engine.ts';
import { GenerationResponseDoc } from '../../src/durable-coding/generation-response.ts';
import { response } from './durable-harness.ts';

const [directory, phase, boundary] = process.argv.slice(2);
assert(directory && (phase === 'begin' || phase === 'resume'));
assert(boundary === 'request' || boundary === 'message_end' || boundary === 'accepted');
const context = BACKGROUND_CONTEXT;
const model: Model<'faux'> = {
  id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const stop = async () => {
  process.stdout.write('CRASH_BOUNDARY\n');
  await new Promise(() => {});
};
const agent = new Agent({
  durable: new DurableLoopBinding({ storage: await openNodeJsonlStorage(directory, context) }),
  initialState: { model },
  finishTurn: async () => {
    if (phase === 'begin' && boundary === 'accepted') await stop();
    return { action: 'end' };
  },
  streamFn: async () => {
    appendFileSync(join(directory, 'requests.txt'), `${phase}\n`);
    assert.equal(phase, 'begin', 'An uncertain request or native event must not be repeated');
    if (boundary === 'request') await stop();
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: response('persisted response') });
    return stream;
  },
});
agent.subscribe(async event => {
  if (phase === 'begin' && boundary === 'message_end' && event.type === 'message_end' && event.message.role === 'assistant') await stop();
});
const backend = await agent.durable.backend();
if (phase === 'begin') {
  backend.harness.resume();
  await agent.prompt('crash at the response boundary');
  throw new Error('Expected a crash boundary');
}
try {
  const pending = await agent.durable.pendingRun();
  assert(pending);
  const task = await backend.harness.getTask(pending, context);
  const receipt = await backend.harness.snapshot(GenerationResponseDoc, pending, context);
  const resumed = await agent.resumeDurable(() => backend.harness.resume());
  const history = await backend.conversation.entries({}, 100, undefined, context);
  console.log(JSON.stringify({ resumed, checkpoint: task?.state, receipt,
    error: agent.state.errorMessage,
    assistants: history.items.filter(entry => entry.model?.some(message => message.role === 'assistant')).length,
    pending: await agent.durable.pendingRun(),
    generation: (await backend.harness.snapshot(LiveDoc, backend.conversation.id, context))?.generation,
  }));
} finally { await agent.durable.close(); }
