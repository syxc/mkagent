import { describe, expect, test } from 'bun:test'
import { NativeSessionOwner } from './native-session-owner'
import { InputOrigins } from './input-origins'
import type { NativeSessionOwnerRecord } from '@mkagent/shared/sessions'
import type {
  PiNativeOwnerActivation, PiNativeOwnerBackend, PiNativeOwnerControl,
  PiNativeOwnerEventBody, PiNativeWorkerTransfer,
} from '../../../shared/src/agent/backend/pi/native-owner-protocol'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const transport = {}
  const sourceDone = deferred()
  const origins = new InputOrigins()
  origins.admit('source', 'input', 'originating-client')
  const log: string[] = []
  const controls: { backend: string; control: PiNativeOwnerControl }[] = []
  const records = new Map<string, NativeSessionOwnerRecord>()
  const publishes: (string | undefined)[] = []
  const rollbacks: string[] = []
  const outcomes: string[] = []
  const errors: unknown[] = []
  const activation: PiNativeOwnerActivation = {
    config: {} as PiNativeOwnerActivation['config'], tools: [], systemPrompt: 'target prompt', reason: 'new',
  }
  const transfer: PiNativeWorkerTransfer = {
    sourceScope: { ownerSessionId: 'source', runtimeGeneration: 1 }, transport,
    send: control => { controls.push({ backend: 'transfer', control }); return true },
    release: () => { log.push('release-pin') },
  }
  function backend(id: string): PiNativeOwnerBackend {
    return {
      prepareActivation: async () => { log.push(`prepare:${id}`); return activation },
      detachForOwner: async () => { log.push(`detach:${id}`); return transfer },
      adoptForOwner: actual => {
        expect(actual).toBe(transfer)
        log.push(`adopt:${id}`)
        return { ownerSessionId: id, runtimeGeneration: 2 }
      },
      sendOwnerControl: control => { controls.push({ backend: id, control }); log.push(`${id}:${control.type}`); return true },
      releaseForOwner: async () => { log.push(`release:${id}`) },
    }
  }
  const source = backend('source')
  const target = backend('target')
  const host: ConstructorParameters<typeof NativeSessionOwner>[0] = {
    source: (id, actual) => {
      if (id !== 'source' || actual !== source) throw new Error('Stale source backend')
      return { nativeSessionId: 'native-source', turnDone: sourceDone.promise }
    },
    claim: (id, inputId) => origins.claim(id, inputId),
    createTarget: async (_source, record) => {
      log.push('create-target')
      records.set('target', { ...record, role: 'target', unpublished: true })
      return 'target'
    },
    backend: async () => target,
    persist: async (id, record) => { records.set(id, structuredClone(record)); log.push(`persist:${id}:${record.phase}`) },
    finalizeSource: async (id, record) => {
      if (records.get(id)?.transactionId === record.transactionId) await host.persist(id, record)
    },
    startTarget: () => { log.push('start-target') },
    finishTarget: async (_id, outcome) => { outcomes.push(outcome); log.push('finish-target') },
    publish: (_source, _target, _tx, clientId) => { publishes.push(clientId); log.push('publish') },
    rollback: async (id, tx) => { rollbacks.push(`${id}:${tx}`); log.push('rollback') },
    unlock: id => { log.push(`unlock:${id}`) },
    report: (_id, error) => { errors.push(error) },
  }
  const owner = new NativeSessionOwner(host)
  const sourcePort = owner.port('source')
  const targetPort = owner.port('target', true)
  const prepare = (operation: Extract<PiNativeOwnerEventBody, { type: 'owner_prepare' }>['operation'] = { type: 'new' }) => send({
    type: 'owner_prepare', transactionId: 'tx', sourceNativeSessionId: 'native-source', operation, inputId: 'input',
  })
  const send = (event: PiNativeOwnerEventBody, fromTarget = false, physical = transport, generation = fromTarget ? 2 : 1, actual = fromTarget ? target : source) =>
    (fromTarget ? targetPort : sourcePort).onEvent({
      ...event, ownerSessionId: fromTarget ? 'target' : 'source', runtimeGeneration: generation,
    }, actual, physical)
  const closed = async () => {
    sourceDone.resolve()
    await send({ type: 'owner_source_closed', transactionId: 'tx' })
  }
  const bound = () => send({ type: 'owner_target_bound', transactionId: 'tx', nativeSessionId: 'native-target' }, true)
  const finished = () => send({ type: 'owner_finished', transactionId: 'tx', outcome: 'complete' }, true)
  return { transport, sourceDone, origins, log, controls, records, publishes, rollbacks, outcomes, errors, source, target, host, owner, sourcePort, targetPort, prepare, send, closed, bound, finished }
}

