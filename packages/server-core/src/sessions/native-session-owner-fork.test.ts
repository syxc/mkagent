import { expect, test } from 'bun:test'
import type { NativeSessionOwnerRecord, NativeSessionReference } from '@mkagent/shared/sessions'
import type { PiNativeOwnerActivation, PiNativeOwnerBackend, PiNativeOwnerControl, PiNativeOwnerEventBody } from '../../../shared/src/agent/backend/pi/native-owner-protocol'
import { NativeSessionOwner } from './native-session-owner'
import type { NativeForkProof } from './native-session-fork'

function fixture() {
  const transport = {}
  const sourceDone = Promise.withResolvers<void>()
  const controls: PiNativeOwnerControl[] = []
  const log: string[] = []
  const records = new Map<string, NativeSessionOwnerRecord>()
  const errors: unknown[] = []
  const reference: NativeSessionReference = { version: 1, sessionId: 'source', nativeSessionId: 'native-source',
    sessionFile: '/fixture/sessions/source/native-session/session.jsonl', conversationId: 1, revision: 1,
    leaf: 'entry', name: null, digest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) }
  const final = { ...reference, revision: 2, digest: 'c'.repeat(64), manifestDigest: 'd'.repeat(64) }
  const targetReference = { ...reference, sessionId: 'target', nativeSessionId: 'native-target', conversationId: 2,
    revision: 3, leaf: null, sessionFile: '/fixture/sessions/target/native-session/session.jsonl' }
  const proof: NativeForkProof = {
    sourcePath: '/fixture/sessions/source',
    tree: { reference, header: { id: 'native-source' }, hasName: false,
      entries: [{ id: 'entry', parentId: null, type: 'message', timestamp: '2026-11-05', message: { role: 'user', content: 'root' } }],
      entryIds: [{ nativeId: 'entry', durableId: 1, productMessageId: 'consumed-input' }] },
    record: { entryId: 'entry', position: 'before', nativeLeafId: null, durableEntryId: null, source: reference },
  }
  const closedProof = { ...proof, tree: { ...proof.tree, reference: final }, record: { ...proof.record, source: final } }
  const activation: PiNativeOwnerActivation = { reason: 'new', tools: [], systemPrompt: 'fixture', config: {
    apiKey: '', model: 'local', thinkingLevel: 'off', cwd: '/fixture', workspaceRootPath: '/fixture',
    sessionId: 'target', sessionPath: '/fixture/sessions/target', workingDirectory: '/fixture',
    plansFolderPath: '/fixture/sessions/target/plans',
  } }
  const transfer = { sourceScope: { ownerSessionId: 'source', runtimeGeneration: 1 }, transport,
    send: (control: PiNativeOwnerControl) => { controls.push(control); return true }, release: () => { log.push('unpin') } }
  const backend = (id: string): PiNativeOwnerBackend => ({
    prepareActivation: async () => { log.push(`prepare:${id}`); return activation },
    detachForOwner: async () => { log.push('detach'); return transfer },
    adoptForOwner: () => ({ ownerSessionId: id, runtimeGeneration: 2 }),
    sendOwnerControl: control => { controls.push(control); return true },
    releaseForOwner: async () => { log.push(`release:${id}`) },
  })
  const source = backend('source')
  const target = backend('target')
  const host: ConstructorParameters<typeof NativeSessionOwner>[0] = {
    source: () => ({ nativeSessionId: reference.nativeSessionId, turnDone: sourceDone.promise }),
    claim: () => undefined,
    projection: async (id, ref) => { log.push(`projection:${id}:${ref.revision}`) },
    prepareFork: async () => { log.push('verify-prepare'); return proof },
    closeFork: async () => { log.push('verify-closed'); return closedProof },
    bindFork: async () => { log.push('verify-bound') },
    createTarget: async () => { log.push('create-target'); return 'target' },
    backend: async () => target,
    persist: async (id, record) => { records.set(id, structuredClone(record)); log.push(`persist:${id}:${record.phase}`) },
    finalizeSource: async () => {},
    startTarget: () => {},
    finishTarget: async () => {},
    publish: () => { log.push('publish') },
    rollback: async () => { log.push('rollback') },
    unlock: () => {},
    report: (_id, error) => { errors.push(error) },
  }
  const owner = new NativeSessionOwner(host)
  const send = (event: PiNativeOwnerEventBody, fromTarget = false) =>
    owner.port(fromTarget ? 'target' : 'source').onEvent({ ...event,
      ownerSessionId: fromTarget ? 'target' : 'source', runtimeGeneration: fromTarget ? 2 : 1,
    }, fromTarget ? target : source, transport)
  const prepare = () => send({ type: 'owner_prepare', transactionId: 'tx', sourceNativeSessionId: reference.nativeSessionId,
    sourceReference: reference, operation: { type: 'fork', entryId: 'entry', position: 'before' },
    fork: { nativeLeafId: null, durableEntryId: null, selectedText: 'root' } })
  const close = (ref: NativeSessionReference | undefined = final) => {
    sourceDone.resolve()
    return send({ type: 'owner_source_closed', transactionId: 'tx', ...(ref ? { reference: ref } : {}) })
  }
  const bound = () => send({ type: 'owner_target_bound', transactionId: 'tx', nativeSessionId: 'native-target', reference: targetReference }, true)
  return { host, owner, log, records, errors, controls, reference, final, proof, targetReference, prepare, close, bound, send }
}

