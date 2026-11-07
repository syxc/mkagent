import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { InMemoryCredentialStore, createProvider } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { NativeModelRegistry } from '../src/native-models.ts';
import { durableFixture, response } from './fixtures/durable-harness.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });
async function setup() {
  const state = await durableFixture([response('registry answer')]);
  cleanup.push(() => rmSync(state.directory, { recursive: true, force: true }));
  cleanup.push(() => state.harness.close(BACKGROUND_CONTEXT));
  return state;
}

describe('native ModelRegistry over host pi-ai Models', () => {
  test('uses host authentication, streaming and provider overrides', async () => {
    const state = await setup();
    const adapter = new NativeModelRegistry(() => state.models);
    await adapter.refreshSnapshot();
    const original = adapter.registry.find('faux', 'local');
    expect(adapter.registry.getAvailable().some(model => model === original)).toBe(true);
    expect(adapter.registry.hasConfiguredAuth(original)).toBe(true);
    expect((await adapter.registry.getApiKeyAndHeaders(original)).ok).toBe(true);
    expect((await adapter.registry.streamSimple(original, { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }).result()).content)
      .toEqual([{ type: 'text', text: 'registry answer' }]);
    adapter.registry.registerProvider('faux', { models: [{ ...original, id: 'registered' }] });
    expect(adapter.registry.find('faux', 'registered')).toBeDefined();
    adapter.registry.unregisterProvider('faux');
    expect(adapter.registry.find('faux', 'registered')).toBeUndefined();
    expect(adapter.registry.find('faux', 'local')).toBe(original);
  });

  test('reapplies extension provider declarations after a host runtime replacement', async () => {
    const state = await setup();
    let source = state.models;
    const adapter = new NativeModelRegistry(() => source);
    const original = source.getProvider('faux')!;
    const model = source.getModel('faux', 'local')!;
    adapter.registry.registerProvider('faux', { models: [{ ...model, id: 'registered' }] });
    source = builtinModels({ credentials: new InMemoryCredentialStore() });
    source.setProvider(original);
    expect(adapter.registry.find('faux', 'registered')).toBeDefined();
    adapter.registry.unregisterProvider('faux');
    expect(source.getProvider('faux')).toBe(original);
    expect(adapter.registry.find('faux', 'registered')).toBeUndefined();
  });

  test('removes a newly registered native provider after repeated registration', async () => {
    const state = await setup();
    const adapter = new NativeModelRegistry(() => state.models);
    const model = { ...state.models.getModel('faux', 'local')!, provider: 'plugin' };
    const provider = createProvider({
      id: 'plugin', name: 'Plugin', models: [model],
      auth: { apiKey: { name: 'Local fixture', resolve: async () => ({ auth: { apiKey: 'test-only-placeholder' } }) } },
      api: { faux: { stream: () => { throw new Error('Unexpected request'); }, streamSimple: () => { throw new Error('Unexpected request'); } } },
    });
    adapter.registry.registerProvider(provider);
    adapter.registry.registerProvider(provider);
    expect(adapter.registry.find('plugin', 'local')).toBeDefined();
    adapter.registry.unregisterProvider('plugin');
    expect(state.models.getProvider('plugin')).toBeUndefined();
  });

  test('honors an extension provider that opts out of the Authorization header', async () => {
    const state = await setup();
    const adapter = new NativeModelRegistry(() => state.models);
    adapter.registry.registerProvider('faux', { authHeader: false, headers: { 'X-Local-Test': 'fixture' } });
    const result = await adapter.registry.getApiKeyAndHeaders(adapter.registry.find('faux', 'local'));
    expect(result.ok).toBe(true);
    expect(result.headers?.['X-Local-Test']).toBe('fixture');
    expect(result.headers?.Authorization).toBeUndefined();
  });

  test('exposes an anonymous native provider without inventing a key requirement', async () => {
    const state = await setup();
    const adapter = new NativeModelRegistry(() => state.models);
    const model = { ...state.models.getModel('faux', 'local')!, provider: 'public' };
    const base = state.models.getProvider('faux')!;
    adapter.registry.registerProvider(createProvider({
      id: 'public', models: [model], auth: {},
      api: { faux: { stream: base.stream, streamSimple: base.streamSimple } },
    }));
    expect(await adapter.registry.getApiKeyAndHeaders(model)).toEqual({ ok: true, headers: undefined });
  });

  test('invalidates auth snapshots when the host replaces its collection', async () => {
    const state = await setup();
    let source = state.models;
    const adapter = new NativeModelRegistry(() => source);
    const model = source.getModel('faux', 'local')!;
    await adapter.refreshSnapshot();
    expect(adapter.registry.hasConfiguredAuth(model)).toBe(true);
    source = builtinModels({ credentials: new InMemoryCredentialStore() });
    expect(adapter.registry.hasConfiguredAuth(model)).toBe(false);
  });
});