describe('product native session owner barriers', () => {
  test('awaits both prepared receipts, source finalization, then both commit receipts before callback permission', async () => {
    const f = fixture()
    const entered = deferred()
    const receipt = deferred()
    const persist = f.host.persist
    f.host.persist = async (id, record) => {
      if (id === 'target' && record.phase === 'prepared') { entered.resolve(); await receipt.promise }
      await persist(id, record)
    }
    const preparing = f.prepare()
    await entered.promise
    expect(f.controls).toEqual([])
    expect(f.owner.isLocked('source')).toBe(true)
    expect(f.owner.isLocked('target')).toBe(true)
    receipt.resolve()
    await preparing
    expect(f.controls.map(item => item.backend + ':' + item.control.type)).toEqual(['source:owner_prepared'])
    const detached = deferred()
    const detach = f.source.detachForOwner
    f.source.detachForOwner = async () => { const transfer = await detach(); detached.resolve(); return transfer }
    const closing = f.send({ type: 'owner_source_closed', transactionId: 'tx' })
    await detached.promise
    expect(f.log).not.toContain('adopt:target')
    f.log.push('source-finalized')
    f.sourceDone.resolve()
    await closing
    expect(f.log.indexOf('persist:source:source_closed')).toBeGreaterThan(f.log.indexOf('source-finalized'))
    expect(f.log.indexOf('adopt:target')).toBeGreaterThan(f.log.indexOf('persist:source:source_closed'))
    expect(f.controls.at(-1)?.backend).toBe('target')
    expect(f.controls.at(-1)?.control.type).toBe('owner_activate')
    const commitEntered = deferred()
    const commitReceipt = deferred()
    f.host.persist = async (id, record) => {
      if (id === 'source' && record.phase === 'committed') { commitEntered.resolve(); await commitReceipt.promise }
      await persist(id, record)
    }
    const binding = f.bound()
    await commitEntered.promise
    expect(f.publishes).toHaveLength(0)
    expect(f.controls.some(item => item.control.type === 'owner_committed')).toBe(false)
    commitReceipt.resolve()
    await binding
    expect(f.publishes).toEqual(['originating-client'])
    expect(f.log.indexOf('publish')).toBeGreaterThan(f.log.indexOf('persist:source:committed'))
    expect(f.log.indexOf('target:owner_committed')).toBeGreaterThan(f.log.indexOf('publish'))
    expect(f.owner.isLocked('source')).toBe(false)
    expect(f.owner.isLocked('target')).toBe(true)
    await f.finished()
    expect(f.outcomes).toEqual(['complete'])
    expect(f.records.get('source')?.callbacks).toBe('finished')
    expect(f.owner.isLocked('target')).toBe(false)
    expect(f.log.filter(entry => entry === 'release-pin')).toHaveLength(1)
  })

  for (const failure of ['source:prepared', 'target:activating', 'target:committed', 'source:committed']) {
    test(`fails closed on strict ${failure} write failure`, async () => {
      const f = fixture()
      const persist = f.host.persist
      f.host.persist = async (id, record) => {
        if (`${id}:${record.phase}` === failure) throw new Error(`Fixture ${failure}`)
        await persist(id, record)
      }
      await f.prepare()
      if (f.owner.isLocked('source')) await f.closed()
      if (f.owner.isLocked('source')) await f.bound()
      expect(f.publishes).toHaveLength(0)
      expect(f.controls.some(item => item.control.type === 'owner_committed')).toBe(false)
      expect(f.rollbacks).toEqual(['target:tx'])
      expect(f.records.get('source')?.committed).toBe(false)
      expect(f.owner.isLocked('source')).toBe(false)
      expect(f.owner.isLocked('target')).toBe(false)
    })
  }

  test('duplicates and stale scope, backend and physical transport frames cannot advance a transaction', async () => {
    const f = fixture()
    await f.prepare()
    await f.prepare()
    expect(f.log.filter(entry => entry === 'create-target')).toHaveLength(1)
    await f.send({ type: 'owner_source_closed', transactionId: 'tx' }, false, {})
    await f.send({ type: 'owner_source_closed', transactionId: 'tx' }, false, f.transport, 99)
    await f.send({ type: 'owner_source_closed', transactionId: 'tx' }, false, f.transport, 1, f.target)
    expect(f.log).not.toContain('detach:source')
    await f.closed()
    await f.closed()
    await f.bound()
    await f.bound()
    await f.finished()
    await f.finished()
    expect(f.log.filter(entry => entry === 'detach:source')).toHaveLength(1)
    expect(f.publishes).toHaveLength(1)
    expect(f.outcomes).toEqual(['complete'])
    await f.prepare()
    expect(f.log.filter(entry => entry === 'create-target')).toHaveLength(1)
  })

  test('keeps source ownership until the independent target publication receipt succeeds', async () => {
    const f = fixture()
    await f.prepare()
    await f.closed()
    const entered = deferred()
    const receipt = deferred()
    const persist = f.host.persist
    f.host.persist = async (id, record) => {
      if (id === 'target' && record.phase === 'committed' && !record.unpublished) {
        entered.resolve()
        await receipt.promise
      }
      await persist(id, record)
    }
    const binding = f.bound()
    await entered.promise
    expect(f.records.get('source')?.committed).toBe(true)
    expect(f.owner.isLocked('source')).toBe(true)
    expect(f.publishes).toHaveLength(0)
    expect(f.controls.some(item => item.control.type === 'owner_committed')).toBe(false)
    receipt.resolve()
    await binding
    expect(f.records.get('target')).toMatchObject({ committed: true, callbacks: 'authorized' })
    expect(f.records.get('target')?.unpublished).toBeUndefined()
    expect(f.owner.cancel('source')).toBeUndefined()
    expect(f.outcomes).toEqual([])
    await f.finished()
  })

  for (const persistent of [false, true]) {
    test(`requires a publication receipt during abort after ${persistent ? 'persistent' : 'transient'} target write failure`, async () => {
      const f = fixture()
      await f.prepare()
      await f.closed()
      const persist = f.host.persist
      let attempts = 0
      f.host.persist = async (id, record) => {
        if (id === 'target' && record.committed && !record.unpublished && (++attempts === 1 || persistent)) {
          throw new Error('Fixture publication receipt failure')
        }
        await persist(id, record)
      }
      const publish = f.host.publish
      const publishedRecords: (NativeSessionOwnerRecord | undefined)[] = []
      f.host.publish = (...args) => {
        publishedRecords.push(structuredClone(f.records.get('target')))
        publish(...args)
      }
      await f.bound()
      expect(f.controls.some(item => item.control.type === 'owner_committed')).toBe(false)
      expect(f.outcomes).toEqual(['error'])
      expect(f.owner.isLocked('source')).toBe(false)
      if (persistent) {
        expect(f.publishes).toHaveLength(0)
        expect(f.records.get('target')?.unpublished).toBe(true)
      } else {
        expect(f.publishes).toHaveLength(1)
        expect(publishedRecords).toEqual([expect.objectContaining({
          committed: true, callbacks: 'interrupted', phase: 'failed', unpublished: false,
        })])
      }
    })
  }

  for (const operation of [
    { type: 'fork', entryId: 'unmapped', position: 'before' },
    { type: 'switch', sessionPath: '/untrusted/arbitrary.jsonl' },
    { type: 'new', parentSession: '/unmapped/parent.jsonl' },
  ] as const) {
    test(`rejects ${JSON.stringify(operation)} before source closure`, async () => {
      const f = fixture()
      await f.prepare(operation)
      expect(f.controls.map(item => item.control.type)).toEqual(['owner_abort'])
      expect(f.log).not.toContain('create-target')
      expect(f.log).not.toContain('detach:source')
    })
  }

  test('validates native identity and capability before creating a target', async () => {
    const f = fixture()
    await f.send({ type: 'owner_prepare', transactionId: 'wrong-native', sourceNativeSessionId: 'forged', operation: { type: 'new' } })
    await f.send({ type: 'owner_prepare', transactionId: 'wrong-backend', sourceNativeSessionId: 'native-source', operation: { type: 'new' } }, false, f.transport, 1, f.target)
    expect(f.log).not.toContain('create-target')
    expect(f.controls.map(item => item.control.type)).toEqual(['owner_abort', 'owner_abort'])
  })

  test('a disconnected caller loses navigation while the prepared transaction can still commit', async () => {
    const f = fixture()
    await f.prepare()
    f.origins.finishTurn('source', new Set())
    f.origins.retireClient('originating-client')
    await f.closed()
    await f.bound()
    expect(f.publishes).toEqual([undefined])
    expect(f.publishes).toHaveLength(1)
    await f.finished()
  })

  test('a committed callback failure reports only to the target owner', async () => {
    const f = fixture()
    const reported: string[] = []
    f.host.report = id => { reported.push(id) }
    await f.prepare()
    await f.closed()
    await f.bound()
    await f.send({ type: 'owner_finished', transactionId: 'tx', outcome: 'error', error: 'target callback failed' }, true)
    expect(f.outcomes).toEqual(['error'])
    expect(reported).toEqual(['target'])
  })

  test('Stop interrupts the source-finalization wait and rolls back without adopting a writer', async () => {
    const f = fixture()
    await f.prepare()
    const closing = f.send({ type: 'owner_source_closed', transactionId: 'tx' })
    const stopping = f.owner.cancel('source')
    await Promise.all([closing, stopping])
    expect(f.log).not.toContain('adopt:target')
    expect(f.rollbacks).toEqual(['target:tx'])
    expect(f.records.get('source')?.phase).toBe('aborted')
    expect(f.owner.isLocked('source')).toBe(false)
  })

  test('Stop racing the durable source commit retains the committed target but grants no callbacks', async () => {
    const f = fixture()
    await f.prepare()
    await f.closed()
    const entered = deferred()
    const receipt = deferred()
    const persist = f.host.persist
    f.host.persist = async (id, record) => {
      if (id === 'source' && record.phase === 'committed') { entered.resolve(); await receipt.promise }
      await persist(id, record)
    }
    const binding = f.bound()
    await entered.promise
    const stopping = f.owner.cancel('source')
    receipt.resolve()
    await Promise.all([binding, stopping])
    expect(f.records.get('source')?.committed).toBe(true)
    expect(f.rollbacks).toEqual([])
    expect(f.publishes).toEqual([undefined])
    expect(f.publishes).toHaveLength(1)
    expect(f.controls.some(item => item.control.type === 'owner_committed')).toBe(false)
    expect(f.outcomes).toEqual(['cancelled'])
  })

  test('activation preparation failure can still abort through the original source transfer', async () => {
    const f = fixture()
    f.target.prepareActivation = async () => { throw new Error('Fixture target configuration failure') }
    await f.prepare()
    await f.closed()
    expect(f.controls.some(item => item.backend === 'transfer' && item.control.type === 'owner_abort')).toBe(true)
    expect(f.controls.some(item => item.backend === 'target' && item.control.type === 'owner_abort')).toBe(false)
    expect(f.rollbacks).toEqual(['target:tx'])
  })

  test('a failed foreground release retains the unpublished target files for recovery', async () => {
    const f = fixture()
    await f.prepare()
    await f.closed()
    f.target.releaseForOwner = async () => { throw new Error('Fixture release failure') }
    await f.owner.cancel('source')
    expect(f.rollbacks).toEqual([])
    expect(f.records.get('target')).toMatchObject({ role: 'target', unpublished: true, committed: false, phase: 'aborted' })
    expect(f.owner.isLocked('target')).toBe(false)
    expect(f.errors.map(String).some(error => error.includes('Fixture release failure'))).toBe(true)
  })

  test('only an exit of the participating physical connection cancels the transaction', async () => {
    const f = fixture()
    await f.prepare()
    await f.sourcePort.onExit(f.source, {}, new Error('stale connection'))
    expect(f.owner.isLocked('source')).toBe(true)
    await f.sourcePort.onExit(f.source, f.transport, new Error('physical exit'))
    expect(f.rollbacks).toEqual(['target:tx'])
    expect(f.owner.isLocked('source')).toBe(false)
  })
})
