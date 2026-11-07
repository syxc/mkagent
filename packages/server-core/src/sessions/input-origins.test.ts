import { expect, test } from 'bun:test'
import { InputOrigins } from './input-origins'

test('claims only the exact product owner and input', () => {
  const origins = new InputOrigins()
  origins.admit('source', 'input', 'client-A')
  expect(origins.claim('other', 'input')).toBeUndefined()
  expect(origins.claim('source', 'missing')).toBeUndefined()
  const lease = origins.claim('source', 'input')!
  expect(lease.clientId).toBe('client-A')
  expect(lease.isCurrent()).toBe(true)
  lease.release()
  expect(lease.isCurrent()).toBe(false)
})

test('completion retires ordinary inputs and preserves inputs still queued', () => {
  const origins = new InputOrigins()
  origins.admit('source', 'active', 'client-A')
  origins.admit('source', 'queued', 'client-B')
  origins.finishTurn('source', new Set(['queued']))
  expect(origins.claim('source', 'active')).toBeUndefined()
  const queued = origins.claim('source', 'queued')!
  expect(queued.clientId).toBe('client-B')
  expect(queued.isCurrent()).toBe(true)
  queued.release()
  origins.finishTurn('source', new Set())
  expect(origins.claim('source', 'queued')).toBeUndefined()
})

test('an existing transaction survives source completion without granting new claims', () => {
  const origins = new InputOrigins()
  origins.admit('source', 'input', 'client-A')
  const first = origins.claim('source', 'input')!
  const second = origins.claim('source', 'input')!
  origins.finishTurn('source', new Set())
  expect(origins.claim('source', 'input')).toBeUndefined()
  expect(first.isCurrent()).toBe(true)
  first.release()
  first.release()
  expect(first.isCurrent()).toBe(false)
  expect(second.isCurrent()).toBe(true)
  second.release()
  expect(second.isCurrent()).toBe(false)
  expect(origins.claim('source', 'input')).toBeUndefined()
})

test('retiring a client invalidates its retained transaction without affecting another client', () => {
  const origins = new InputOrigins()
  origins.admit('source', 'input-A', 'client-A')
  origins.admit('source', 'input-B', 'client-B')
  const a = origins.claim('source', 'input-A')!
  const b = origins.claim('source', 'input-B')!
  origins.finishTurn('source', new Set())
  origins.retireClient('client-A')
  expect(a.isCurrent()).toBe(false)
  expect(b.isCurrent()).toBe(true)
  a.release()
  b.release()
})

test('an old lease cannot navigate or release a newly admitted origin with the same ID', () => {
  const origins = new InputOrigins()
  origins.admit('source', 'input', 'client-A')
  const old = origins.claim('source', 'input')!
  origins.retireClient('client-A')
  origins.admit('source', 'input', 'client-B')
  const current = origins.claim('source', 'input')!
  expect(old.isCurrent()).toBe(false)
  old.release()
  expect(current.clientId).toBe('client-B')
  expect(current.isCurrent()).toBe(true)
  current.release()
})

test('Stop invalidates active transaction claims while preserving the product queue', () => {
  const origins = new InputOrigins()
  origins.admit('source', 'active', 'client-A')
  origins.admit('source', 'queued', 'client-B')
  const active = origins.claim('source', 'active')!
  origins.cancelTurn('source', new Set(['queued']))
  expect(active.isCurrent()).toBe(false)
  expect(origins.claim('source', 'active')).toBeUndefined()
  const queued = origins.claim('source', 'queued')!
  expect(queued.clientId).toBe('client-B')
  expect(queued.isCurrent()).toBe(true)
  active.release()
  queued.release()
})

test('deleting a session and cleanup retire all corresponding claims', () => {
  const origins = new InputOrigins()
  origins.admit('source', 'input-A', 'client-A')
  origins.admit('target', 'input-B', 'client-B')
  const a = origins.claim('source', 'input-A')!
  const b = origins.claim('target', 'input-B')!
  origins.retireSession('source')
  expect(a.isCurrent()).toBe(false)
  expect(b.isCurrent()).toBe(true)
  origins.clear()
  expect(b.isCurrent()).toBe(false)
  a.release()
  b.release()
})
