import type { NativeSessionOwnerRecord, NativeSessionReference } from '@mkagent/shared/sessions'
import type {
  PiNativeOwnerBackend, PiNativeOwnerControl, PiNativeOwnerEvent, PiNativeOwnerHostPort,
  PiNativeWorkerTransfer,
  PiNativeOwnerRequest,
} from '../../../shared/src/agent/backend/pi/native-owner-protocol'
import type { PiWorkerScope } from '../../../shared/src/agent/backend/pi/protocol'
import type { InputOriginLease } from './input-origins'
import type { NativeForkProof } from './native-session-fork'

interface NativeOwnerHost {
  source(sessionId: string, backend: PiNativeOwnerBackend): { nativeSessionId: string; turnDone: Promise<void> }
  projection?(sessionId: string, reference: NativeSessionReference, backend: PiNativeOwnerBackend): Promise<void>
  prepareFork?(sessionId: string, request: PiNativeOwnerRequest): Promise<NativeForkProof>
  closeFork?(sourceId: string, targetId: string, proof: NativeForkProof, reference: NativeSessionReference): Promise<NativeForkProof>
  bindFork?(targetId: string, proof: NativeForkProof, reference: NativeSessionReference): Promise<void>
  claim(sessionId: string, inputId: string): InputOriginLease | undefined
  createTarget(sourceSessionId: string, record: NativeSessionOwnerRecord): Promise<string>
  backend(sessionId: string): Promise<PiNativeOwnerBackend>
  persist(sessionId: string, record: NativeSessionOwnerRecord): Promise<void>
  finalizeSource(sessionId: string, record: NativeSessionOwnerRecord): Promise<void>
  startTarget(sessionId: string): void
  finishTarget(sessionId: string, outcome: 'complete' | 'error' | 'cancelled'): Promise<void>
  publish(sourceSessionId: string, targetSessionId: string, transactionId: string, clientId?: string): void
  rollback(sessionId: string, transactionId: string): Promise<void>
  unlock(sessionId: string): void
  report(sessionId: string, error: unknown): void
}

interface Transaction {
  record: NativeSessionOwnerRecord
  source: PiNativeOwnerBackend
  sourceScope: PiWorkerScope
  transport: object
  sourceDone: Promise<void>
  interrupted: Promise<void>
  interrupt: () => void
  origin?: InputOriginLease
  target?: PiNativeOwnerBackend
  targetScope?: PiWorkerScope
  transfer?: PiNativeWorkerTransfer
  fork?: NativeForkProof
  queue: Promise<void>
  cancelled: boolean
  committed: boolean
  published: boolean
  targetStarted: boolean
  retired: boolean
}

function sameScope(a: PiWorkerScope, b: PiWorkerScope): boolean {
  return a.ownerSessionId === b.ownerSessionId && a.runtimeGeneration === b.runtimeGeneration
}

/** One foreground writer crosses the barrier; the transport retains background owners. */
export class NativeSessionOwner {
  private readonly transactions = new Map<string, Transaction>()
  private readonly locks = new Map<string, Transaction>()
  private readonly seen = new WeakMap<object, Set<string>>()

  constructor(private readonly host: NativeOwnerHost) {}

  isLocked(sessionId: string): boolean { return this.locks.has(sessionId) }

  port(sessionId: string, deferStartup = false): PiNativeOwnerHostPort {
    return {
      deferStartup,
      onProjection: (reference, backend) => this.host.projection?.(sessionId, reference, backend) ?? Promise.resolve(),
      onEvent: (event, backend, transport) => this.receive(sessionId, event, backend, transport),
      onExit: (backend, transport, error) => this.exit(backend, transport, error),
    }
  }

  private send(tx: Transaction, control: PiNativeOwnerControl): void {
    const sent = tx.targetScope && tx.target ? tx.target.sendOwnerControl(control)
      : tx.transfer ? tx.transfer.send(control) : tx.source.sendOwnerControl(control)
    if (!sent) throw new Error('Native owner control delivery failed')
  }

  private check(tx: Transaction): void {
    if (tx.cancelled || tx.retired) throw new Error('Native session replacement cancelled')
  }

