import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentBackend } from '@mkagent/shared/agent/backend'
import type { AgentEvent } from '@mkagent/core/types'
import type { SessionEvent } from '@mkagent/shared/protocol'
import type { PiNativeOwnerActivation, PiNativeOwnerBackend, PiNativeOwnerControl, PiNativeOwnerEventBody } from '../../../shared/src/agent/backend/pi/native-owner-protocol'
import type { NativeSessionOwner } from './native-session-owner'

// Run in a separate process: config paths are fixed when their modules load.
const root = mkdtempSync(join(tmpdir(), 'product-native-owner-'))
const previousConfig = process.env.CONFIG_DIR
const previousHome = process.env.HOME
process.env.CONFIG_DIR = root
process.env.HOME = join(root, 'home')
mkdirSync(process.env.HOME)
const { SessionManager, setSessionRuntimeHooks } = await import('./SessionManager')
const { listSessions, loadSession, sessionPersistenceQueue } = await import('@mkagent/shared/sessions')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

type Managed = ReturnType<typeof import('./SessionManager')['createManagedSession']>
type Harness = {
  sessions: Map<string, Managed>
  nativeOwners: NativeSessionOwner
  getOrCreateAgent(managed: Managed): Promise<AgentBackend>
  bindBackgroundEvents(managed: Managed, agent: AgentBackend): void
  setupConfigWatcher(): void
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  setSessionRuntimeHooks({ onSessionStarted() {}, onSessionStopped() {} })
})
afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  process.env.CONFIG_DIR = previousConfig
  process.env.HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const workspaceRoot = mkdtempSync(join(root, 'workspace-'))
  const workspace = { id: 'owner-ws', slug: 'owner-ws', name: 'Native owner fixture', rootPath: workspaceRoot, createdAt: 1 }
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1 }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id }))
  const manager = new SessionManager()
  const harness = manager as unknown as Harness
  const events: { target: unknown; event: SessionEvent }[] = []
  manager.setEventSink((_channel, target, event) => { events.push({ target, event: event as SessionEvent }) })
  const source = await manager.createSession(workspace.id, { name: 'Source', codingMode: true, permissionMode: 'safe', model: 'fixture-model', thinkingLevel: 'low' })
  events.length = 0
  const sourceManaged = harness.sessions.get(source.id)!
  sourceManaged.sdkSessionId = 'native-source'
  const transport = {}
  const closed = deferred()
  const started = deferred()
  const sourceQueueDone = deferred()
  const targetQueueDone = deferred()
  const completionEvents: { sessionId: string; stopReason: string }[] = []
  const controls: { owner: string; control: PiNativeOwnerControl }[] = []
  const log: string[] = []
  const counts = { started: 0, stopped: 0, sourceChats: 0, targetChats: 0, targetReleases: 0, pinsReleased: 0 }
  let inputId = ''
  let targetId = ''
  let targetNativeId: string | null = null
  let targetSink: ((event: AgentEvent) => void) | undefined
  let sourceRun: Promise<void> | undefined
  setSessionRuntimeHooks({ onSessionStarted: () => { counts.started++ }, onSessionStopped: () => { counts.stopped++ } })
  manager.onSessionComplete(event => {
    completionEvents.push(event)
    if (event.sessionId === source.id && counts.sourceChats > 1) sourceQueueDone.resolve()
    if (event.sessionId === targetId && counts.targetChats > 0) targetQueueDone.resolve()
  })
  const sourceOwner: PiNativeOwnerBackend = {
    prepareActivation: async () => { throw new Error('Source activation must not run') },
    detachForOwner: async () => {
      closed.resolve()
      log.push('source-detached')
      return {
        sourceScope: { ownerSessionId: source.id, runtimeGeneration: 1 }, transport,
        send: () => true, release: () => { counts.pinsReleased++ },
      }
    },
    adoptForOwner: () => { throw new Error('Source must not adopt target') },
    sendOwnerControl: control => {
      controls.push({ owner: source.id, control })
      if (control.type === 'owner_prepared') targetId = control.targetSessionId
      if (control.type === 'owner_abort') closed.resolve()
      return true
    },
    releaseForOwner: async () => { throw new Error('Source foreground release must not close target') },
  }
  const targetOwner: PiNativeOwnerBackend = {
    prepareActivation: async () => {
      expect(completionEvents.some(event => event.sessionId === source.id)).toBe(true)
      expect(counts.stopped).toBeGreaterThan(0)
      const target = harness.sessions.get(targetId)!
      expect(target.permissionMode).toBe('safe')
      expect(target.model).toBe('fixture-model')
      expect(target.codingMode).toBe(true)
      return { config: { sessionId: target.id } as PiNativeOwnerActivation['config'], tools: [], systemPrompt: 'target-own-prompt', reason: 'new' }
    },
    detachForOwner: async () => { throw new Error('Target must not detach') },
    adoptForOwner: transfer => {
      expect(transfer.transport).toBe(transport)
      return { ownerSessionId: targetId, runtimeGeneration: 2 }
    },
    sendOwnerControl: control => { controls.push({ owner: targetId, control }); return true },
    releaseForOwner: async () => { counts.targetReleases++ },
  }
  const sourceAgent = {
    nativeSessionOwner: sourceOwner, getSessionId: () => 'native-source', redirect: () => false, destroy() {},
    async *chat(message: string, _attachments: unknown, options: { messageId: string }): AsyncGenerator<AgentEvent> {
      counts.sourceChats++
      if (message === '/new') {
        inputId = options.messageId
        started.resolve()
        await closed.promise
      }
      yield { type: 'complete' }
    },
  } as unknown as AgentBackend
  const targetAgent = {
    nativeSessionOwner: targetOwner, getSessionId: () => targetNativeId, redirect: () => { throw new Error('Adopted turn input must queue') }, destroy() {},
    setBackgroundEventSink: (sink: (event: AgentEvent) => void) => { targetSink = sink },
    async *chat(): AsyncGenerator<AgentEvent> { counts.targetChats++; yield { type: 'complete' } },
  } as unknown as AgentBackend
  sourceManaged.agent = sourceAgent
  harness.getOrCreateAgent = async managed => {
    const agent = managed.id === source.id ? sourceAgent : targetAgent
    managed.agent = agent
    harness.bindBackgroundEvents(managed, agent)
    return agent
  }
  const sourcePort = harness.nativeOwners.port(source.id)
  const send = (event: PiNativeOwnerEventBody, toTarget = false) => (toTarget ? harness.nativeOwners.port(targetId) : sourcePort).onEvent({
    ...event, ownerSessionId: toTarget ? targetId : source.id, runtimeGeneration: toTarget ? 2 : 1,
  }, toTarget ? targetOwner : sourceOwner, transport)
  const prepare = async () => {
    sourceRun = manager.sendMessage(source.id, '/new', undefined, undefined, undefined, undefined, undefined, undefined, { callerClientId: 'actual-rpc-caller' })
    await started.promise
    await send({ type: 'owner_prepare', transactionId: 'product-tx', sourceNativeSessionId: 'native-source', inputId, operation: { type: 'new' } })
  }
  const sourceClosed = async () => {
    const closing = send({ type: 'owner_source_closed', transactionId: 'product-tx' })
    await sourceRun
    await closing
  }
  const bound = async () => {
    targetNativeId = 'native-target'
    await send({ type: 'owner_target_bound', transactionId: 'product-tx', nativeSessionId: targetNativeId }, true)
  }
  const finish = () => send({ type: 'owner_finished', transactionId: 'product-tx', outcome: 'complete' }, true)
  cleanups.push(async () => {
    closed.resolve()
    await sourceRun
    for (const id of [...harness.sessions.keys()]) await manager.cancelProcessing(id, true)
    await sessionPersistenceQueue.flushAll()
    manager.cleanup()
  })
  return { manager, harness, source, sourceManaged, workspaceRoot, events, counts, controls, completionEvents, log, prepare, sourceClosed, bound, finish, send, sourceQueueDone, targetQueueDone, get targetId() { return targetId }, background: (event: AgentEvent) => { if (!targetSink) throw new Error('Missing target sink'); targetSink(event) } }
}

