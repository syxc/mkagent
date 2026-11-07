import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Config paths are fixed at module load. This fixture never constructs an agent.
const root = mkdtempSync(join(tmpdir(), 'product-native-history-'))
const previousHome = process.env.HOME
const previousConfig = process.env.CONFIG_DIR
process.env.HOME = join(root, 'home')
process.env.CONFIG_DIR = root
mkdirSync(process.env.HOME)
const { SessionManager } = await import('./SessionManager')
const { loadSession, sessionPersistenceQueue } = await import('@mkagent/shared/sessions')
const { writeSessionJsonl } = await import('../../../shared/src/sessions/jsonl')
const workspace = { id: 'history-ws', slug: 'history-ws', name: 'History', rootPath: join(root, 'workspace'), createdAt: 1 }
mkdirSync(workspace.rootPath)
writeFileSync(join(workspace.rootPath, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1 }))
writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id }))

const managers: InstanceType<typeof SessionManager>[] = []
afterEach(async () => {
  await sessionPersistenceQueue.flushAll()
  for (const manager of managers.splice(0)) manager.cleanup()
})
afterAll(() => {
  process.env.HOME = previousHome
  process.env.CONFIG_DIR = previousConfig
  rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const sourceId = '260101-native-history'
  const path = join(workspace.rootPath, 'sessions', sourceId)
  mkdirSync(join(path, 'attachments'), { recursive: true })
  const planPath = join(path, 'attachments', 'inactive.md')
  writeFileSync(planPath, 'inactive branch metadata')
  writeSessionJsonl(join(path, 'session.jsonl'), {
    id: sourceId, workspaceRootPath: workspace.rootPath, createdAt: 1, lastUsedAt: 1, codingMode: true,
    messages: [{ id: 'active', type: 'user', content: 'active branch', timestamp: 1, nativeHistory: { order: 0, anchor: null } }],
    nativeArchivedMessages: [{ id: 'inactive', type: 'plan', content: 'inactive branch', timestamp: 2, planPath,
      nativeHistory: { order: 1, anchor: 'inactive-leaf' } },
    { id: 'source-queued', type: 'user', content: '/source-only-command', timestamp: 3, isQueued: true,
      nativeHistory: { order: 2, anchor: 'inactive-leaf', sourceSessionId: sourceId } }],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  const manager = new SessionManager()
  managers.push(manager)
  manager.setEventSink(() => {})
  await manager.initialize()
  const harness = manager as unknown as {
    sessions: Map<string, { name?: string; messagesLoaded: boolean; messageQueue: unknown[] }>
    getOrCreateAgent(): never
  }
  harness.getOrCreateAgent = () => { throw new Error('Product history tests must never create an agent') }
  return { manager, harness, sourceId }
}

test('lazy metadata flush retains inactive rows and product DTOs only expose active public messages', async () => {
  const f = await fixture()
  const managed = f.harness.sessions.get(f.sourceId)!
  expect(managed.messagesLoaded).toBe(false)
  managed.name = 'renamed without loading history'
  await f.manager.flushSession(f.sourceId)
  const saved = loadSession(workspace.rootPath, f.sourceId)!
  expect(saved.name).toBe(managed.name)
  expect(saved.nativeArchivedMessages?.[0]?.id).toBe('inactive')
  const visible = await f.manager.getSession(f.sourceId)
  expect(visible?.messages.map(message => message.id)).toEqual(['active'])
  expect(visible?.messages[0]).not.toHaveProperty('nativeHistory')
  expect(visible).not.toHaveProperty('nativeArchivedMessages')
  expect(managed.messageQueue).toHaveLength(0)
})

test('real product export and import preserve native archives and inactive files without queuing them', async () => {
  const f = await fixture()
  const bundle = await f.manager.exportSession(f.sourceId, workspace.id)
  expect(bundle?.version).toBe(2)
  const imported = await f.manager.importSession(workspace.id, bundle!, 'fork')
  await f.manager.flushSession(imported.sessionId)
  const saved = loadSession(workspace.rootPath, imported.sessionId)!
  expect(saved.messages.map(message => message.id)).toEqual(['active'])
  expect(saved.nativeArchivedMessages?.[0]).toMatchObject({ id: 'inactive', nativeHistory: { order: 1, anchor: 'inactive-leaf' } })
  expect(saved.nativeArchivedMessages?.[1]).toMatchObject({ id: 'source-queued', isQueued: true,
    nativeHistory: { sourceSessionId: f.sourceId } })
  const expected = join(workspace.rootPath, 'sessions', imported.sessionId, 'attachments', 'inactive.md')
  expect(saved.nativeArchivedMessages?.[0]?.planPath).toBe(expected)
  expect(readFileSync(expected, 'utf8')).toBe('inactive branch metadata')
  expect(f.harness.sessions.get(imported.sessionId)?.messageQueue).toHaveLength(0)
  const exported = await f.manager.exportSession(imported.sessionId, workspace.id)
  expect(exported?.session.nativeArchivedMessages).toEqual(bundle?.session.nativeArchivedMessages)
})
