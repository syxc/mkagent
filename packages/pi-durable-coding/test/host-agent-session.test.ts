import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, createModels, createProvider, InMemoryCredentialStore, type AssistantMessage, type Message, type Model } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry, MemoryStorage } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';
import { DurableLoopBinding, currentCodingToolInvocation } from '../src/durable-coding/engine.ts';
import { NativeSessionJournal } from '../src/durable-coding/session-journal.ts';
import { createHostResources } from '../src/host-resources.ts';
import { wrapAgentTool } from '../src/host-tools.ts';
import { createAgentSession } from '../src/pi/core/sdk.ts';
import { response } from './fixtures/durable-harness.ts';
import {
  AgentSession, DefaultResourceLoader, getReadmePath, markRuntimeStreamFunction,
  ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';

const directories: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(Session: typeof AgentSession = AgentSession) {
  const cwd = await mkdtemp(join(tmpdir(), 'coding-sdk-session-'));
  directories.push(cwd);
  const model: Model<'faux'> = {
    id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
    reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  modelRuntime.registerProvider('faux', { api: model.api, baseUrl: model.baseUrl, models: [model] });
  await modelRuntime.setRuntimeApiKey('faux', 'local-test-placeholder');
  expect(await modelRuntime.checkAuth('faux')).toBeDefined();
  const agent = new Agent({
    initialState: { model },
    streamFn: () => {
      const message: AssistantMessage = {
        role: 'assistant', content: [{ type: 'text', text: 'local answer' }], stopReason: 'stop',
        api: 'faux', provider: 'faux', model: 'local', timestamp: 1,
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }));
      return stream;
    },
  });
  markRuntimeStreamFunction(agent.streamFunction, modelRuntime);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: join(cwd, 'agent'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const session = new Session({ agent, sessionManager, settingsManager, cwd, resourceLoader, modelRuntime,
    baseToolsOverride: {}, initialActiveToolNames: [] });
  sessions.push(session);
  return { session, agent, sessionManager };
}

test('the SDK default lifecycle keeps agent identity, prompt paths, persistence and settlement', async () => {
  const { session, agent, sessionManager } = await fixture();
  const events: string[] = [];
  session.subscribe(event => events.push(event.type));
  const dispositions: string[] = [];
  await session.prompt('local input', { preflightResult: value => dispositions.push(value) });
  expect(session.agent).toBe(agent);
  expect(session.isIdle).toBe(true);
  expect(agent.state.systemPrompt).toContain(getReadmePath());
  expect(sessionManager.getEntries().filter(entry => entry.type === 'message').map(entry => entry.message.role)).toEqual(['system', 'user', 'assistant']);
  expect(dispositions).toEqual(['started']);
  expect(events.indexOf('agent_end')).toBeGreaterThan(events.indexOf('agent_start'));
  expect(events.indexOf('agent_settled')).toBeGreaterThan(events.indexOf('agent_end'));
});

async function nativeFixture(check: (value: {
  owners: Array<{ call: string; owner: string; task: string }>;
  boundaries: Message[][];
  requests: Message[][];
  messages: AgentMessage[];
  entries: ReturnType<SessionManager['getEntries']>;
}) => void) {
  const cwd = await mkdtemp(join(tmpdir(), 'coding-native-session-'));
  directories.push(cwd);
  const credentials = ModelRuntime.createCredentials(new InMemoryCredentialStore());
  const models = createModels({ credentials });
  const model: Model<'faux'> = {
    id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
    reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const first = response('', 'toolUse');
  first.content = [{ type: 'toolCall', id: 'outer-call', name: 'outer', arguments: {} }];
  const answers = [first, response('done')];
  const requests: Message[][] = [];
  const stream = (_model: Model<any>, request: { messages: Message[] }) => {
    requests.push(request.messages);
    const message = answers.shift();
    if (!message) throw new Error('Unexpected fixture request');
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => events.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }));
    return events;
  };
  models.setProvider(createProvider({ id: 'faux', models: [model],
    auth: { apiKey: { name: 'Synthetic', resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream } }));
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { registry, models,
    settings: { retry: { enabled: false }, compaction: { enabled: false } } }, context);
  const conversation = await harness.root(context);
  const journal = await NativeSessionJournal.open({ harness, conversation, context, cwd });
  const durable = new DurableLoopBinding({ kernel: { harness, conversation, registry }, journal });
  const owners: Array<{ call: string; owner: string; task: string }> = [];
  const boundaries: Message[][] = [];
  const own = (call: string) => {
    const invocation = currentCodingToolInvocation();
    owners.push({ call, owner: invocation.input.toolCall.id, task: invocation.runtime.taskId });
  };
  const resources = createHostResources({ cwd, agentDir: join(cwd, 'agent'),
    globalSettings: { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' },
    disabledBuiltinExtensions: ['codemode', 'tool-search', 'mcp'], extensionFactories: [pi => {
      pi.registerTool({ name: 'outer', label: 'Outer', description: 'Local parent tool', parameters: obj({}),
        execute: async (id, _args, _signal, _onUpdate, ctx) => {
          own(id);
          const outcome = await ctx.executeTool('leaf', {});
          return { ...outcome.result, details: { nestedError: outcome.isError } };
        } });
      pi.registerTool({ name: 'leaf', label: 'Leaf', description: 'Local child tool', parameters: obj({}),
        execute: async id => { own(id); return { content: [{ type: 'text', text: 'leaf result' }], details: {} }; } });
      pi.on('turn_end', event => { boundaries.push(event.context.llmMessages); });
    }] });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    await resources.resourceLoader.reload();
    const modelRuntime = await ModelRuntime.bind({ models: () => models, credentials });
    const bridged: ReturnType<typeof wrapAgentTool>['registration'][] = [];
    ({ session } = await createAgentSession({ ...resources, cwd, agentDir: join(cwd, 'agent'),
      modelRuntime, model, sessionManager: journal.manager, durable, baseToolsOverride: {}, tools: ['outer', 'leaf'],
      wrapTool: tool => {
        const bridge = wrapAgentTool(tool, tool => tool, (api, ctx, work) => durable.withHostToolScope(api, ctx, work));
        bridged.push(bridge.registration);
        return bridge.tool;
      } }));
    registry.install({ name: 'fixture-tools', tools: bridged });
    await session.bindExtensions({ onError: error => { throw new Error(error.message); } });
    await journal.flush();
    await session.prompt('transformed model input', {
      hostMessageId: 'host-id', hostUserInput: { version: 1, content: 'raw display sentinel' },
    });
    await session.waitForIdle();
    await journal.flush();
    check({ owners, boundaries, requests, messages: session.messages, entries: journal.manager.getEntries() });
  } finally {
    session?.dispose();
    await durable.close();
    journal.close();
    await harness.close(context);
  }
}

