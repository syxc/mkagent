/** Scope challenges require explicit authorization and never replay a rejected tool call. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamableHttpTransport } from '@earendil-works/pi-mcp';
import type { ExtensionAPI, ExtensionCommandContext } from '@mkagent/pi-durable-coding/native';
import {
  InMemoryAuthStorageBackend, McpOAuthCredentialStore, signInMcpServer,
} from '@mkagent/pi-durable-coding/mcp-oauth';
import { startOAuthMcpServer } from '../../../pi-durable-coding/test/fixtures/upstream/mcp-oauth-server.ts';
import { McpAuthorization } from './authorization.ts';
import { McpServerConnection } from './runtime.ts';

test('insufficient_scope withdraws tools until explicit login merges the new scope without replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-scope-challenge-'));
  const server = await startOAuthMcpServer();
  const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
  let requireScope = true;
  let dispatches = 0;
  const connection = new McpServerConnection({
    entry: { name: 'issues', config: { url: server.url, oauth: { scope: 'issues:read' } }, scope: 'global' },
    cwd: root, credentials, version: 'test', log: undefined, onTools() {}, onChange() {},
    createTransport: (_entry, _cwd, authProvider) => new StreamableHttpTransport({
      url: server.url, authProvider,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === '/mcp' && init?.method === 'POST'
          && JSON.parse(String(init.body)).method === 'tools/call') {
          dispatches++;
          if (requireScope) return new Response(null, { status: 403, headers: {
            'www-authenticate': `Bearer error="insufficient_scope", scope="issues:write", resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', server.url)}"`,
          } });
        }
        return fetch(input, init);
      },
    }),
  });
  try {
    const initialCallback = Promise.withResolvers<void>();
    await signInMcpServer({
      serverUrl: server.url, store: credentials.forServer('issues', server.url), settings: connection.oauthSettings(),
      prompt: {
        showAuthorizationUrl(url) { void fetch(url).then(() => initialCallback.resolve(), initialCallback.reject); },
        promptForRedirectUrl: signal => new Promise(resolve =>
          signal.addEventListener('abort', () => resolve(undefined), { once: true })),
      },
    });
    await initialCallback.promise;
    await connection.getClient();
    expect(connection.tools.map(tool => tool.name)).toEqual(['whoami']);
    await expect(connection.callTool('whoami', {}, {})).rejects.toThrow('/mcp login issues');
    expect(dispatches).toBe(1);
    expect(server.log.filter(line => line.startsWith('call '))).toEqual([]);
    expect(connection.state).toBe('needs-auth');
    expect(connection.tools).toEqual([]);
    expect(connection.challenge?.error).toBe('insufficient_scope');
    expect(connection.challenge?.scope).toBe('issues:write');
    expect(server.authorizations).toHaveLength(1);
    expect(server.tokenRequests).toHaveLength(1);

    const notices: Array<{ text: string; level: string }> = [];
    const callback = Promise.withResolvers<void>();
    let handler: Parameters<ExtensionAPI['registerCommand']>[1]['handler'] | undefined;
    const authorization = new McpAuthorization({ credentials, connections: () => [connection], assertOwner() {} });
    authorization.extension()({
      registerCommand(_name, command) { handler = command.handler; },
    } as ExtensionAPI);
    const context = {
      hasUI: true,
      ui: {
        setWidget(_key: string, lines?: string[]) {
          if (lines) void fetch(lines[1]!).then(() => callback.resolve(), callback.reject);
        },
        notify(text: string, level: string) { notices.push({ text, level }); },
        input: (_title: string, _placeholder: string, options: { signal: AbortSignal }) => new Promise(resolve =>
          options.signal.addEventListener('abort', () => resolve(undefined), { once: true })),
      },
    } as ExtensionCommandContext;
    requireScope = false;
    await handler!('login issues', context);
    await callback.promise;
    expect(notices).toEqual([{ text: 'Signed in to MCP server "issues".', level: 'info' }]);
    expect(server.authorizations).toHaveLength(2);
    expect(server.authorizations[1]!.get('scope')?.split(' ').sort()).toEqual(['issues:read', 'issues:write']);
    expect(server.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token')).toEqual([]);
    expect(connection.state).toBe('connected');
    expect(connection.challenge).toBeUndefined();
    expect(connection.tools.map(tool => tool.name)).toEqual(['whoami']);
    expect(dispatches).toBe(1);
    await connection.callTool('whoami', {}, {});
    expect(dispatches).toBe(2);
    expect(server.log.filter(line => line.startsWith('call '))).toHaveLength(1);
  } finally {
    await connection.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
