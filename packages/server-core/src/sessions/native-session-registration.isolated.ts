import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentBackend } from '@mkagent/shared/agent/backend'
import type { NativeSessionOwnerRecord, NativeSessionReference } from '@mkagent/shared/sessions'
import type { NativeForkProof } from './native-session-fork'

const root = mkdtempSync(join(tmpdir(), 'native-registration-'))
const previous = { HOME: process.env.HOME, CONFIG_DIR: process.env.CONFIG_DIR }
process.env.CONFIG_DIR = root
process.env.HOME = join(root, 'home')
mkdirSync(process.env.HOME)
const { SessionManager, createManagedSession } = await import('./SessionManager')
const { getSessionFilePath, getSessionPath, loadSession, sessionPersistenceQueue } = await import('@mkagent/shared/sessions')
type Managed = ReturnType<typeof createManagedSession>
type Harness = {
  sessions: Map<string, Managed>
  nativeOwners: { port(id: string): { onProjection(ref: unknown, backend: unknown, transport: object, hasName?: boolean): Promise<void> } }
  persistNativeOwner(id: string, record: NativeSessionOwnerRecord): Promise<void>
  persistNativeForkHistory(id: string, proof: NativeForkProof): Promise<void>
  persistSession(managed: Managed): void
  getOrCreateAgent(managed: Managed): Promise<AgentBackend>
  generateTitle(managed: Managed, text: string): Promise<void>
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  for (const key of ['HOME', 'CONFIG_DIR'] as const) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const workspaceRoot = mkdtempSync(join(root, 'workspace-'))
  const workspace = { id: 'registry', name: 'Registry fixture', slug: 'registry', rootPath: workspaceRoot, createdAt: 1 }
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1 }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id }))
  const manager = new SessionManager()
  cleanup.push(async () => { await manager.flushAllSessions(); manager.cleanup() })
  const source = await manager.createSession(workspace.id, { name: 'Product name', codingMode: true })
  const harness = manager as unknown as Harness
  const managed = harness.sessions.get(source.id)!
  let revision = 1
  const backend = { setSessionName: async (name: string) => {
    revision++
    await register({ ...reference, revision, name, digest: String(revision).repeat(64), manifestDigest: String(revision + 1).repeat(64) })
  } }
  managed.agent = { nativeSessionOwner: backend, getSessionId: () => 'native-source', destroy() {} } as unknown as AgentBackend
  managed.sdkSessionId = 'native-source'
  const reference: NativeSessionReference = {
    version: 1, sessionId: source.id, nativeSessionId: 'native-source', conversationId: 1,
    revision: 1, sessionFile: join(getSessionPath(workspaceRoot, source.id), 'native-session', 'session.jsonl'),
    leaf: null, name: null, digest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64),
  }
  const register = (ref: unknown = reference, owner: unknown = backend) =>
    harness.nativeOwners.port(source.id).onProjection(ref, owner, {})
  return { manager, harness, managed, source, workspace, workspaceRoot, reference, register }
}

test('only the current product backend can register its canonical native reference', async () => {
  const f = await fixture()
  await expect(f.register(f.reference, {})).rejects.toThrow('current')
  await expect(f.register({ ...f.reference, sessionId: 'other' })).rejects.toThrow('identity')
  await expect(f.register({ ...f.reference, nativeSessionId: 'other' })).rejects.toThrow('identity')
  await expect(f.register({ ...f.reference, sessionFile: join(f.workspaceRoot, 'foreign.jsonl') })).rejects.toThrow('path')
  await f.register()
  const stored = loadSession(f.workspaceRoot, f.source.id)!
  expect((stored as unknown as { nativeSessionProjection: unknown }).nativeSessionProjection).toEqual(f.reference)
  const reopened = createManagedSession(stored, f.workspace)
  expect((reopened as unknown as { nativeSessionProjection: unknown }).nativeSessionProjection).toEqual(f.reference)
  expect(stored.name).toBe('Product name')
})