test('SDK nested extension calls retain distinct durable task ownership through host wrappers', async () => {
  await nativeFixture(({ owners, messages }) => {
    expect(owners.map(({ call, owner }) => ({ call, owner }))).toEqual([
      { call: 'outer-call', owner: 'outer-call' }, { call: 'outer-call/1', owner: 'outer-call/1' },
    ]);
    expect(owners[1]!.task).not.toBe(owners[0]!.task);
    expect(messages.find(message => message.role === 'toolResult')).toMatchObject({
      content: [{ type: 'text', text: 'leaf result' }], details: { nestedError: false }, isError: false,
      nestedCalls: { calls: [{ id: 'outer-call/1', name: 'leaf', status: 'ok' }], complete: true },
    });
  });
});

test('SDK boundary projections omit host input metadata while the transcript and journal retain it', async () => {
  await nativeFixture(({ boundaries, requests, messages, entries }) => {
    expect(boundaries.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(2);
    for (const projection of [...boundaries, ...requests]) {
      const user = projection.find(message => message.role === 'user');
      expect(user).toMatchObject({ content: [{ type: 'text', text: 'transformed model input' }] });
      expect(user).not.toHaveProperty('hostMessageId');
      expect(user).not.toHaveProperty('hostUserInput');
    }
    const original = { hostMessageId: 'host-id', hostUserInput: { version: 1, content: 'raw display sentinel' } };
    expect(messages.find(message => message.role === 'user')).toMatchObject(original);
    expect(entries.find(entry => entry.type === 'message' && entry.message.role === 'user')).toMatchObject({ message: original });
  });
});

for (const method of ['steer', 'followUp'] as const) {
  test(`SDK ${method} acknowledges and publishes queued input only after admission succeeds`, async () => {
    let accept!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const admission = new Promise<void>(resolve => { accept = resolve; });
    class AdmittedSession extends AgentSession {
      protected override _acceptQueuedInput(_kind: string, _message: AgentMessage): Promise<void> {
        entered();
        return admission;
      }
    }
    const { session, agent } = await fixture(AdmittedSession);
    const events: string[] = [];
    session.subscribe(event => events.push(event.type));
    let acknowledged = false;
    const pending = session[method]('accepted input').then(value => { acknowledged = true; return value; });
    await Promise.race([started, pending]);
    expect(acknowledged).toBe(false);
    expect(agent.peekQueuedMessages()).toEqual([]);
    expect(events).not.toContain('queue_update');
    accept();
    expect(await pending).toBe('queued');
    expect(acknowledged).toBe(true);
    expect(method === 'steer' ? session.getSteeringMessages() : session.getFollowUpMessages()).toEqual(['accepted input']);
    expect(agent.peekQueuedMessages()).toMatchObject([{ role: 'user', content: [{ type: 'text', text: 'accepted input' }] }]);
    expect(events.filter(event => event === 'queue_update')).toHaveLength(1);
  });

  test(`SDK ${method} waits for admission and leaves both queues unchanged when admission fails`, async () => {
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const admission = new Promise<void>((_resolve, fail) => { reject = fail; });
    class AdmittedSession extends AgentSession {
      protected override _acceptQueuedInput(_kind: string, _message: AgentMessage): Promise<void> {
        entered();
        return admission;
      }
    }
    const { session, agent } = await fixture(AdmittedSession);
    const events: string[] = [];
    session.subscribe(event => events.push(event.type));
    let acknowledged = false;
    const pending = session[method]('pending input').then(() => { acknowledged = true; });
    await Promise.race([started, pending]);
    expect(acknowledged).toBe(false);
    expect(session.getSteeringMessages()).toEqual([]);
    expect(session.getFollowUpMessages()).toEqual([]);
    expect(agent.peekQueuedMessages()).toEqual([]);
    expect(events).not.toContain('queue_update');
    const failure = new Error('admission rejected');
    const rejected = pending.catch(error => error);
    reject(failure);
    expect(await rejected).toBe(failure);
    expect(acknowledged).toBe(false);
    expect(session.getSteeringMessages()).toEqual([]);
    expect(session.getFollowUpMessages()).toEqual([]);
    expect(agent.peekQueuedMessages()).toEqual([]);
    expect(events).not.toContain('queue_update');
  });
}
