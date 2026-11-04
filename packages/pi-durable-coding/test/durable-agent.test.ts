/** Public Agent operations must run through the durable task graph. */
import { expect, test } from 'bun:test';
import { Agent } from '../src/agent-runtime.ts';
import { DurableLoopBinding } from '../src/durable-coding/engine.ts';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { response } from './fixtures/durable-harness.ts';
import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import * as s from '@earendil-works/pi-schema';

const model: Model<'faux'> = {
  id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test('new Agent preserves native events and commits the response in a durable task', async () => {
  const events: string[] = [];
  const agent = new Agent({
    initialState: { model, systemPrompt: 'Local test' },
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: response('done') }));
      return stream;
    },
  });
  agent.subscribe(event => { events.push(event.type); });
  try {
    await agent.prompt('hello');
    expect(events).toEqual([
      'agent_start', 'turn_start', 'message_start', 'message_end',
      'message_start', 'message_end', 'turn_end', 'agent_end',
    ]);
    expect(agent.state.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(agent.state.isStreaming).toBe(false);
    const backend = await agent.durable.backend();
    const history = await backend.conversation.context(backend.context);
    expect(history.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant']);
    const tasks = await backend.harness.inspect(backend.context);
    expect(tasks.tasks).toHaveLength(0);
    expect(backend.reports).toEqual([]);
  } finally {
    await agent.durable.close();
  }
});

test('shared registry routes each Agent task to its own conversation', async () => {
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), {
    registry, models: builtinModels({ credentials: new InMemoryCredentialStore() }),
  }, BACKGROUND_CONTEXT);
  const conversations = await Promise.all([
    harness.root(BACKGROUND_CONTEXT),
    harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT),
  ]);
  const agents = conversations.map((conversation, index) => new Agent({
    durable: new DurableLoopBinding({ kernel: { harness, conversation, registry } }),
    initialState: { model, systemPrompt: `Session ${index}` },
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: response(`reply-${index}`) }));
      return stream;
    },
  }));
  try {
    await Promise.all(agents.map(agent => agent.durable.backend()));
    await Promise.all(agents.map((agent, index) => agent.prompt(`prompt-${index}`)));
    for (const [index, agent] of agents.entries()) {
      expect(agent.state.errorMessage).toBeUndefined();
      const texts = agent.state.messages.flatMap(message => message.role === 'assistant'
        ? message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []);
      expect(texts).toEqual([`reply-${index}`]);
      const view = await conversations[index]!.context(BACKGROUND_CONTEXT);
      expect(view.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
    }
    const definitions = registry.snapshot().tasks().filter(task => task.definition.name.startsWith('pi.coding.'));
    expect(definitions.map(task => task.definition.name).sort()).toEqual([
      'pi.coding.call', 'pi.coding.run', 'pi.coding.session', 'pi.coding.tool',
    ]);
  } finally {
    await Promise.all(agents.map(agent => agent.durable.close()));
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('a fault before one parallel tool starts does not strand its sibling', async () => {
  let executed = false;
  let requests = 0;
  const broken = {
    name: 'broken', label: 'broken', description: 'Fail before execution', parameters: s.obj({}),
    get replay(): 'never' { throw new Error('Synthetic binding fault'); },
    execute: async () => ({ content: [], details: {} }),
  };
  const sibling = {
    name: 'sibling', label: 'sibling', description: 'Record execution', parameters: s.obj({}),
    execute: async () => {
      executed = true;
      return { content: [], details: {} };
    },
  };
  const agent = new Agent({
    initialState: { model, tools: [broken, sibling] },
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = response('done');
      if (++requests === 1) {
        message.content = [
          { type: 'toolCall', id: 'broken-call', name: 'broken', arguments: {} },
          { type: 'toolCall', id: 'sibling-call', name: 'sibling', arguments: {} },
        ];
        message.stopReason = 'toolUse';
      }
      queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }));
      return stream;
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      agent.prompt('run parallel tools'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Parallel tool batch stalled')), 500); }),
    ]);
    expect(executed).toBe(true);
    expect(agent.state.errorMessage).toContain('Synthetic binding fault');
  } finally {
    clearTimeout(timer);
    agent.abort();
    await agent.waitForIdle();
    await agent.durable.close();
  }
});
