import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import * as sdk from '@earendil-works/pi-coding-agent';
import { AgentSession } from '../src/native-agent-session.ts';
import { createAgentSessionFromServices, createAgentSessionServices } from '../src/native-session-services.ts';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) {
    expect(Bun.spawnSync(['/usr/bin/trash', path]).exitCode).toBe(0);
  }
});
const resourceOptions = { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true };
function directory() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'coding-services-')));
  directories.push(path);
  return path;
}

test('SDK model initialization preserves registration order, diagnostics, queue clearing and offline refresh', async () => {
  const calls: unknown[] = [];
  const runtime = sdk.createExtensionRuntime();
  runtime.pendingProviderRegistrations.push({ name: 'ok', config: {}, extensionPath: 'first.ts' }, { name: 'bad', config: {}, extensionPath: 'second.ts' });
  runtime.pendingNativeProviderRegistrations.push({ provider: { id: 'native' }, extensionPath: 'third.ts' } as never);
  runtime.pendingVirtualModelRegistrations.push({ definition: { id: 'virtual' }, extensionPath: 'fourth.ts' } as never);
  const loader = { getExtensions: () => ({ runtime }) } as sdk.ResourceLoader;
  const models = {
    registerProvider(name: string) { calls.push(name); if (name === 'bad') throw new Error('provider failure'); },
    registerNativeProvider(provider: unknown) { calls.push(provider); throw 'native failure'; },
    registerVirtualModel(definition: unknown) { calls.push(definition); },
    async refresh(options: unknown) { calls.push(options); },
  } as unknown as sdk.ModelRuntime;
  expect(await sdk.initializeExtensionModels(loader, models)).toEqual([
    { type: 'error', message: 'Extension "second.ts" error: provider failure' },
    { type: 'error', message: 'Extension "third.ts" error: native failure' },
  ]);
  expect(calls).toEqual(['ok', 'bad', { id: 'native' }, { id: 'virtual' }, { allowNetwork: false }]);
  expect(runtime.pendingProviderRegistrations).toEqual([]);
  expect(runtime.pendingNativeProviderRegistrations).toEqual([]);
  expect(runtime.pendingVirtualModelRegistrations).toEqual([]);
  const failure = new Error('refresh failed');
  models.refresh = async () => { throw failure; };
  await expect(sdk.initializeExtensionModels(loader, models)).rejects.toBe(failure);
});

test.each([sdk.createAgentSessionServices, createAgentSessionServices])('service factories retain explicit loader overrides and extension flag diagnostics', async create => {
  const cwd = directory(), settingsManager = sdk.SettingsManager.inMemory();
  let loaded = 0, refreshed = 0;
  const models = { async refresh(options: unknown) { expect(options).toEqual({ allowNetwork: false }); refreshed++; } } as unknown as sdk.ModelRuntime;
  const loader = {
    clearExtensionCache: sdk.clearExtensionCache,
    createExtensionRuntime: sdk.createExtensionRuntime,
    loadExtensionFromFactory: sdk.loadExtensionFromFactory,
    async loadExtensionsCached() { loaded++; return { extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }; },
  };
  const options = Object.create({ cwd, agentDir: join(cwd, 'agent'), settingsManager, modelRuntime: models });
  Object.defineProperty(options, 'resourceLoaderOptions', { value: { ...resourceOptions, extensionLoader: loader,
    extensionFactories: [(pi: sdk.ExtensionAPI) => {
      pi.registerFlag('bool', { type: 'boolean' });
      pi.registerFlag('str', { type: 'string' });
      pi.registerFlag('missing', { type: 'string' });
    }],
  } });
  options.extensionFlagValues = new Map<string, string | boolean>([['bool', false], ['str', 'value'], ['missing', true], ['unknown', true]]);
  const services = await create(options);
  expect(services.modelRuntime).toBe(models);
  expect(services.settingsManager).toBe(settingsManager);
  expect(services.resourceLoader).toBeInstanceOf(sdk.DefaultResourceLoader);
  expect(loaded).toBe(1); expect(refreshed).toBe(1);
  expect([...services.resourceLoader.getExtensions().runtime.flagValues]).toEqual([['bool', true], ['str', 'value']]);
  expect(services.diagnostics).toEqual([
    { type: 'error', message: 'Extension flag "--missing" requires a value' },
    { type: 'error', message: 'Unknown option: --unknown' },
  ]);
});

test('SDK service projection retains inherited inputs and the injected factory result', async () => {
  const fields = ['cwd', 'agentDir', 'modelRuntime', 'settingsManager', 'resourceLoader'];
  const services = Object.fromEntries(fields.map(name => [name, { name }]));
  const sessionFields = ['sessionManager', 'model', 'thinkingLevel', 'scopedModels', 'tools', 'excludeTools', 'noTools', 'customTools', 'sessionStartEvent'];
  const inherited = Object.fromEntries(sessionFields.map(name => [name, { name }]));
  const options = Object.create(inherited); options.services = services;
  const sentinel = { session: {}, extensionsResult: {}, marker: 'host result' } as unknown as sdk.CreateAgentSessionResult & { marker: string };
  const result = await sdk.createAgentSessionFromServices(options, async input => {
    expect(input).toEqual({ ...services, ...inherited });
    return sentinel;
  });
  expect(result).toBe(sentinel);
});

test('host service factory creates the durable subclass while the default SDK factory retains its session', async () => {
  const cwd = directory();
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const services = await createAgentSessionServices({ cwd, agentDir: join(cwd, 'agent'), modelRuntime,
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }),
    resourceLoaderOptions: resourceOptions,
  });
  const model: Model<'faux'> = { id: 'test', name: 'Test', api: 'faux', provider: 'local', baseUrl: 'http://unused.invalid', reasoning: false,
    input: ['text'], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  for (const [create, durable] of [[sdk.createAgentSessionFromServices, false], [createAgentSessionFromServices, true]] as const) {
    const { session } = await create({ services, sessionManager: sdk.SessionManager.inMemory(cwd), model, noTools: 'all' });
    try {
      expect(session).toBeInstanceOf(sdk.AgentSession);
      expect(session instanceof AgentSession).toBe(durable);
      if (session instanceof AgentSession) expect(session.exportDurableState().activeTools).toEqual([]);
    } finally { session.dispose(); }
  }
});
