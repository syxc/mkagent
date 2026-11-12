/** Exercise host authentication against native Models, AgentSession commands and epoch-scoped RPC UI. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension } from '@earendil-works/pi-durable';
import { ModelRuntime, prepareHostResources } from '@mkagent/coding-runtime/native';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { durableFixture } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { ExtensionUIHost, type ExtensionUIEvent } from './extension-ui.ts';
import { DurableKernel } from './kernel.ts';
import { ProviderAuthorization } from './provider-authorization.ts';
import { providerLoginExtension, syntheticAccess } from './test-fixtures/provider-login.ts';

type Request = Extract<ExtensionUIEvent, { type: 'extension_ui_request' }>;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await durableFixture([]);
  await root.harness.close(BACKGROUND_CONTEXT);
  cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const resultPath = join(root.directory, 'result.json');
  const events: ExtensionUIEvent[] = [];
  const listeners = new Set<() => void>();
  const ui = new ExtensionUIHost(event => {
    events.push(event);
    for (const listener of [...listeners]) listener();
  });
  ui.setAvailable(true);
  let kernel: DurableKernel;
  const changes: string[] = [];
  const credentials = ModelRuntime.createCredentials(new InMemoryCredentialStore());
  const authorization = new ProviderAuthorization({
    models: () => kernel.currentModels(), assertOwner: () => {},
    inputSecret: (title, placeholder, signal) => ui.inputSecret(title, placeholder, signal),
    changed: async (provider, action) => { changes.push(`${action}:${provider}`); },
  });
  ui.onUnavailable(() => { void authorization.cancelAll(); });
  const preparedResources = await prepareHostResources({
    cwd: root.directory, agentDir, resourcePolicy: 'host-only',
    globalSettings: { cacheWarming: 'off', compaction: { enabled: false } }, projectSettings: {},
    extensionFactories: [authorization.extension(), providerLoginExtension(resultPath)],
  });
  const errors: string[] = [];
  kernel = new DurableKernel({
    sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
    modelCredentialsSource: () => credentials,
    toolsExtension: defineExtension({ name: 'host', tools: [] }),
    coding: { agentDir, resourcePolicy: 'host-only', preparedResources },
    codingUI: ui, wrapCodingTool: tool => tool,
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: message => errors.push(message) },
  });
  cleanup.push(async () => { await authorization.cancelAll(); await kernel.close(); });
  await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
  const run = async (text: string) => { await kernel.submitPrompt(text); await kernel.waitForIdle(); };
  const request = (start: number, title: string) => {
    const found = Promise.withResolvers<Request>();
    const check = () => {
      const event = events.slice(start).find(event => event.type === 'extension_ui_request'
        && 'title' in event && event.title === title);
      if (event?.type === 'extension_ui_request') { listeners.delete(check); found.resolve(event); }
    };
    const timer = setTimeout(() => { listeners.delete(check); found.reject(new Error(`Missing dialog: ${title}`)); }, 5_000);
    listeners.add(check); check();
    return found.promise.finally(() => clearTimeout(timer));
  };
  const answer = async (title: string, value?: string, start = 0) => {
    const event = await request(start, title);
    expect(ui.respond(event.uiEpoch, { type: 'extension_ui_response', id: event.id,
      ...(value === undefined ? { cancelled: true } : { value }) })).toBe(true);
    return event;
  };
  const oauth = async (start = events.length, chooseProvider = false) => {
    const pending = run(chooseProvider ? '/login' : '/login fixture-login');
    if (chooseProvider) await answer('Provider login', 'fixture-login', start);
    await answer('Sign in: fixture-login', 'OAuth', start);
    await answer('Fixture name', 'fixture-user', start);
    const select = await answer('Fixture account', '2. Account: Second account', start);
    expect(select).toMatchObject({ options: ['1. Account: First account', '2. Account: Second account'] });
    await answer('Fixture code', 'local-code', start);
    const secret = await request(start, 'Fixture secret');
    expect(secret).toMatchObject({ method: 'input', sensitive: true });
    return { pending, secret, start };
  };
  return { root, kernel, ui, authorization, changes, events, errors, run, request, answer, oauth,
    result: () => JSON.parse(readFileSync(resultPath, 'utf8')) };
}

test('native OAuth preserves option IDs, hides secret input and persists across native reload', async () => {
  const f = await fixture();
  const login = await f.oauth(undefined, true);
  expect(f.ui.respond(login.secret.uiEpoch, { type: 'extension_ui_response', id: login.secret.id, value: syntheticAccess })).toBe(true);
  await login.pending;
  expect(f.result()).toEqual({ name: true, account: 'second', code: true, secret: true });
  expect((await f.kernel.currentModels().getAuth('fixture-login'))?.auth.apiKey).toBe(syntheticAccess);
  await f.run('/provider-reload');
  expect((await f.kernel.currentModels().getAuth('fixture-login'))?.auth.apiKey).toBe(syntheticAccess);
  await f.run('/logout fixture-login');
  expect(await f.kernel.currentModels().getAuth('fixture-login')).toBeUndefined();
  expect(JSON.stringify(f.events)).not.toContain(syntheticAccess);
  expect(f.errors.join('\n')).not.toContain(syntheticAccess);
  expect(f.root.calls).toHaveLength(0);
});

test('API-key login uses a secret dialog and compatibility OAuth uses the original callbacks', async () => {
  const f = await fixture();
  let start = f.events.length;
  let pending = f.run('/login fixture-login');
  await f.answer('Sign in: fixture-login', 'API key', start);
  expect(await f.answer('Fixture API key', syntheticAccess, start)).toMatchObject({ sensitive: true });
  await pending;
  expect((await f.kernel.currentModels().getAuth('fixture-login'))?.auth.apiKey).toBe(syntheticAccess);
  await f.run('/logout fixture-login');
  start = f.events.length;
  pending = f.run('/login fixture-legacy');
  await f.answer('Legacy code', 'local-code', start);
  await pending;
  expect((await f.kernel.currentModels().getAuth('fixture-legacy'))?.auth.apiKey).toBe(syntheticAccess);
  expect(f.changes).toContain('login:fixture-legacy');
  await f.run('/logout fixture-legacy');
  expect(await f.kernel.currentModels().getAuth('fixture-legacy')).toBeUndefined();
  expect(f.changes).toContain('logout:fixture-legacy');
  expect(f.root.calls).toHaveLength(0);
});

test('cancel, stop and UI disconnect reject late secret answers without saving credentials', async () => {
  const f = await fixture();
  for (const action of ['cancel', 'stop', 'disconnect'] as const) {
    const login = await f.oauth();
    if (action === 'cancel') {
      expect(f.ui.respond(login.secret.uiEpoch, { type: 'extension_ui_response', id: login.secret.id, cancelled: true })).toBe(true);
    } else if (action === 'stop') await f.kernel.abort();
    else f.ui.setAvailable(false);
    await login.pending;
    f.ui.setAvailable(true);
    expect(f.ui.respond(login.secret.uiEpoch, { type: 'extension_ui_response', id: login.secret.id, value: syntheticAccess })).toBe(false);
    expect(await f.kernel.currentModels().getAuth('fixture-login')).toBeUndefined();
  }
  expect(f.root.calls).toHaveLength(0);
});

test('stop also drains a provider waiting outside a dialog and errors cannot echo entered secrets', async () => {
  const f = await fixture();
  await f.run('/provider-mode fail');
  let login = await f.oauth();
  f.ui.respond(login.secret.uiEpoch, { type: 'extension_ui_response', id: login.secret.id, value: syntheticAccess });
  await login.pending;
  expect(await f.kernel.currentModels().getAuth('fixture-login')).toBeUndefined();
  expect(JSON.stringify(f.events)).not.toContain(syntheticAccess);
  expect(f.errors.join('\n')).not.toContain(syntheticAccess);
  await f.run('/provider-mode wait');
  login = await f.oauth();
  const waiting = Promise.withResolvers<void>();
  const listener = (event: ExtensionUIEvent) => event.type === 'extension_ui_request'
    && event.method === 'setWidget' && event.widgetLines?.includes('Waiting for fixture callback');
  // Wait until the provider has consumed the secret before exercising non-dialog cancellation.
  const original = f.ui.respond.bind(f.ui);
  expect(original(login.secret.uiEpoch, { type: 'extension_ui_response', id: login.secret.id, value: syntheticAccess })).toBe(true);
  const timeout = setTimeout(() => waiting.reject(new Error('Provider callback phase did not start')), 5_000);
  const check = () => { if (f.events.slice(login.start).some(listener)) waiting.resolve(); };
  for (let attempt = 0; attempt < 100 && !f.events.slice(login.start).some(listener); attempt++) await Bun.sleep(1);
  check();
  await waiting.promise.finally(() => clearTimeout(timeout));
  await f.kernel.abort();
  await login.pending;
  expect(await f.kernel.currentModels().getAuth('fixture-login')).toBeUndefined();
  expect(f.root.calls).toHaveLength(0);
});

test('a callback can cancel only its manual prompt while provider selection can be cancelled before login', async () => {
  const f = await fixture();
  await f.run('/provider-mode callback');
  let start = f.events.length;
  let pending = f.run('/login fixture-login');
  await f.answer('Sign in: fixture-login', 'OAuth', start);
  await f.answer('Fixture name', 'fixture-user', start);
  await f.answer('Fixture account', '2. Account: Second account', start);
  const manual = await f.request(start, 'Fixture code');
  await f.answer('Fixture secret', syntheticAccess, start);
  await pending;
  expect(f.ui.respond(manual.uiEpoch, { type: 'extension_ui_response', id: manual.id, value: 'late' })).toBe(false);
  expect((await f.kernel.currentModels().getAuth('fixture-login'))?.auth.apiKey).toBe(syntheticAccess);
  await f.run('/logout fixture-login');
  start = f.events.length;
  pending = f.run('/login');
  const choice = await f.request(start, 'Provider login');
  await f.authorization.cancelAll();
  await pending;
  expect(f.ui.respond(choice.uiEpoch, { type: 'extension_ui_response', id: choice.id, value: 'fixture-login' })).toBe(false);
  expect(await f.kernel.currentModels().getAuth('fixture-login')).toBeUndefined();
  expect(f.root.calls).toHaveLength(0);
});
