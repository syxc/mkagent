/** Exercise project trust through the actual product owner and bundled worker. */
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionUIUpdate } from '@mkagent/shared/protocol'
import type { PiAgent } from '../../../shared/src/agent/pi-agent'

test('product startup gates native extensions and both project MCP files, and reload revokes them', async () => {
  const appRoot = resolve(import.meta.dir, '../../../..')
  const build = Bun.spawnSync([process.execPath, 'run', 'server:build:subprocess'], { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(`Pi subprocess build failed: ${build.stderr}`)
  const root = mkdtempSync(join(tmpdir(), 'native-project-trust-'))
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
  mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true })
  mkdirSync(join(cwd, '.mkagent'))
  writeFileSync(join(agentDir, 'settings.json'), '{"defaultProjectTrust":"ask","cacheWarming":"off","compaction":{"enabled":false}}')
  writeFileSync(join(cwd, '.pi', 'settings.json'), '{"defaultProjectTrust":"always"}')
  const globalMarker = join(root, 'global-loaded')
  const projectMarker = join(root, 'project-loaded')
  const probe = join(root, 'probe.json')
  const commandsProbe = join(root, 'commands.json')
  writeFileSync(join(extensions, 'trust-probe.ts'), `
    import { appendFileSync, writeFileSync } from 'node:fs';
    export default function(pi) {
      appendFileSync(${JSON.stringify(globalMarker)}, 'loaded\\n');
      pi.registerCommand('trust-probe', { handler: () =>
        writeFileSync(${JSON.stringify(probe)}, JSON.stringify(pi.getAllTools().map(tool => tool.name))) });
      pi.registerCommand('trust-reload', { handler: (_, ctx) => ctx.reload() });
      pi.registerCommand('trust-idle', { handler: (_, ctx) => ctx.waitForIdle() });
      pi.registerCommand('trust-commands', { handler: () =>
        writeFileSync(${JSON.stringify(commandsProbe)}, JSON.stringify(pi.getCommands().map(command => command.name))) });
    }
  `)
  writeFileSync(join(cwd, '.pi', 'extensions', 'project.ts'), `
    import { appendFileSync } from 'node:fs';
    export default function() { appendFileSync(${JSON.stringify(projectMarker)}, 'loaded\\n'); }
  `)
  let modelRequests = 0
  const starts = new Map<string, number>()
  const closes = new Map<string, number>()
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path.startsWith('/v1')) { modelRequests++; return new Response('Unexpected model request', { status: 500 }) }
    if (request.method === 'DELETE') {
      closes.set(path, (closes.get(path) ?? 0) + 1)
      return new Response(null, { status: 200 })
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const body = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string } }
    if (body.id === undefined) return new Response(null, { status: 202 })
    let result: unknown
    if (body.method === 'initialize') {
      starts.set(path, (starts.get(path) ?? 0) + 1)
      result = { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: path.slice(1), version: '1' } }
    } else if (body.method === 'tools/list') {
      result = { tools: [{ name: 'hello', description: 'Local trust fixture', inputSchema: { type: 'object', properties: {} } }] }
    } else result = {}
    return Response.json({ jsonrpc: '2.0', id: body.id, result },
      { headers: { 'mcp-session-id': `fixture-${path.slice(1)}` } })
  } })
  cleanup.defer(() => endpoint.stop(true))
  const mcpServer = (name: string) => ({ url: `http://127.0.0.1:${endpoint.port}/${name}`, exposure: 'direct' })
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: { global: { url: `http://127.0.0.1:${endpoint.port}/global` } },
  }))
  writeFileSync(join(cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { native: mcpServer('native') } }))
  writeFileSync(join(cwd, '.mkagent', 'mcp.json'), JSON.stringify({
    autoEnableCodemode: false, mcpServers: { host: mcpServer('host') },
  }))
  const workspace = { id: 'trust-ws', name: 'Trust', slug: 'trust', rootPath: workspaceRoot, createdAt: 1 }
  const connection = { slug: 'local', name: 'Local', providerType: 'pi_compat', authType: 'none',
    baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, customEndpoint: { api: 'openai-completions' },
    models: [{ id: 'trust-local', contextWindow: 100_000 }], defaultModel: 'trust-local', createdAt: 1 }
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1,
    defaults: { model: 'trust-local', defaultLlmConnection: 'local', permissionMode: 'allow-all',
      thinkingLevel: 'off', workingDirectory: cwd, codingMode: true } }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id,
    activeSessionId: null, defaultLlmConnection: 'local', llmConnections: [connection] }))
  const { ensureConfigDir } = await import('@mkagent/shared/config')
  ensureConfigDir()
  const { SessionManager, setSessionPlatform } = await import('./SessionManager')
  const { createHeadlessPlatform } = await import('../runtime/platform-headless')
  const { RPC_CHANNELS } = await import('@mkagent/shared/protocol')
  const { ProjectTrustStore } = await import('@mkagent/coding-runtime/native')
  const platform = createHeadlessPlatform()
  platform.appRootPath = appRoot
  setSessionPlatform(platform)
  const manager = new SessionManager()
  cleanup.defer(() => manager.cleanup())
  const runtime = manager as unknown as { sessions: Map<string, {
    agent: PiAgent; isProcessing: boolean; messageQueue: unknown[]
  }> }
  const deadline = <T>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Product project trust deadline exceeded')), 20_000)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
  const asked = Promise.withResolvers<ExtensionUIUpdate>()
  let dialogs = 0
  manager.setEventSink((channel, _target, event) => {
    if (channel !== RPC_CHANNELS.sessions.EXTENSION_UI_UPDATED) return
    const update = event as ExtensionUIUpdate
    if (update.snapshot.requests.some(request => request.method === 'select' && request.title.startsWith('Trust project folder?'))) {
      dialogs++
      asked.resolve(update)
    }
  })
  const run = async (id: string, text: string) => {
    await deadline(manager.sendMessage(id, text, undefined, undefined, undefined, undefined, undefined, undefined,
      { callerClientId: 'trust-client' }))
    await deadline(manager.sendMessage(id, '/trust-idle'))
    const idle = Promise.withResolvers<void>()
    const check = () => {
      const current = runtime.sessions.get(id)!
      if (!current.isProcessing && !current.messageQueue.length) idle.resolve()
    }
    const stop = manager.onSessionComplete(event => { if (event.sessionId === id) check() })
    try { check(); await deadline(idle.promise) } finally { stop() }
    await manager.flushSession(id)
  }
  await manager.initialize()
  const session = await manager.createSession(workspace.id, { name: 'Project trust' })
  await manager.attachExtensionUI(session.id, workspace.id, 'trust-client', 'trust-lease')
  const opening = run(session.id, '/trust-probe')
  const pending = await deadline(asked.promise)
  expect(existsSync(projectMarker)).toBe(false)
  expect(starts.size).toBe(0)
  expect(readFileSync(globalMarker, 'utf8')).toBe('loaded\n')
  const request = pending.snapshot.requests.find(request => request.method === 'select')!
  expect(await manager.respondToExtensionUI(session.id, workspace.id, 'trust-client', pending.subscriptionId,
    request.uiEpoch, { type: 'extension_ui_response', id: request.id, value: 'Trust (this session only)' })).toBe(true)
  await opening
  const tools = (): string[] => JSON.parse(readFileSync(probe, 'utf8'))
  expect(tools()).toEqual(expect.arrayContaining(['mcp__global__hello', 'mcp__native__hello', 'mcp__host__hello']))
  expect(tools()).not.toContain('codemode')
  expect(readFileSync(projectMarker, 'utf8')).toBe('loaded\n')
  expect(readFileSync(globalMarker, 'utf8')).toBe('loaded\n')
  expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull()
  expect([...starts.keys()].sort()).toEqual(['/global', '/host', '/native'])
  new ProjectTrustStore(agentDir).set(cwd, false)
  await run(session.id, '/trust-reload')
  await run(session.id, '/trust-probe')
  expect(tools()).toContain('mcp__global__hello')
  expect(tools()).toContain('codemode')
  expect(tools()).not.toContain('mcp__native__hello')
  expect(tools()).not.toContain('mcp__host__hello')
  expect(readFileSync(projectMarker, 'utf8')).toBe('loaded\n')
  expect(readFileSync(globalMarker, 'utf8')).toBe('loaded\nloaded\n')
  expect(starts.get('/native')).toBe(1)
  expect(starts.get('/host')).toBe(1)
  expect(closes.get('/native')).toBe(1)
  expect(closes.get('/host')).toBe(1)
  new ProjectTrustStore(agentDir).set(cwd, true)
  await run(session.id, '/trust-reload')
  await run(session.id, '/trust-probe')
  expect(tools()).not.toContain('codemode')
  expect(tools()).toEqual(expect.arrayContaining(['mcp__global__hello', 'mcp__native__hello', 'mcp__host__hello']))
  expect(readFileSync(projectMarker, 'utf8')).toBe('loaded\nloaded\n')
  expect(dialogs).toBeGreaterThan(0)
  const localPackage = join(root, 'local package')
  const packageMarker = join(root, 'package-invoked')
  mkdirSync(localPackage)
  writeFileSync(join(localPackage, 'package.json'), '{"name":"local-package","pi":{"extensions":["index.ts"]}}')
  writeFileSync(join(localPackage, 'index.ts'), `
    import { writeFileSync } from 'node:fs';
    export default function(pi) {
      pi.registerCommand('package-probe', { handler: () => writeFileSync(${JSON.stringify(packageMarker)}, 'called') });
    }
  `)
  await run(session.id, '/packages list')
  await run(session.id, `/packages install "${localPackage}"`)
  expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).packages).toHaveLength(1)
  await run(session.id, '/package-probe')
  expect(readFileSync(packageMarker, 'utf8')).toBe('called')
  await run(session.id, `/packages remove "${localPackage}"`)
  expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).packages).toEqual([])
  expect(existsSync(localPackage)).toBe(true)
  await run(session.id, '/trust-commands')
  const commandNames: string[] = JSON.parse(readFileSync(commandsProbe, 'utf8'))
  expect(commandNames).toContain('packages')
  expect(commandNames).not.toContain('package-probe')
  new ProjectTrustStore(agentDir).set(cwd, false)
  await run(session.id, '/trust-reload')
  await run(session.id, `/packages install --local "${localPackage}"`)
  expect(JSON.parse(readFileSync(join(cwd, '.pi', 'settings.json'), 'utf8')).packages).toBeUndefined()
  expect(modelRequests).toBe(0)
}, 120_000)