  private report(tx: Transaction, error: unknown): void {
    this.host.report(tx.published ? tx.record.targetSessionId! : tx.record.sourceSessionId, error)
  }

  private async save(tx: Transaction, role: 'source' | 'target', phase: NativeSessionOwnerRecord['phase'],
    extra: Partial<NativeSessionOwnerRecord> = {}): Promise<void> {
    tx.record = { ...tx.record, phase, ...extra }
    const id = role === 'source' ? tx.record.sourceSessionId : tx.record.targetSessionId
    if (!id) throw new Error('Native session target is missing')
    const record = { ...tx.record, role, ...(role === 'target' ? { unpublished: tx.committed ? undefined : true } : {}) }
    if (role === 'source' && phase === 'finished') await this.host.finalizeSource(id, record)
    else await this.host.persist(id, record)
    if (role === 'source' && phase === 'committed') tx.committed = true
    this.check(tx)
  }

  private async receive(sessionId: string, event: PiNativeOwnerEvent, backend: PiNativeOwnerBackend, transport: object): Promise<void> {
    if (event.type === 'owner_prepare') {
      if (event.ownerSessionId !== sessionId || !Number.isSafeInteger(event.runtimeGeneration) || event.runtimeGeneration < 1) return
      const key = `${sessionId}:${event.runtimeGeneration}:${event.transactionId}`
      let seen = this.seen.get(transport)
      if (!seen) { seen = new Set(); this.seen.set(transport, seen) }
      if (seen.has(key)) return
      seen.add(key)
      if (this.transactions.has(event.transactionId) || this.locks.has(sessionId)) {
        backend.sendOwnerControl({ type: 'owner_abort', transactionId: event.transactionId, error: 'Native session replacement already in progress' })
        return
      }
      try {
        const source = this.host.source(sessionId, backend)
        if (!event.sourceNativeSessionId || source.nativeSessionId !== event.sourceNativeSessionId) throw new Error('Native source session identity does not match')
        if (event.operation.type === 'switch') throw new Error('Native switch requires a stable session path and owner release (D3.4)')
        if (event.operation.type === 'new' && event.operation.parentSession !== undefined) throw new Error('Native parentSession requires a stable native path mapping (D3.4)')
        if (event.operation.type === 'fork' && (!event.sourceReference || !this.host.projection
          || !this.host.prepareFork || !this.host.closeFork || !this.host.bindFork)) {
          throw new Error('Native fork requires a registered projection and exact anchor (D3.4)')
        }
        let interrupt!: () => void
        const interrupted = new Promise<void>(done => { interrupt = done })
        const tx: Transaction = {
          record: {
            transactionId: event.transactionId, role: 'source', sourceSessionId: sessionId,
            sourceNativeSessionId: event.sourceNativeSessionId, operation: event.operation.type, phase: 'preparing',
            committed: false, callbacks: 'blocked',
          },
          source: backend, sourceScope: { ownerSessionId: sessionId, runtimeGeneration: event.runtimeGeneration },
          transport, sourceDone: source.turnDone, interrupted, interrupt,
          origin: event.inputId ? this.host.claim(sessionId, event.inputId) : undefined,
          queue: Promise.resolve(), cancelled: false, committed: false, published: false, targetStarted: false, retired: false,
        }
        this.transactions.set(event.transactionId, tx)
        this.locks.set(sessionId, tx)
        return this.enqueue(tx, async () => {
          if (event.operation.type === 'fork') {
            await this.host.projection!(sessionId, event.sourceReference!, backend)
            this.check(tx)
            tx.fork = await this.host.prepareFork!(sessionId, event)
            tx.record = { ...tx.record, fork: tx.fork.record }
          }
          await this.save(tx, 'source', 'preparing')
          const targetId = await this.host.createTarget(sessionId, tx.record)
          tx.record = { ...tx.record, targetSessionId: targetId }
          this.locks.set(targetId, tx)
          this.check(tx)
          await this.save(tx, 'source', 'prepared')
          await this.save(tx, 'target', 'prepared')
          this.send(tx, { type: 'owner_prepared', transactionId: event.transactionId, targetSessionId: targetId })
        })
      } catch (error) {
        backend.sendOwnerControl({ type: 'owner_abort', transactionId: event.transactionId, error: String(error) })
        this.host.report(sessionId, error)
        return
      }
    }
    const tx = this.transactions.get(event.transactionId)
    if (!tx || tx.transport !== transport) return
    const fromSource = backend === tx.source && sessionId === tx.record.sourceSessionId && sameScope(event, tx.sourceScope)
    const fromTarget = backend === tx.target && sessionId === tx.record.targetSessionId && tx.targetScope && sameScope(event, tx.targetScope)
    if (!fromSource && !fromTarget) return
    return this.enqueue(tx, async () => {
      if (event.type === 'owner_source_closed' && fromSource && tx.record.phase === 'prepared') {
        if (tx.fork && !event.reference) throw new Error('Native fork is missing its closed source reference')
        if (event.reference) await this.host.projection?.(sessionId, event.reference, backend)
        this.check(tx)
        // Detaching pins the closed source connection and finishes its generator.
        // Adoption still waits for product persistence, listeners and runtime hooks.
        tx.transfer = await tx.source.detachForOwner()
        if (tx.transfer.transport !== transport || !sameScope(tx.transfer.sourceScope, tx.sourceScope)) throw new Error('Native transfer identity does not match')
        await Promise.race([tx.sourceDone, tx.interrupted])
        this.check(tx)
        const targetId = tx.record.targetSessionId!
        if (tx.fork) {
          tx.fork = await this.host.closeFork!(sessionId, targetId, tx.fork, event.reference!)
          tx.record = { ...tx.record, fork: tx.fork.record }
        }
        await this.save(tx, 'source', 'source_closed')
        tx.target = await this.host.backend(targetId)
        const activation = await tx.target.prepareActivation()
        if (tx.fork) {
          activation.reason = 'fork'
          activation.config = { ...activation.config, branchFromSessionPath: tx.fork.sourcePath,
            nativeFork: { leaf: tx.fork.record.nativeLeafId, source: tx.fork.record.source } }
        }
        this.check(tx)
        tx.targetScope = tx.target.adoptForOwner(tx.transfer, tx.record.transactionId)
        if (tx.targetScope.ownerSessionId !== targetId || tx.targetScope.runtimeGeneration <= tx.sourceScope.runtimeGeneration) throw new Error('Native adoption must advance target generation')
        this.host.startTarget(targetId)
        tx.targetStarted = true
        await this.save(tx, 'target', 'activating')
        await this.save(tx, 'source', 'activating')
        this.send(tx, { type: 'owner_activate', transactionId: tx.record.transactionId, activation })
      } else if (event.type === 'owner_target_bound' && fromTarget && tx.record.phase === 'activating') {
        if (!event.nativeSessionId) throw new Error('Native target session identity is missing')
        if (tx.fork && (!event.reference || event.reference.nativeSessionId !== event.nativeSessionId)) {
          throw new Error('Native fork is missing its bound target reference')
        }
        if (event.reference) await this.host.projection?.(sessionId, event.reference, backend)
        this.check(tx)
        if (tx.fork) await this.host.bindFork!(sessionId, tx.fork, event.reference!)
        // The target now holds the foreground lease. The gap pin and original
        // source control must not block another transfer on a fresh connection.
        tx.transfer?.release()
        tx.transfer = undefined
        await this.save(tx, 'target', 'target_bound', { targetNativeSessionId: event.nativeSessionId })
        await this.save(tx, 'target', 'committed', { committed: true })
        await this.save(tx, 'source', 'committed', { callbacks: 'authorized' })
        tx.committed = true
        // Publication must survive source deletion or its next replacement.
        await this.save(tx, 'target', 'committed')
        this.check(tx)
        const targetId = tx.record.targetSessionId!
        this.host.publish(tx.record.sourceSessionId, targetId, tx.record.transactionId, tx.origin?.isCurrent() ? tx.origin.clientId : undefined)
        tx.published = true
        this.send(tx, { type: 'owner_committed', transactionId: tx.record.transactionId })
        this.unlockSource(tx)
      } else if (event.type === 'owner_finished' && fromTarget && tx.record.phase === 'committed') {
        if (event.outcome === 'cancelled') tx.cancelled = true
        if (event.outcome !== 'complete') throw new Error(event.error ?? `Native session replacement ${event.outcome}`)
        await this.host.finishTarget(tx.record.targetSessionId!, 'complete')
        tx.targetStarted = false
        await this.save(tx, 'target', 'finished', { callbacks: 'finished' })
        await this.save(tx, 'source', 'finished')
        this.retire(tx)
      } else if (event.type === 'owner_failed') {
        throw new Error(event.error)
      }
    })
  }

