/** Keep authentication and requests on the caller's explicit context. */
import { expect, test } from 'bun:test';
import {
  createAssistantMessageEventStream, createModels, createProvider, InMemoryCredentialStore,
  type Api, type AssistantMessage, type AuthContext, type Model,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

function fixture(label: string) {
  const calls: string[] = [], requests: Array<string | undefined> = [];
  const authContext: AuthContext = {
    async env(name) { calls.push(name); return name === 'AUTH_CONTEXT_FIXTURE' ? label : undefined; },
    async fileExists(path) { calls.push(path); return path === '/fixture/auth'; },
  };
  const credentials = ModelRuntime.createCredentials(new InMemoryCredentialStore());
  const selected: Model<Api> = {
    id: 'physical', provider: 'auth-context-fixture', name: 'Fixture', api: 'fixture',
    baseUrl: 'https://unused.invalid', reasoning: false, input: ['text'], contextWindow: 1024, maxTokens: 32,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  function stream(model: Model<Api>, _context: unknown, options?: { apiKey?: string }) {
    requests.push(options?.apiKey);
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'fixture' }], stopReason: 'stop', timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => events.push({ type: 'done', reason: 'stop', message }));
    return events;
  }
  const provider = createProvider({
    id: selected.provider, models: [selected], api: { stream, streamSimple: stream },
    auth: { apiKey: { name: 'Fixture', async resolve({ ctx, credential }) {
      if (ctx !== authContext) throw new Error('Expected explicit auth context');
      if (!await ctx.fileExists('/fixture/auth')) return undefined;
      const key = credential?.type === 'api_key' ? credential.key : await ctx.env('AUTH_CONTEXT_FIXTURE');
      return key ? { auth: { apiKey: key }, source: 'fixture' } : undefined;
    } } },
  });
  const models = createModels({ credentials, authContext });
  models.setProvider(provider);
  return { authContext, credentials, models, provider, selected, calls, requests };
}

test('bound runtime uses explicit auth context for availability, auth and requests', async () => {
  const state = fixture('synthetic-bound');
  const runtime = await ModelRuntime.bind({
    models: () => state.models, credentials: state.credentials, authContext: state.authContext,
  });
  expect(runtime.getAvailableSnapshot().map(model => model.id)).toEqual(['physical']);
  expect(await runtime.checkAuth(state.provider.id)).toMatchObject({ source: 'fixture' });
  expect((await runtime.getAuth(state.provider.id))?.auth.apiKey).toBe('synthetic-bound');
  expect((await runtime.completeSimple(runtime.getModel(state.provider.id, 'physical')!, { messages: [] })).stopReason).toBe('stop');
  expect(state.requests).toEqual(['synthetic-bound']);
  expect(state.calls).toContain('AUTH_CONTEXT_FIXTURE');
  expect(state.calls).toContain('/fixture/auth');
});

test('default runtime creation forwards an explicit auth context to registered providers', async () => {
  const state = fixture('synthetic-create');
  const runtime = await ModelRuntime.create({
    credentials: state.credentials, modelsPath: null, refreshOnCreate: false, authContext: state.authContext,
  });
  runtime.registerNativeProvider(state.provider);
  expect((await runtime.getAuth(state.provider.id))?.auth.apiKey).toBe('synthetic-create');
  expect((await runtime.completeSimple(runtime.getModel(state.provider.id, 'physical')!, { messages: [] })).stopReason).toBe('stop');
  expect(state.requests).toEqual(['synthetic-create']);
});

test('explicit auth contexts stay instance-local across runtime key changes', async () => {
  const first = fixture('synthetic-first'), second = fixture('synthetic-second');
  const bind = (state: ReturnType<typeof fixture>) => ModelRuntime.bind({
    models: () => state.models, credentials: state.credentials, authContext: state.authContext,
  });
  const a = await bind(first), b = await bind(second);
  expect((await a.getAuth(first.provider.id))?.auth.apiKey).toBe('synthetic-first');
  expect((await b.getAuth(second.provider.id))?.auth.apiKey).toBe('synthetic-second');
  await a.setRuntimeApiKey(first.provider.id, 'synthetic-override');
  expect((await a.getAuth(first.provider.id))?.auth.apiKey).toBe('synthetic-override');
  expect((await b.getAuth(second.provider.id))?.auth.apiKey).toBe('synthetic-second');
  await a.removeRuntimeApiKey(first.provider.id);
  expect((await a.getAuth(first.provider.id))?.auth.apiKey).toBe('synthetic-first');
});