test('NEW hides the pending target, locks source input, and finalizes an adopted turn without a target chat generator', async () => {
  const f = await fixture()
  await f.prepare()
  expect(f.manager.getSessions().map(session => session.id)).toEqual([f.source.id])
  expect(await f.manager.getSession(f.targetId)).toBeNull()
  expect(loadSession(f.workspaceRoot, f.targetId)?.nativeSessionOwner?.unpublished).toBe(true)
  await f.sourceClosed()
  expect(f.sourceManaged.isProcessing).toBe(false)
  await f.manager.sendMessage(f.source.id, 'source continuation')
  expect(f.counts.sourceChats).toBe(1)
  expect(f.sourceManaged.messageQueue).toHaveLength(1)
  expect(f.counts.targetChats).toBe(0)
  expect(f.harness.sessions.get(f.targetId)?.isProcessing).toBe(true)
  expect(f.events.some(({ event }) => event.type === 'session_created')).toBe(false)
  await f.bound()
  await f.sourceQueueDone.promise
  const created = f.events.find(({ event }) => event.type === 'session_created')?.event
  expect(created?.type === 'session_created' && created.session).toMatchObject({
    id: f.targetId, workspaceId: 'owner-ws', isProcessing: true, messages: [],
  })
  expect(f.events.filter(({ event }) => event.type === 'native_session_redirect')).toEqual([{
    target: { to: 'client', clientId: 'actual-rpc-caller' },
    event: { type: 'native_session_redirect', sessionId: f.source.id, targetSessionId: f.targetId, transactionId: 'product-tx' },
  }])
  expect(f.manager.getSessions()).toHaveLength(2)
  await f.manager.sendMessage(f.targetId, 'target continuation')
  expect(f.counts.targetChats).toBe(0)
  f.background({ type: 'status', message: 'callback' })
  f.background({ type: 'tool_start', toolUseId: 'callback-tool', toolName: 'fixture', input: {} })
  f.background({ type: 'text_complete', text: 'from native setup', sdkMessageId: 'callback-output' })
  f.background({ type: 'complete', usage: { inputTokens: 12, outputTokens: 5, costUsd: 0.25 } })
  f.background({ type: 'complete', usage: { inputTokens: 12, outputTokens: 5, costUsd: 0.25 } })
  await f.finish()
  await f.targetQueueDone.promise
  const target = f.harness.sessions.get(f.targetId)!
  expect(target.isProcessing).toBe(false)
  expect(target.currentStatus).toBeUndefined()
  expect(target.pendingToolInputs.size).toBe(0)
  expect(f.counts.targetChats).toBe(1)
  expect(f.counts.started).toBe(4)
  expect(f.counts.stopped).toBe(4)
  expect(f.counts.pinsReleased).toBe(1)
  expect(f.completionEvents.filter(event => event.sessionId === f.targetId).map(event => event.stopReason)).toEqual(['complete', 'complete'])
  const stored = loadSession(f.workspaceRoot, f.targetId)!
  expect(stored.nativeSessionOwner?.phase).toBe('finished')
  expect(stored.tokenUsage.costUsd).toBe(0.25)
  expect(stored.tokenUsage.outputTokens).toBe(5)
  expect(stored.messages.some(message => message.id === 'callback-output')).toBe(true)
  expect(created?.type === 'session_created' && created.session?.messages).toEqual([])
  expect(readFileSync(join(f.workspaceRoot, 'sessions', f.targetId, 'session.jsonl'), 'utf8')).not.toContain('actual-rpc-caller')
})

