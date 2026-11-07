/** Branch initialization must own strict receipts before its creation is published. */
import { afterAll, expect, spyOn, test } from 'bun:test'
import * as fsPromises from 'node:fs/promises'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentBackend } from '@mkagent/shared/agent/backend'
import type { SessionEvent } from '@mkagent/shared/protocol'
import type { StoredSession } from '@mkagent/shared/sessions'

const root = mkdtempSync(join(tmpdir(), 'branch-preflight-'))
const previousConfig = process.env.CONFIG_DIR
const previousHome = process.env.HOME
process.env.CONFIG_DIR = root
process.env.HOME = join(root, 'home')
const { SessionManager, savePiTurnAnchor } = await import('./SessionManager')
const { getSessionPath, listSessions, loadSession, sessionPersistenceQueue } = await import('@mkagent/shared/sessions')
type Managed = ReturnType<typeof import('./SessionManager')['createManagedSession']>
type Harness = {
  sessions: Map<string, Managed>
  getOrCreateAgent(managed: Managed): Promise<AgentBackend>
  persistNativeMetadata(id: string, prepare: (snapshot: StoredSession, managed: Managed) => () => void): Promise<void>
  waitForNativeWrites(id: string): Promise<void>
  emit(workspaceId: string, event: SessionEvent): void
}

afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  if (previousConfig === undefined) delete process.env.CONFIG_DIR
  else process.env.CONFIG_DIR = previousConfig
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const workspaceRoot = mkdtempSync(join(root, 'workspace-'))
  const workspace = { id: 'branch-ws', slug: 'branch-ws', name: 'Branch fixture', rootPath: workspaceRoot, createdAt: 1 }
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1 }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id }))
  const manager = new SessionManager()
  const harness = manager as unknown as Harness
  const source = await manager.createSession(workspace.id, { codingMode: true })
  const sourceManaged = harness.sessions.get(source.id)!
  sourceManaged.sdkSessionId = 'fixture-native-source'
  sourceManaged.messages = [
    { id: 'branch-user', role: 'user', content: 'Before the checkpoint', timestamp: 1 },
    { id: 'branch-answer', role: 'assistant', content: 'Checkpoint answer', timestamp: 2 },
  ]
  await manager.flushSession(source.id)
  await savePiTurnAnchor(getSessionPath(workspaceRoot, source.id), 'branch-answer', 'native-answer')
  const events: unknown[] = []
  manager.setEventSink((_channel, _target, event) => events.push(event))
  return { manager, harness, workspace, source, events }
}

test.each(['success', 'failure-after-receipt'] as const)('branch preflight %s preserves strict receipts and creation order', async outcome => {
  const f = await fixture()
  let branchId = ''
  let destroyed = 0
  let receipts = 0
  const failure = new Error('Fixture branch preflight failure')
  const backend = {
    destroy() { destroyed++ },
    async ensureBranchReady() {
      expect(f.events).toEqual([])
      expect(f.manager.getSessions(f.workspace.id).map(session => session.id)).toEqual([f.source.id])
      expect(await f.manager.getSession(branchId)).toBeNull()
      await expect(f.manager.sendMessage(branchId, 'Must wait for creation')).rejects.toThrow('initializing')
      const managed = f.harness.sessions.get(branchId)!
      managed.isProcessing = true
      expect(f.manager.getActiveSessionCount(f.workspace.id)).toBe(0)
      expect(f.manager.getActiveSessionsInfo()).toEqual([])
      managed.isProcessing = false
      await f.harness.persistNativeMetadata(branchId, (snapshot, managed) => {
        snapshot.name = 'Receipt saved before creation'
        return () => { managed.name = snapshot.name }
      })
      receipts++
      expect(loadSession(f.workspace.rootPath, branchId)?.name).toBe('Receipt saved before creation')
      f.harness.emit(f.workspace.id, { type: 'name_changed', sessionId: branchId, name: 'Receipt saved before creation' })
      expect(f.events).toEqual([])
      if (outcome === 'failure-after-receipt') throw failure
    },
  } as unknown as AgentBackend
  const prepare = spyOn(f.harness, 'getOrCreateAgent').mockImplementation(async managed => {
    branchId = managed.id
    managed.agent = backend
    return backend
  })
  try {
    const result = await f.manager.createSession(f.workspace.id, {
      branchFromSessionId: f.source.id, branchFromMessageId: 'branch-answer', codingMode: false,
    }).then(value => ({ kind: 'value' as const, value }), error => ({ kind: 'error' as const, error }))
    expect(receipts).toBe(1)
    if (outcome === 'success') {
      expect(result.kind).toBe('value')
      if (result.kind !== 'value') throw result.error
      expect(result.value.codingMode).toBe(true)
      expect(result.value.name).toBe('Receipt saved before creation')
      expect(f.events).toEqual([{ type: 'session_created', sessionId: branchId }])
    } else {
      expect(result.kind).toBe('error')
      if (result.kind !== 'error') throw new Error('Expected branch failure')
      expect(result.error.message).toContain(failure.message)
      expect(destroyed).toBe(1)
      expect(f.harness.sessions.has(branchId)).toBe(false)
      expect(f.events).toEqual([])
      await sessionPersistenceQueue.flushAll()
      expect(existsSync(getSessionPath(f.workspace.rootPath, branchId))).toBe(false)
      expect(listSessions(f.workspace.rootPath).map(session => session.id)).toEqual([f.source.id])
    }
  } finally {
    prepare.mockRestore()
    f.manager.cleanup()
    await sessionPersistenceQueue.flushAll()
  }
})

