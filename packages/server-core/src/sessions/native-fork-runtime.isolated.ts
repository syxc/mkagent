/** Real product fork, native journal, archive, callback and process restart. */
import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Message } from '@mkagent/core/types'
import type { PiAgent } from '../../../shared/src/agent/pi-agent'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

test('real product native sessions preserve branches, lineage and history across ownership and restart on both stores', async () => {
  const appRoot = resolve(import.meta.dir, '../../../..')
  const build = Bun.spawnSync([process.execPath, 'run', 'server:build:subprocess'], { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(`Pi subprocess build failed: ${build.stderr}`)
  const root = mkdtempSync(join(tmpdir(), 'native-fork-runtime-'))
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
  writeFileSync(join(extensions, 'fork.ts'), `
    import { basename, join } from 'node:path';
    import { readFileSync } from 'node:fs';
    export default function(pi) {
      pi.registerCommand('native-fork', { handler: async (entryId, ctx) => {
        await ctx.fork(entryId.trim(), { position: 'at', withSession: async next => {
          await next.sendUserMessage('fork callback marker');
        } });
      } });
      pi.registerCommand('archive-marker', { handler: async () => {
        pi.appendEntry('inactive-file', { path: join(process.env.MKAGENT_SESSION_DIR, 'attachments', 'inactive.md') });
      } });
      pi.registerCommand('native-idle', { handler: async (_args, ctx) => { await ctx.waitForIdle(); } });
      let cancelTree = false;
      pi.on('session_before_tree', () => {
        if (cancelTree) { cancelTree = false; return { cancel: true }; }
      });
      pi.registerCommand('native-tree', { handler: async (args, ctx) => {
        const [mode, entryId] = args.trim().split(/\\s+/);
        cancelTree = mode === 'cancel';
        const result = await ctx.navigateTree(entryId, { summarize: mode === 'summarize' });
        pi.appendEntry('tree-result', { ...result, leaf: ctx.sessionManager.getLeafId() });
      } });
      pi.registerCommand('native-name', { handler: async name => { pi.setSessionName(name); } });
      pi.registerCommand('native-read-name', { handler: async () => {
        pi.appendEntry('observed-name', { name: pi.getSessionName() ?? null });
      } });
      pi.registerCommand('native-switch', { handler: async (sessionPath, ctx) => {
        await ctx.switchSession(sessionPath.trim(), { withSession: async next => {
          await next.sendUserMessage('switch callback marker');
        } });
      } });
      pi.registerCommand('native-parent', { handler: async (sessionPath, ctx) => {
        const parentSession = sessionPath.trim() || ctx.sessionManager.getSessionFile();
        await ctx.newSession({ parentSession, setup: async manager => {
          if (manager.getHeader().parentSession !== parentSession) throw new Error('Missing parent lineage');
          if (manager.getEntries().some(entry => entry.type === 'message')) throw new Error('Inherited parent history');
        }, withSession: async next => {
          await next.sendUserMessage('parent callback marker');
        } });
      } });
      pi.on('session_shutdown', (_, ctx) => {
        if (basename(process.env.MKAGENT_SESSION_DIR || '') !== readFileSync(join(ctx.cwd, '.fork-source'), 'utf8')) return;
        pi.appendEntry('shutdown-marker', { marker: 'closed source marker' });
        pi.setSessionName('');
      });
    }
  `)
  const requests: Array<Record<string, unknown>> = []
  let held: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>)
    const waiting = held
    held = undefined
    if (waiting) { waiting.entered.resolve(); await waiting.release.promise }
    const id = `local-${requests.length}`
    return new Response([
      { id, choices: [{ index: 0, delta: { role: 'assistant', content: `local fork reply ${requests.length}` }, finish_reason: null }] },
      { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } })
  } })
  const workspace = { id: 'fork-ws', name: 'Fork', slug: 'fork', rootPath: workspaceRoot, createdAt: 1 }
  const connection = { slug: 'local', name: 'Local', providerType: 'pi_compat', authType: 'none',
    baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, customEndpoint: { api: 'openai-completions' },
    models: [{ id: 'fork-local', contextWindow: 100_000 }], defaultModel: 'fork-local', createdAt: 1 }
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1,
    defaults: { model: 'fork-local', defaultLlmConnection: 'local', permissionMode: 'allow-all',
      thinkingLevel: 'off', workingDirectory: cwd, codingMode: true } }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id,
    activeSessionId: null, defaultLlmConnection: 'local', llmConnections: [connection] }))
  const { ensureConfigDir } = await import('@mkagent/shared/config')
  ensureConfigDir()
  const { SessionManager, setSessionPlatform } = await import('./SessionManager')
  const { createHeadlessPlatform } = await import('../runtime/platform-headless')
  const { getSessionPath, getSessionFilePath, loadSession } = await import('@mkagent/shared/sessions')
  const { readTrustedNativeSession } = await import('./native-session-source')
  const platform = createHeadlessPlatform()
  platform.appRootPath = appRoot
  setSessionPlatform(platform)
  const manager = new SessionManager()
  const runtime = manager as unknown as { sessions: Map<string, { agent: PiAgent; messages: Message[] }> }
  const child = (agent: PiAgent) => (agent as unknown as { subprocess: ChildProcessWithoutNullStreams | null }).subprocess
  let operation: { sourceId: string; targetId?: string; done: ReturnType<typeof Promise.withResolvers<string>> } | undefined
  const redirected: string[] = []
  const created: string[] = []
  const historyEvents: Array<{ sessionId: string; ids: string[] }> = []
  const deadline = <T>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Product fork deadline exceeded')), 20_000)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
  const read = async (id: string) => {
    await deadline(manager.flushSession(id))
    const stored = loadSession(workspaceRoot, id)!
    const tree = readTrustedNativeSession({ workspaceRootPath: workspaceRoot, sessionId: id,
      nativeSessionId: stored.sdkSessionId!, reference: stored.nativeSessionProjection! })
    return { stored, tree }
  }
  const fork = async (sourceId: string, entryId: string) => {
    const current = operation = { sourceId, targetId: undefined as string | undefined, done: Promise.withResolvers<string>() }
    const sending = manager.sendMessage(sourceId, `/native-fork ${entryId}`, undefined, undefined, undefined,
      undefined, undefined, undefined, { callerClientId: 'fork-client' })
    const targetId = await deadline(current.done.promise)
    await deadline(sending)
    operation = undefined
    return targetId
  }
  try {
    await manager.initialize()
    manager.setEventSink((_channel, target, event) => {
      if (!event || typeof event !== 'object' || !('type' in event)) return
      if (event.type === 'session_created') created.push(event.sessionId)
      if (event.type === 'native_history_changed') {
        const stored = loadSession(workspaceRoot, event.sessionId)!
        expect(stored.messages.map(row => row.id)).toEqual(event.session.messages.map((row: Message) => row.id))
        historyEvents.push({ sessionId: event.sessionId, ids: event.session.messages.map((row: Message) => row.id) })
      }
      if (event.type === 'session_created' && operation && operation.targetId === undefined) {
        operation.targetId = event.sessionId
        expect(target).toEqual({ to: 'workspace', workspaceId: workspace.id })
      }
      if (event.type === 'native_session_redirect') {
        expect(target).toEqual({ to: 'client', clientId: 'fork-client' })
        redirected.push(event.targetSessionId)
      }
      if (event.type === 'error' && operation && [operation.sourceId, operation.targetId].includes(event.sessionId)) {
        operation.done.reject(new Error(event.error))
      }
    })
    manager.onSessionComplete(event => {
      if (operation?.targetId === event.sessionId) operation.done.resolve(event.sessionId)
    })
    for (const backend of ['sqlite', 'jsonl'] as const) {
      const source = await manager.createSession(workspace.id, { name: `Fork ${backend}` })
      writeFileSync(join(cwd, '.fork-source'), source.id)
      const sourcePath = getSessionPath(workspaceRoot, source.id)
      if (backend === 'jsonl') {
        mkdirSync(join(sourcePath, 'durable-store'), { recursive: true })
        writeFileSync(join(sourcePath, 'durable-store', 'main.jsonl'), '')
      }
      const requestsBeforeOpen = requests.length
      await deadline(manager.renameSession(source.id, ''))
      expect(loadSession(workspaceRoot, source.id)?.name).toBe('')
      expect(requests.length).toBe(requestsBeforeOpen)
      await deadline(manager.sendMessage(source.id, 'included source marker'))
      expect(loadSession(workspaceRoot, source.id)?.name).toBe('')
      expect(existsSync(join(sourcePath, 'durable-store', backend === 'jsonl' ? 'main.jsonl' : 'store.db'))).toBe(true)
      await deadline(manager.sendMessage(source.id, 'excluded source marker'))
      const nameRequests = requests.length
      await deadline(manager.sendMessage(source.id, '/native-name Plugin committed name'))
      expect((await read(source.id)).stored.name).toBe('Plugin committed name')
      await deadline(manager.renameSession(source.id, 'Product manual name'))
      await deadline(manager.sendMessage(source.id, '/native-read-name'))
      const named = await read(source.id)
      expect(named.tree.entries.findLast(entry => entry.customType === 'observed-name')?.data).toEqual({ name: 'Product manual name' })
      expect(named.stored.name).toBe('Product manual name')
      await deadline(manager.renameSession(source.id, ''))
      expect((await read(source.id)).stored.name).toBe('')
      expect(requests.length).toBe(nameRequests)
      const path = join(sourcePath, 'attachments', 'inactive.md')
      mkdirSync(join(sourcePath, 'attachments'), { recursive: true })
      writeFileSync(path, 'archived file contents')
      const inactiveRow = runtime.sessions.get(source.id)!.messages.find(row => row.content === 'excluded source marker')!
      inactiveRow.attachments = [{ id: 'archive-file', type: 'text', name: 'inactive.md',
        mimeType: 'text/markdown', size: 22, storedPath: path }]
      await deadline(manager.sendMessage(source.id, '/archive-marker'))
      const before = await read(source.id)
      const firstReply = before.tree.entries.find(entry => entry.type === 'message'
        && entry.message && typeof entry.message === 'object' && 'role' in entry.message && entry.message.role === 'assistant')!
      const originalPid = child(runtime.sessions.get(source.id)!.agent)!.pid
      const targetId = await fork(source.id, firstReply.id)
      const closed = await read(source.id)
      const target = await read(targetId)
      expect(closed.tree.entries.length).toBeGreaterThan(before.tree.entries.length)
      expect(closed.tree.entries.some(entry => entry.customType === 'shutdown-marker')).toBe(true)
      expect(target.stored.nativeSessionOwner?.committed).toBe(true)
      expect(target.stored.nativeSessionOwner?.fork?.source).toEqual(closed.tree.reference)
      expect(target.stored.name).toBe('')
      expect(target.tree.header.parentSession).toBe(closed.tree.reference.sessionFile)
      expect(target.tree.reference.nativeSessionId).not.toBe(closed.tree.reference.nativeSessionId)
      expect(target.tree.entries.slice(0, closed.tree.entries.length).map(entry => entry.id)).toEqual(closed.tree.entries.map(entry => entry.id))
      expect(target.stored.messages.some(row => row.content === 'included source marker')).toBe(true)
      expect(target.stored.messages.some(row => row.content === 'excluded source marker')).toBe(false)
      expect(target.stored.nativeArchivedMessages?.some(row => row.id === inactiveRow.id)).toBe(true)
      expect(target.stored.nativeArchivedMessages?.find(row => row.id === inactiveRow.id)?.attachments?.[0]?.storedPath)
        .toBe(join(getSessionPath(workspaceRoot, targetId), 'attachments', 'inactive.md'))
      expect(readFileSync(join(getSessionPath(workspaceRoot, targetId), 'attachments', 'inactive.md'), 'utf8')).toBe('archived file contents')
      expect(JSON.stringify(target.tree.entries)).not.toContain(path)
      expect(JSON.stringify(requests.at(-1))).toContain('included source marker')
      expect(JSON.stringify(requests.at(-1))).not.toContain('excluded source marker')
      expect(JSON.stringify(requests.at(-1))).toContain('fork callback marker')
      expect(child(runtime.sessions.get(targetId)!.agent)?.pid).toBe(originalPid)
      expect(child(runtime.sessions.get(source.id)!.agent)).toBeNull()
      expect(existsSync(join(getSessionPath(workspaceRoot, targetId), 'durable-store', backend === 'jsonl' ? 'main.jsonl' : 'store.db'))).toBe(true)
      const repeatedId = await fork(targetId, firstReply.id)
      const repeated = await read(repeatedId)
      expect(repeated.tree.header.parentSession).toBe(target.tree.reference.sessionFile)
      expect(repeated.stored.nativeArchivedMessages?.some(row => row.id === inactiveRow.id)).toBe(true)
      await deadline(manager.sendMessage(source.id, 'resumed original source marker'))
      await deadline(manager.sendMessage(source.id, '/native-idle'))
      const waiting = held = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
      const busyTarget = manager.sendMessage(source.id, 'held target marker')
      await deadline(waiting.entered.promise)
      try {
        await deadline(manager.renameSession(source.id, 'Renamed during streaming'))
        expect(loadSession(workspaceRoot, source.id)?.name).toBe('Renamed during streaming')
      } catch (error) {
        waiting.release.resolve()
        await busyTarget
        throw error
      }
      const busySwitch = operation = { sourceId: repeatedId, targetId: source.id, done: Promise.withResolvers<string>() }
      const busyError = busySwitch.done.promise.catch(error => String(error))
      const sourcePid = child(runtime.sessions.get(repeatedId)!.agent)!.pid
      try {
        await deadline(manager.sendMessage(repeatedId, `/native-switch ${before.tree.reference.sessionFile}`,
          undefined, undefined, undefined, undefined, undefined, undefined, { callerClientId: 'fork-client' }))
        expect(await deadline(busyError)).toContain('busy or unavailable')
        expect(child(runtime.sessions.get(repeatedId)!.agent)?.pid).toBe(sourcePid)
      } finally {
        operation = undefined
        waiting.release.resolve()
        await deadline(busyTarget)
      }
      await deadline(manager.sendMessage(source.id, '/native-idle'))
      const reserved = await read(source.id)
      const oldTargetPid = child(runtime.sessions.get(source.id)!.agent)!.pid
      expect(oldTargetPid).not.toBe(originalPid)
      const createdBeforeSwitch = created.length
      const existingTarget = runtime.sessions.get(source.id)!.agent.nativeSessionOwner!
      const prepareActivation = existingTarget.prepareActivation
      existingTarget.prepareActivation = async () => { throw new Error('intentional switch activation rejection') }
      const failedSwitch = operation = { sourceId: repeatedId, targetId: source.id, done: Promise.withResolvers<string>() }
      const failed = failedSwitch.done.promise.catch(error => String(error))
      const rejected = manager.sendMessage(repeatedId, `/native-switch ${reserved.tree.reference.sessionFile}`,
        undefined, undefined, undefined, undefined, undefined, undefined, { callerClientId: 'fork-client' })
      try {
        expect(await deadline(failed)).toContain('intentional switch activation rejection')
        await deadline(rejected)
      } finally {
        existingTarget.prepareActivation = prepareActivation
        operation = undefined
      }
      const retained = await read(source.id)
      expect(retained.tree).toEqual(reserved.tree)
      expect(retained.stored.messages).toEqual(reserved.stored.messages)
      expect(retained.stored.nativeArchivedMessages).toEqual(reserved.stored.nativeArchivedMessages)
      expect(retained.stored.nativeSessionOwner?.unpublished).not.toBe(true)
      expect(await manager.getSession(source.id)).not.toBeNull()
      expect(child(runtime.sessions.get(source.id)!.agent)?.pid).toBe(oldTargetPid)
      expect(child(runtime.sessions.get(repeatedId)!.agent)).toBeNull()
      await deadline(manager.sendMessage(repeatedId, '/native-idle'))
      const switchPid = child(runtime.sessions.get(repeatedId)!.agent)!.pid
      const currentSwitch = operation = { sourceId: repeatedId, targetId: source.id, done: Promise.withResolvers<string>() }
      const switching = manager.sendMessage(repeatedId, `/native-switch ${reserved.tree.reference.sessionFile}`,
        undefined, undefined, undefined, undefined, undefined, undefined, { callerClientId: 'fork-client' })
      expect(await deadline(currentSwitch.done.promise)).toBe(source.id)
      await deadline(switching)
      operation = undefined
      const resumed = await read(source.id)
      expect(created).toHaveLength(createdBeforeSwitch)
      expect(resumed.tree.reference.nativeSessionId).toBe(reserved.tree.reference.nativeSessionId)
      expect(resumed.tree.reference.conversationId).toBe(reserved.tree.reference.conversationId)
      expect(resumed.tree.header).toEqual(reserved.tree.header)
      expect(resumed.tree.entries.slice(0, reserved.tree.entries.length)).toEqual(reserved.tree.entries)
      expect(resumed.stored.nativeSessionOwner?.operation).toBe('switch')
      expect(resumed.stored.nativeSessionOwner?.committed).toBe(true)
      expect(resumed.stored.name).toBe('')
      expect(resumed.stored.messages.some(row => row.content === 'excluded source marker')).toBe(true)
      expect(child(runtime.sessions.get(source.id)!.agent)?.pid).toBe(switchPid)
      expect(child(runtime.sessions.get(repeatedId)!.agent)).toBeNull()
      expect(JSON.stringify(requests.at(-1))).toContain('excluded source marker')
      expect(JSON.stringify(requests.at(-1))).toContain('resumed original source marker')
      expect(JSON.stringify(requests.at(-1))).toContain('switch callback marker')
      expect(JSON.stringify(requests.at(-1))).not.toContain('fork callback marker')
      const switchedAgent = runtime.sessions.get(source.id)!.agent
      await deadline(switchedAgent.nativeSessionOwner!.releaseForOwner())
      expect(child(switchedAgent)).toBeNull()
      await deadline(manager.sendMessage(source.id, 'cold switched target marker'))
      expect(child(switchedAgent)?.pid).not.toBe(switchPid)
      expect(switchedAgent.getSessionId()).toBe(reserved.tree.reference.nativeSessionId)
      expect(JSON.stringify(requests.at(-1))).toContain('resumed original source marker')
      expect(JSON.stringify(requests.at(-1))).not.toContain('fork callback marker')
      const parentPid = child(switchedAgent)!.pid
      const parentCreated = created.length
      const invalidParent = operation = { sourceId: source.id, done: Promise.withResolvers<string>() }
      const parentError = invalidParent.done.promise.catch(error => String(error))
      await deadline(manager.sendMessage(source.id, '/native-parent ../unregistered',
        undefined, undefined, undefined, undefined, undefined, undefined, { callerClientId: 'fork-client' }))
      expect(await deadline(parentError)).toContain('canonical registered path')
      expect(created).toHaveLength(parentCreated)
      expect(child(switchedAgent)?.pid).toBe(parentPid)
      operation = undefined
      for (const from of [source.id, repeatedId]) {
        const currentParent = operation = { sourceId: from, targetId: undefined as string | undefined,
          done: Promise.withResolvers<string>() }
        const sendingParent = manager.sendMessage(from, `/native-parent ${resumed.tree.reference.sessionFile}`,
          undefined, undefined, undefined, undefined, undefined, undefined, { callerClientId: 'fork-client' })
        const parentTargetId = await deadline(currentParent.done.promise)
        await deadline(sendingParent)
        operation = undefined
        const parentTarget = await read(parentTargetId)
        expect(parentTarget.stored.parentSessionId).toBe(source.id)
        expect(parentTarget.tree.header.parentSession).toBe(resumed.tree.reference.sessionFile)
        expect(parentTarget.tree.reference.nativeSessionId).not.toBe(resumed.tree.reference.nativeSessionId)
        expect(parentTarget.stored.nativeSessionOwner?.parent?.sessionId).toBe(source.id)
        expect(JSON.stringify(requests.at(-1))).toContain('parent callback marker')
        expect(JSON.stringify(requests.at(-1))).not.toContain('included source marker')
        expect(JSON.stringify(requests.at(-1))).not.toContain('fork callback marker')
        expect(child(runtime.sessions.get(from)!.agent)).toBeNull()
        const parentAgent = runtime.sessions.get(parentTargetId)!.agent
        const beforeParentPid = child(parentAgent)!.pid
        if (from === source.id) expect(beforeParentPid).toBe(parentPid)
        await deadline(parentAgent.nativeSessionOwner!.releaseForOwner())
        await deadline(manager.sendMessage(parentTargetId, 'cold parent target marker'))
        expect(child(parentAgent)?.pid).not.toBe(beforeParentPid)
        expect(parentAgent.getSessionId()).toBe(parentTarget.tree.reference.nativeSessionId)
        expect(JSON.stringify(requests.at(-1))).toContain('parent callback marker')
        expect(JSON.stringify(requests.at(-1))).not.toContain('included source marker')
      }
      await deadline(manager.deleteSession(source.id))
      await deadline(manager.deleteSession(targetId))
      const repeatedAgent = runtime.sessions.get(repeatedId)!.agent
      const beforeNameFailure = loadSession(workspaceRoot, repeatedId)!.name
      const rename = fs.rename
      const spy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === getSessionFilePath(workspaceRoot, repeatedId)) throw new Error('name receipt storage failure')
        return rename(from, to)
      })
      try {
        await expect(deadline(manager.renameSession(repeatedId, 'Recovered committed name'))).rejects.toThrow('name receipt storage failure')
      } finally { spy.mockRestore() }
      expect(loadSession(workspaceRoot, repeatedId)?.name).toBe(beforeNameFailure)
      expect(JSON.parse(readFileSync(join(getSessionPath(workspaceRoot, repeatedId), 'meta', 'native-session.json'), 'utf8')).name)
        .toBe('Recovered committed name')
      await deadline(repeatedAgent.nativeSessionOwner!.releaseForOwner()).catch(() => {})
      expect(child(repeatedAgent)).toBeNull()
      await deadline(manager.sendMessage(repeatedId, 'cold fork continuation marker'))
      expect(child(repeatedAgent)?.pid).not.toBe(originalPid)
      expect(JSON.stringify(requests.at(-1))).toContain('cold fork continuation marker')
      expect(JSON.stringify(requests.at(-1))).toContain('included source marker')
      expect(JSON.stringify(requests.at(-1))).not.toContain('excluded source marker')
      await manager.flushSession(repeatedId)
      expect(loadSession(workspaceRoot, repeatedId)?.nativeArchivedMessages?.some(row => row.id === inactiveRow.id)).toBe(true)
      expect(loadSession(workspaceRoot, repeatedId)?.name).toBe('Recovered committed name')
      expect(redirected).toContain(repeatedId)

      const navigating = await manager.createSession(workspace.id, { name: `Tree ${backend}` })
      const navigationPath = getSessionPath(workspaceRoot, navigating.id)
      if (backend === 'jsonl') {
        mkdirSync(join(navigationPath, 'durable-store'), { recursive: true })
        writeFileSync(join(navigationPath, 'durable-store', 'main.jsonl'), '')
      }
      await deadline(manager.sendMessage(navigating.id, 'tree first marker'))
      await deadline(manager.sendMessage(navigating.id, 'tree second marker'))
      await deadline(manager.sendMessage(navigating.id, '/native-idle'))
      const beforeTree = await read(navigating.id)
      const secondUser = beforeTree.tree.entries.find(entry => entry.type === 'message'
        && (entry.message as { role: string; content: string }).role === 'user'
        && JSON.stringify(entry.message).includes('tree second marker'))!
      const secondReply = beforeTree.tree.entries.findLast(entry => entry.type === 'message'
        && (entry.message as { role: string }).role === 'assistant')!
      const secondRow = beforeTree.stored.messages.find(row => row.content === 'tree second marker')!
      const navigationRequests = requests.length
      await deadline(manager.sendMessage(navigating.id, `/native-tree plain ${secondUser.id}`))
      const rewound = await read(navigating.id)
      expect(requests.length).toBe(navigationRequests)
      expect(rewound.stored.messages.some(row => row.id === secondRow.id)).toBe(false)
      expect(rewound.stored.nativeArchivedMessages?.some(row => row.id === secondRow.id)).toBe(true)
      expect(rewound.tree.entries.findLast(entry => entry.customType === 'tree-result')?.data)
        .toMatchObject({ cancelled: false, editorText: expect.stringContaining('tree second marker'), leaf: secondUser.parentId })
      expect(rewound.tree.reference.treeRevision).toBeGreaterThan(0)
      expect(historyEvents.some(event => event.sessionId === navigating.id)).toBe(true)
      await deadline(manager.sendMessage(navigating.id, `/native-tree cancel ${secondReply.id}`))
      const cancelled = await read(navigating.id)
      expect(cancelled.tree.entries.findLast(entry => entry.customType === 'tree-result')?.data).toMatchObject({ cancelled: true })
      expect(cancelled.tree.reference.treeRevision).toBe(rewound.tree.reference.treeRevision)
      expect(cancelled.stored.messages.some(row => row.id === secondRow.id)).toBe(false)
      await deadline(manager.sendMessage(navigating.id, `/native-tree plain ${secondReply.id}`))
      const restored = await read(navigating.id)
      expect(restored.stored.messages.some(row => row.id === secondRow.id)).toBe(true)
      expect(restored.stored.nativeArchivedMessages?.some(row => row.id === secondRow.id)).toBe(false)
      await deadline(manager.sendMessage(navigating.id, `/native-tree plain ${restored.tree.reference.leaf}`))
      const unchanged = await read(navigating.id)
      expect(unchanged.tree.reference.treeRevision).toBe(restored.tree.reference.treeRevision)
      const validResults = unchanged.tree.entries.filter(entry => entry.customType === 'tree-result').length
      await deadline(manager.sendMessage(navigating.id, '/native-tree plain unavailable-tree-entry'))
      const invalid = await read(navigating.id)
      expect(invalid.tree.reference.treeRevision).toBe(unchanged.tree.reference.treeRevision)
      expect(invalid.tree.entries.filter(entry => entry.customType === 'tree-result')).toHaveLength(validResults)
      expect(requests.length).toBe(navigationRequests)
      await deadline(manager.sendMessage(navigating.id, `/native-tree summarize ${secondUser.id}`))
      const summarized = await read(navigating.id)
      const branchSummary = summarized.tree.entries.findLast(entry => entry.type === 'branch_summary')!
      expect(branchSummary.summary).toContain('local fork reply')
      expect(requests.length).toBe(navigationRequests + 1)
      expect(summarized.stored.messages.some(row => row.id === secondRow.id)).toBe(false)
      const navigationAgent = runtime.sessions.get(navigating.id)!.agent
      const navigationPid = child(navigationAgent)!.pid
      await deadline(navigationAgent.nativeSessionOwner!.releaseForOwner())
      await deadline(manager.sendMessage(navigating.id, 'cold tree continuation marker'))
      await deadline(manager.sendMessage(navigating.id, '/native-idle'))
      expect(child(navigationAgent)?.pid).not.toBe(navigationPid)
      expect(JSON.stringify(requests.at(-1))).toContain(JSON.stringify(branchSummary.summary).slice(1, -1))
      expect(JSON.stringify(requests.at(-1))).not.toContain('tree second marker')
      expect((await read(navigating.id)).stored.nativeArchivedMessages?.some(row => row.id === secondRow.id)).toBe(true)

      const beforeHistoryFailure = await read(navigating.id)
      const resultsBeforeFailure = beforeHistoryFailure.tree.entries.filter(entry => entry.customType === 'tree-result').length
      const historySpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === getSessionFilePath(workspaceRoot, navigating.id)) {
          const pending = await fs.readFile(from, 'utf8')
          const revision = Number(pending.match(/"treeRevision":(\d+)/)?.[1] ?? 0)
          if (revision > (beforeHistoryFailure.tree.reference.treeRevision ?? 0)) throw new Error('history receipt storage failure')
        }
        return rename(from, to)
      })
      try {
        await deadline(manager.sendMessage(navigating.id, `/native-tree plain ${secondReply.id}`))
        const failedManifest = JSON.parse(readFileSync(join(navigationPath, 'meta', 'native-session.json'), 'utf8'))
        expect(failedManifest.treeRevision).toBeGreaterThan(beforeHistoryFailure.tree.reference.treeRevision!)
        expect(loadSession(workspaceRoot, navigating.id)?.nativeSessionProjection?.treeRevision)
          .toBe(beforeHistoryFailure.tree.reference.treeRevision)
        await deadline(navigationAgent.nativeSessionOwner!.releaseForOwner()).catch(() => {})
      } finally { historySpy.mockRestore() }
      await deadline(manager.sendMessage(navigating.id, 'repaired tree continuation marker'))
      await deadline(manager.sendMessage(navigating.id, '/native-idle'))
      const repaired = await read(navigating.id)
      expect(repaired.stored.messages.some(row => row.id === secondRow.id)).toBe(true)
      expect(repaired.stored.nativeArchivedMessages?.some(row => row.id === secondRow.id)).toBe(false)
      expect(repaired.tree.entries.filter(entry => entry.customType === 'tree-result')).toHaveLength(resultsBeforeFailure)
      expect(JSON.stringify(requests.at(-1))).toContain('tree second marker')
      expect(JSON.stringify(requests.at(-1))).not.toContain('cold tree continuation marker')
    }
  } finally {
    try { await deadline(manager.flushAllSessions()) }
    finally {
      manager.cleanup()
      endpoint.stop(true)
      if (previousConfig === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = previousConfig
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  }
}, 120_000)