test('a failed strict source commit emits neither creation nor redirect and rolls back only the new target', async () => {
  const f = await fixture()
  await f.prepare()
  await f.sourceClosed()
  const persist = sessionPersistenceQueue.persist.bind(sessionPersistenceQueue)
  const failure = spyOn(sessionPersistenceQueue, 'persist').mockImplementation(async snapshot => {
    if (snapshot.id === f.source.id && snapshot.nativeSessionOwner?.phase === 'committed') throw new Error('Fixture source commit failure')
    await persist(snapshot)
  })
  try { await f.bound() } finally { failure.mockRestore() }
  expect(f.manager.getSessions().map(session => session.id)).toEqual([f.source.id])
  expect(listSessions(f.workspaceRoot).map(session => session.id)).toEqual([f.source.id])
  expect(f.events.some(({ event }) => event.type === 'session_created' || event.type === 'native_session_redirect')).toBe(false)
  expect(f.controls.some(({ control }) => control.type === 'owner_committed')).toBe(false)
  expect(f.counts.targetReleases).toBe(1)
  expect(f.completionEvents.at(-1)?.stopReason).toBe('error')
})

test('ordinary flush cannot persist an unacknowledged native commit while its strict receipt is pending', async () => {
  const f = await fixture()
  await f.prepare()
  await f.sourceClosed()
  const entered = deferred()
  const receipt = deferred()
  const persist = sessionPersistenceQueue.persist.bind(sessionPersistenceQueue)
  const failure = spyOn(sessionPersistenceQueue, 'persist').mockImplementation(async snapshot => {
    if (snapshot.id === f.source.id && snapshot.nativeSessionOwner?.phase === 'committed') {
      entered.resolve()
      await receipt.promise
      throw new Error('Fixture failed native commit receipt')
    }
    await persist(snapshot)
  })
  const binding = f.bound()
  await entered.promise
  const ordinary = f.manager.flushSession(f.source.id)
  try {
    await sessionPersistenceQueue.flush(f.source.id)
    expect(loadSession(f.workspaceRoot, f.source.id)?.nativeSessionOwner?.committed).toBe(false)
    expect(f.sourceManaged.nativeSessionOwner?.committed).toBe(false)
  } finally {
    receipt.resolve()
    await Promise.all([binding, ordinary])
    failure.mockRestore()
  }
  expect(f.events.some(({ event }) => event.type === 'native_session_redirect')).toBe(false)
})

