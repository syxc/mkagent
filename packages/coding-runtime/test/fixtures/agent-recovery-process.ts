/** A separate process owns each side of a real JSONL crash/reopen boundary. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import * as s from '@earendil-works/pi-schema';
import { Agent, type AgentTool } from '../../src/agent-runtime.ts';
import { DurableLoopBinding } from '../../src/durable-coding/engine.ts';
import { response } from './durable-harness.ts';

const [directory, phase, replay] = process.argv.slice(2);
assert(directory && (phase === 'begin' || phase === 'resume'));
assert(replay === 'safe' || replay === 'never');
const model: Model<'faux'> = {
  id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const target: AgentTool = {
  name: 'fixture', label: 'Fixture', description: 'Record attempted effects', parameters: s.obj({}), replay,
  execute: async () => {
    appendFileSync(join(directory, 'effects.txt'), `${phase}\n`);
    if (phase === 'begin') {
      // The parent kills this process while the durable execute intent is already committed.
      process.stdout.write('TOOL_ENTERED\n');
      await new Promise(() => {});
    }
    return { content: [{ type: 'text', text: 'safe result' }], details: {} };
  },
};
const requests: string[][] = [];
const agent = new Agent({
  durable: new DurableLoopBinding({ storage: await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT) }),
  initialState: { model, systemPrompt: 'Local recovery test', tools: [target] },
  streamFn: (_model, context) => {
    requests.push(context.messages.map(message => message.role));
    appendFileSync(join(directory, 'requests.txt'), `${phase}\n`);
    const message = response('recovered');
    if (phase === 'begin') {
      message.content = [{ type: 'toolCall', id: 'call-1', name: 'fixture', arguments: {} }];
      message.stopReason = 'toolUse';
    }
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({
      type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message,
    }));
    return stream;
  },
});
const events: string[] = [];
agent.subscribe(event => { events.push(event.type); });
const backend = await agent.durable.backend();
if (phase === 'begin') {
  backend.harness.resume();
  await agent.prompt('run the fixture');
  throw new Error('Expected the parent to kill the pending tool process');
}
try {
  const pending = await agent.durable.pendingRun();
  assert(pending, 'Expected a persisted Agent run');
  const task = await backend.harness.getTask(pending, backend.context);
  const bindingError = new Error('Synthetic binding failure');
  await agent.resumeDurable(() => { throw bindingError; });
  assert.equal(agent.state.errorMessage, bindingError.message);
  assert.equal(agent.state.isStreaming, false);
  events.length = 0;
  const resumed = await agent.resumeDurable(() => backend.harness.resume());
  assert.equal(agent.state.errorMessage, undefined);
  const history = await backend.conversation.context(backend.context);
  const messages = [...agent.state.messages];
  const recoveredRequests = [...requests];
  await agent.prompt('after recovery');
  const continuedHistory = await backend.conversation.context(backend.context);
  console.log(JSON.stringify({
    resumed, checkpoint: task?.state, requests: recoveredRequests, events, messages,
    history: history.messages, streaming: agent.state.isStreaming,
    pending: await agent.durable.pendingRun(), reports: backend.reports,
    secondResume: await agent.resumeDurable(),
    continued: { messages: agent.state.messages, history: continuedHistory.messages, requests },
  }));
} finally {
  await agent.durable.close();
}
