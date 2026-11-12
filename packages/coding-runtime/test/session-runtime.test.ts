import { afterEach, expect, test } from 'bun:test';
import { basename, dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import * as sdk from '@earendil-works/pi-coding-agent';
import { AgentSession } from '../src/native-agent-session.ts';
import { createAgentSessionRuntime, createAgentSessionFromServices, createAgentSessionServices,
  type CreateAgentSessionRuntimeFactory } from '../src/native-session-runtime.ts';

const directories: string[] = [], sessions: AgentSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const path of directories.splice(0)) expect(Bun.spawnSync(['/usr/bin/trash', path]).exitCode).toBe(0);
});
const model: Model<'faux'> = { id: 'local', name: 'Local', api: 'faux', provider: 'local', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const user = (text: string) => ({ role: 'user' as const, content: text, timestamp: 1 });
async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'coding-runtime-')); directories.push(cwd);
  const agentDir = join(cwd, 'agent'), events: string[] = [];
  const controls = { cancelSwitch: false, cancelFork: false, failure: undefined as Error | undefined };
  const models = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const factory: CreateAgentSessionRuntimeFactory = async input => {
    events.push('create'); if (controls.failure) throw controls.failure;
    const services = await createAgentSessionServices({ cwd: input.cwd, agentDir: input.agentDir, modelRuntime: models,
      settingsManager: settings, resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        extensionFactories: [pi => {
          pi.on('session_before_switch', event => { events.push('before:' + event.reason); return controls.cancelSwitch ? { cancel: true } : undefined; });
          pi.on('session_before_fork', () => { events.push('before:fork'); return controls.cancelFork ? { cancel: true } : undefined; });
          pi.on('session_shutdown', event => { events.push('shutdown:' + event.reason); });
        }],
      } });
    const result = await createAgentSessionFromServices({ services, sessionManager: input.sessionManager,
      sessionStartEvent: input.sessionStartEvent, model, noTools: 'all' });
    sessions.push(result.session);
    await result.session.bindExtensions({ onError: error => { throw new Error(error.error); } });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(cwd) });
  events.length = 0;
  return { cwd, agentDir, events, controls, runtime, factory };
}

test('SDK runtime replacement retains durable sessions and teardown, setup and rebind order', async () => {
  const { runtime, events } = await fixture(), previous = runtime.session;
  runtime.setBeforeSessionInvalidate(() => { events.push('invalidate'); });
  runtime.setRebindSession(async session => { expect(session).toBeInstanceOf(AgentSession); session.exportDurableState(); events.push('rebind'); });
  expect(await runtime.newSession({ setup: async manager => { events.push('setup'); manager.appendMessage(user('setup')); },
    withSession: async () => { events.push('with'); } })).toEqual({ cancelled: false });
  expect(events).toEqual(['before:new', 'shutdown:new', 'invalidate', 'create', 'setup', 'rebind', 'with']);
  expect(runtime).toBeInstanceOf(sdk.AgentSessionRuntime);
  expect(runtime.session).not.toBe(previous);
  expect(runtime.session.exportDurableState().activeTools).toEqual([]);
  expect(runtime.session.messages).toEqual([user('setup')]);
  events.length = 0; await runtime.dispose();
  expect(events).toEqual(['shutdown:quit', 'invalidate']);
});

test('SDK runtime preserves cancellation, invalid input and factory failure propagation', async () => {
  const { runtime, controls, events, cwd } = await fixture(), previous = runtime.session;
  controls.cancelSwitch = true;
  expect(await runtime.newSession()).toEqual({ cancelled: true });
  expect(events).toEqual(['before:new']); expect(runtime.session).toBe(previous);
  controls.cancelFork = true; events.length = 0;
  expect(await runtime.fork('missing')).toEqual({ cancelled: true });
  expect(events).toEqual(['before:fork']); expect(runtime.session).toBe(previous);
  controls.cancelSwitch = false; controls.cancelFork = false;
  await expect(runtime.fork('missing')).rejects.toThrow('Invalid entry ID for forking');
  await expect(runtime.importFromJsonl(join(cwd, 'missing.jsonl'))).rejects.toMatchObject({ name: 'SessionImportFileNotFoundError' });
  expect(runtime.session).toBe(previous);
  const failure = new Error('factory failed'); controls.failure = failure; events.length = 0;
  await expect(runtime.newSession()).rejects.toBe(failure);
  expect(events).toEqual(['before:new', 'shutdown:new', 'create']);
});

test('SDK runtime forks in-memory branches before and at entries', async () => {
  const { runtime } = await fixture();
  const first = runtime.session.sessionManager.appendMessage(user('first'));
  const second = runtime.session.sessionManager.appendMessage(user('second'));
  expect(await runtime.fork(second)).toEqual({ cancelled: false, selectedText: 'second' });
  expect(runtime.session.messages).toEqual([user('first')]);
  expect(runtime.session).toBeInstanceOf(AgentSession);
  expect(await runtime.fork(first, { position: 'at' })).toEqual({ cancelled: false, selectedText: undefined });
  expect(runtime.session.messages).toEqual([user('first')]);
  expect(await runtime.fork(first)).toEqual({ cancelled: false, selectedText: 'first' });
  expect(runtime.session.messages).toEqual([]);
});

test('SDK runtime switches and imports JSONL without overwriting a colliding file', async () => {
  const { cwd, runtime } = await fixture();
  const target = sdk.SessionManager.create(cwd, join(cwd, 'stored'));
  target.appendMessage(user('stored'));
  const body = [target.getHeader(), ...target.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  const sessionPath = target.getSessionFile()!; mkdirSync(dirname(sessionPath), { recursive: true }); writeFileSync(sessionPath, body);
  expect(await runtime.switchSession(sessionPath)).toEqual({ cancelled: false });
  expect(runtime.session.messages).toEqual([user('stored')]);
  expect(runtime.session).toBeInstanceOf(AgentSession);
  const input = join(cwd, 'import.jsonl'), collision = join(dirname(sessionPath), 'import.jsonl');
  writeFileSync(input, body); writeFileSync(collision, body);
  expect(await runtime.importFromJsonl(input)).toEqual({ cancelled: false });
  expect(basename(runtime.session.sessionFile!)).toBe('import-1.jsonl');
  expect(readFileSync(collision, 'utf8')).toBe(body); expect(readFileSync(input, 'utf8')).toBe(body);
  expect(runtime.session.exportDurableState().activeTools).toEqual([]);
  expect(runtime.session.messages).toEqual([user('stored')]);
});

test('SDK runtime checks stored session cwd and retains the in-memory exception', async () => {
  const { cwd, agentDir, factory, events } = await fixture(), missingCwd = join(cwd, 'missing');
  const stored = sdk.SessionManager.create(missingCwd, join(cwd, 'stored'));
  expect(stored.getSessionFile()).toBeDefined();
  await expect(createAgentSessionRuntime(factory, { cwd, agentDir,
    sessionManager: stored })).rejects.toMatchObject({ name: 'MissingSessionCwdError' });
  expect(events).toEqual([]);
  const memory = sdk.SessionManager.inMemory(missingCwd);
  expect(memory.getSessionFile()).toBeUndefined();
  const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: memory });
  expect(runtime.session.sessionManager).toBe(memory);
  expect(events).toEqual(['create']);
});