test('failed branch preflight waits for an active receipt and cancels deferred saves before removing files', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const cleanupWaiting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const failure = new Error('Fixture fails while a receipt is writing')
  let branchId = ''
  let receipt: Promise<void> | undefined
  const rename = fsPromises.rename
  const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (branchId && String(to) === join(getSessionPath(f.workspace.rootPath, branchId), 'session.jsonl')) {
      entered.resolve()
      await release.promise
    }
    return rename(from, to)
  })
  const backend = {
    destroy() {},
    async ensureBranchReady() {
      receipt = f.harness.persistNativeMetadata(branchId, (snapshot, managed) => {
        snapshot.name = 'Active receipt'
        return () => { managed.name = snapshot.name }
      })
      void receipt.catch(() => {})
      await entered.promise
      sessionPersistenceQueue.enqueue({
        ...loadSession(f.workspace.rootPath, branchId)!, name: 'Pending SDK identity metadata',
      })
      throw failure
    },
  } as unknown as AgentBackend
  const prepare = spyOn(f.harness, 'getOrCreateAgent').mockImplementation(async managed => {
    branchId = managed.id
    managed.agent = backend
    return backend
  })
  const wait = f.harness.waitForNativeWrites.bind(f.harness)
  const waitSpy = spyOn(f.harness, 'waitForNativeWrites').mockImplementation(async id => {
    if (id === branchId) cleanupWaiting.resolve()
    await wait(id)
  })
  let finished = false
  const creating = f.manager.createSession(f.workspace.id, {
    branchFromSessionId: f.source.id, branchFromMessageId: 'branch-answer',
  }).then(() => { throw new Error('Expected preflight failure') }, error => error)
    .finally(() => { finished = true })
  try {
    await entered.promise
    await cleanupWaiting.promise
    // The receipt has entered rename and cannot finish until the fixture releases it.
    expect(finished).toBe(false)
    expect(existsSync(getSessionPath(f.workspace.rootPath, branchId))).toBe(true)
    release.resolve()
    expect((await creating).message).toContain(failure.message)
    await receipt
    await sessionPersistenceQueue.flushAll()
    expect(f.harness.sessions.has(branchId)).toBe(false)
    expect(existsSync(getSessionPath(f.workspace.rootPath, branchId))).toBe(false)
    expect(f.events).toEqual([])
  } finally {
    release.resolve()
    await creating
    renameSpy.mockRestore()
    prepare.mockRestore()
    waitSpy.mockRestore()
    f.manager.cleanup()
    await sessionPersistenceQueue.flushAll()
  }
}, 10_000)