test('committed names save before broadcast, clear explicitly and repair an equal revision', async () => {
  const f = await fixture()
  const broadcasts: Array<unknown> = []
  f.manager.setEventSink((_channel, _target, value) => {
    const event = value as { type: string; name?: string }
    if (event.type !== 'name_changed') return
    expect(loadSession(f.workspaceRoot, f.source.id)?.name).toBe(event.name)
    broadcasts.push(event.name)
  })
  const named = { ...f.reference, name: 'Native name' }
  await f.register(named)
  expect(f.managed.name).toBe('Native name')
  const clear = { ...f.reference, revision: 2, digest: 'c'.repeat(64), manifestDigest: 'd'.repeat(64) }
  await f.harness.nativeOwners.port(f.source.id).onProjection(clear, f.managed.agent!.nativeSessionOwner, {}, true)
  expect(loadSession(f.workspaceRoot, f.source.id)?.name).toBe('')
  expect(createManagedSession(loadSession(f.workspaceRoot, f.source.id)!, f.workspace).name).toBe('')
  await f.register(named)
  expect(f.managed.name).toBe('')
  // The pointer may already be saved when upgrading or retrying a name receipt.
  f.managed.name = 'Unsynchronized product title'
  await f.harness.nativeOwners.port(f.source.id).onProjection(clear, f.managed.agent!.nativeSessionOwner, {}, true)
  expect(f.managed.name).toBe('')
  expect(broadcasts).toEqual(['Native name', '', ''])
})

test('failed strict registration keeps the preceding pointer and can retry the receipt', async () => {
  const f = await fixture()
  await f.register()
  const next = { ...f.reference, revision: 2, name: 'Saved after retry', digest: 'c'.repeat(64), manifestDigest: 'd'.repeat(64) }
  const broadcasts: string[] = []
  f.manager.setEventSink((_channel, _target, event) => {
    if (event && typeof event === 'object' && 'type' in event && event.type === 'name_changed') broadcasts.push(String(event.name))
  })
  const rename = fs.rename
  const spy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === getSessionFilePath(f.workspaceRoot, f.source.id)) throw new Error('registry rename failure')
    return rename(from, to)
  })
  try { await expect(f.register(next)).rejects.toThrow('registry rename failure') }
  finally { spy.mockRestore() }
  expect(f.managed.name).toBe('Product name')
  expect(broadcasts).toEqual([])
  expect((f.managed as unknown as { nativeSessionProjection: unknown }).nativeSessionProjection).toEqual(f.reference)
  expect((loadSession(f.workspaceRoot, f.source.id) as unknown as { nativeSessionProjection: unknown }).nativeSessionProjection).toEqual(f.reference)
  await f.register(next)
  expect(f.managed.name).toBe('Saved after retry')
  expect(broadcasts).toEqual(['Saved after retry'])
  expect((loadSession(f.workspaceRoot, f.source.id) as unknown as { nativeSessionProjection: unknown }).nativeSessionProjection).toEqual(next)
})

test('renaming an unopened coding session commits an explicit clear instead of losing it', async () => {
  const f = await fixture()
  const agent = f.managed.agent!
  f.managed.agent = null
  f.managed.sdkSessionId = undefined
  const opening = spyOn(f.harness, 'getOrCreateAgent').mockImplementation(async () => {
    f.managed.agent = agent
    return agent
  })
  try {
    await f.manager.renameSession(f.source.id, '')
    expect(loadSession(f.workspaceRoot, f.source.id)?.name).toBe('')
    expect(loadSession(f.workspaceRoot, f.source.id)?.nativeSessionProjection?.name).toBe('')
    expect(opening).toHaveBeenCalledTimes(1)
  } finally { opening.mockRestore() }
})

test('automatic title cannot overtake a manual rename awaiting its strict product receipt', async () => {
  const f = await fixture()
  await f.register()
  const title = Promise.withResolvers<string | null>()
  f.managed.agent!.generateTitle = () => title.promise
  const opening = spyOn(f.harness, 'getOrCreateAgent').mockResolvedValue(f.managed.agent!)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const rename = fs.rename
  const spy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === getSessionFilePath(f.workspaceRoot, f.source.id)) {
      entered.resolve()
      await release.promise
    }
    return rename(from, to)
  })
  const generation = f.harness.generateTitle(f.managed, 'first input')
  const renaming = f.manager.renameSession(f.source.id, 'Manual title')
  try {
    await entered.promise
    expect(f.managed.name).toBe('Product name')
    title.resolve('Automatic title')
    release.resolve()
    await Promise.all([generation, renaming])
    expect(loadSession(f.workspaceRoot, f.source.id)?.name).toBe('Manual title')
    expect(loadSession(f.workspaceRoot, f.source.id)?.nativeSessionProjection?.name).toBe('Manual title')
  } finally {
    title.resolve(null); release.resolve()
    await Promise.allSettled([generation, renaming])
    spy.mockRestore(); opening.mockRestore()
  }
})