test('a rejected adopted event still ends processing and hooks with an error completion', async () => {
  const f = await fixture()
  await f.prepare()
  await f.sourceClosed()
  await f.bound()
  f.manager.setEventSink((_channel, _target, event) => {
    if ((event as SessionEvent).type === 'status') throw new Error('Fixture event sink failure')
  })
  f.background({ type: 'status', message: 'failing callback event' })
  f.background({ type: 'complete' })
  await f.finish()
  expect(f.completionEvents.at(-1)?.stopReason).toBe('error')
  expect(f.harness.sessions.get(f.targetId)?.isProcessing).toBe(false)
  expect(f.counts.started).toBe(f.counts.stopped)
})

test('Stop during an active target write waits for the writer before removing its directory', async () => {
  const f = await fixture()
  const entered = deferred()
  const receipt = deferred()
  let pendingTarget = ''
  const rename = fsPromises.rename
  const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (String(to).startsWith(f.workspaceRoot) && String(to).includes('session.jsonl')) {
      const header = JSON.parse(readFileSync(String(from), 'utf8').split('\n')[0]!)
      if (header.nativeSessionOwner?.role === 'target' && header.nativeSessionOwner.phase === 'prepared') {
        pendingTarget = header.id
        entered.resolve()
        await receipt.promise
      }
    }
    return rename(from, to)
  })
  const preparing = f.prepare()
  await entered.promise
  let stopped = false
  const stopping = f.manager.cancelProcessing(f.source.id).then(() => { stopped = true })
  expect(stopped).toBe(false)
  expect(existsSync(join(f.workspaceRoot, 'sessions', pendingTarget))).toBe(true)
  receipt.resolve()
  try { await Promise.all([preparing, stopping]) } finally { renameSpy.mockRestore() }
  await sessionPersistenceQueue.flushAll()
  expect(existsSync(join(f.workspaceRoot, 'sessions', pendingTarget))).toBe(false)
  expect(f.manager.getSessions().map(session => session.id)).toEqual([f.source.id])
})

for (const invalidation of ['disconnect', 'workspace'] as const) {
  test(`${invalidation} invalidates the originating caller after source finalization`, async () => {
    const f = await fixture()
    await f.prepare()
    await f.sourceClosed()
    if (invalidation === 'disconnect') f.manager.onClientDisconnected('actual-rpc-caller')
    else f.manager.onClientWorkspaceChanged('actual-rpc-caller')
    await f.bound()
    expect(f.events.some(({ event }) => event.type === 'native_session_redirect')).toBe(false)
    f.background({ type: 'complete' })
    await f.finish()
  })
}

test('Stop on an idle source cancels the active adoption and does not report target success', async () => {
  const f = await fixture()
  await f.prepare()
  await f.sourceClosed()
  expect(f.sourceManaged.isProcessing).toBe(false)
  expect(f.manager.getActiveSessionsInfo()).toEqual([])
  f.background({ type: 'status', message: 'unpublished target cleanup' })
  f.background({ type: 'complete' })
  await f.manager.cancelProcessing(f.source.id)
  expect(f.counts.targetReleases).toBe(1)
  expect(f.completionEvents.at(-1)?.stopReason).toBe('cancelled')
  expect(f.events.some(({ event }) => event.type === 'complete' && event.sessionId === f.targetId)).toBe(false)
  expect(f.manager.getSessions().map(session => session.id)).toEqual([f.source.id])
})