test('fork waits for preparation, closed-history and bound-reference receipts before activation and publication', async () => {
  const f = fixture()
  const projectionEntered = Promise.withResolvers<void>()
  const projectionReceipt = Promise.withResolvers<void>()
  const projection = f.host.projection!
  f.host.projection = async (id, ref, backend) => {
    if (id === 'source' && ref.revision === 1) { projectionEntered.resolve(); await projectionReceipt.promise }
    await projection(id, ref, backend)
  }
  const preparing = f.prepare()
  await projectionEntered.promise
  expect(f.owner.isLocked('source')).toBe(true)
  expect(f.log).not.toContain('create-target')
  expect(f.controls).toEqual([])
  projectionReceipt.resolve()
  await preparing
  expect(f.log.indexOf('verify-prepare')).toBeLessThan(f.log.indexOf('create-target'))
  expect(f.log).not.toContain('prepare:target')
  const closedEntered = Promise.withResolvers<void>()
  const closedReceipt = Promise.withResolvers<void>()
  const close = f.host.closeFork!
  f.host.closeFork = async (...args) => { closedEntered.resolve(); await closedReceipt.promise; return close(...args) }
  const closing = f.close()
  await closedEntered.promise
  expect(f.log).toContain('projection:source:2')
  expect(f.controls.map(control => control.type)).toEqual(['owner_prepared'])
  closedReceipt.resolve()
  await closing
  const activate = f.controls.find(control => control.type === 'owner_activate')!
  if (activate.type !== 'owner_activate') throw new Error('Expected owner activation')
  expect(activate.activation.reason).toBe('fork')
  expect(activate.activation.config.nativeFork).toEqual({ leaf: null, source: f.final })
  expect(activate.activation.config.branchFromSessionPath).toBe(f.proof.sourcePath)
  const boundEntered = Promise.withResolvers<void>()
  const boundReceipt = Promise.withResolvers<void>()
  f.host.projection = async (id, ref, backend) => {
    if (id === 'target') { boundEntered.resolve(); await boundReceipt.promise }
    await projection(id, ref, backend)
  }
  const binding = f.bound()
  await boundEntered.promise
  expect(f.log).not.toContain('verify-bound')
  expect(f.log).not.toContain('publish')
  expect(f.controls.some(control => control.type === 'owner_committed')).toBe(false)
  boundReceipt.resolve()
  await binding
  expect(f.log.indexOf('publish')).toBeGreaterThan(f.log.indexOf('verify-bound'))
  expect(f.records.get('source')?.fork?.source).toEqual(f.final)
  expect(f.records.get('target')?.unpublished).toBeUndefined()
  expect(f.controls.at(-1)?.type).toBe('owner_committed')
})

for (const failure of ['closed-reference', 'closed-registration', 'closed-history', 'bound-registration', 'bound-tree']) {
  test(`fork does not publish or authorize callbacks after failed ${failure}`, async () => {
    const f = fixture()
    const projection = f.host.projection!
    f.host.projection = async (id, ref, backend) => {
      if ((failure === 'closed-registration' && id === 'source' && ref.revision === 2)
        || (failure === 'bound-registration' && id === 'target')) throw new Error(failure)
      await projection(id, ref, backend)
    }
    if (failure === 'closed-history') f.host.closeFork = async () => { throw new Error(failure) }
    if (failure === 'bound-tree') f.host.bindFork = async () => { throw new Error(failure) }
    await f.prepare()
    if (failure === 'closed-reference') {
      await f.send({ type: 'owner_source_closed', transactionId: 'tx' })
    } else {
      await f.close()
      if (f.owner.isLocked('source')) await f.bound()
    }
    expect(f.log).toContain('rollback')
    expect(f.log).not.toContain('publish')
    expect(f.controls.some(control => control.type === 'owner_committed')).toBe(false)
    expect(f.records.get('source')?.committed).toBe(false)
    expect(f.owner.isLocked('source')).toBe(false)
    expect(f.errors).toHaveLength(1)
  })
}
