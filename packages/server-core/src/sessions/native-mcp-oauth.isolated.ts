/** MCP authorization through the actual product owner, RPC UI, and bundled worker. */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionUIUpdate } from '@mkagent/shared/protocol'
import { startOAuthMcpServer } from '../../../pi-durable-coding/test/fixtures/upstream/mcp-oauth-server.ts'
import { startProviderMcpServer } from '../../../pi-agent-server/src/test-fixtures/mcp-provider-server.ts'

test('product MCP login supports callbacks and pasted redirects, and cancels on stop, disconnect, and reload', async () => {
  const appRoot = resolve(import.meta.dir, '../../../..')
  const build = Bun.spawnSync([process.execPath, 'run', 'server:build:subprocess'], { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(`Pi subprocess build failed: ${build.stderr}`)
  const root = mkdtempSync(join(tmpdir(), 'native-mcp-oauth-'))
  const previousHome = process.env.HOME
  const previousConfig = process.env.CONFIG_DIR
  using cleanup = new DisposableStack()
  cleanup.defer(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    if (previousConfig === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = previousConfig
    rmSync(root, { recursive: true, force: true })
  })
  process.env.HOME = join(root, 'home')
  process.env.CONFIG_DIR = root
  const workspaceRoot = join(root, 'workspace')
  const cwd = join(root, 'project')
  const agentDir = join(root, 'home', '.pi', 'agent')
  const extensions = join(agentDir, 'extensions')
  mkdirSync(workspaceRoot); mkdirSync(cwd); mkdirSync(extensions, { recursive: true })
  writeFileSync(join(agentDir, 'settings.json'), '{"cacheWarming":"off","compaction":{"enabled":false}}')
  const probe = join(root, 'probe.json')
  const reloadTrigger = join(root, 'reload-trigger')
  const removeTrigger = join(root, 'remove-trigger')
  const nativeServer = { command: process.execPath,
    args: [join(appRoot, 'packages/pi-agent-server/src/test-fixtures/mcp-server-resources.ts')], exposure: 'direct' }
  writeFileSync(join(extensions, 'oauth-probe.ts'), `
    import { watch, writeFileSync } from 'node:fs';
    export default function(pi) {
      let watcher;
      const nativeServer = ${JSON.stringify(nativeServer)};
      pi.registerMcpServer('native', nativeServer);
      pi.registerMcpServer('issues', nativeServer);
      pi.registerCommand('oauth-native-hide', { handler: () =>
        pi.registerMcpServer('native', { ...nativeServer, exposure: 'hidden' }) });
      pi.registerCommand('oauth-native-remove', { handler: () => pi.unregisterMcpServer('native') });
      pi.registerCommand('oauth-native-add', { handler: () => pi.registerMcpServer('native', nativeServer) });
      pi.registerCommand('oauth-probe', { handler: () =>
        writeFileSync(${JSON.stringify(probe)}, JSON.stringify(pi.getAllTools().map(tool => tool.name))) });
      pi.registerCommand('oauth-arm-reload', { handler: (_, ctx) => {
        watcher = watch(${JSON.stringify(root)}, (_, name) => {
          if (name !== 'reload-trigger') return;
          watcher.close();
          void ctx.reload();
        });
      } });
      pi.on('session_shutdown', () => watcher?.close());
      pi.registerCommand('oauth-idle', { handler: (_, ctx) => ctx.waitForIdle() });
    }
  `)
  const oauth = await startOAuthMcpServer()
  cleanup.defer(() => { void oauth.close() })
  let providerToken = 'fixture-native-provider-1'
  const provider = startProviderMcpServer(() => providerToken)
  cleanup.defer(() => provider.close())
  writeFileSync(join(extensions, 'native-provider.ts'), `
    export default function(pi) {
      const register = apiKey => pi.registerProvider('fixture-native', {
        baseUrl: ${JSON.stringify(provider.url)}, api: 'openai-completions', apiKey,
        models: [{ id: 'fixture-native-model', name: 'Fixture native', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 }],
      });
      register('fixture-native-provider-1');
      pi.registerMcpServer('provider-native', { url: ${JSON.stringify(provider.url)},
        auth: { provider: 'fixture-native' }, exposure: 'direct' });
      pi.registerCommand('oauth-provider-rotate', { handler: () => register('fixture-native-provider-2') });
      pi.registerCommand('oauth-provider-remove', { handler: () => pi.unregisterProvider('fixture-native') });
    }
  `)
  writeFileSync(join(extensions, 'native-login.ts'), `
    import { watch } from 'node:fs';
    export default function(pi) {
      let watcher;
      pi.registerCommand('oauth-native-login-add', { handler: () =>
        pi.registerMcpServer('native-login', { url: ${JSON.stringify(oauth.url)}, exposure: 'direct' }) });
      pi.registerCommand('oauth-native-login-arm-remove', { handler: () => {
        watcher = watch(${JSON.stringify(root)}, (_, name) => {
          if (name !== 'remove-trigger') return;
          watcher.close();
          pi.unregisterMcpServer('native-login');
        });
      } });
      pi.on('session_shutdown', () => watcher?.close());
    }
  `)
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      issues: { url: oauth.url, exposure: 'direct' },
      'provider-config': { url: provider.url, auth: { provider: 'fixture-native' }, exposure: 'direct' },
    },
  }))
  let modelRequests = 0
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    modelRequests++
    return new Response('Unexpected model request', { status: 500 })
  } })
  cleanup.defer(() => endpoint.stop(true))
  const workspace = { id: 'oauth-ws', name: 'OAuth', slug: 'oauth', rootPath: workspaceRoot, createdAt: 1 }
  const connection = { slug: 'local', name: 'Local', providerType: 'pi_compat', authType: 'none',
    baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, customEndpoint: { api: 'openai-completions' },
    models: [{ id: 'oauth-local', contextWindow: 100_000 }], defaultModel: 'oauth-local', createdAt: 1 }
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1,
    defaults: { model: 'oauth-local', defaultLlmConnection: 'local', permissionMode: 'allow-all',
      thinkingLevel: 'off', workingDirectory: cwd, codingMode: true } }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id,
    activeSessionId: null, defaultLlmConnection: 'local', llmConnections: [connection] }))
  const { ensureConfigDir } = await import('@mkagent/shared/config')
  ensureConfigDir()
  const { SessionManager, setSessionPlatform } = await import('./SessionManager')
  const { createHeadlessPlatform } = await import('../runtime/platform-headless')
  const { RPC_CHANNELS } = await import('@mkagent/shared/protocol')
  const platform = createHeadlessPlatform()
  platform.appRootPath = appRoot
  setSessionPlatform(platform)
  const manager = new SessionManager()
  cleanup.defer(() => manager.cleanup())
  const updates: ExtensionUIUpdate[] = []
  const listeners = new Set<() => void>()
  manager.setEventSink((channel, _target, event) => {
    if (channel !== RPC_CHANNELS.sessions.EXTENSION_UI_UPDATED) return
    updates.push(event as ExtensionUIUpdate)
    for (const listener of [...listeners]) listener()
  })
  const deadline = <T>(promise: Promise<T>, label = 'authorization dialog') => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Product MCP OAuth deadline exceeded: ${label}`)), 15_000)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
  const waitUpdate = (start: number, predicate: (update: ExtensionUIUpdate) => boolean) => {
    const found = Promise.withResolvers<ExtensionUIUpdate>()
    const check = () => {
      const update = updates.slice(start).find(predicate)
      if (update) { listeners.delete(check); found.resolve(update) }
    }
    listeners.add(check); check()
    return deadline(found.promise).finally(() => listeners.delete(check))
  }
  await manager.initialize()
  const session = await manager.createSession(workspace.id, { name: 'MCP OAuth' })
  let lease = 'oauth-lease'
  await manager.attachExtensionUI(session.id, workspace.id, 'oauth-client', lease)
  const run = async (text: string) => {
    await deadline(manager.sendMessage(session.id, text, undefined, undefined, undefined, undefined, undefined, undefined,
      { callerClientId: 'oauth-client' }), text)
    await deadline(manager.sendMessage(session.id, '/oauth-idle'), `idle after ${text}`)
    await manager.flushSession(session.id)
  }
  const tools = async () => {
    await run('/oauth-probe')
    return JSON.parse(readFileSync(probe, 'utf8')) as string[]
  }
  const waitTools = async (present: boolean) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const names = await tools()
      if (names.includes('mcp__native__hello') === present) return names
      await Bun.sleep(10)
    }
    throw new Error(`Native MCP tool presence did not become ${present}`)
  }
  const status = async () => {
    const start = updates.length
    await run('/mcp status')
    return updates.slice(start).flatMap(update => update.snapshot.widgets)
      .findLast(widget => widget.key === 'mcp-status')?.lines.join('\n')
  }
  const beginLogin = async (server = 'issues') => {
    const start = updates.length
    const pending = run(`/mcp login ${server}`)
    const update = await waitUpdate(start, update => update.snapshot.requests.some(request =>
      request.method === 'input' && request.title === `MCP sign-in: ${server}`))
    const request = update.snapshot.requests.find(request => request.method === 'input')!
    const url = update.snapshot.widgets.find(widget => widget.key === `mcp-login-${server}`)!.lines[1]!
    return { pending, update, request, url }
  }
  const respond = (login: Awaited<ReturnType<typeof beginLogin>>, value?: string) =>
    manager.respondToExtensionUI(session.id, workspace.id, 'oauth-client', login.update.subscriptionId,
      login.request.uiEpoch, { type: 'extension_ui_response', id: login.request.id,
        ...(value === undefined ? { cancelled: true } : { value }) })
  expect(await status()).toContain('issues: needs-auth')
  expect(await tools()).not.toContain('mcp__issues__whoami')
  expect(await tools()).toContain('mcp__native__hello')
  expect(await tools()).not.toContain('mcp__issues__hello')
  expect(await tools()).toContain('mcp__provider_native__hello')
  expect(await tools()).toContain('mcp__provider_config__hello')
  providerToken = 'fixture-native-provider-2'
  await run('/oauth-provider-rotate')
  const rotationStart = provider.requests.length
  await run('/mcp reconnect provider-native')
  await run('/mcp reconnect provider-config')
  expect(await status()).toContain('provider-native: connected')
  expect(await status()).toContain('provider-config: connected')
  expect(provider.requests.slice(rotationStart).filter(request => request.method === 'initialize')).toHaveLength(2)
  expect(provider.requests.slice(rotationStart).every(request => request.authorized)).toBe(true)
  await run('/oauth-provider-remove')
  await run('/mcp reconnect provider-native')
  expect(await status()).toContain('provider-native: needs-auth')
  expect(await tools()).not.toContain('mcp__provider_native__hello')
  await run('/oauth-provider-rotate')
  await run('/mcp reconnect provider-native')
  expect(await tools()).toContain('mcp__provider_native__hello')
  await run('/oauth-native-hide')
  expect(await waitTools(false)).not.toContain('mcp__native__hello')
  await run('/oauth-native-remove')
  await run('/oauth-native-add')
  expect(await waitTools(true)).toContain('mcp__native__hello')
  expect(oauth.authorizations).toHaveLength(0)
  expect(oauth.registrations).toHaveLength(0)
  let login = await beginLogin()
  expect((await fetch(login.url)).ok).toBe(true)
  await login.pending
  expect(await status()).toContain('issues: connected')
  expect(await tools()).toContain('mcp__issues__whoami')
  await run('/mcp logout issues')
  expect(await status()).toContain('issues: needs-auth')
  expect(await tools()).not.toContain('mcp__issues__whoami')
  expect(await tools()).toContain('mcp__native__hello')
  expect(readFileSync(join(agentDir, 'mcp-auth.json'), 'utf8').trim()).toBe('{}')

  login = await beginLogin()
  const redirect = (await fetch(login.url, { redirect: 'manual' })).headers.get('location')!
  expect(await respond(login, redirect)).toBe(true)
  await login.pending
  expect(await tools()).toContain('mcp__issues__whoami')
  await run('/mcp logout issues')
  login = await beginLogin()
  expect(await respond(login)).toBe(true)
  await login.pending
  expect(await status()).toContain('issues: needs-auth')

  login = await beginLogin()
  await deadline(manager.cancelProcessing(session.id))
  await login.pending
  expect(await status()).toContain('issues: needs-auth')
  expect(await respond(login, 'http://127.0.0.1/callback?code=late')).toBe(false)

  login = await beginLogin()
  manager.detachExtensionUI(session.id, 'oauth-client', lease)
  await login.pending
  lease = 'oauth-lease-reconnected'
  await manager.attachExtensionUI(session.id, workspace.id, 'oauth-client', lease)
  expect(await status()).toContain('issues: needs-auth')

  await run('/oauth-arm-reload')
  providerToken = 'fixture-native-provider-1'
  login = await beginLogin()
  const reloading = updates.length
  writeFileSync(reloadTrigger, '')
  await login.pending
  await waitUpdate(reloading, update => update.snapshot.uiEpoch !== login.request.uiEpoch
    && update.snapshot.available)
  expect(await status()).toContain('issues: needs-auth')
  expect(await tools()).not.toContain('mcp__issues__whoami')
  expect(oauth.tokenRequests.filter(request => request.get('grant_type') === 'authorization_code')).toHaveLength(2)
  expect(await tools()).toContain('mcp__native__hello')
  expect(await tools()).toContain('mcp__provider_native__hello')
  expect(await tools()).toContain('mcp__provider_config__hello')
  await run('/oauth-native-login-add')
  for (let attempt = 0; !(await status())?.includes('native-login: needs-auth'); attempt++) {
    if (attempt >= 50) throw new Error('Native registered OAuth server never required sign-in')
    await Bun.sleep(10)
  }
  await run('/oauth-native-login-arm-remove')
  login = await beginLogin('native-login')
  writeFileSync(removeTrigger, '')
  await login.pending
  expect(await status()).not.toContain('native-login:')
  expect(await respond(login, 'http://127.0.0.1/callback?code=late')).toBe(false)
  const nativeAuth = JSON.parse(readFileSync(join(agentDir, 'mcp-auth.json'), 'utf8'))
  expect(nativeAuth[`mcp__native_login|${oauth.url}`]).toBeDefined()
  expect(nativeAuth[`mcp__native_login|${oauth.url}`].tokens).toBeUndefined()
  expect(modelRequests).toBe(0)
}, 120_000)
