import { describe, expect, test } from 'bun:test';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type AuthCheck,
  type Model,
  type Models,
  type OAuthAuth,
  type ProviderAuth,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';

const authContext = { env: async () => undefined, fileExists: async () => false };
const storedKey = { type: 'api_key', key: 'synthetic-stored' } as const;
const apiKey: ProviderAuth = {
  apiKey: {
    name: 'Synthetic API key',
    resolve: async ({ credential }) => credential?.key
      ? { auth: { apiKey: credential.key }, source: 'synthetic' }
      : undefined,
  },
};

function model(provider = 'host', id = 'physical'): Model<Api> {
  return {
    id, provider, name: id, api: 'fixture', baseUrl: 'https://unused.invalid',
    reasoning: false, input: ['text'], contextWindow: 1024, maxTokens: 32,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function stream(selected: Model<Api>) {
  const events = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
    content: [{ type: 'text', text: selected.id }], stopReason: 'stop', timestamp: 1,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => events.push({ type: 'done', reason: 'stop', message }));
  return events;
}

function provider(id = 'host', ids = ['physical'], auth: ProviderAuth = apiKey) {
  return createProvider({
    id, auth, models: ids.map(value => model(id, value)),
    api: { stream, streamSimple: stream },
  });
}

function fixture() {
  const store = new InMemoryCredentialStore();
  const credentials = ModelRuntime.createCredentials(store);
  const models = createModels({ credentials, authContext });
  models.setProvider(provider());
  return { store, credentials, models };
}

describe('native ModelRuntime bound to host Models', () => {
  test('keeps the SDK default creation path and rejects a recursive host source', async () => {
    const ordinary = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    expect(ordinary.getProviders().some(value => value.id === 'anthropic')).toBe(true);
    expect(ordinary.getModels().length).toBeGreaterThan(0);
    const state = fixture();
    let source: Models = state.models;
    const bound = await ModelRuntime.bind({
      models: () => source, credentials: state.credentials, refreshOnCreate: false,
    });
    source = bound;
    expect(() => bound.getProviders()).toThrow('Host models source must not return its bound runtime.');
  });

  test('refreshes availability automatically when the host collection or provider changes', async () => {
    const state = fixture();
    await state.store.modify('host', async () => storedKey);
    let source = state.models;
    const runtime = await ModelRuntime.bind({ models: () => source, credentials: state.credentials });
    const registry = new ModelRegistry(runtime);
    expect(registry.getAvailable().map(value => value.id)).toEqual(['physical']);
    source = createModels({ credentials: state.credentials, authContext });
    source.setProvider(provider('host', ['replaced']));
    expect(runtime.getModel('host', 'replaced')).toBeDefined();
    await yieldToEventLoop();
    expect(registry.getAvailable().map(value => value.id)).toEqual(['replaced']);
    source.setProvider(provider('host', ['in-place']));
    expect(runtime.getModel('host', 'in-place')).toBeDefined();
    await yieldToEventLoop();
    expect(registry.getAvailable().map(value => value.id)).toEqual(['in-place']);
  });

  test('owns extension overlays and restores the current host provider after replacement', async () => {
    const state = fixture();
    await state.store.modify('host', async () => storedKey);
    let source = state.models;
    const runtime = await ModelRuntime.bind({ models: () => source, credentials: state.credentials });
    const registry = new ModelRegistry(runtime);
    const original = source.getProvider('host');
    expect(runtime).toBeInstanceOf(ModelRuntime);
    expect(registry.getAvailable().map(value => value.id)).toEqual(['physical']);

    registry.registerProvider('host', {
      models: [model('host', 'extension')],
      headers: { 'X-Fixture': 'overlay' },
    });
    registry.registerProvider('host', { name: 'Extension label' });
    expect(source.getProvider('host')).toBe(original);
    expect(source.getModel('host', 'extension')).toBeUndefined();
    expect(registry.find('host', 'extension')).toBeDefined();
    expect(runtime.getRegisteredProviderConfig('host')?.headers).toEqual({ 'X-Fixture': 'overlay' });

    const next = createModels({ credentials: state.credentials, authContext });
    const replacement = provider('host', ['replacement']);
    next.setProvider(replacement);
    source = next;
    expect(registry.find('host', 'extension')).toBeDefined();
    expect(registry.hasConfiguredAuth(model())).toBe(false);
    await runtime.refresh({ allowNetwork: false });
    expect(registry.hasConfiguredAuth(model())).toBe(true);
    registry.unregisterProvider('host');
    expect(registry.find('host', 'extension')).toBeUndefined();
    expect(registry.find('host', 'replacement')).toBeDefined();
    expect(runtime.getProvider('host')).toBe(replacement);
    expect(source.getProvider('host')).toBe(replacement);
    registry.registerProvider(provider('host', ['native-override']));
    expect(registry.find('host', 'native-override')).toBeDefined();
    expect(source.getProvider('host')).toBe(replacement);
    registry.unregisterProvider('host');
    expect(runtime.getProvider('host')).toBe(replacement);
    await runtime.refresh({ allowNetwork: false });
  });

  test('tracks in-place host provider updates and keeps native and virtual registrations', async () => {
    const state = fixture();
    const runtime = await ModelRuntime.bind({ models: () => state.models, credentials: state.credentials });
    const plugin = provider('plugin', ['native'], {
      apiKey: { name: 'Anonymous fixture', resolve: async () => ({ auth: {} }) },
    });
    runtime.registerNativeProvider(plugin);
    runtime.registerNativeProvider(plugin);
    runtime.registerVirtualModel({
      provider: 'router', id: 'auto', name: 'Auto',
      route: () => ({ model: model('plugin', 'native'), thinkingLevel: 'off' }),
    });
    const replacement = provider('host', ['added']);
    state.models.setProvider(replacement);
    expect(runtime.getModel('host', 'added')).toBeDefined();
    expect(runtime.getModel('plugin', 'native')).toBeDefined();
    expect(runtime.getModel('router', 'auto')).toBeDefined();
    expect(state.models.getProvider('plugin')).toBeUndefined();
    expect(state.models.getProvider('router')).toBeUndefined();
    state.models.deleteProvider('host');
    expect(runtime.getProvider('host')).toBeUndefined();
    expect(runtime.getProvider('plugin')).toBe(plugin);
    runtime.unregisterProvider('plugin');
    runtime.unregisterVirtualModel('router', 'auto');
    expect(runtime.getProvider('plugin')).toBeUndefined();
    expect(runtime.getProvider('router')).toBeUndefined();
    await runtime.refresh({ allowNetwork: false });
  });

  test('routes virtual requests to the latest host model without forwarding another provider auth', async () => {
    const state = fixture();
    await state.store.modify('host', async () => storedKey);
    const calls: Array<{ selected: Model<Api>; options?: SimpleStreamOptions }> = [];
    state.models.setProvider(createProvider({
      id: 'host', auth: apiKey, models: [model()],
      api: {
        stream,
        streamSimple: (selected, _context, options) => {
          calls.push({ selected, options });
          return stream(selected);
        },
      },
    }));
    const runtime = await ModelRuntime.bind({ models: () => state.models, credentials: state.credentials });
    runtime.registerVirtualModel({
      provider: 'router', id: 'auto', name: 'Auto', thinkingLevels: ['off', 'high'],
      route: request => ({
        model: model(), thinkingLevel: request.thinkingLevel, state: { count: 1 },
      }),
    });
    const virtual = runtime.getModel('router', 'auto')!;
    await runtime.refresh({ allowNetwork: false });
    const route = await runtime.resolveModel(virtual, [], { reason: 'user', thinkingLevel: 'high' });
    expect(route.model).toBe(state.models.getModel('host', 'physical')!);
    expect(route.thinkingLevel).toBe('off');
    expect(route.state).toEqual({ count: 1 });
    const result = await runtime.completeSimple(virtual, { messages: [] }, {
      apiKey: 'synthetic-router-only', headers: { 'X-Router-Only': 'fixture' },
      env: { ROUTER_ONLY: 'fixture' }, maxTokens: 100, reasoning: 'high',
    });
    expect(result.model).toBe('physical');
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.apiKey).toBe(storedKey.key);
    expect(calls[0].options?.headers?.['X-Router-Only']).toBeUndefined();
    expect(calls[0].options?.env?.ROUTER_ONLY).toBeUndefined();
    expect(calls[0].options?.maxTokens).toBe(32);
    expect(calls[0].options?.reasoning).toBeUndefined();
    expect(() => runtime.registerVirtualModel({
      provider: 'host', id: 'physical', name: 'Collision',
      route: () => ({ model: model(), thinkingLevel: 'off' }),
    })).toThrow('conflicts with a physical model');
  });

  test('shares runtime keys with the host without persisting or losing the stored credential', async () => {
    const state = fixture();
    await state.store.modify('host', async () => storedKey);
    const runtime = await ModelRuntime.bind({ models: () => state.models, credentials: state.credentials });
    await runtime.setRuntimeApiKey('host', 'synthetic-runtime');
    expect((await runtime.getAuth('host'))?.auth.apiKey).toBe('synthetic-runtime');
    expect((await state.models.getAuth('host'))?.auth.apiKey).toBe('synthetic-runtime');
    expect(await state.store.read('host')).toEqual(storedKey);
    expect(runtime.getProviderAuthStatus('host')).toEqual({ configured: true, source: 'runtime' });
    expect(runtime.getAvailableSnapshot().map(value => value.id)).toEqual(['physical']);
    await runtime.removeRuntimeApiKey('host');
    expect((await state.models.getAuth('host'))?.auth.apiKey).toBe(storedKey.key);
    expect(runtime.getProviderAuthStatus('host')).toEqual({ configured: true, source: 'stored' });

    await state.store.delete('host');
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.hasConfiguredAuth('host')).toBe(false);
    await runtime.setRuntimeApiKey('host', 'synthetic-runtime-only');
    expect(runtime.hasConfiguredAuth('host')).toBe(true);
    expect(await state.store.list()).toEqual([]);
    await runtime.removeRuntimeApiKey('host');
    expect(runtime.hasConfiguredAuth('host')).toBe(false);
    expect(await state.models.getAuth('host')).toBeUndefined();
  });

  test('keeps stored mutations beneath runtime keys and exposes only credential metadata', async () => {
    const state = fixture();
    const stored = { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 1 } as const;
    await state.store.modify('host', async () => stored);
    state.credentials.setRuntimeApiKey('host', 'synthetic-runtime');
    state.credentials.setRuntimeApiKey('runtime-only', 'synthetic-runtime-only');
    expect(await state.credentials.list()).toEqual([
      { providerId: 'host', type: 'api_key' },
      { providerId: 'runtime-only', type: 'api_key' },
    ]);
    expect(await state.store.list()).toEqual([{ providerId: 'host', type: 'oauth' }]);

    const updated = await state.credentials.modify('host', async current => {
      expect(current).toEqual(stored);
      return storedKey;
    });
    expect(updated).toEqual(storedKey);
    expect(await state.store.read('host')).toEqual(storedKey);
    expect(await state.credentials.read('host')).toEqual({ type: 'api_key', key: 'synthetic-runtime' });
    state.credentials.removeRuntimeApiKey('host');
    expect(await state.credentials.read('host')).toEqual(storedKey);
    await state.credentials.delete('runtime-only');
    expect(state.credentials.hasRuntimeApiKey('runtime-only')).toBe(false);
    expect(await state.store.read('runtime-only')).toBeUndefined();
  });

  test('preserves runtime keys on failed or cancelled credential operations', async () => {
    const state = fixture();
    await state.store.modify('host', async () => storedKey);
    state.credentials.setRuntimeApiKey('host', 'synthetic-runtime');
    const failure = new Error('Synthetic storage failure');
    const remove = state.store.delete;
    state.store.delete = async () => { throw failure; };
    await expect(state.credentials.delete('host')).rejects.toBe(failure);
    state.store.delete = remove;
    expect(state.credentials.hasRuntimeApiKey('host')).toBe(true);

    const cancelled = new Error('Synthetic cancellation');
    const options = { signal: AbortSignal.abort(cancelled) };
    await expect(state.credentials.read('host', options)).rejects.toBe(cancelled);
    await expect(state.credentials.list(options)).rejects.toBe(cancelled);
    await expect(state.credentials.modify('host', async () => undefined, options)).rejects.toBe(cancelled);
    await expect(state.credentials.delete('host', options)).rejects.toBe(cancelled);
    expect(await state.store.read('host')).toEqual(storedKey);
    expect(await state.credentials.read('host')).toEqual({ type: 'api_key', key: 'synthetic-runtime' });
    await state.credentials.delete('host');
    expect(state.credentials.hasRuntimeApiKey('host')).toBe(false);
    expect(await state.store.read('host')).toBeUndefined();
  });

  test('keeps OAuth snapshots side-effect-free and serializes refresh through the host store', async () => {
    const state = fixture();
    let refreshes = 0;
    const expired = { type: 'oauth', access: 'synthetic-expired', refresh: 'synthetic-refresh', expires: 1 } as const;
    const loggedIn = {
      type: 'oauth', access: 'synthetic-login', refresh: 'synthetic-login-refresh', expires: Number.MAX_SAFE_INTEGER,
    } as const;
    const oauth: OAuthAuth = {
      name: 'Synthetic OAuth', isSubscription: true,
      login: async () => loggedIn,
      refresh: async credential => {
        refreshes++;
        return { ...credential, access: 'synthetic-refreshed', expires: Number.MAX_SAFE_INTEGER };
      },
      toAuth: async credential => ({ apiKey: credential.access }),
    };
    state.models.setProvider(provider('host', ['physical'], { ...apiKey, oauth }));
    await state.store.modify('host', async () => expired);
    const runtime = await ModelRuntime.bind({ models: () => state.models, credentials: state.credentials });
    expect(runtime.isUsingOAuth('host')).toBe(true);
    expect(runtime.isUsingSubscription('host')).toBe(true);
    expect(runtime.getAvailableSnapshot()).toHaveLength(1);
    expect(refreshes).toBe(0);
    const resolved = await Promise.all([runtime.getAuth('host'), state.models.getAuth('host')]);
    expect(resolved.map(value => value?.auth.apiKey)).toEqual(['synthetic-refreshed', 'synthetic-refreshed']);
    expect(refreshes).toBe(1);
    expect((await state.store.read('host'))?.type).toBe('oauth');

    await runtime.setRuntimeApiKey('host', 'synthetic-runtime');
    expect(runtime.isUsingOAuth('host')).toBe(false);
    expect((await state.models.getAuth('host'))?.auth.apiKey).toBe('synthetic-runtime');
    await runtime.removeRuntimeApiKey('host');
    expect(runtime.isUsingOAuth('host')).toBe(true);
    expect(await runtime.login('host', 'oauth', { prompt: async () => '', notify: () => {} })).toEqual(loggedIn);
    expect(await state.store.read('host')).toEqual(loggedIn);
    expect((await state.models.getAuth('host'))?.auth.apiKey).toBe(loggedIn.access);
    await runtime.logout('host');
    expect(await state.store.read('host')).toBeUndefined();
    expect(runtime.hasConfiguredAuth('host')).toBe(false);
    expect(runtime.isUsingOAuth('host')).toBe(false);
    expect(runtime.getAvailableSnapshot()).toEqual([]);
  });

  test('supports extension OAuth registration through the native compatibility contract', async () => {
    const state = fixture();
    const runtime = await ModelRuntime.bind({ models: () => state.models, credentials: state.credentials });
    runtime.registerProvider('extension', {
      api: 'fixture', baseUrl: 'https://unused.invalid',
      models: [model('extension')], streamSimple: stream,
      oauth: {
        name: 'Extension OAuth', isSubscription: true,
        login: async () => ({
          access: 'synthetic-extension', refresh: 'synthetic-extension-refresh', expires: Number.MAX_SAFE_INTEGER,
        }),
        refreshToken: async credential => credential,
        getApiKey: credential => credential.access,
      },
    });
    await runtime.login('extension', 'oauth', { prompt: async () => '', notify: () => {} });
    expect((await state.store.read('extension'))?.type).toBe('oauth');
    expect(runtime.isUsingOAuth('extension')).toBe(true);
    expect(runtime.isUsingSubscription('extension')).toBe(true);
    expect((await runtime.getAuth('extension'))?.auth.apiKey).toBe('synthetic-extension');
    expect(state.models.getProvider('extension')).toBeUndefined();
    runtime.unregisterProvider('extension');
    expect(runtime.getModel('extension', 'physical')).toBeUndefined();
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.hasConfiguredAuth('extension')).toBe(false);
  });

  test('discards availability checks completed for a superseded host collection', async () => {
    const state = fixture();
    let unblock!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const checking = new Promise<void>(resolve => { started = resolve; });
    state.models.setProvider(provider('host', ['old'], {
      apiKey: {
        name: 'Blocked auth',
        check: async (): Promise<AuthCheck> => {
          started();
          await blocked;
          return { type: 'api_key', source: 'old host' };
        },
        resolve: async () => ({ auth: {} }),
      },
    }));
    let source: Models = state.models;
    const runtime = await ModelRuntime.bind({
      models: () => source, credentials: state.credentials, refreshOnCreate: false,
    });
    const pending = runtime.getAvailable();
    await checking;
    const replacement = createModels({ credentials: state.credentials, authContext });
    replacement.setProvider(provider('host', ['new']));
    source = replacement;
    expect(runtime.getModel('host', 'new')).toBeDefined();
    unblock();
    await pending;
    expect(runtime.getAvailableSnapshot()).toEqual([]);
    expect(runtime.hasConfiguredAuth('host')).toBe(false);
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getAvailableSnapshot()).toEqual([]);
  });

  test('refreshes host providers through their original collection and catalog store', async () => {
    const state = fixture();
    const refreshes: Array<Parameters<Models['refresh']>[0]> = [];
    const host = new Proxy(state.models, {
      get(target, property) {
        if (property === 'refresh') return async (options: Parameters<Models['refresh']>[0]) => {
          refreshes.push(options);
          return target.refresh(options);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = await ModelRuntime.bind({ models: () => host, credentials: state.credentials });
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.allowNetwork).toBe(false);
    expect(refreshes[0]?.providers).toEqual(['host']);
    await runtime.refresh({ providers: ['host'], allowNetwork: false });
    expect(refreshes).toHaveLength(2);
    expect(state.models.getProviders()).toHaveLength(1);
  });
});
