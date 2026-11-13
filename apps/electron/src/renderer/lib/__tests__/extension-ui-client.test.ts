import { describe, expect, test } from 'bun:test'
import type { ExtensionUISnapshot, ExtensionUIUpdate } from '@mkagent/shared/protocol'
import type { TransportConnectionState } from '../../../shared/types'
import { ExtensionUIClient } from '../extension-ui-client'

type Bridge = ConstructorParameters<typeof ExtensionUIClient>[0]
const snapshot = (revision = 0): ExtensionUISnapshot => ({
  sessionId: 'session', uiEpoch: 'epoch', available: true, revision,
  requests: [{ type: 'extension_ui_request', method: 'input', id: 'dialog', title: 'Input', uiEpoch: 'epoch' }],
  statuses: [], widgets: [],
})
const state = (status: TransportConnectionState['status']): TransportConnectionState => ({
  mode: 'local', status, url: 'ws://127.0.0.1:1', attempt: 0, updatedAt: 0,
})
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

function fixture() {
  const updates = new Set<(update: ExtensionUIUpdate) => void>()
  const connections = new Set<(value: TransportConnectionState) => void>()
  const attaches: Array<{ id: string; lease: string; result: ReturnType<typeof Promise.withResolvers<ExtensionUISnapshot>> }> = []
  const detaches: string[] = []
  const responses: unknown[][] = []
  const effects: unknown[] = []
  const initial = Promise.withResolvers<TransportConnectionState>()
  let ack = true
  const api: Bridge = {
    onExtensionUIUpdate(callback) { updates.add(callback); return () => { updates.delete(callback) } },
    onTransportConnectionStateChanged(callback) { connections.add(callback); return () => { connections.delete(callback) } },
    getTransportConnectionState: () => initial.promise,
    isChannelAvailable: () => true,
    attachExtensionUI(id, lease) {
      const result = Promise.withResolvers<ExtensionUISnapshot>()
      attaches.push({ id, lease, result })
      return result.promise
    },
    async detachExtensionUI(_id, lease) { detaches.push(lease) },
    async respondToExtensionUI(...args) { responses.push(args); return ack },
  }
  const client = new ExtensionUIClient(api, (id, effect) => effects.push({ id, effect }))
  client.setSessions(['session'])
  client.start()
  const connect = () => { for (const callback of connections) callback(state('connected')) }
  const disconnect = () => { for (const callback of connections) callback(state('reconnecting')) }
  const update = (lease: string, revision: number, text?: string) => {
    const value: ExtensionUIUpdate = {
      subscriptionId: lease, snapshot: snapshot(revision),
      ...(text === undefined ? {} : { effect: {
        type: 'extension_ui_request', method: 'set_editor_text', id: 'effect', uiEpoch: 'epoch', text,
      } as const }),
    }
    for (const callback of updates) callback(value)
  }
  return { client, attaches, detaches, responses, effects, initial, connect, disconnect, update,
    setAck(value: boolean) { ack = value } }
}

describe('ExtensionUIClient leases', () => {
  test('accepts an event before attach ack, without rolling its snapshot back', async () => {
    const f = fixture()
    try {
      f.connect()
      const first = f.attaches[0]!
      f.update(first.lease, 2, '')
      first.result.resolve(snapshot(1))
      await tick()
      expect(f.client.getSnapshot().get('session')?.revision).toBe(2)
      expect(f.effects).toHaveLength(1)
      f.update(first.lease, 2, '')
      expect(f.effects).toHaveLength(1)
    } finally { f.client.dispose() }
  })

  test('reconnect rejects buffered effects and a late attach from the previous connection', async () => {
    const f = fixture()
    try {
      f.connect()
      const first = f.attaches[0]!
      f.update(first.lease, 1, 'before')
      f.disconnect()
      expect(f.client.getSnapshot().size).toBe(0)
      f.connect()
      const second = f.attaches[1]!
      expect(second.lease).not.toBe(first.lease)
      f.update(first.lease, 9, 'stale')
      first.result.resolve(snapshot(10))
      second.result.resolve(snapshot(2))
      await tick()
      expect(f.effects).toHaveLength(1)
      expect(f.detaches).toContain(first.lease)
      expect(f.client.getSnapshot().get('session')?.revision).toBe(2)
    } finally { f.client.dispose() }
  })

  test('a late transport-state query cannot undo a newer disconnect', async () => {
    const f = fixture()
    try {
      f.connect()
      f.disconnect()
      f.initial.resolve(state('connected'))
      await tick()
      expect(f.attaches).toHaveLength(1)
      expect(f.client.getSnapshot().size).toBe(0)
    } finally { f.client.dispose() }
  })

  test('StrictMode restart uses a new lease and removes its old listeners', async () => {
    const f = fixture()
    try {
      f.connect()
      const first = f.attaches[0]!
      f.client.dispose()
      f.client.start()
      f.connect()
      const second = f.attaches[1]!
      f.update(first.lease, 3, 'old')
      f.update(second.lease, 1, 'new')
      expect(f.effects).toHaveLength(1)
      expect(f.detaches).toContain(first.lease)
      expect(f.client.getSnapshot().get('session')?.revision).toBe(1)
    } finally { f.client.dispose() }
  })

  test('waits for worker acceptance and refreshes a rejected response', async () => {
    const f = fixture()
    try {
      f.connect()
      f.attaches[0]!.result.resolve(snapshot())
      await tick()
      const response = { type: 'extension_ui_response', id: 'dialog', value: '' } as const
      expect(await f.client.respond('session', 'wrong-epoch', response)).toBe(false)
      expect(f.responses).toHaveLength(0)
      expect(await f.client.respond('session', 'epoch', response)).toBe(true)
      expect(f.responses[0]?.[3]).toEqual(response)
      f.setAck(false)
      expect(await f.client.respond('session', 'epoch', response)).toBe(false)
      expect(f.attaches).toHaveLength(2)
      expect(f.attaches[1]!.lease).toBe(f.attaches[0]!.lease)
    } finally { f.client.dispose() }
  })

  test('does not apply a transient effect after a subscriber removes its session', () => {
    const f = fixture()
    try {
      f.connect()
      const unsubscribe = f.client.subscribe(() => {
        if (f.client.getSnapshot().size) f.client.setSessions([])
      })
      f.update(f.attaches[0]!.lease, 1, 'must not reach a retired draft')
      unsubscribe()
      expect(f.effects).toHaveLength(0)
      expect(f.client.getSnapshot().size).toBe(0)
    } finally { f.client.dispose() }
  })
})
