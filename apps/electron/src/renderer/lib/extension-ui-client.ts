import { RPC_CHANNELS } from '@mkagent/shared/protocol'
import type { ExtensionUIResponse, ExtensionUISnapshot, ExtensionUIUpdate } from '@mkagent/shared/protocol'
import type { ElectronAPI, TransportConnectionState } from '../../shared/types'

type Bridge = Pick<ElectronAPI, 'attachExtensionUI' | 'detachExtensionUI' | 'respondToExtensionUI'
  | 'onExtensionUIUpdate' | 'getTransportConnectionState' | 'onTransportConnectionStateChanged' | 'isChannelAvailable'>
type Effect = NonNullable<ExtensionUIUpdate['effect']>
interface Lease { subscriptionId: string; revision: number; effectRevision: number }

/** A reconnect changes client leases before any buffered UI effect can reach a draft. */
export class ExtensionUIClient {
  private readonly listeners = new Set<() => void>()
  private snapshots: ReadonlyMap<string, ExtensionUISnapshot> = new Map()
  private readonly leases = new Map<string, Lease>()
  private desired = new Set<string>()
  private cleanups: Array<() => void> = []
  private started = false
  private connected = false
  private run = 0
  private transportRevision = 0

  constructor(private readonly api: Bridge, private readonly effect: (sessionId: string, effect: Effect) => void) {}

  getSnapshot = (): ReadonlyMap<string, ExtensionUISnapshot> => this.snapshots
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(snapshots: ReadonlyMap<string, ExtensionUISnapshot>): void {
    this.snapshots = snapshots
    for (const listener of this.listeners) listener()
  }

  start(): void {
    if (this.started) return
    this.started = true
    const run = ++this.run
    this.cleanups.push(this.api.onExtensionUIUpdate(update => {
      if (!this.started || run !== this.run) return
      const lease = this.leases.get(update.snapshot.sessionId)
      if (!lease || lease.subscriptionId !== update.subscriptionId) return
      this.snapshot(update.snapshot, lease)
      if (!this.started || run !== this.run || this.leases.get(update.snapshot.sessionId) !== lease) return
      if (update.effect && update.snapshot.revision > lease.effectRevision) {
        lease.effectRevision = update.snapshot.revision
        this.effect(update.snapshot.sessionId, update.effect)
      }
    }))
    this.cleanups.push(this.api.onTransportConnectionStateChanged(state => {
      if (this.started && run === this.run) this.transport(state)
    }))
    const revision = this.transportRevision
    void this.api.getTransportConnectionState().then(state => {
      if (this.started && run === this.run && revision === this.transportRevision) this.transport(state)
    }).catch(() => {})
  }

  setSessions(sessionIds: Iterable<string>): void {
    this.desired = new Set(sessionIds)
    if (this.connected) this.reconcile()
  }

  private transport(state: TransportConnectionState): void {
    this.transportRevision++
    const connected = state.status === 'connected'
    if (connected === this.connected) return
    this.connected = connected
    if (connected) this.reconcile()
    else {
      this.leases.clear()
      this.publish(new Map())
    }
  }

  private snapshot(snapshot: ExtensionUISnapshot, lease: Lease): void {
    if (this.leases.get(snapshot.sessionId) !== lease || snapshot.revision <= lease.revision) return
    lease.revision = snapshot.revision
    const snapshots = new Map(this.snapshots)
    snapshots.set(snapshot.sessionId, snapshot)
    this.publish(snapshots)
  }

  private detach(sessionId: string, lease: Lease): void {
    void this.api.detachExtensionUI(sessionId, lease.subscriptionId).catch(() => {})
  }

  private attach(sessionId: string, lease: Lease): void {
    void this.api.attachExtensionUI(sessionId, lease.subscriptionId).then(snapshot => {
      if (this.leases.get(sessionId) !== lease) {
        // Cleanup may have run while the server was still initializing this attach.
        this.detach(sessionId, lease)
        return
      }
      if (snapshot.sessionId === sessionId) this.snapshot(snapshot, lease)
    }).catch(() => {
      this.detach(sessionId, lease)
      if (this.leases.get(sessionId) !== lease) return
      this.leases.delete(sessionId)
      const snapshots = new Map(this.snapshots)
      snapshots.delete(sessionId)
      this.publish(snapshots)
    })
  }

  private reconcile(): void {
    if (!this.api.isChannelAvailable(RPC_CHANNELS.sessions.ATTACH_EXTENSION_UI)) return
    for (const [sessionId, lease] of this.leases) {
      if (this.desired.has(sessionId)) continue
      this.leases.delete(sessionId)
      this.detach(sessionId, lease)
      const snapshots = new Map(this.snapshots)
      snapshots.delete(sessionId)
      this.publish(snapshots)
    }
    for (const sessionId of this.desired) {
      if (this.leases.has(sessionId)) continue
      const lease = { subscriptionId: crypto.randomUUID(), revision: -1, effectRevision: -1 }
      this.leases.set(sessionId, lease)
      this.attach(sessionId, lease)
    }
  }

  async respond(sessionId: string, uiEpoch: string, response: ExtensionUIResponse): Promise<boolean> {
    const lease = this.leases.get(sessionId)
    if (!this.connected || !lease || this.snapshots.get(sessionId)?.uiEpoch !== uiEpoch) return false
    try {
      const accepted = await this.api.respondToExtensionUI(sessionId, lease.subscriptionId, uiEpoch, response)
      if (!accepted && this.leases.get(sessionId) === lease) this.attach(sessionId, lease)
      return accepted && this.leases.get(sessionId) === lease
    } catch {
      return false
    }
  }

  dispose(): void {
    this.started = false
    this.connected = false
    this.run++
    this.transportRevision++
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    for (const [sessionId, lease] of this.leases) this.detach(sessionId, lease)
    this.leases.clear()
    this.publish(new Map())
  }
}
