import { afterEach, expect, test } from 'bun:test';
import { trashFixture } from './fixtures/trash-fixture.ts';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemoryCredentialStore, PI_ATTRIBUTION, type Model } from '@earendil-works/pi-ai';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Agent } from '../src/agent-runtime.ts';
import { DurableLoopBinding } from '../src/durable-coding/engine.ts';
import { AgentSession } from '../src/native-agent-session.ts';
import { createAgentSession, type CreateAgentSessionOptions } from '../src/native-sdk.ts';
import { convertToLlm } from '../src/native-messages.ts';

const directories: string[] = [], sessions: sdk.AgentSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const path of directories.splice(0)) trashFixture(path);
});
const model: Model<'faux'> = { id: 'factory', name: 'Factory', api: 'faux', provider: 'local', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text', 'image'], contextWindow: 10000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'coding-factory-'))); directories.push(cwd);
  const agentDir = join(cwd, 'agent');
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  return { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, model, sessionManager: sdk.SessionManager.inMemory(cwd) };
}

test('SDK default and native factories retain their session and agent constructors', async () => {
  for (const [create, durable] of [[sdk.createAgentSession, false], [createAgentSession, true]] as const) {
    const input = await fixture();
    const options = Object.create({ ...input, noTools: 'all' });
    Object.defineProperty(options, 'initializeSessionMetadata', { value: false });
    const { session, extensionsResult } = await create(options); sessions.push(session);
    expect(session instanceof AgentSession).toBe(durable);
    expect(session.agent instanceof Agent).toBe(durable);
    expect(session.sessionManager).toBe(input.sessionManager);
    expect(session.sessionManager.getEntries()).toEqual([]);
    expect(session.getActiveToolNames()).toEqual([]);
    expect(extensionsResult).toBe(input.resourceLoader.getExtensions());
    if (session instanceof AgentSession) expect(session.agent.durable).toBeInstanceOf(DurableLoopBinding);
  }
});

test('native factory keeps injected durable state, inherited callbacks and dynamic image filtering', async () => {
  const input = await fixture(), durable = new DurableLoopBinding();
  const captured: string[] = [];
  const options: CreateAgentSessionOptions = Object.create({ ...input, durable, noTools: 'all',
    onToolsChanged: () => captured.push('tools'),
  });
  Object.defineProperty(options, 'captureUserInput', { value: () => ({ hostMessageId: 'captured' }) });
  const { session } = await createAgentSession(options); sessions.push(session);
  expect(session.agent.durable).toBe(durable);
  const message = { role: 'user' as const, timestamp: 1, hostMessageId: 'host-id', hostUserInput: { text: 'host' },
    content: [{ type: 'image' as const, data: 'fixture', mimeType: 'image/png' }] };
  const before = await session.agent.convertToLlm([message]);
  expect(before[0]).not.toHaveProperty('hostMessageId');
  expect(before[0]).not.toHaveProperty('hostUserInput');
  expect(before[0]?.content).toEqual(message.content);
  input.settingsManager.setBlockImages(true);
  expect((await session.agent.convertToLlm([message]))[0]?.content).toEqual([{ type: 'text', text: 'Image reading is disabled.' }]);
  input.settingsManager.setBlockImages(false);
  expect((await session.agent.convertToLlm([message]))[0]?.content).toEqual(message.content);
  expect(message.hostMessageId).toBe('host-id');
  expect(captured).not.toEqual([]);
});

test('SDK constructor injection forwards host policy fields and keeps selection in SDK assembly', async () => {
  const input = await fixture();
  const options: sdk.CreateAgentSessionOptions = { ...input, tools: ['+grep', '-bash'], excludeTools: ['write'],
    baseToolsOverride: {}, wrapTool: tool => tool, onAction: work => work(), onToolsChanged() {}, captureUserInput: () => ({}) };
  let configs = 0;
  const result = await sdk.createAgentSession(options, {
    createAgent: config => new Agent(config),
    createSession(config) {
      configs++;
      for (const key of ['baseToolsOverride', 'wrapTool', 'onAction', 'onToolsChanged', 'captureUserInput'] as const) expect(config[key]).toBe(options[key]);
      expect(config.initialActiveToolNames).toEqual(['read', 'edit', 'grep']);
      expect(config.defaultToolModifiers).toBe(options.tools);
      expect(config.excludedToolNames).toBe(options.excludeTools);
      expect(config.agent).toBeInstanceOf(Agent);
      return new AgentSession(config);
    },
    convertToLlm,
    cacheWarmingAction: work => work(),
  });
  sessions.push(result.session);
  expect(configs).toBe(1);
  expect(result.session).toBeInstanceOf(AgentSession);
  await expect(sdk.createAgentSession({ ...input, tools: ['read', '+grep'] })).rejects.toThrow('Invalid tools option');
});

