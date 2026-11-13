import { expect, spyOn, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import { getSessionFilePath, loadSession, readSessionHeader, writeSessionJsonl, type NativeSessionReference, type StoredSession } from '@mkagent/shared/sessions'
import { ConfigWatcher } from '../../shared/src/config/watcher.ts'
import { durableFixture, response } from '../../coding-runtime/test/fixtures/durable-harness.ts'
import { DurableKernel, type DurableKernelOptions } from './kernel.ts'
import type { CodingHost } from './coding-host.ts'
import { SessionManager, createManagedSession } from '../../server-core/src/sessions/SessionManager.ts'

type ProjectionHost = { registerNativeProjection(id: string, reference: NativeSessionReference, backend: unknown, hasName?: boolean): Promise<void> }

for (const [store, externalName] of [
  ['sqlite', 'External rename'], ['sqlite', ''],
  ['jsonl', 'External rename'], ['jsonl', ''],
]) test(`committed native name recovers and retains external ${JSON.stringify(externalName)} (${store})`, async () => {
  const root = await durableFixture([response('continued')])
  await root.harness.close(BACKGROUND_CONTEXT)
  const id = 'name-recovery'
  const path = getSessionFilePath(root.directory, id)
  const sessionPath = dirname(path)
  mkdirSync(sessionPath, { recursive: true })
  if (store === 'jsonl') {
    mkdirSync(join(sessionPath, 'durable-store'))
    writeFileSync(join(sessionPath, 'durable-store', 'main.jsonl'), '')
  }
  const stored: StoredSession = {
    id, workspaceRootPath: root.directory, name: '', codingMode: true,
    createdAt: 1, lastUsedAt: 2, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  }
  writeSessionJsonl(path, stored)
  const manager = new SessionManager()
  // Drive the real watcher handler synchronously without starting filesystem watches.
  const start = spyOn(ConfigWatcher.prototype, 'start').mockImplementation(() => {})
  try { manager.setupConfigWatcher(root.directory, 'ws') }
  finally { start.mockRestore() }
  const watcher = (manager as unknown as {
    configWatchers: Map<string, { handleWorkspaceChange(filename: string): void }>
  }).configWatchers.get(root.directory)!
  const observeHeader = () => watcher.handleWorkspaceChange(`sessions/${id}/session.jsonl`)
  const workspace = { id: 'ws', name: 'Workspace', slug: 'workspace', rootPath: root.directory, createdAt: 1 }
  const managed = createManagedSession(stored, workspace as never, { messagesLoaded: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  let kernel: DurableKernel
  const backend = { setSessionName: (name: string) => kernel.setSessionName(name) }
  managed.agent = { nativeSessionOwner: backend, getSessionId: () => kernel.sessionId } as never
  const options: DurableKernelOptions = {
    sessionPath, cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'empty' }), wrapCodingTool: tool => tool,
    coding: { agentDir: join(root.directory, 'agent'), resourcePolicy: 'host-only',
      disabledBuiltinExtensions: ['codemode', 'tool-search', 'mcp'],
      globalSettings: { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' } },
    commitNativeHistory: (reference, hasName) =>
      (manager as unknown as ProjectionHost).registerNativeProjection(id, reference, backend, hasName),
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: () => {} },
  }
  kernel = new DurableKernel(options)
  try {
    await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } })
    await manager.renameSession(id, '')
    const previous = loadSession(root.directory, id)!.nativeSessionProjection
    managed.isProcessing = true
    managed.activeTurnSerial = 1
    writeSessionJsonl(path, { ...loadSession(root.directory, id)!, isFlagged: true })
    observeHeader()
    const pendingHeader = managed.pendingExternalHeader!
    expect(pendingHeader).toEqual(readSessionHeader(path))
    const rename = fs.rename
    const spy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path) throw new Error('name receipt storage failure')
      return rename(from, to)
    })
    try {
      await expect(manager.renameSession(id, 'Recovered committed name')).rejects.toThrow('name receipt storage failure')
    } finally { spy.mockRestore() }
    expect(loadSession(root.directory, id)?.name).toBe('')
    expect(loadSession(root.directory, id)?.nativeSessionProjection).toEqual(previous)
    expect(managed.name).toBe('')
    expect(managed.pendingExternalHeader).toBe(pendingHeader)
    expect(JSON.parse(readFileSync(join(sessionPath, 'meta', 'native-session.json'), 'utf8')).name)
      .toBe('Recovered committed name')
    const coding = (kernel as unknown as { coding: CodingHost }).coding
    expect(coding.journal.committedSnapshot().name).toBe('Recovered committed name')
    await kernel.close().catch(() => {})
    expect(coding.journal.committedSnapshot().name).toBe('Recovered committed name')
    expect(coding.journal.committedSnapshot().entries.findLast(entry => entry.type === 'session_info')?.name)
      .toBe('Recovered committed name')
    kernel = new DurableKernel(options)
    await kernel.open({})
    await kernel.submitPrompt('cold continuation marker')
    await kernel.waitForIdle()
    expect(managed.name).toBe('Recovered committed name')
    await (manager as unknown as { finalizeTurn(...args: unknown[]): Promise<void> })
      .finalizeTurn(managed, 1, 0, 'complete')
    expect(root.calls).toHaveLength(1)
    expect(loadSession(root.directory, id)?.name).toBe('Recovered committed name')
    expect(managed.name).toBe('Recovered committed name')
    expect(managed.isFlagged).toBe(true)
    expect(loadSession(root.directory, id)?.isFlagged).toBe(true)

    const equalRevision = loadSession(root.directory, id)!.nativeSessionProjection!
    managed.isProcessing = true
    managed.activeTurnSerial = 2
    writeSessionJsonl(path, { ...loadSession(root.directory, id)!, name: externalName, isFlagged: false })
    observeHeader()
    const externalHeader = managed.pendingExternalHeader!
    expect(externalHeader).toEqual(readSessionHeader(path))
    expect(externalHeader.name).toBe(externalName)
    await (manager as unknown as ProjectionHost).registerNativeProjection(id, equalRevision, backend, true)
    const pendingAfterReceipt = managed.pendingExternalHeader
    expect(managed.name).toBe('Recovered committed name')
    expect(readSessionHeader(path)?.name).toBe(externalName)
    await (manager as unknown as { finalizeTurn(...args: unknown[]): Promise<void> })
      .finalizeTurn(managed, 2, 0, 'complete')
    expect(loadSession(root.directory, id)).toMatchObject({ name: externalName, isFlagged: false })
    expect(managed.name).toBe(externalName)
    expect(pendingAfterReceipt).toEqual(externalHeader)

    await manager.renameSession(id, 'Recovered committed name')
    managed.isProcessing = true
    managed.activeTurnSerial = 3
    writeSessionJsonl(path, { ...loadSession(root.directory, id)!, isFlagged: true })
    observeHeader()
    expect(managed.pendingExternalHeader).toEqual(readSessionHeader(path))
    await manager.renameSession(id, '')
    expect(managed.pendingExternalHeader).toMatchObject({ name: '', isFlagged: true })
    await (manager as unknown as { finalizeTurn(...args: unknown[]): Promise<void> })
      .finalizeTurn(managed, 3, 0, 'complete')
    expect(loadSession(root.directory, id)).toMatchObject({ name: '', isFlagged: true,
      nativeSessionProjection: { name: null } })

    managed.isProcessing = true
    managed.activeTurnSerial = 4
    writeSessionJsonl(path, { ...loadSession(root.directory, id)!, name: 'Later external title', isFlagged: false })
    observeHeader()
    expect(managed.name).toBe('')
    expect(managed.pendingExternalHeader).toEqual(readSessionHeader(path))
    await (manager as unknown as { finalizeTurn(...args: unknown[]): Promise<void> })
      .finalizeTurn(managed, 4, 0, 'complete')
    expect(managed.name).toBe('Later external title')
    expect(loadSession(root.directory, id)).toMatchObject({ name: 'Later external title', isFlagged: false })
  } finally {
    await kernel.close().catch(() => {})
    await manager.flushSession(id)
    rmSync(root.directory, { recursive: true, force: true })
  }
}, 15_000)