test('native reference and owner receipts serialize snapshots without losing either field', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const rename = fs.rename
  let gated = false
  const spy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!gated && String(to) === getSessionFilePath(f.workspaceRoot, f.source.id)) {
      gated = true
      entered.resolve()
      await release.promise
    }
    return rename(from, to)
  })
  try {
    const registration = f.register()
    await entered.promise
    const record: NativeSessionOwnerRecord = {
      transactionId: 'concurrent-owner', role: 'source', operation: 'new', sourceSessionId: f.source.id,
      sourceNativeSessionId: 'native-source', phase: 'prepared', committed: false, callbacks: 'blocked',
    }
    const owner = f.harness.persistNativeOwner(f.source.id, record)
    const renaming = f.manager.renameSession(f.source.id, 'Concurrent name')
    release.resolve()
    await Promise.all([registration, owner, renaming])
    await f.manager.flushSession(f.source.id)
    const stored = loadSession(f.workspaceRoot, f.source.id)!
    expect(stored.nativeSessionProjection).toMatchObject({ revision: 2, name: 'Concurrent name' })
    expect(stored.nativeSessionOwner).toEqual(record)
    expect(stored.name).toBe('Concurrent name')
  } finally { release.resolve(); spy.mockRestore() }
})

test('fork history receipts retain input admitted and message updates arriving during strict IO', async () => {
  const f = await fixture()
  const early = { id: 'early', role: 'user' as const, content: 'initial text', timestamp: 1 }
  f.managed.messagesLoaded = true
  f.managed.messages.push(early)
  await f.manager.flushSession(f.source.id)
  const proof: NativeForkProof = {
    sourcePath: getSessionPath(f.workspaceRoot, f.source.id),
    tree: { reference: f.reference, header: {}, entries: [], entryIds: [], hasName: false },
    record: { entryId: 'prepared-root', position: 'before', nativeLeafId: null, durableEntryId: null,
      source: f.reference, inputId: early.id },
  }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const rename = fs.rename
  const spy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === getSessionFilePath(f.workspaceRoot, f.source.id)) {
      entered.resolve()
      await release.promise
    }
    return rename(from, to)
  })
  const writing = f.harness.persistNativeForkHistory(f.source.id, proof)
  void writing.catch(error => entered.reject(error))
  try {
    await entered.promise
    early.content = 'updated while persisting'
    f.managed.messages.push({ id: 'late', role: 'user', content: 'late queued input', timestamp: 2, isQueued: true })
    f.harness.persistSession(f.managed)
    release.resolve()
    await writing
    await f.manager.flushSession(f.source.id)
    const saved = loadSession(f.workspaceRoot, f.source.id)!
    expect(saved.messages.map(row => row.id)).toEqual(['early', 'late'])
    expect(saved.messages[0]?.content).toBe('updated while persisting')
    expect(saved.messages[0]?.nativeHistory).toMatchObject({ order: 0, anchor: null, sourceSessionId: f.source.id })
    expect(saved.messages[1]?.isQueued).toBe(true)
    expect(f.managed.messageCount).toBe(2)
    expect(f.managed.messageQueue).toHaveLength(0)
  } finally {
    release.resolve()
    await writing.catch(() => {})
    spy.mockRestore()
  }
})

test('flushAllSessions waits for metadata admitted before its file writer starts', async () => {
  const f = await fixture()
  const registration = f.register()
  try {
    await f.manager.flushAllSessions()
    expect(loadSession(f.workspaceRoot, f.source.id)?.nativeSessionProjection).toEqual(f.reference)
  } finally { await registration }
})
