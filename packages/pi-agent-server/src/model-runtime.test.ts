import { describe, expect, it } from 'bun:test';
import { OAuthSyncCredentialStore, createModelRuntime, registerCustomEndpointModels } from './model-runtime.ts';

describe('OAuth credential synchronization', () => {
  it('reports the credential actually replaced after queued updates', async () => {
    const updates: Array<{ previousRefresh?: string; credential: { refresh: string } }> = [];
    const store = new OAuthSyncCredentialStore(update => updates.push(update));
    const credential = (refresh: string) => ({ type: 'oauth' as const, access: 'fake', refresh, expires: 1 });
    await store.seed('provider', credential('old'));

    let release!: () => void;
    let notifyStarted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const first = store.modify('provider', async () => {
      notifyStarted();
      await gate;
      return credential('middle');
    });
    await started;
    const second = store.modify('provider', async () => credential('new'));
    release();
    await Promise.all([first, second]);

    expect(updates.map(update => [update.previousRefresh, update.credential.refresh])).toEqual([
      ['old', 'middle'], ['middle', 'new'],
    ]);
  });
});

describe('custom endpoint model catalogs', () => {
  it('keeps model registrations and overrides isolated between runtimes', async () => {
    const endpoint = { api: 'openai-completions' as const };
    const first = await createModelRuntime({
      baseUrl: 'http://first.test', customEndpoint: endpoint,
      customModels: [{ id: 'first-model', contextWindow: 123_456 }],
    }, () => {});
    const second = await createModelRuntime({
      baseUrl: 'http://second.test', customEndpoint: endpoint,
      customModels: [{ id: 'second-model', contextWindow: 234_567 }],
    }, () => {});

    registerCustomEndpointModels({
      models: first.models, api: endpoint.api, baseUrl: 'http://first.test', apiKey: 'fake',
      entries: [{ id: 'first-extra' }],
    });

    expect(first.models.getModel('custom-endpoint', 'first-model')?.contextWindow).toBe(123_456);
    expect(first.models.getModel('custom-endpoint', 'first-extra')).toBeDefined();
    expect(first.models.getModel('custom-endpoint', 'second-model')).toBeUndefined();
    expect(second.models.getModel('custom-endpoint', 'second-model')?.contextWindow).toBe(234_567);
  });
});
