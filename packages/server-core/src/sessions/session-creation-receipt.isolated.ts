import { expect, spyOn, test } from 'bun:test'
import * as fsPromises from 'node:fs/promises'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('product creation rejects an uncommitted record, rolls it back, and can recover', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-creation-receipt-'))
  const previousConfig = process.env.CONFIG_DIR
  const previousHome = process.env.HOME
  process.env.CONFIG_DIR = root
  process.env.HOME = join(root, 'home')
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot)
  const workspace = { id: 'receipt-workspace', name: 'Receipt fixture', slug: 'receipt', rootPath: workspaceRoot, createdAt: 1 }
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1 }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id }))
  const { SessionManager } = await import('./SessionManager')
  const { listSessions, loadSession, sessionPersistenceQueue } = await import('@mkagent/shared/sessions')
  const manager = new SessionManager()
  const events: unknown[] = []
  manager.setEventSink((_channel, _target, event) => events.push(event))
  const rename = fsPromises.rename
  let replacements = 0
  const failure = new Error('Fixture final product record failure')
  const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (String(to).startsWith(workspaceRoot) && ++replacements === 2) throw failure
    return rename(from, to)
  })
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const result = await manager.createSession(workspace.id, { codingMode: true }).then(
      value => ({ status: 'fulfilled', value }),
      error => ({ status: 'rejected', error }),
    )
    expect(result.status).toBe('rejected')
    expect('error' in result && result.error).toBe(failure)
    expect(manager.getSessions(workspace.id)).toEqual([])
    expect(listSessions(workspaceRoot)).toEqual([])
    expect(events).toEqual([])

    const recovered = await manager.createSession(workspace.id, { codingMode: true })
    expect(recovered.codingMode).toBe(true)
    expect(loadSession(workspaceRoot, recovered.id)?.codingMode).toBe(true)
    expect(events).toEqual([{ type: 'session_created', sessionId: recovered.id }])
  } finally {
    renameSpy.mockRestore()
    errors.mockRestore()
    manager.cleanup()
    await sessionPersistenceQueue.flushAll()
    process.env.CONFIG_DIR = previousConfig
    process.env.HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})