test('deleting the source aborts adoption without replaying its locked queue or recreating files', async () => {
  const f = await fixture()
  await f.prepare()
  await f.sourceClosed()
  await f.manager.sendMessage(f.source.id, 'must not run during deletion')
  await f.manager.deleteSession(f.source.id)
  await sessionPersistenceQueue.flushAll()
  expect(f.counts.sourceChats).toBe(1)
  expect(f.counts.targetReleases).toBe(1)
  expect(f.manager.getSessions()).toEqual([])
  expect(listSessions(f.workspaceRoot)).toEqual([])
  expect(f.events.some(({ event }) => event.type === 'native_session_redirect')).toBe(false)
})

test('a cancelled owner_finished frame finalizes the committed target as cancelled', async () => {
  const f = await fixture()
  await f.prepare()
  await f.sourceClosed()
  await f.bound()
  f.background({ type: 'complete' })
  await f.send({ type: 'owner_finished', transactionId: 'product-tx', outcome: 'cancelled' }, true)
  expect(f.completionEvents.at(-1)?.stopReason).toBe('cancelled')
  expect(f.harness.sessions.get(f.targetId)?.isProcessing).toBe(false)
  expect(loadSession(f.workspaceRoot, f.targetId)?.nativeSessionOwner).toMatchObject({ phase: 'aborted', committed: true, callbacks: 'interrupted' })
})

test('a published target survives source deletion and recovers without the old authority file', async () => {
  const f = await fixture()
  await f.prepare()
  await f.sourceClosed()
  await f.bound()
  await f.manager.deleteSession(f.source.id)
  expect(f.harness.sessions.get(f.targetId)?.isProcessing).toBe(true)
  expect(loadSession(f.workspaceRoot, f.source.id)).toBeNull()
  const restarted = new SessionManager()
  ;(restarted as unknown as Harness).setupConfigWatcher = () => {}
  try {
    await restarted.initialize()
    expect(restarted.getSessions().map(session => session.id)).toEqual([f.targetId])
    expect(loadSession(f.workspaceRoot, f.targetId)?.nativeSessionOwner?.callbacks).toBe('interrupted')
    expect(f.counts.targetChats).toBe(0)
  } finally { restarted.cleanup() }
  f.background({ type: 'complete' })
  await f.finish()
  expect(loadSession(f.workspaceRoot, f.source.id)).toBeNull()
})

test('an old target finalization cannot overwrite the source next transaction', async () => {
  const f = await fixture()
  await f.prepare()
  await f.sourceClosed()
  await f.bound()
  f.sourceManaged.nativeSessionOwner = { ...f.sourceManaged.nativeSessionOwner!,
    transactionId: 'next-source-transaction', phase: 'prepared', committed: false, callbacks: 'blocked' }
  await f.manager.flushSession(f.source.id)
  f.background({ type: 'complete' })
  await f.finish()
  expect(loadSession(f.workspaceRoot, f.source.id)?.nativeSessionOwner).toMatchObject({
    transactionId: 'next-source-transaction', phase: 'prepared', committed: false,
  })
})

for (const committed of [false, true]) {
  test(`restart ${committed ? 'publishes the committed' : 'rolls back the uncommitted'} target without replaying callbacks`, async () => {
    const f = await fixture()
    await f.prepare()
    await f.sourceClosed()
    if (committed) await f.bound()
    const restarted = new SessionManager()
    ;(restarted as unknown as Harness).setupConfigWatcher = () => {}
    await restarted.initialize()
    expect(restarted.getSessions().map(session => session.id).sort()).toEqual((committed ? [f.source.id, f.targetId] : [f.source.id]).sort())
    expect(f.counts.targetChats).toBe(0)
    expect(f.counts.started).toBe(2)
    expect(loadSession(f.workspaceRoot, f.source.id)?.nativeSessionOwner?.callbacks).toBe('interrupted')
    if (committed) {
      expect(loadSession(f.workspaceRoot, f.targetId)?.nativeSessionOwner?.unpublished).toBeUndefined()
      expect(loadSession(f.workspaceRoot, f.targetId)?.nativeSessionOwner?.callbacks).toBe('interrupted')
    }
    restarted.cleanup()
  })
}
