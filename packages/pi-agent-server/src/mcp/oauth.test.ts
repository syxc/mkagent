/** Exercise host connections against the pinned upstream PKCE/refresh server. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamableHttpTransport } from '@earendil-works/pi-mcp';
import {
  FileAuthStorageBackend, InMemoryAuthStorageBackend, McpOAuthCredentialStore, McpSignInCancelledError, signInMcpServer,
} from '@mkagent/coding-runtime/mcp-oauth';
import { startOAuthMcpServer } from '../../../coding-runtime/test/fixtures/upstream/mcp-oauth-server.ts';
import { closeMcpConnections, loadMcpTools } from './extension.ts';
import { McpServerConnection } from './runtime.ts';
import { validateMcpServerConfig } from './mcp-servers.ts';

test('automatic MCP connection retains needs-auth without starting authorization, then refreshes and signs out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-host-oauth-'));
  const server = await startOAuthMcpServer();
  const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: { issues: { url: server.url, exposure: 'direct' } },
  }));
  const mcp = await loadMcpTools({ agentDir, cwd: root, credentials, version: 'test', debugLog() {} });
  try {
    expect(mcp.errors).toEqual([]);
    expect(mcp.connections).toHaveLength(1);
    const connection = mcp.connections[0]!;
    expect(connection.state).toBe('needs-auth');
    expect(mcp.tools).toEqual([]);
    expect(server.registrations).toEqual([]);
    expect(server.authorizations).toEqual([]);
    expect(connection.challenge?.resourceMetadataUrl?.href).toContain('/.well-known/oauth-protected-resource/mcp');
    const authorized = Promise.withResolvers<void>();
    await signInMcpServer({
      serverUrl: server.url, store: credentials.forServer('issues', server.url), settings: connection.oauthSettings(),
      challenge: connection.challenge,
      prompt: {
        showAuthorizationUrl(url) {
          fetch(url).then(response => {
            expect(response.ok).toBe(true);
            authorized.resolve();
          }, authorized.reject);
        },
        promptForRedirectUrl(signal) {
          return new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
        },
      },
    });
    await authorized.promise;
    await connection.reconnect();
    expect(connection.state).toBe('connected');
    expect(mcp.tools.map(tool => tool.name)).toContain('mcp__issues__whoami');
    expect(server.registrations).toHaveLength(1);
    server.expireAccessTokens();
    await Promise.all([connection.callTool('whoami', {}, {}), connection.callTool('whoami', {}, {})]);
    expect(server.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token')).toHaveLength(1);
    expect(await credentials.forServer('other', server.url).load()).toBeUndefined();
    expect(await credentials.forServer('issues', `${server.url}/other`).load()).toBeUndefined();
    const signingOut = connection.signOut();
    expect(await connection.authProvider!.token()).toBeUndefined();
    await signingOut;
    credentials.remove('issues', server.url);
    expect(connection.state).toBe('needs-auth');
    expect(mcp.tools).toEqual([]);
    await expect(connection.getClient()).rejects.toThrow('/mcp login issues');
    expect(server.authorizations).toHaveLength(1);
  } finally {
    await closeMcpConnections(mcp.connections);
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

for (const mutation of ['state', 'path', 'issuer'] as const) {
  test(`MCP sign-in rejects a pasted redirect with the wrong ${mutation}`, async () => {
    const server = await startOAuthMcpServer({ issParameter: true });
    const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
    const redirect = Promise.withResolvers<string>();
    try {
      await expect(signInMcpServer({
        serverUrl: server.url, store: credentials.forServer('issues', server.url), settings: {},
        prompt: {
          showAuthorizationUrl(url) {
            fetch(url, { redirect: 'manual' }).then(response => {
              const location = new URL(response.headers.get('location')!);
              if (mutation === 'state') location.searchParams.set('state', 'wrong-state');
              else if (mutation === 'path') location.pathname = '/other-callback';
              else location.searchParams.set('iss', 'https://wrong-issuer.invalid');
              redirect.resolve(location.href);
            }, redirect.reject);
          },
          promptForRedirectUrl: () => redirect.promise,
        },
      })).rejects.toThrow();
      expect(server.tokenRequests).toEqual([]);
      expect((await credentials.forServer('issues', server.url).load())?.tokens).toBeUndefined();
    } finally { await server.close(); }
  });
}

test('MCP sign-in cancels discovery before any authorization prompt exists', async () => {
  const server = await startOAuthMcpServer();
  const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
  const controller = new AbortController();
  server.stall.add('/.well-known/oauth-protected-resource/mcp');
  let prompts = 0;
  const signingIn = signInMcpServer({
    serverUrl: server.url, store: credentials.forServer('issues', server.url), settings: {},
    signal: controller.signal,
    prompt: { showAuthorizationUrl() { prompts++; }, async promptForRedirectUrl() { prompts++; return undefined; } },
  });
  // Bun's rejects matcher waits during evaluation, so attach an ordinary rejection handler first.
  const cancelled = signingIn.then(() => undefined, error => error);
  try {
    const deadline = Date.now() + 2_000;
    while (!server.stalled.length && Date.now() < deadline) await Bun.sleep(5);
    expect(server.stalled.length).toBeGreaterThan(0);
    controller.abort();
    expect(await cancelled).toBeInstanceOf(McpSignInCancelledError);
    expect(prompts).toBe(0);
    expect(server.registrations).toEqual([]);
  } finally { controller.abort(); await server.close(); }
}, 5_000);

test('closing a connection waits for the rotated refresh token to be saved and reused by a new store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-refresh-close-'));
  const server = await startOAuthMcpServer();
  const file = join(root, 'mcp-auth.json');
  const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), root);
  const rotated = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holdRefresh = false;
  const connection = new McpServerConnection({
    entry: { name: 'issues', config: { url: server.url }, scope: 'global' },
    cwd: root, credentials, version: 'test', log: undefined, onTools() {}, onChange() {},
    createTransport: (_entry, _cwd, authProvider) => new StreamableHttpTransport({
      url: server.url, authProvider, fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (holdRefresh && new URL(input instanceof Request ? input.url : String(input)).pathname === '/token') {
          rotated.resolve();
          await release.promise;
        }
        return response;
      },
    }),
  });
  let reopened: McpServerConnection | undefined;
  try {
    const callback = Promise.withResolvers<void>();
    await signInMcpServer({
      serverUrl: server.url, store: credentials.forServer('issues', server.url), settings: {},
      prompt: {
        showAuthorizationUrl(url) {
          fetch(url).then(() => callback.resolve(), callback.reject);
        },
        promptForRedirectUrl: signal => new Promise(resolve =>
          signal.addEventListener('abort', () => resolve(undefined), { once: true })),
      },
    });
    await callback.promise;
    await connection.getClient();
    server.expireAccessTokens();
    holdRefresh = true;
    const call = connection.callTool('whoami', {}, {}).catch(error => error);
    await rotated.promise;
    let closed = false;
    const closing = connection.close().then(() => { closed = true; });
    await Bun.sleep(5);
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    await call;
    const nextStore = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), root);
    expect((await nextStore.forServer('issues', server.url).load())?.tokens?.refresh_token).toBe('refresh-2');
    reopened = new McpServerConnection({
      entry: connection.entry, cwd: root, credentials: nextStore, version: 'test', log: undefined,
      onTools() {}, onChange() {}, createTransport: (entry, _cwd, authProvider) =>
        new StreamableHttpTransport({ url: entry.config.url!, authProvider }),
    });
    await reopened.getClient();
    expect(reopened.state).toBe('connected');
    expect(server.authorizations).toHaveLength(1);
    expect(server.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token')).toHaveLength(1);
  } finally {
    release.resolve();
    await connection.close();
    await reopened?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('explicit Authorization headers and provider references do not read the OAuth store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-explicit-auth-'));
  let reads = 0;
  class UnusedBackend extends InMemoryAuthStorageBackend {
    override withLock<T>(): T { reads++; throw new Error('OAuth store must not be used'); }
  }
  const credentials = new McpOAuthCredentialStore(new UnusedBackend());
  const headers: Array<string | null> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    headers.push(request.headers.get('authorization'));
    return new Response(null, { status: 401 });
  } });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers: {
    header: { url, headers: { aUtHoRiZaTiOn: 'Bearer fixture-header' } },
    provider: { url, auth: { provider: 'fixture-provider' } },
    missing: { url, auth: { provider: 'missing-provider' } },
  } }));
  let mcp: Awaited<ReturnType<typeof loadMcpTools>> | undefined;
  try {
    mcp = await loadMcpTools({ agentDir: root, cwd: root, credentials, version: 'test', debugLog() {},
      providerToken: async provider => provider === 'fixture-provider' ? 'fixture-provider-token' : undefined,
    });
    expect(mcp.connections.map(connection => [connection.name, connection.state]))
      .toEqual([['missing', 'needs-auth'], ['provider', 'needs-auth']]);
    expect(mcp.errors).toHaveLength(1);
    expect(headers).toContain('Bearer fixture-header');
    expect(headers).toContain('Bearer fixture-provider-token');
    expect(headers).toContain(null);
    expect(reads).toBe(0);
  } finally { await mcp?.close(); server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test('remote plaintext HTTP cannot acquire or send OAuth tokens', async () => {
  const url = 'http://remote.example.invalid/mcp';
  const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
  await credentials.forServer('remote', url).save({ serverUrl: url, tokens: { access_token: 'fixture-grant', token_type: 'Bearer' } });
  const connection = new McpServerConnection({
    entry: { name: 'remote', config: { url }, scope: 'global' }, cwd: tmpdir(), credentials,
    version: 'test', log: undefined, onTools() {}, onChange() {},
    createTransport() { throw new Error('No network is allowed in this test'); },
  });
  try {
    expect(connection.oauthUrl).toBeUndefined();
    expect(await connection.authProvider?.token()).toBeUndefined();
    expect(typeof validateMcpServerConfig('remote', { url, oauth: {} })).toBe('string');
    expect(typeof validateMcpServerConfig('anonymous', { url })).toBe('object');
  } finally { await connection.close(); }
});

test('host MCP accepts the pinned native automatic client-registration mode', () => {
  const config = validateMcpServerConfig('auto', {
    url: 'https://example.invalid/mcp', oauth: { clientRegistration: 'auto' },
  });
  expect(typeof config).toBe('object');
});
