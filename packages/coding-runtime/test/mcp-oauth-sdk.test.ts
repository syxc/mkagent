import { expect, test } from 'bun:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as oauth from '../src/mcp-oauth.ts';

const serverUrl = 'https://fixture.invalid/mcp';

test('the host OAuth facade uses the SDK classes and functions', () => {
  for (const name of ['McpOAuthCredentialStore', 'McpSignInCancelledError', 'createMcpAuthProvider', 'signInMcpServer'] as const) {
    expect(oauth[name]).toBe(sdk[name]);
  }
  const credentials = new oauth.McpOAuthCredentialStore(new oauth.InMemoryAuthStorageBackend());
  const options: sdk.McpExtensionOptions = { credentials };
  expect(options.credentials).toBeInstanceOf(sdk.McpOAuthCredentialStore);
});

test('legacy grants migrate once and remain isolated by server name and URL', async () => {
  const backend = new oauth.InMemoryAuthStorageBackend();
  const state = { tokens: { access_token: 'fixture-access', token_type: 'Bearer', refresh_token: 'fixture-refresh' } };
  backend.withLock(() => ({ result: undefined, next: JSON.stringify({ [serverUrl]: state }) }));
  const credentials = new oauth.McpOAuthCredentialStore(backend);
  expect(credentials.tokens('issues', serverUrl)).toEqual(state.tokens);
  expect(await credentials.forServer('issues', serverUrl).load()).toEqual(state);
  expect(await credentials.forServer('other', serverUrl).load()).toBeUndefined();
  expect(await credentials.forServer('issues', serverUrl + '/other').load()).toBeUndefined();
  const stored = backend.withLock(content => ({ result: JSON.parse(content!) }));
  expect(stored[serverUrl]).toBeUndefined();
  expect(stored['mcp__issues|' + serverUrl]).toEqual(state);
  expect(credentials.remove('issues', serverUrl)).toBe(true);
  expect(credentials.tokens('issues', serverUrl)).toBeUndefined();
});

test('an aborted command without a file lock cannot mutate a grant', async () => {
  const store = new oauth.McpOAuthCredentialStore(new oauth.InMemoryAuthStorageBackend()).forServer('issues', serverUrl);
  const controller = new AbortController();
  controller.abort();
  let mutations = 0;
  await expect(store.withRefreshLock(async () => { mutations++; }, controller.signal)).rejects.toHaveProperty('name', 'AbortError');
  expect(mutations).toBe(0);
});

test('an active grant write completes after cancellation', async () => {
  const store = new oauth.McpOAuthCredentialStore(new oauth.InMemoryAuthStorageBackend()).forServer('issues', serverUrl);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<void>();
  const mutation = store.withRefreshLock(async () => {
    entered.resolve();
    await response.promise;
    await store.save({ tokens: { access_token: 'fixture-rotated', token_type: 'Bearer' } });
  }, controller.signal);
  await entered.promise;
  controller.abort();
  response.resolve();
  await mutation;
  expect((await store.load())?.tokens?.access_token).toBe('fixture-rotated');
});
