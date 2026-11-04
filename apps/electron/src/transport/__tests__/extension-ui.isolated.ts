/** Real product RPC, client bridge, owner and native worker, with no external model. */
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionUISnapshot } from '@mkagent/shared/protocol'
import { PiAgent } from '@mkagent/shared/agent'
import { ensureConfigDir } from '@mkagent/shared/config'
import { WsRpcServer, WsRpcClient } from '@mkagent/server-core/transport'
import { registerSessionsHandlers } from '../../../../../packages/server-core/src/handlers/rpc/sessions'
import { registerWorkspaceCoreHandlers } from '../../../../../packages/server-core/src/handlers/rpc/workspace'
import type { HandlerDeps } from '../../../../../packages/server-core/src/handlers/handler-deps'
import { buildClientApi } from '../build-api'
import { CHANNEL_MAP } from '../channel-map'
import { ExtensionUIClient } from '../../renderer/lib/extension-ui-client'
import { SessionManager, createManagedSession } from '../../../../../packages/server-core/src/sessions/SessionManager'
import type { SessionExtensionUI } from '../../../../../packages/server-core/src/sessions/extension-ui'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation() })

async function fixture(manager = new SessionManager()) {
  ensureConfigDir()
  const directory = mkdtempSync(join(tmpdir(), 'native-ui-rpc-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const workspace = { id: 'ui-workspace', slug: 'ui', name: 'UI', rootPath: directory, createdAt: 1 }
  const managed = createManagedSession({ id: 'ui-product-session', name: 'Original title' }, workspace, { messagesLoaded: true })
  const internals = manager as unknown as {
    sessions: Map<string, ReturnType<typeof createManagedSession>>
    extensionUI: SessionExtensionUI
  }
  internals.sessions.set(managed.id, managed)
  const token = `ui-fixture-${crypto.randomUUID()}`
  const server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true,
    validateToken: async value => value === token, onClientDisconnected: id => manager.onClientDisconnected(id) })
  manager.setEventSink((channel, target, ...args) => server.push(channel, target, ...args))
  const deps = { sessionManager: manager, platform: { logger: {
    info() {}, warn() {}, error() {}, debug() {},
  } } } as unknown as HandlerDeps
  registerSessionsHandlers(server, deps)
  registerWorkspaceCoreHandlers(server, deps)
  await server.listen()
  cleanup.push(async () => { await server.close(); manager.cleanup() })
  const connect = async (workspaceId = workspace.id) => {
    const rpc = new WsRpcClient(`ws://127.0.0.1:${server.port}`, { workspaceId, token, autoReconnect: false })
    cleanup.push(() => rpc.destroy())
    const api = buildClientApi(rpc, CHANNEL_MAP, channel => rpc.isChannelAvailable(channel))
    api.getTransportConnectionState = async () => rpc.getConnectionState()
    api.onTransportConnectionStateChanged = callback => rpc.onConnectionStateChanged(callback)
    await api.getWindowMode()
    return api
  }
  return { directory, workspace, managed, manager, port: internals.extensionUI.port(managed.id), connect }
}

function waitSnapshot(client: ExtensionUIClient, sessionId: string, predicate: (value: ExtensionUISnapshot) => boolean) {
  const ready = Promise.withResolvers<ExtensionUISnapshot>()
  let unsubscribe = () => {}
  const timer = setTimeout(() => { unsubscribe(); ready.reject(new Error('UI snapshot timeout')) }, 5_000)
  const check = () => {
    const value = client.getSnapshot().get(sessionId)
    if (value && predicate(value)) { clearTimeout(timer); unsubscribe(); ready.resolve(value) }
  }
  unsubscribe = client.subscribe(check)
  check()
  return ready.promise
}

