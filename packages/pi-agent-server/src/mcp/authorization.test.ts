/** Coordinate explicit host commands with another credential-store instance. */
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { StreamableHttpTransport } from '@earendil-works/pi-mcp';
import type { ExtensionAPI, ExtensionCommandContext } from '@mkagent/pi-durable-coding/native';
import {
  FileAuthStorageBackend, McpOAuthCredentialStore, createMcpAuthProvider, signInMcpServer,
} from '@mkagent/pi-durable-coding/mcp-oauth';
import { startOAuthMcpServer } from '../../../pi-durable-coding/test/fixtures/upstream/mcp-oauth-server.ts';
import { McpAuthorization } from './authorization.ts';
import { McpServerConnection } from './runtime.ts';

function commands(connection: McpServerConnection, credentials: McpOAuthCredentialStore, signal?: AbortSignal) {
  const notices: Array<{ text: string; level: string }> = [];
  let definition: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
  const controller = new McpAuthorization({ credentials, connections: () => [connection], assertOwner() {} });
  controller.extension()({
    registerCommand(_name, command) { definition = command; },
  } as ExtensionAPI);
  const context = {
    hasUI: true,
    signal,
    ui: {
      setWidget() {},
      notify(text: string, level: string) { notices.push({ text, level }); },
      async input() { return undefined; },
    },
  } as ExtensionCommandContext;
  return {
    controller, notices,
    run: (args: string) => definition!.handler(args, context),
  };
}

test('logout waits for another credential store to finish refreshing, then removes its grant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-shared-logout-'));
  const file = join(root, 'mcp-auth.json');
  const url = 'https://example.invalid/mcp';
  const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), root);
  const other = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), root);
  const otherStore = other.forServer('issues', url);
  await otherStore.save({ serverUrl: url, tokens: { access_token: 'fixture-stale', token_type: 'Bearer' } });
  const connection = new McpServerConnection({
    entry: { name: 'issues', config: { url }, scope: 'global' }, cwd: root, credentials,
    version: 'test', log: undefined, onTools() {}, onChange() {},
    createTransport() { throw new Error('This test must not use the network'); },
  });
  const command = commands(connection, credentials);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refresh = otherStore.withRefreshLock(async () => {
    held.resolve();
    await release.promise;
    await otherStore.save({ serverUrl: url, tokens: { access_token: 'fixture-rotated', token_type: 'Bearer' } });
  });
  let loggingOut: Promise<void> | undefined;
  try {
    await held.promise;
    let finished = false;
    loggingOut = Promise.resolve(command.run('logout issues')).then(() => { finished = true; });
    await Bun.sleep(10);
    const finishedBeforeRelease = finished;
    release.resolve();
    await refresh;
    await loggingOut;
    expect(await otherStore.load()).toBeUndefined();
    expect(finishedBeforeRelease).toBe(false);
    expect(command.notices).toEqual([{ text: 'Signed out of MCP server "issues".', level: 'info' }]);
    expect(await connection.authProvider!.token()).toBeUndefined();
  } finally {
    release.resolve();
    await refresh;
    await loggingOut;
    await connection.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 5_000);

test('cancelling login preserves a refresh rotation whose response already arrived', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-login-cancel-refresh-'));
  const server = await startOAuthMcpServer();
  const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(join(root, 'mcp-auth.json')), root);
  const connection = new McpServerConnection({
    entry: { name: 'issues', config: { url: server.url }, scope: 'global' }, cwd: root, credentials,
    version: 'test', log: undefined, onTools() {}, onChange() {},
    createTransport: (entry, _cwd, authProvider) => new StreamableHttpTransport({
      url: entry.config.url!, authProvider,
    }),
  });
  const release = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  const controller = new AbortController();
  let restore: (() => void) | undefined;
  let login: Promise<unknown> | undefined;
  try {
    const visited = Promise.withResolvers<void>();
    await signInMcpServer({
      serverUrl: server.url, store: credentials.forServer('issues', server.url), settings: {},
      prompt: {
        showAuthorizationUrl(url) { fetch(url).then(() => visited.resolve(), visited.reject); },
        promptForRedirectUrl: signal => new Promise(resolve =>
          signal.addEventListener('abort', () => resolve(undefined), { once: true })),
      },
    });
    await visited.promise;
    const fetcher = globalThis.fetch;
    const spy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await fetcher(input, init);
      if (String(input) === new URL('/token', server.url).href && init?.body instanceof URLSearchParams
        && init.body.get('grant_type') === 'refresh_token') {
        arrived.resolve();
        await release.promise;
      }
      return response;
    });
    restore = () => spy.mockRestore();
    const command = commands(connection, credentials, controller.signal);
    login = Promise.resolve(command.run('login issues'));
    await arrived.promise;
    controller.abort();
    release.resolve();
    await login;
    expect((await credentials.forServer('issues', server.url).load())?.tokens?.refresh_token).toBe('refresh-2');
    expect(command.notices).toEqual([{ text: 'MCP operation cancelled.', level: 'info' }]);
    expect(server.authorizations).toHaveLength(1);
  } finally {
    release.resolve();
    await login;
    restore?.();
    await connection.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 5_000);