test.each([false, true])('native metadata suppression preserves existing session input: %s', async existing => {
  const input = await fixture();
  if (existing) input.sessionManager.appendMessage({ role: 'user', content: 'accepted', timestamp: 1 });
  const entries = input.sessionManager.getEntries();
  const result = await createAgentSession({ ...input, noTools: 'all', initializeSessionMetadata: false }); sessions.push(result.session);
  expect(input.sessionManager.getEntries()).toEqual(entries);
  const normal = await fixture();
  if (existing) normal.sessionManager.appendMessage({ role: 'user', content: 'accepted', timestamp: 1 });
  const created = await createAgentSession({ ...normal, noTools: 'all' }); sessions.push(created.session);
  expect(normal.sessionManager.getEntries().map(entry => entry.type)).toEqual(existing
    ? ['message', 'thinking_level_change'] : ['model_change', 'thinking_level_change']);
});

test('native factory default resource loader resolves public plugin imports through the host API', async () => {
  const { resourceLoader: _loader, ...input } = await fixture();
  const extensionDir = join(input.cwd, '.pi', 'extensions'); mkdirSync(extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, 'factory.ts'), `
    import { createAgentSession, createReadToolDefinition } from '@earendil-works/pi-coding-agent';
    export default function(pi) {
      if (typeof createAgentSession !== 'function') throw new Error('Missing factory');
      pi.registerTool(createReadToolDefinition(import.meta.dir));
      pi.registerFlag('factory-plugin', { type: 'boolean', default: true });
    }
  `);
  const result = await createAgentSession({ ...input, noTools: 'all' }); sessions.push(result.session);
  expect(result.extensionsResult.errors).toEqual([]);
  expect(result.extensionsResult.extensions).toHaveLength(1);
  expect(result.extensionsResult.extensions[0]?.flags.get('factory-plugin')?.default).toBe(true);
  expect(result.extensionsResult.extensions[0]?.tools.get('read')?.definition.name).toBe('read');
});

test('bundled native factory keeps the Coding version and dynamic attribution without SDK metadata', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'coding-factory-bundle-'))); directories.push(directory);
  const entry = join(directory, 'identity.ts'), artifact = join(directory, 'artifact');
  writeFileSync(entry, `
    import { createAgentSession } from ${JSON.stringify(resolve(import.meta.dir, '../src/native-sdk.ts'))};
    import { VERSION } from ${JSON.stringify(resolve(import.meta.dir, '../src/native-config.ts'))};
    import { ModelRuntime, SettingsManager, SessionManager, DefaultResourceLoader } from ${JSON.stringify(Bun.resolveSync('@earendil-works/pi-coding-agent', import.meta.dir))};
    import { InMemoryCredentialStore } from ${JSON.stringify(Bun.resolveSync('@earendil-works/pi-ai', import.meta.dir))};
    const cwd = process.cwd(), agentDir = cwd + '/agent', model = ${JSON.stringify(model)};
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const identities = [];
    modelRuntime.streamSimple = (_model, _context, options) => { identities.push(options.identity); return {}; };
    const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd), noTools: 'all' });
    try {
      for (const enabled of [false, true]) {
        settingsManager.setEnableInstallTelemetry(enabled);
        await session.agent.streamFunction(model, { messages: [] }, { sessionId: 'identity-probe' });
      }
      console.log(JSON.stringify({ version: VERSION, identities }));
    } finally { session.dispose(); }
  `);
  const built = await Bun.build({ entrypoints: [entry], outdir: artifact, naming: 'identity.js', target: 'bun', format: 'esm', external: ['koffi'] });
  expect(built.success, built.logs.join('\n')).toBe(true);
  for (const metadata of [undefined, { name: '@mkagent/pi-agent-server', version: '0.2.6', type: 'module' }]) {
    if (metadata) writeFileSync(join(artifact, 'package.json'), JSON.stringify(metadata));
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '--config=/dev/null', '--preload',
      resolve(import.meta.dir, '../../pi-agent-server/src/test-fixtures/block-network.ts'), join(artifact, 'identity.js')], {
      cwd: artifact, env: { PATH: process.env.PATH!, HOME: directory, TMPDIR: directory,
        XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, PI_OFFLINE: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ version: '1.5.0', identities: [
      { userAgent: 'detailed', version: '1.5.0', attribution: null },
      { userAgent: 'detailed', version: '1.5.0', attribution: PI_ATTRIBUTION },
    ] });
  }
}, 60_000);
