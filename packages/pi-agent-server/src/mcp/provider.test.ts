/** Provider credentials stay live and separate from MCP OAuth grants. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryAuthStorageBackend, McpOAuthCredentialStore } from '@mkagent/coding-runtime/mcp-oauth';
import { loadMcpTools } from './extension.ts';
import { McpServerConnection } from './runtime.ts';
import { startProviderMcpServer } from '../test-fixtures/mcp-provider-server.ts';

test.each(['global', 'extension'] as const)('%s MCP requests use live provider tokens without an OAuth grant', async scope => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-provider-'));
  let token = 'fixture-token-first';
  const server = startProviderMcpServer(() => token);
  let reads = 0;
  class UnusedBackend extends InMemoryAuthStorageBackend {
    override withLock<T>(): T { reads++; throw new Error('MCP must not store provider credentials'); }
  }
  const config = { url: server.url, auth: { provider: 'fixture-provider' }, exposure: 'direct' as const,
    headers: { Authorization: 'Bearer fixture-explicit-header' } };
  if (scope === 'global') writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { live: config } }));
  const providers: string[] = [];
  const mcp = await loadMcpTools({ agentDir: root, cwd: root, version: 'test', debugLog() {},
    credentials: new McpOAuthCredentialStore(new UnusedBackend()),
    providerToken: async provider => { providers.push(provider); return token; },
  });
  try {
    if (scope === 'extension') await mcp.updateRegisteredServers([{ name: 'live', config, extensionPath: '/fixture/provider.ts' }]);
    const connection = mcp.connections[0]!;
    expect(connection.state).toBe('connected');
    expect(mcp.tools.map(tool => tool.name)).toContain('mcp__live__hello');
    expect((await connection.callTool('hello', {}, {})).content).toEqual([{ type: 'text', text: 'fixture provider greeting' }]);
    token = 'fixture-token-rotated';
    expect((await connection.callTool('hello', {}, {})).content).toEqual([{ type: 'text', text: 'fixture provider greeting' }]);
    expect(server.requests.filter(request => request.method === 'tools/call')).toHaveLength(2);
    expect(server.requests.every(request => request.authorized)).toBe(true);
    expect(providers.length).toBeGreaterThan(2);
    expect(providers.every(provider => provider === 'fixture-provider')).toBe(true);
    expect(reads).toBe(0);
    expect(connection.oauthUrl).toBeUndefined();
  } finally { await mcp.close(); server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('provider rejection retains needs-auth without OAuth discovery or replaying the tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-provider-rejected-'));
  let accepted = 'fixture-valid';
  const server = startProviderMcpServer(() => accepted);
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({
    mcpServers: { live: { url: server.url, auth: { provider: 'fixture-provider' }, exposure: 'direct' } },
  }));
  const mcp = await loadMcpTools({ agentDir: root, cwd: root, version: 'test', debugLog() {},
    providerToken: async () => 'fixture-valid',
  });
  try {
    const connection = mcp.connections[0]!;
    expect(connection.state).toBe('connected');
    accepted = 'fixture-invalidates-old-token';
    await expect(connection.callTool('hello', {}, {})).rejects.toThrow('credentials for provider "fixture-provider"');
    expect(server.requests.filter(request => request.method === 'tools/call')).toHaveLength(1);
    expect(connection.state).toBe('needs-auth');
    expect(mcp.tools).toEqual([]);
    expect(connection.authProvider?.onUnauthorized).toBeUndefined();
  } finally { await mcp.close(); server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('closing a connection suppresses a provider token that is still resolving', async () => {
  const token = Promise.withResolvers<string>();
  let reads = 0;
  const connection = new McpServerConnection({
    entry: { name: 'live', config: { url: 'https://example.invalid/mcp', auth: { provider: 'fixture' } }, scope: 'global' },
    cwd: tmpdir(), version: 'test', log: undefined, onTools() {}, onChange() {},
    providerToken: async () => { reads++; return token.promise; },
    createTransport() { throw new Error('This test never opens a network connection'); },
  });
  const pending = connection.authProvider!.token();
  await connection.close();
  token.resolve('fixture-token');
  expect(await pending).toBeUndefined();
  expect(await connection.authProvider!.token()).toBeUndefined();
  expect(reads).toBe(1);
});

test.each([
  { scope: 'global', url: 'http://example.invalid/mcp' },
  { scope: 'project', url: 'https://example.invalid/mcp' },
] as const)('$scope provider credentials cannot cross the URL or project boundary', async ({ scope, url }) => {
  let reads = 0;
  const connection = new McpServerConnection({
    entry: { name: 'denied', config: { url, auth: { provider: 'fixture' } }, scope },
    cwd: tmpdir(), version: 'test', log: undefined, onTools() {}, onChange() {},
    providerToken: async () => { reads++; return 'fixture-token'; },
    createTransport() { throw new Error('This test never opens a network connection'); },
  });
  try {
    expect(await connection.authProvider?.token()).toBeUndefined();
    expect(connection.oauthUrl).toBeUndefined();
    expect(reads).toBe(0);
  } finally { await connection.close(); }
});