test('interactive login waits for a different provider and refreshes its rotated grant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-shared-login-'));
  const file = join(root, 'mcp-auth.json');
  const server = await startOAuthMcpServer();
  const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), root);
  const other = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), root);
  const connection = new McpServerConnection({
    entry: { name: 'issues', config: { url: server.url }, scope: 'global' }, cwd: root, credentials,
    version: 'test', log: undefined, onTools() {}, onChange() {},
    createTransport: (entry, _cwd, authProvider) => new StreamableHttpTransport({
      url: entry.config.url!, authProvider,
    }),
  });
  const release = Promise.withResolvers<void>();
  let refresh: Promise<void> | undefined;
  let login: Promise<unknown> | undefined;
  try {
    const visited = Promise.withResolvers<void>();
    await signInMcpServer({
      serverUrl: server.url, store: credentials.forServer('issues', server.url), settings: {},
      prompt: {
        showAuthorizationUrl(url) { fetch(url).then(() => visited.resolve(), visited.reject); },
        promptForRedirectUrl: signal => new Promise(resolve =>
          signal.addEventListener('abort', () => resolve(undefined), { once: true })),
      },
    });
    await visited.promise;
    await connection.getClient();
    const previous = await other.forServer('issues', server.url).load();
    const rotated = Promise.withResolvers<void>();
    const provider = createMcpAuthProvider({
      serverUrl: server.url, store: other.forServer('issues', server.url), settings: () => ({}), onChallenge() {},
    });
    refresh = provider.onUnauthorized!({
      response: new Response(null, { status: 401 }), serverUrl: new URL(server.url),
      token: previous?.tokens?.access_token,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (new URL(String(input)).pathname === '/token') {
          rotated.resolve();
          await release.promise;
        }
        return response;
      },
    });
    await rotated.promise;
    const command = commands(connection, credentials);
    login = Promise.resolve(command.run('login issues'));
    await Bun.sleep(30);
    release.resolve();
    await refresh;
    await login;
    const requests = server.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token');
    expect(requests.map(request => request.get('refresh_token'))).toEqual(['refresh-1', 'refresh-2']);
    expect((await other.forServer('issues', server.url).load())?.tokens?.refresh_token).toBe('refresh-3');
    expect(server.authorizations).toHaveLength(1);
    expect(command.notices).toEqual([{ text: 'Signed in to MCP server "issues".', level: 'info' }]);
  } finally {
    release.resolve();
    await refresh?.catch(() => undefined);
    await login;
    await connection.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 5_000);

test('a cancelled shared-lock waiter exits without running its grant mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-cancel-lock-'));
  const file = join(root, 'mcp-auth.json');
  const url = 'https://example.invalid/mcp';
  const first = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), root).forServer('issues', url);
  const next = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), root).forServer('issues', url);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  let mutations = 0;
  const holding = first.withRefreshLock(async () => { held.resolve(); await release.promise; });
  let waiter: Promise<unknown> | undefined;
  try {
    await held.promise;
    let settled = false;
    waiter = next.withRefreshLock(async () => { mutations++; }, controller.signal)
      .then(() => { settled = true; }, error => { settled = true; return error; });
    controller.abort();
    await Bun.sleep(10);
    const settledBeforeRelease = settled;
    release.resolve();
    await holding;
    await waiter;
    expect(settledBeforeRelease).toBe(true);
    expect(mutations).toBe(0);
  } finally {
    release.resolve();
    await holding;
    await waiter;
    rmSync(root, { recursive: true, force: true });
  }
}, 5_000);

