/** Unchanged upstream plugins exercise the actual product owner and native worker. */
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionUIUpdate } from '@mkagent/shared/protocol'
import type { PiAgent } from '../../../shared/src/agent/pi-agent'

test('unchanged upstream RPC, confirmation and naming plugins work through the product factory', async () => {
  const appRoot = resolve(import.meta.dir, '../../../..')
  const build = Bun.spawnSync([process.execPath, 'run', 'server:build:subprocess'], { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(`Pi subprocess build failed: ${build.stderr}`)
  const root = mkdtempSync(join(tmpdir(), 'native-plugin-runtime-'))
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
  const extensions = join(root, 'home', '.pi', 'agent', 'extensions')
  mkdirSync(workspaceRoot); mkdirSync(cwd); mkdirSync(extensions, { recursive: true })
  writeFileSync(join(extensions, '..', 'settings.json'), '{"cacheWarming":"off","compaction":{"enabled":false}}')
  const fixtures = join(appRoot, 'packages/pi-durable-coding/test/fixtures')
  for (const name of ['rpc-demo.ts', 'confirm-destructive.ts', 'session-name.ts']) {
    writeFileSync(join(extensions, name), readFileSync(join(fixtures, 'upstream', name)))
  }
  writeFileSync(join(extensions, 'session-contract.ts'), readFileSync(join(fixtures, 'session-contract.ts')))
  const sentinel = join(cwd, 'retained')
  mkdirSync(sentinel)
  writeFileSync(join(sentinel, 'marker.txt'), 'retain')
  let requests = 0
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests++
    const body = await request.json() as { messages: Array<{ role: string; content?: unknown }> }
    const dangerous = body.messages.at(-1)?.role === 'user'
      && JSON.stringify(body.messages.at(-1)).includes('blocked shell marker')
    const delta = dangerous ? { role: 'assistant', tool_calls: [{
      index: 0, id: 'blocked-fixture-shell', type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({
        command: `rm -r "${sentinel}"`, _displayName: 'Fixture shell', _intent: 'Exercise the upstream blocking hook',
      }) },
    }] } : { role: 'assistant', content: 'local plugin reply' }
    return new Response([
      { id: `p${requests}`, choices: [{ index: 0, delta, finish_reason: null }] },
      { id: `p${requests}`, choices: [{ index: 0, delta: {}, finish_reason: dangerous ? 'tool_calls' : 'stop' }] },
      { id: `p${requests}`, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } })
  } })
  cleanup.defer(() => endpoint.stop(true))
  const workspace = { id: 'plugin-ws', name: 'Plugin', slug: 'plugin', rootPath: workspaceRoot, createdAt: 1 }
  const connection = { slug: 'local', name: 'Local', providerType: 'pi_compat', authType: 'none',
    baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, customEndpoint: { api: 'openai-completions' },
    models: [{ id: 'plugin-local', contextWindow: 100_000 }], defaultModel: 'plugin-local', createdAt: 1 }
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1,
    defaults: { model: 'plugin-local', defaultLlmConnection: 'local', permissionMode: 'allow-all',
      thinkingLevel: 'off', workingDirectory: cwd, codingMode: true } }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id,
    activeSessionId: null, defaultLlmConnection: 'local', llmConnections: [connection] }))
  const { ensureConfigDir } = await import('@mkagent/shared/config')
  ensureConfigDir()
  const { SessionManager, setSessionPlatform } = await import('./SessionManager')
  const { createHeadlessPlatform } = await import('../runtime/platform-headless')
  const { loadSession } = await import('@mkagent/shared/sessions')
  const { readTrustedNativeSession } = await import('./native-session-source')
  const { RPC_CHANNELS } = await import('@mkagent/shared/protocol')
  const platform = createHeadlessPlatform()
  platform.appRootPath = appRoot
  setSessionPlatform(platform)
  const manager = new SessionManager()
  cleanup.defer(() => manager.cleanup())
  const runtime = manager as unknown as {
    sessions: Map<string, { agent: PiAgent; isProcessing: boolean; messageQueue: unknown[] }>
  }
  const updates: ExtensionUIUpdate[] = []
  const replies: Array<Promise<boolean>> = []
  const answered = new Set<string>()
  const created: string[] = []
  let replacement: { id?: string; done: ReturnType<typeof Promise.withResolvers<string>> } | undefined
  let allow = false
  const deadline = <T>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Product plugin deadline exceeded')), 20_000)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
  const attach = (id: string) => manager.attachExtensionUI(id, workspace.id, 'plugin-client', `lease-${id}`)
  const run = async (id: string, text: string) => {
    await deadline(manager.sendMessage(id, text, undefined, undefined, undefined, undefined, undefined, undefined,
      { callerClientId: 'plugin-client' }))
    await deadline(manager.sendMessage(id, '/contract-idle'))
    const idle = Promise.withResolvers<void>()
    const check = () => {
      const current = runtime.sessions.get(id)!
      if (!current.isProcessing && !current.messageQueue.length) idle.resolve()
    }
    const stop = manager.onSessionComplete(event => { if (event.sessionId === id) check() })
    try { check(); await deadline(idle.promise) }
    finally { stop() }
    await manager.flushSession(id)
  }
  const read = async (id: string) => {
    await manager.flushSession(id)
    const stored = loadSession(workspaceRoot, id)!
    const tree = readTrustedNativeSession({ workspaceRootPath: workspaceRoot, sessionId: id,
      nativeSessionId: stored.sdkSessionId!, reference: stored.nativeSessionProjection! })
    return { stored, tree }
  }
  try {
    await manager.initialize()
    manager.setEventSink((channel, _target, event) => {
      if (channel === RPC_CHANNELS.sessions.EXTENSION_UI_UPDATED) {
        const update = event as ExtensionUIUpdate
        updates.push(update)
        for (const request of update.snapshot.requests) {
          const key = `${update.snapshot.sessionId}:${request.uiEpoch}:${request.id}`
          if (answered.has(key)) continue
          answered.add(key)
          const response = request.method === 'confirm' ? { confirmed: allow }
            : { value: request.method === 'input' ? 'native response'
              : request.method === 'editor' ? 'native\neditor'
                : request.title.startsWith('Dangerous command:') ? 'Block'
                  : request.options[allow ? 0 : 1]! }
          replies.push(manager.respondToExtensionUI(update.snapshot.sessionId, workspace.id, 'plugin-client',
            update.subscriptionId, request.uiEpoch, { type: 'extension_ui_response', id: request.id, ...response }))
        }
      } else if (event?.type === 'session_created') {
        created.push(event.sessionId)
        if (replacement) replacement.id = event.sessionId
      } else if (event?.type === 'error' && replacement) replacement.done.reject(new Error(event.error))
    })
    manager.onSessionComplete(event => {
      if (replacement?.id === event.sessionId) replacement.done.resolve(event.sessionId)
    })
    const source = await manager.createSession(workspace.id, { name: 'Upstream plugin source' })
    await attach(source.id)
    await run(source.id, '/session-name Upstream product name')
    expect((await read(source.id)).stored.name).toBe('Upstream product name')
    const startup = await attach(source.id)
    expect(startup.title).toContain('pi RPC Demo')
    expect(startup.widgets.some(widget => widget.key === 'rpc-demo')).toBe(true)
    expect(requests).toBe(0)
    for (const command of ['/rpc-input', '/rpc-editor', '/rpc-prefill']) await run(source.id, command)
    const effects = () => updates.flatMap(update => update.effect ? [update.effect] : [])
    expect(effects()).toContainEqual(expect.objectContaining({ method: 'notify', message: 'You entered: native response' }))
    expect(effects()).toContainEqual(expect.objectContaining({ method: 'notify', message: 'Editor submitted (2 lines)' }))
    expect(effects()).toContainEqual(expect.objectContaining({
      method: 'set_editor_text', text: 'This text was set by the rpc-demo extension.',
    }))
    expect(requests).toBe(0)
    await run(source.id, 'source plugin marker')
    const history = await read(source.id)
    const user = history.tree.entries.find(entry => entry.type === 'message'
      && (entry.message as { role: string }).role === 'user')!
    const count = created.length
    await run(source.id, '/contract-new')
    await run(source.id, `/contract-fork ${user.id}`)
    expect(created).toHaveLength(count)
    expect(effects()).toContainEqual(expect.objectContaining({ method: 'notify', message: 'Clear cancelled' }))
    expect(effects()).toContainEqual(expect.objectContaining({ method: 'notify', message: 'Fork cancelled' }))
    await run(source.id, 'blocked shell marker')
    expect(existsSync(join(sentinel, 'marker.txt'))).toBe(true)
    expect(effects()).toContainEqual(expect.objectContaining({ method: 'notify', message: 'Command blocked by user' }))
    const beforeTree = await read(source.id)
    const lastUser = beforeTree.tree.entries.findLast(entry => entry.type === 'message'
      && (entry.message as { role: string }).role === 'user')!
    await run(source.id, `/contract-tree ${lastUser.id}`)
    expect(effects()).toContainEqual(expect.objectContaining({
      method: 'set_editor_text', text: expect.stringContaining('blocked shell marker'),
    }))
    const beforeReload = await attach(source.id)
    await run(source.id, '/contract-reload')
    const reloaded = await attach(source.id)
    expect(reloaded.uiEpoch).not.toBe(beforeReload.uiEpoch)
    expect(reloaded.widgets.some(widget => widget.key === 'rpc-demo')).toBe(true)
    await run(source.id, '/session-name Reloaded upstream name')
    expect((await read(source.id)).stored.name).toBe('Reloaded upstream name')
    allow = true
    const pending = replacement = { done: Promise.withResolvers<string>() }
    await run(source.id, '/contract-new')
    const targetId = await deadline(pending.done.promise)
    replacement = undefined
    expect(created).toHaveLength(count + 1)
    await attach(targetId)
    await run(targetId, '/session-name New upstream target')
    const target = await read(targetId)
    expect(target.stored.name).toBe('New upstream target')
    expect(target.tree.entries.some(entry => entry.type === 'message'
      && (entry.message as { role: string }).role === 'user'
      && JSON.stringify(entry.message).includes('contract new callback'))).toBe(true)
    expect(target.stored.messages.some(row => row.type === 'assistant' && row.content === 'local plugin reply')).toBe(true)
    expect(target.stored.messages.some(row => row.content.includes('source plugin marker'))).toBe(false)
    const targetAgent = runtime.sessions.get(targetId)!.agent
    await deadline(targetAgent.nativeSessionOwner!.releaseForOwner())
    await run(targetId, '/session-name Cold upstream target')
    expect((await read(targetId)).stored.name).toBe('Cold upstream target')
    expect((await attach(targetId)).widgets.some(widget => widget.key === 'rpc-demo')).toBe(true)
    allow = false
    const sourceFile = (await read(source.id)).stored.nativeSessionProjection!.sessionFile
    await run(targetId, `/contract-switch ${sourceFile}`)
    expect(created).toHaveLength(count + 1)
    expect(effects()).toContainEqual(expect.objectContaining({ method: 'notify', message: 'Switch cancelled' }))
    allow = true
    const switching = replacement = { id: source.id, done: Promise.withResolvers<string>() }
    await run(targetId, `/contract-switch ${sourceFile}`)
    expect(await deadline(switching.done.promise)).toBe(source.id)
    replacement = undefined
    await attach(source.id)
    await run(source.id, '/session-name Switched upstream source')
    const switched = await read(source.id)
    expect(switched.stored.name).toBe('Switched upstream source')
    expect(switched.tree.entries.some(entry => entry.type === 'message'
      && JSON.stringify(entry.message).includes('contract switch callback'))).toBe(true)
    const forking = replacement = { done: Promise.withResolvers<string>() }
    await run(source.id, `/contract-fork ${user.id}`)
    const forkId = await deadline(forking.done.promise)
    replacement = undefined
    expect(created).toHaveLength(count + 2)
    await attach(forkId)
    await run(forkId, '/session-name Forked upstream target')
    const forked = await read(forkId)
    expect(forked.stored.name).toBe('Forked upstream target')
    expect(forked.tree.entries.some(entry => entry.type === 'message'
      && JSON.stringify(entry.message).includes('contract fork callback'))).toBe(true)
    expect(forked.stored.messages.some(row => row.content.includes('source plugin marker'))).toBe(true)
    expect(replies.length).toBeGreaterThan(0)
    expect((await Promise.all(replies)).every(Boolean)).toBe(true)
  } finally {
    await deadline(manager.flushAllSessions())
  }
}, 90_000)
