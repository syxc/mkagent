/** Native provider login through the actual product owner, RPC UI and bundled worker. */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionUIDialog, ExtensionUIUpdate } from '@mkagent/shared/protocol'
import { startProviderMcpServer } from '../../../pi-agent-server/src/test-fixtures/mcp-provider-server.ts'
import { syntheticAccess } from '../../../pi-agent-server/src/test-fixtures/provider-login.ts'

test('product provider login restores MCP tools, survives reload and keeps secrets out of product history', async () => {
  const appRoot = resolve(import.meta.dir, '../../../..')
  const build = Bun.spawnSync([process.execPath, 'run', 'server:build:subprocess'], { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(`Pi subprocess build failed: ${build.stderr}`)
  const root = mkdtempSync(join(tmpdir(), 'native-provider-auth-'))
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
  const provider = startProviderMcpServer(() => syntheticAccess)
  cleanup.defer(() => provider.close())
  writeFileSync(join(extensions, 'provider-login.ts'), `
    import { watch } from 'node:fs';
    import { providerLoginExtension } from ${JSON.stringify(join(appRoot, 'packages/pi-agent-server/src/test-fixtures/provider-login.ts'))};
    export default function(pi) {
      providerLoginExtension(${JSON.stringify(probe)}, ${JSON.stringify(provider.url)})(pi);
      let watcher;
      pi.registerCommand('provider-arm-reload', { handler: async (_, ctx) => {
        watcher = watch(${JSON.stringify(root)}, (_, name) => {
          if (name !== 'reload-trigger') return;
          watcher.close();
          void ctx.reload();
        });
      } });
      pi.on('session_shutdown', () => watcher?.close());
    }
  `)
  let modelRequests = 0
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    modelRequests++
    return new Response('Unexpected model request', { status: 500 })
  } })
  cleanup.defer(() => endpoint.stop(true))
  const workspace = { id: 'provider-ws', name: 'Provider', slug: 'provider', rootPath: workspaceRoot, createdAt: 1 }
  const connection = { slug: 'local', name: 'Local', providerType: 'pi_compat', authType: 'none',
    baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, customEndpoint: { api: 'openai-completions' },
    models: [{ id: 'provider-local', contextWindow: 100_000 }], defaultModel: 'provider-local', createdAt: 1 }
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1,
    defaults: { model: 'provider-local', defaultLlmConnection: 'local', permissionMode: 'allow-all',
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
  const deadline = <T>(promise: Promise<T>, label: string) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Provider product deadline exceeded: ${label}`)), 15_000)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
  const wait = (start: number, predicate: (update: ExtensionUIUpdate) => boolean) => {
    const found = Promise.withResolvers<ExtensionUIUpdate>()
    const check = () => {
      const update = updates.slice(start).find(predicate)
      if (update) { listeners.delete(check); found.resolve(update) }
    }
    listeners.add(check); check()
    return deadline(found.promise, 'UI update').finally(() => listeners.delete(check))
  }
  await manager.initialize()
  const session = await manager.createSession(workspace.id, { name: 'Provider login' })
  let lease = 'provider-lease'
  await manager.attachExtensionUI(session.id, workspace.id, 'provider-client', lease)
  const run = async (text: string) => {
    await deadline(manager.sendMessage(session.id, text, undefined, undefined, undefined, undefined, undefined, undefined,
      { callerClientId: 'provider-client' }), text)
    await deadline(manager.sendMessage(session.id, '/provider-idle'), `idle after ${text}`)
    await manager.flushSession(session.id)
  }
  const result = async () => {
    await run('/provider-probe')
    return JSON.parse(readFileSync(probe, 'utf8')) as { authenticated: boolean; oauth: boolean; tools: string[] }
  }
  const request = async (start: number, title: string) => {
    const update = await wait(start, update => update.snapshot.requests.some(request => request.title === title))
    return { update, dialog: update.snapshot.requests.find(request => request.title === title)! }
  }
  const respond = (entry: { update: ExtensionUIUpdate; dialog: ExtensionUIDialog }, value?: string) =>
    manager.respondToExtensionUI(session.id, workspace.id, 'provider-client', entry.update.subscriptionId,
      entry.dialog.uiEpoch, { type: 'extension_ui_response', id: entry.dialog.id,
        ...(value === undefined ? { cancelled: true } : { value }) })
  const answer = async (start: number, title: string, value: string) => {
    const entry = await request(start, title)
    expect(await respond(entry, value)).toBe(true)
    return entry
  }
  const beginLogin = async () => {
    const start = updates.length
    const pending = run('/login fixture-login')
    await answer(start, 'Sign in: fixture-login', 'OAuth')
    await answer(start, 'Fixture name', 'fixture-user')
    await answer(start, 'Fixture account', '2. Account: Second account')
    await answer(start, 'Fixture code', 'local-code')
    const entry = await request(start, 'Fixture secret')
    expect(entry.dialog).toMatchObject({ method: 'input', sensitive: true })
    return { start, pending, ...entry }
  }
  expect(await result()).toMatchObject({ authenticated: false, oauth: false })
  expect((await result()).tools).not.toContain('mcp__provider_login__hello')
  let login = await beginLogin()
  expect(await respond(login, syntheticAccess)).toBe(true)
  await login.pending
  expect(JSON.parse(readFileSync(probe, 'utf8'))).toEqual({ name: true, account: 'second', code: true, secret: true })
  expect(await result()).toMatchObject({ authenticated: true, oauth: true })
  expect((await result()).tools).toContain('mcp__provider_login__hello')
  expect(provider.requests.some(request => request.method === 'initialize' && request.authorized)).toBe(true)
  await run('/provider-reload')
  expect(await result()).toMatchObject({ authenticated: true, oauth: true })
  expect((await result()).tools).toContain('mcp__provider_login__hello')
  await run('/logout fixture-login')
  expect(await result()).toMatchObject({ authenticated: false, oauth: false })
  expect((await result()).tools).not.toContain('mcp__provider_login__hello')

  for (const action of ['cancel', 'stop', 'disconnect', 'reload'] as const) {
    if (action === 'reload') await run('/provider-arm-reload')
    login = await beginLogin()
    if (action === 'cancel') expect(await respond(login)).toBe(true)
    else if (action === 'stop') await deadline(manager.cancelProcessing(session.id), 'stop')
    else if (action === 'disconnect') manager.detachExtensionUI(session.id, 'provider-client', lease)
    else writeFileSync(reloadTrigger, '')
    await login.pending
    if (action === 'disconnect') {
      lease = 'provider-reconnected'
      await manager.attachExtensionUI(session.id, workspace.id, 'provider-client', lease)
    }
    if (action === 'reload') await wait(login.start, update =>
      update.snapshot.uiEpoch !== login.dialog.uiEpoch && update.snapshot.available)
    expect(await respond(login, syntheticAccess)).toBe(false)
    expect(await result()).toMatchObject({ authenticated: false, oauth: false })
    expect((await result()).tools).not.toContain('mcp__provider_login__hello')
  }
  const history = await manager.getSession(session.id)
  expect(JSON.stringify(history)).toContain('/login fixture-login')
  expect(JSON.stringify(history)).not.toContain(syntheticAccess)
  expect(JSON.stringify(updates)).not.toContain(syntheticAccess)
  expect(modelRequests).toBe(0)
}, 120_000)