  private enqueue(tx: Transaction, action: () => Promise<void>): Promise<void> {
    const next = tx.queue.then(async () => {
      if (tx.retired) return
      this.check(tx)
      await action()
    }).catch(error => this.abort(tx, error))
    tx.queue = next
    return next
  }

  cancel(sessionId: string): Promise<void> | undefined {
    const tx = this.locks.get(sessionId)
    if (!tx) return
    tx.cancelled = true
    tx.interrupt()
    const error = new Error('Native session replacement cancelled')
    try { this.send(tx, { type: 'owner_abort', transactionId: tx.record.transactionId, error: error.message }) } catch {}
    const pending = tx.queue.then(() => this.abort(tx, error))
    tx.queue = pending
    return pending
  }

  private async exit(backend: PiNativeOwnerBackend, transport: object, error: Error): Promise<void> {
    await Promise.all([...this.transactions.values()]
      .filter(tx => tx.transport === transport && (tx.source === backend || tx.target === backend))
      .map(tx => {
        tx.cancelled = true
        tx.interrupt()
        return this.enqueue(tx, async () => { throw error })
      }))
  }

  private async abort(tx: Transaction, error: unknown): Promise<void> {
    if (tx.retired) return
    const message = error instanceof Error ? error.message : String(error)
    let released = true
    try {
      try { this.send(tx, { type: 'owner_abort', transactionId: tx.record.transactionId, error: message }) } catch {}
      if (tx.target) {
        try { await tx.target.releaseForOwner() }
        catch (releaseError) { released = false; this.report(tx, releaseError) }
      }
      if (tx.targetStarted) {
        try { await this.host.finishTarget(tx.record.targetSessionId!, tx.cancelled ? 'cancelled' : 'error') }
        catch (finishError) { this.report(tx, finishError) }
        tx.targetStarted = false
      }
      tx.record = { ...tx.record, phase: tx.cancelled ? 'aborted' : 'failed', committed: tx.committed, callbacks: 'interrupted', error: message }
      try {
        const record = { ...tx.record, role: 'source' as const }
        if (tx.committed) await this.host.finalizeSource(tx.record.sourceSessionId, record)
        else await this.host.persist(tx.record.sourceSessionId, record)
      }
      catch (persistError) { this.report(tx, persistError) }
      if (tx.record.targetSessionId) {
        if (!tx.committed && released) await this.host.rollback(tx.record.targetSessionId, tx.record.transactionId)
        else {
          try {
            const publish = tx.committed && !tx.published
            // Error publication needs the same independent receipt as success.
            await this.host.persist(tx.record.targetSessionId, { ...tx.record, role: 'target', unpublished: publish ? false : !tx.published })
            if (publish) {
              this.host.publish(tx.record.sourceSessionId, tx.record.targetSessionId, tx.record.transactionId)
              tx.published = true
            }
          }
          catch (persistError) { this.report(tx, persistError) }
        }
      }
      this.report(tx, error)
    } finally {
      this.retire(tx)
    }
  }

  private unlockSource(tx: Transaction): void {
    if (this.locks.get(tx.record.sourceSessionId) !== tx) return
    this.locks.delete(tx.record.sourceSessionId)
    this.host.unlock(tx.record.sourceSessionId)
  }

  private retire(tx: Transaction): void {
    tx.retired = true
    tx.origin?.release()
    tx.transfer?.release()
    this.transactions.delete(tx.record.transactionId)
    this.unlockSource(tx)
    if (tx.record.targetSessionId && this.locks.get(tx.record.targetSessionId) === tx) {
      this.locks.delete(tx.record.targetSessionId)
      this.host.unlock(tx.record.targetSessionId)
    }
  }
}