test('product RPC and renderer bridge answer a real native startup and reject other client/workspace responses', async () => {
  const f = await fixture()
  const api = await f.connect()
  const other = await f.connect()
  const foreign = await f.connect('other-workspace')
  const effects: unknown[] = []
  const draftEffect = Promise.withResolvers<void>()
  const client = new ExtensionUIClient(api, (_id, effect) => { effects.push(effect); draftEffect.resolve() })
  cleanup.push(() => client.dispose())
  client.setSessions([f.managed.id])
  client.start()
  await waitSnapshot(client, f.managed.id, () => true)
  const plugin = join(f.directory, 'plugin.ts')
  const result = join(f.directory, 'result.json')
  writeFileSync(plugin, `
    import { writeFileSync } from 'node:fs';
    export default function(pi) {
      pi.on('session_start', async (_, ctx) => {
        const value = await ctx.ui.input('Startup');
        writeFileSync(${JSON.stringify(result)}, JSON.stringify({ value, hasUI: ctx.hasUI }));
      });
      pi.registerCommand('dialog', { handler: async (_, ctx) => {
        const confirmed = await ctx.ui.confirm('Confirm', 'Native plugin confirmation');
        const input = await ctx.ui.input('Input');
        const edited = await ctx.ui.editor('Editor', 'initial');
        ctx.ui.setStatus('fixture', 'ready');
        ctx.ui.setWidget('fixture', ['widget', ''], { placement: 'belowEditor' });
        ctx.ui.setTitle('Display title');
        ctx.ui.setEditorText('');
        writeFileSync(${JSON.stringify(result)}, JSON.stringify({ confirmed, input, edited }));
      } });
      pi.registerCommand('wait', { handler: async (_, ctx) => {
        const value = await ctx.ui.input('Waiting');
        writeFileSync(${JSON.stringify(result)}, JSON.stringify({ value: value ?? null, hasUI: ctx.hasUI }));
      } });
    }
  `)
  let modelRequests = 0
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    modelRequests++
    return new Response('Native UI must not call the model', { status: 500 })
  } })
  cleanup.push(() => model.stop(true))
  const agentDir = join(f.directory, 'agent')
  mkdirSync(agentDir)
  writeFileSync(join(agentDir, 'settings.json'), '{"cacheWarming":"off"}')
  const agent = new PiAgent({
    provider: 'pi', providerType: 'pi_compat', authType: 'none', model: 'ui-local', agentProfile: 'coding',
    workspace: f.workspace, session: { id: f.managed.id, workspaceRootPath: f.directory, createdAt: 1, lastUsedAt: 1 },
    isHeadless: true, skipConfigWatcher: true, extensionUI: f.port,
    codingResources: { agentDir, resourcePolicy: 'host-only', extensionPaths: [plugin] },
    runtime: { paths: { node: process.execPath, piServer: resolve(import.meta.dir, '../../../../../packages/pi-agent-server/src/index.ts') },
      baseUrl: `http://127.0.0.1:${model.port}/v1`, customEndpoint: { api: 'openai-completions' },
      customModels: [{ id: 'ui-local', contextWindow: 16_384 }] },
  })
  cleanup.push(async () => { await agent.disposeForRestart(); agent.destroy() })
  const dialogRun = (async () => { for await (const _ of agent.chat('/dialog')) {} })()
  const startup = (await waitSnapshot(client, f.managed.id, value => value.requests.some(r => r.title === 'Startup'))).requests[0]!
  expect(await client.respond(f.managed.id, startup.uiEpoch, { type: 'extension_ui_response', id: startup.id, value: '' })).toBe(true)
  const confirm = (await waitSnapshot(client, f.managed.id, value => value.requests.some(r => r.method === 'confirm'))).requests[0]!
  await expect(foreign.attachExtensionUI(f.managed.id, 'foreign')).rejects.toThrow('Session not found in workspace')
  expect(await foreign.respondToExtensionUI(f.managed.id, 'foreign', confirm.uiEpoch,
    { type: 'extension_ui_response', id: confirm.id, confirmed: true })).toBe(false)
  expect(await other.respondToExtensionUI(f.managed.id, 'invented-lease', confirm.uiEpoch,
    { type: 'extension_ui_response', id: confirm.id, confirmed: true })).toBe(false)
  expect(await client.respond(f.managed.id, confirm.uiEpoch, { type: 'extension_ui_response', id: confirm.id, confirmed: false })).toBe(true)
  for (const [method, value] of [['input', ''], ['editor', 'edited\ntext']] as const) {
    const request = (await waitSnapshot(client, f.managed.id, state => state.requests.some(r => r.method === method))).requests[0]!
    expect(await client.respond(f.managed.id, request.uiEpoch, { type: 'extension_ui_response', id: request.id, value })).toBe(true)
  }
  await dialogRun
  await draftEffect.promise
  expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({ confirmed: false, input: '', edited: 'edited\ntext' })
  const current = client.getSnapshot().get(f.managed.id)!
  expect(current).toMatchObject({ title: 'Display title', statuses: [{ key: 'fixture', text: 'ready' }],
    widgets: [{ key: 'fixture', lines: ['widget', ''], placement: 'belowEditor' }] })
  expect(f.managed.name).toBe('Original title')
  expect(effects).toContainEqual(expect.objectContaining({ method: 'set_editor_text', text: '' }))
  const waiting = (async () => { for await (const _ of agent.chat('/wait')) {} })()
  await waitSnapshot(client, f.managed.id, value => value.requests.some(r => r.title === 'Waiting'))
  await api.switchWorkspace('other-workspace')
  await waiting
  expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({ value: null, hasUI: false })
  expect(modelRequests).toBe(0)
}, 30_000)

test('a workspace switch invalidates an attach that is still waiting for SessionManager initialization', async () => {
  const entered = Promise.withResolvers<void>()
  const initialized = Promise.withResolvers<void>()
  class DelayedManager extends SessionManager {
    override waitForInit() { entered.resolve(); return initialized.promise }
  }
  const f = await fixture(new DelayedManager())
  const api = await f.connect()
  const attaching = api.attachExtensionUI(f.managed.id, 'old-lease')
  void attaching.catch(() => {})
  await entered.promise
  await api.switchWorkspace('other-workspace')
  initialized.resolve()
  await expect(attaching).rejects.toThrow('Extension UI subscription retired')
  await api.switchWorkspace(f.workspace.id)
  expect((await api.attachExtensionUI(f.managed.id, 'new-lease')).sessionId).toBe(f.managed.id)
}, 10_000)
