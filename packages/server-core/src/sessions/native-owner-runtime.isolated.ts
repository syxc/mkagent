/** Exercise product ownership against the actual PiAgent and bundled durable worker. */
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionEvent } from '@mkagent/shared/protocol'
import type { PiAgent } from '../../../shared/src/agent/pi-agent'

test('native NEW adopts the actual worker, completes without a target generator and lets the source restart independently', async () => {
  const appRoot = resolve(import.meta.dir, '../../../..')
  const build = Bun.spawnSync([process.execPath, 'run', 'server:build:subprocess'], { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(`Pi subprocess build failed: ${build.stderr}`)
  const root = mkdtempSync(join(tmpdir(), 'native-owner-runtime-'))
  const previousConfig = process.env.CONFIG_DIR
  const previousHome = process.env.HOME
  process.env.CONFIG_DIR = root
  process.env.HOME = join(root, 'home')
  const workspaceRoot = join(root, 'workspace')
  const cwd = join(root, 'project')
  mkdirSync(workspaceRoot); mkdirSync(cwd)
  const extensions = join(root, 'home', '.pi', 'agent', 'extensions')
  mkdirSync(extensions, { recursive: true })
  writeFileSync(join(extensions, '..', 'settings.json'), '{"cacheWarming":"off","compaction":{"enabled":false}}')
  writeFileSync(join(extensions, 'owner.ts'), `
    import { existsSync, readFileSync } from 'node:fs';
    import { basename, join } from 'node:path';
    export default function(pi) {
      pi.registerCommand('fresh', { handler: async (_, ctx) => ctx.newSession({
        setup: async manager => manager.appendMessage({ role: 'user', content: 'target setup marker', timestamp: Date.now() }),
        withSession: async next => next.sendUserMessage('target callback marker'),
      }) });
      pi.on('session_start', (_, ctx) => {
        const flag = join(ctx.cwd, '.startup-source');
        if (existsSync(flag) && readFileSync(flag, 'utf8') === basename(process.env.MKAGENT_SESSION_DIR || ''))
          pi.sendUserMessage('/fresh', { expandPromptTemplates: true });
      });
    }
  `)
  const requests: Array<Record<string, unknown>> = []
  let modelGate: ReturnType<typeof Promise.withResolvers<void>> | undefined
  const heldRequest = Promise.withResolvers<void>()
  const secondHeldRequest = Promise.withResolvers<void>()
  let heldRequests = 0
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>)
    if (modelGate && JSON.stringify(requests.at(-1)).includes('target callback marker')) {
      if (++heldRequests === 2) secondHeldRequest.resolve()
      heldRequest.resolve()
      await modelGate.promise
    }
    return new Response([
      { id: `r${requests.length}`, choices: [{ index: 0, delta: { role: 'assistant', content: 'local owner reply' }, finish_reason: null }] },
      { id: `r${requests.length}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: `r${requests.length}`, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } })
  } })
  const workspace = { id: 'owner-ws', name: 'Owner', slug: 'owner', rootPath: workspaceRoot, createdAt: 1 }
  const connection = { slug: 'local', name: 'Local', providerType: 'pi_compat', authType: 'none',
    baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, customEndpoint: { api: 'openai-completions' },
    models: [{ id: 'owner-local', contextWindow: 100_000 }], defaultModel: 'owner-local', createdAt: 1 }
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1,
    defaults: { model: 'owner-local', defaultLlmConnection: 'local', permissionMode: 'allow-all',
      thinkingLevel: 'off', workingDirectory: cwd, codingMode: true } }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id,
    activeSessionId: null, defaultLlmConnection: 'local', llmConnections: [connection] }))
  const { ensureConfigDir } = await import('@mkagent/shared/config')
  ensureConfigDir()
  const { SessionManager, setSessionPlatform } = await import('./SessionManager')
  const { createHeadlessPlatform } = await import('../runtime/platform-headless')
  const { loadSession } = await import('@mkagent/shared/sessions')
  const { nativeForkPlan, readTrustedNativeSession } = await import('./native-session-source')
  const platform = createHeadlessPlatform()
  platform.appRootPath = appRoot
  setSessionPlatform(platform)
  const manager = new SessionManager()
  const targetDone = Promise.withResolvers<string>()
  const events: Array<{ target: unknown; event: SessionEvent }> = []
  let sourceId = ''
  let targetId = ''
  const completed: string[] = []
  const deadline = <T>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Product native owner deadline exceeded')), 20_000)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
  try {
    await manager.initialize()
    manager.setEventSink((_channel, target, event) => {
      if (!event || typeof event !== 'object' || !('type' in event)) return
      events.push({ target, event: event as SessionEvent })
      if (event.type === 'session_created' && event.sessionId !== sourceId) targetId = event.sessionId
    })
    manager.onSessionComplete(event => {
      completed.push(event.sessionId)
      if (event.sessionId === targetId) targetDone.resolve(event.sessionId)
    })
    const source = await manager.createSession(workspace.id, { name: 'Native source' })
    sourceId = source.id
    targetId = ''
    await manager.sendMessage(sourceId, 'source history marker')
    const runtime = manager as unknown as { sessions: Map<string, { agent: PiAgent }> }
    const child = (agent: PiAgent) => (agent as unknown as { subprocess: { pid: number } | null }).subprocess
    const callbackPort = (agent: PiAgent) => (agent as unknown as { callbackPort: number }).callbackPort
    const sourceAgent = runtime.sessions.get(sourceId)!.agent
    const sourcePid = child(sourceAgent)!.pid
    await manager.sendMessage(sourceId, '/fresh', undefined, undefined, undefined, undefined, undefined, undefined,
      { callerClientId: 'originating-client' })
    expect(await deadline(targetDone.promise)).toBe(targetId)
    for (const id of [sourceId, targetId]) {
      await manager.flushSession(id)
      const stored = loadSession(workspaceRoot, id)!
      const reference = stored.nativeSessionProjection
      expect(reference).toBeDefined()
      const metadata = await Bun.file(join(workspaceRoot, 'sessions', id, 'meta', 'native-session.json')).text()
      const { entryIds, ...manifest } = JSON.parse(metadata)
      expect(entryIds.length).toBeGreaterThan(0)
      expect(reference).toEqual({ ...manifest, manifestDigest: createHash('sha256').update(metadata).digest('hex') })
      expect(reference?.nativeSessionId).toBe(stored.sdkSessionId)
      expect(reference).not.toHaveProperty('entryIds')
      const verified = readTrustedNativeSession({
        workspaceRootPath: workspaceRoot, sessionId: id, nativeSessionId: stored.sdkSessionId!, reference: reference!,
      })
      expect(verified.entryIds).toEqual(entryIds)
      expect(verified.entries).toHaveLength(entryIds.length)
      const user = verified.entries.find(entry => entry.type === 'message'
        && entry.message && typeof entry.message === 'object' && 'role' in entry.message && entry.message.role === 'user')!
      expect(user).toBeDefined()
      expect(nativeForkPlan(verified, user.id, 'at')).toEqual({
        nativeLeafId: user.id, durableEntryId: entryIds.find((entry: { nativeId: string }) => entry.nativeId === user.id).durableId,
      })
    }
    const targetAgent = runtime.sessions.get(targetId)!.agent
    expect(child(targetAgent)?.pid).toBe(sourcePid)
    expect(child(sourceAgent)).toBeNull()
    expect((await manager.getSession(sourceId))?.isProcessing).toBe(false)
    const target = (await manager.getSession(targetId))!
    expect(target.isProcessing).toBe(false)
    expect(target.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['local owner reply'])
    expect(completed.filter(id => id === targetId)).toHaveLength(1)
    expect(events.filter(item => item.event.type === 'native_session_redirect')).toEqual([{
      target: { to: 'client', clientId: 'originating-client' },
      event: expect.objectContaining({ type: 'native_session_redirect', sessionId: sourceId, targetSessionId: targetId }),
    }])
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('target setup marker')
    expect(JSON.stringify(requests[1])).toContain('target callback marker')
    expect(JSON.stringify(requests[1])).not.toContain('source history marker')
    expect(loadSession(workspaceRoot, targetId)?.nativeSessionOwner?.committed).toBe(true)
    expect(callbackPort(sourceAgent)).toBe(0)
    expect(callbackPort(targetAgent)).toBeGreaterThan(0)
    const callback = await fetch(`http://127.0.0.1:${callbackPort(targetAgent)}/call-llm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'target HTTP callback marker', model: 'owner-local' }),
    })
    expect(await callback.json()).toMatchObject({ text: 'local owner reply' })
    expect(JSON.stringify(requests.at(-1))).toContain('target HTTP callback marker')
    await manager.sendMessage(sourceId, 'source continuation marker')
    expect(child(sourceAgent)?.pid).not.toBe(sourcePid)
    expect(JSON.stringify(requests.at(-1))).toContain('source history marker')
    expect(JSON.stringify(requests.at(-1))).not.toContain('target setup marker')
    await manager.deleteSession(sourceId)
    expect(child(targetAgent)?.pid).toBe(sourcePid)
    await manager.sendMessage(targetId, 'target continuation marker')
    expect(JSON.stringify(requests.at(-1))).toContain('target callback marker')
    expect(child(targetAgent)?.pid).toBe(sourcePid)
    // Reuse the adopted process through further complete ownership barriers.
    for (let step = 0; step < 2; step++) {
      const previousId = targetId
      const previousAgent = runtime.sessions.get(previousId)!.agent
      const nextDone = Promise.withResolvers<string>()
      manager.onSessionComplete(event => {
        if (event.sessionId !== previousId && event.sessionId === targetId) nextDone.resolve(event.sessionId)
      })
      await deadline(manager.sendMessage(previousId, '/fresh', undefined, undefined, undefined, undefined, undefined, undefined,
        { callerClientId: `chain-client-${step}` }))
      const nextId = await deadline(nextDone.promise)
      expect(nextId).not.toBe(previousId)
      expect(child(runtime.sessions.get(nextId)!.agent)?.pid).toBe(sourcePid)
      expect(child(previousAgent)).toBeNull()
      expect((await manager.getSession(nextId))?.isProcessing).toBe(false)
      expect(loadSession(workspaceRoot, nextId)?.nativeSessionOwner?.sourceSessionId).toBe(previousId)
    }

    // Once committed, source actions must not cancel the new foreground owner.
    const otherSource = await manager.createSession(workspace.id, { name: 'Independent source' })
    sourceId = otherSource.id
    targetId = ''
    modelGate = Promise.withResolvers<void>()
    const heldDone = Promise.withResolvers<void>()
    manager.onSessionComplete(event => { if (event.sessionId === targetId) heldDone.resolve() })
    await manager.sendMessage(sourceId, '/fresh', undefined, undefined, undefined, undefined, undefined, undefined,
      { callerClientId: 'other-client' })
    await deadline(heldRequest.promise)
    const heldTargetId = targetId
    const heldTargetAgent = runtime.sessions.get(heldTargetId)!.agent
    const heldTargetPid = child(heldTargetAgent)!.pid
    expect((await manager.getSession(heldTargetId))?.isProcessing).toBe(true)
    await deadline(manager.cancelProcessing(sourceId))
    expect((await manager.getSession(heldTargetId))?.isProcessing).toBe(true)
    expect(child(heldTargetAgent)?.pid).toBe(heldTargetPid)
    // The source can replace again on its new connection while B still runs.
    const firstHeldDone = Promise.withResolvers<void>()
    const secondHeldDone = Promise.withResolvers<void>()
    let secondTargetId = ''
    manager.onSessionComplete(event => {
      if (event.sessionId === heldTargetId) firstHeldDone.resolve()
      if (event.sessionId === secondTargetId) secondHeldDone.resolve()
    })
    await deadline(manager.sendMessage(sourceId, '/fresh', undefined, undefined, undefined, undefined, undefined, undefined,
      { callerClientId: 'new-source-client' }))
    await deadline(secondHeldRequest.promise)
    secondTargetId = targetId
    expect(secondTargetId).not.toBe(heldTargetId)
    expect((await manager.getSession(heldTargetId))?.isProcessing).toBe(true)
    expect((await manager.getSession(secondTargetId))?.isProcessing).toBe(true)
    expect(loadSession(workspaceRoot, heldTargetId)?.nativeSessionOwner?.unpublished).toBeUndefined()
    expect(loadSession(workspaceRoot, secondTargetId)?.nativeSessionOwner?.unpublished).toBeUndefined()
    await manager.deleteSession(sourceId)
    expect((await manager.getSession(heldTargetId))?.isProcessing).toBe(true)
    expect((await manager.getSession(secondTargetId))?.isProcessing).toBe(true)
    modelGate.resolve()
    await deadline(Promise.all([heldDone.promise, firstHeldDone.promise, secondHeldDone.promise]))
    expect((await manager.getSession(heldTargetId))?.messages.some(message => message.content === 'local owner reply')).toBe(true)

    const startupSource = await manager.createSession(workspace.id, { name: 'Startup source' })
    sourceId = startupSource.id
    targetId = ''
    writeFileSync(join(cwd, '.startup-source'), sourceId)
    const startupDone = Promise.withResolvers<void>()
    manager.onSessionComplete(event => { if (event.sessionId === targetId) startupDone.resolve() })
    await deadline(manager.sendMessage(sourceId, 'input before startup replacement'))
    await deadline(startupDone.promise)
    expect((await manager.getSession(sourceId))?.isProcessing).toBe(false)
    expect((await manager.getSession(targetId))?.isProcessing).toBe(false)
    expect((await manager.getSession(targetId))?.messages.some(message => message.content === 'local owner reply')).toBe(true)
  } finally {
    modelGate?.resolve()
    await manager.flushAllSessions()
    manager.cleanup()
    endpoint.stop(true)
    if (previousConfig === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = previousConfig
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
