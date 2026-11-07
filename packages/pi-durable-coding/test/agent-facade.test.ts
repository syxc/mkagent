/** Core lifecycle reuse must retain Native defaults, queues and recovery boundaries. */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Agent as CoreAgent, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import { Agent, type AgentOptions } from '../src/durable-agent.ts';
import { DurableLoopBinding } from '../src/durable-coding/engine.ts';
import { getDefaultStreamFn, setDefaultStreamFn } from '../src/stream-fn.ts';

const streamFn: StreamFn = () => { throw new Error('No provider call expected'); };
const message = (text: string): AgentMessage => ({
  role: 'user', content: [{ type: 'text', text }], timestamp: 1,
});

class FailedRunBinding extends DurableLoopBinding {
  restore: (messages: AgentMessage[]) => void = () => {};
  override setMessageRestorer(restore: (messages: AgentMessage[]) => void): void {
    this.restore = restore;
    super.setMessageRestorer(restore);
  }
  override async run(..._args: Parameters<DurableLoopBinding['run']>): Promise<AgentMessage[]> {
    throw new Error('Synthetic durable failure');
  }
}

test('Native defaults and fallback stream remain separate from public core defaults', async () => {
  assert.equal(CoreAgent.length, 1);
  assert.equal(Agent.length, 1);
  const publicCore = new CoreAgent({ streamFn });
  const first = new Agent({ streamFn, durable: new FailedRunBinding() });
  const second = new Agent({ streamFn, durable: new FailedRunBinding() });
  assert(first instanceof CoreAgent);
  assert(first instanceof Agent);
  assert.equal(first.state.model, second.state.model);
  assert.notEqual(first.state.model, publicCore.state.model);
  assert.equal(first.convertToLlm, second.convertToLlm);
  assert.notEqual(first.convertToLlm, publicCore.convertToLlm);
  await first.prompt('one');
  await second.prompt('two');
  const one = first.state.messages.at(-1), two = second.state.messages.at(-1);
  assert(one?.role === 'assistant' && two?.role === 'assistant');
  assert.equal(one.usage, two.usage);
  assert.equal(one.errorMessage, 'Synthetic durable failure');
  assert.equal(first.state.isStreaming, false);
  setDefaultStreamFn(streamFn);
  try {
    const legacy: Agent = Reflect.construct(Agent, []);
    assert.equal(legacy.streamFunction, streamFn);
    assert.equal(getDefaultStreamFn(), streamFn);
  } finally { setDefaultStreamFn(undefined); }
});

test('constructor property reads retain their order across durable binding', () => {
  const reads: string[] = [];
  const durable = new FailedRunBinding();
  const options: AgentOptions = { streamFn, durable, initialState: { systemPrompt: 'baseline' } };
  const initialState = new Proxy(options.initialState!, {
    get(target, key, receiver) { reads.push('state.' + String(key)); return Reflect.get(target, key, receiver); },
  });
  const agent = new Agent(new Proxy({ ...options, initialState }, {
    get(target, key, receiver) { reads.push(String(key)); return Reflect.get(target, key, receiver); },
  }));
  assert.deepEqual(reads.slice(0, 10), [
    'initialState', 'state.tools', 'state.messages', 'state.systemPrompt', 'state.model',
    'state.thinkingLevel', 'durable', 'convertToLlm', 'transformContext', 'streamFn',
  ]);
  const restored = [message('recovered')];
  durable.restore(restored);
  assert.notEqual(agent.state.messages, restored);
  assert.equal(agent.state.messages[0], restored[0]);
});

test('a transparent Agent proxy retains the durable execution backend', async () => {
  const agent = new Proxy(new Agent({ streamFn, durable: new FailedRunBinding() }), {
    get(target, key, receiver) { return Reflect.get(target, key, receiver); },
    set(target, key, value, receiver) { return Reflect.set(target, key, value, receiver); },
  });
  await agent.prompt('proxied');
  assert.equal(agent.state.errorMessage, 'Synthetic durable failure');
  assert.equal(agent.state.isStreaming, false);
  assert.equal(agent.signal, undefined);
});

test('durable queue snapshots preserve all inputs and their identities in both drain modes', () => {
  for (const mode of ['all', 'one-at-a-time'] as const) {
    const agent = new Agent({ streamFn, steeringMode: mode, followUpMode: mode });
    const one = message('one'), two = message('two'), later = message('later');
    agent.steer(one); agent.steer(two); agent.followUp(later);
    const state = agent.exportDurableQueues();
    assert.deepEqual(state.steering, [one, two]);
    assert.deepEqual(agent.peekQueuedMessages(), mode === 'all' ? [one, two] : [one]);
    state.steering.pop();
    assert.equal(agent.exportDurableQueues().steering.length, 2);
    agent.restoreDurableQueues(state);
    assert.equal(agent.exportDurableQueues().steering[0], one);
    assert.deepEqual(agent.exportDurableQueues().followUp, [later]);
    agent.clearAllQueues();
    assert.equal(agent.hasQueuedMessages(), false);
  }
});

test('agent_end listeners hold lifecycle settlement and reject overlapping operations', async () => {
  const agent = new Agent({ streamFn, durable: new FailedRunBinding() });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  agent.subscribe(async (event, signal) => {
    events.push(event.type);
    assert.equal(signal, agent.signal);
    if (event.type === 'agent_end') { enter(); await gate; }
  });
  const work = agent.prompt('active');
  await entered;
  try {
    assert.equal(agent.state.isStreaming, true);
    await assert.rejects(agent.prompt('overlap'), /already processing a prompt/);
    await assert.rejects(agent.continue(), /already processing/);
    await assert.rejects(agent.resumeDurable(), /already processing/);
    assert.throws(() => agent.reset(), /already processing/);
    let idle = false;
    const waiting = agent.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    assert.equal(idle, false);
    agent.abort();
    assert.equal(agent.signal?.aborted, true);
    release();
    await work; await waiting;
    assert.equal(agent.state.isStreaming, false);
    assert.equal(agent.signal, undefined);
    assert.deepEqual(events, ['message_start', 'message_end', 'turn_end', 'agent_end']);
  } finally { release(); await work; }
});
