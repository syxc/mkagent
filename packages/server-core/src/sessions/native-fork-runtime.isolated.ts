/** Real product fork, native journal, archive, callback and process restart. */
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Message } from '@mkagent/core/types'
import type { PiAgent } from '../../../shared/src/agent/pi-agent'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

test('real product forks preserve full trees and archived files across repeated ownership and restart on both stores', async () => {
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
      pi.on('session_shutdown', (_, ctx) => {
        if (basename(process.env.MKAGENT_SESSION_DIR || '') !== readFileSync(join(ctx.cwd, '.fork-source'), 'utf8')) return;
        pi.appendEntry('shutdown-marker', { marker: 'closed source marker' });
        pi.setSessionName('');
      });
    }
  `)
  const requests: Array<Record<string, unknown>> = []
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>)
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
  const { getSessionPath, loadSession } = await import('@mkagent/shared/sessions')
  const { readTrustedNativeSession } = await import('./native-session-source')
  const platform = createHeadlessPlatform()
  platform.appRootPath = appRoot
  setSessionPlatform(platform)
  const manager = new SessionManager()
  const runtime = manager as unknown as { sessions: Map<string, { agent: PiAgent; messages: Message[] }> }
  const child = (agent: PiAgent) => (agent as unknown as { subprocess: ChildProcessWithoutNullStreams | null }).subprocess
  let operation: { sourceId: string; targetId?: string; done: ReturnType<typeof Promise.withResolvers<string>> } | undefined
  const redirected: string[] = []
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
      if (event.type === 'session_created' && operation && event.session.parentSessionId === operation.sourceId) {
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
      await deadline(manager.sendMessage(source.id, 'included source marker'))
      expect(existsSync(join(sourcePath, 'durable-store', backend === 'jsonl' ? 'main.jsonl' : 'store.db'))).toBe(true)
      await deadline(manager.sendMessage(source.id, 'excluded source marker'))
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
      await deadline(manager.deleteSession(source.id))
      await deadline(manager.deleteSession(targetId))
      const repeatedAgent = runtime.sessions.get(repeatedId)!.agent
      await deadline(repeatedAgent.nativeSessionOwner!.releaseForOwner())
      await deadline(manager.sendMessage(repeatedId, 'cold fork continuation marker'))
      expect(child(repeatedAgent)?.pid).not.toBe(originalPid)
      expect(JSON.stringify(requests.at(-1))).toContain('cold fork continuation marker')
      expect(JSON.stringify(requests.at(-1))).toContain('included source marker')
      expect(JSON.stringify(requests.at(-1))).not.toContain('excluded source marker')
      await manager.flushSession(repeatedId)
      expect(loadSession(workspaceRoot, repeatedId)?.nativeArchivedMessages?.some(row => row.id === inactiveRow.id)).toBe(true)
      expect(redirected).toContain(repeatedId)
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