test('logout in a separate process cannot be undone by another process refreshing the grant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-process-logout-'));
  const file = join(root, 'mcp-auth.json');
  const server = await startOAuthMcpServer();
  const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), root);
  const visited = Promise.withResolvers<void>();
  try {
    await signInMcpServer({
      serverUrl: server.url, store: credentials.forServer('issues', server.url), settings: {},
      prompt: {
        showAuthorizationUrl(url) { fetch(url).then(() => visited.resolve(), visited.reject); },
        promptForRedirectUrl: signal => new Promise(resolve =>
          signal.addEventListener('abort', () => resolve(undefined), { once: true })),
      },
    });
    await visited.promise;
    const program = `
      import { FileAuthStorageBackend, McpOAuthCredentialStore, createMcpAuthProvider } from '@mkagent/pi-durable-coding/mcp-oauth';
      import { McpAuthorization } from ${JSON.stringify(join(import.meta.dir, 'authorization.ts'))};
      import { McpServerConnection, createDefaultTransport } from ${JSON.stringify(join(import.meta.dir, 'runtime.ts'))};
      const { root, file, url, action } = JSON.parse(Bun.argv.at(-1));
      const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), root);
      if (action === 'refresh') {
        const provider = createMcpAuthProvider({
          serverUrl: url, store: credentials.forServer('issues', url), settings: () => ({}), onChallenge() {},
        });
        await provider.onUnauthorized({
          response: new Response(null, { status: 401 }), serverUrl: new URL(url),
          token: (await credentials.forServer('issues', url).load()).tokens.access_token,
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            if (new URL(String(input)).pathname === '/token') {
              console.log('held');
              await Bun.stdin.stream().getReader().read();
            }
            return response;
          },
        });
      } else {
        const connection = new McpServerConnection({
          entry: { name: 'issues', config: { url }, scope: 'global' }, cwd: root, credentials,
          version: 'test', log: undefined, onTools() {}, onChange() {}, createTransport: createDefaultTransport,
        });
        let handler;
        const notices = [];
        new McpAuthorization({ credentials, connections: () => [connection], assertOwner() {} })
          .extension()({ registerCommand(_name, command) { handler = command.handler; } });
        console.log('ready');
        await handler('logout issues', {
          hasUI: true, ui: { notify(text, level) { notices.push({ text, level }); }, setWidget() {} },
        });
        await connection.close();
        if (notices.length !== 1 || notices[0].level !== 'info' || !notices[0].text.startsWith('Signed out')) {
          throw new Error('Logout did not report success');
        }
      }
    `;
    const rotating = Bun.spawn({
      cmd: [process.execPath, '--eval', program, JSON.stringify({ root, file, url: server.url, action: 'refresh' })],
      cwd: join(import.meta.dir, '../..'), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    let loggingOut: typeof rotating | undefined;
    const rotatingLines = createInterface({ input: Readable.fromWeb(rotating.stdout) });
    let logoutLines: ReturnType<typeof createInterface> | undefined;
    try {
      expect((await rotatingLines[Symbol.asyncIterator]().next()).value).toBe('held');
      loggingOut = Bun.spawn({
        cmd: [process.execPath, '--eval', program, JSON.stringify({ root, file, url: server.url, action: 'logout' })],
        cwd: join(import.meta.dir, '../..'), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      logoutLines = createInterface({ input: Readable.fromWeb(loggingOut.stdout) });
      expect((await logoutLines[Symbol.asyncIterator]().next()).value).toBe('ready');
      let finished = false;
      loggingOut.exited.then(() => { finished = true; });
      await Bun.sleep(50);
      const finishedBeforeRelease = finished;
      rotating.stdin.write('release\n');
      await rotating.stdin.flush();
      rotating.stdin.end();
      expect(await rotating.exited).toBe(0);
      expect(await new Response(rotating.stderr).text()).toBe('');
      expect(await loggingOut.exited).toBe(0);
      expect(await new Response(loggingOut.stderr).text()).toBe('');
      expect(finishedBeforeRelease).toBe(false);
      expect(await credentials.forServer('issues', server.url).load()).toBeUndefined();
      expect(server.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token')).toHaveLength(1);
    } finally {
      rotating.kill();
      loggingOut?.kill();
      await Promise.all([rotating.exited, loggingOut?.exited]);
      rotatingLines.close();
      logoutLines?.close();
    }
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
