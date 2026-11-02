import { afterEach, describe, expect, it, mock } from 'bun:test'
import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const real = { ...fs }
const realPromises = { ...promises }
const nativeWatch = fs.watch
const nativeWatchers: fs.FSWatcher[] = []
const nativeCallbacks: fs.WatchListener<string>[] = []
const closedWatchers = new WeakSet<fs.FSWatcher>()
let rejectScan = false
let scanFailures = 0
const silentFs = () => ({
  ...real,
  watch(path: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) {
    nativeCallbacks.push(listener)
    const watcher = nativeWatch(path, { recursive: true }, () => {})
    const close = watcher.close.bind(watcher)
    watcher.close = () => {
      closedWatchers.add(watcher)
      return close()
    }
    nativeWatchers.push(watcher)
    return watcher
  },
})
// Lost native notifications must not prevent state reconciliation.
mock.module('fs', silentFs)
mock.module('node:fs', silentFs)
mock.module('node:fs/promises', () => ({
  ...realPromises,
  async readdir(path: fs.PathLike, options: unknown) {
    if (rejectScan) {
      scanFailures++
      throw Object.assign(new Error('Fixture directory is unreadable'), { code: 'EACCES' })
    }
    return Reflect.apply(realPromises.readdir, realPromises, [path, options])
  },
}))

const { registerSessionsHandlers, cleanupSessionFileWatchForClient } = await import('../handlers/rpc/sessions')
const { RPC_CHANNELS } = await import('@mkagent/shared/protocol')
const roots: string[] = []
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function harness() {
  const root = real.mkdtempSync(join(tmpdir(), 'mkagent-watch-recovery-'))
  roots.push(root)
  for (const id of ['a', 'b']) real.mkdirSync(join(root, id))
  const handlers = new Map<string, (...args: any[]) => any>()
  const pushes: Array<{ id: string; session: string }> = []
  registerSessionsHandlers({
    handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
    push: (_channel: string, target: any, session: string) => pushes.push({ id: target.clientId, session }),
  } as any, {
    sessionManager: { getSessionPath: (id: string) => join(root, id) },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  } as any)
  return {
    path: (id: string, name: string) => join(root, id, name),
    watch: (client: string, session: string) => handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)!({ clientId: client }, session),
    unwatch: (client: string) => handlers.get(RPC_CHANNELS.sessions.UNWATCH_FILES)!({ clientId: client }),
    pushes,
  }
}

async function notification(check: () => boolean, timeout = 2300) {
  const deadline = performance.now() + timeout
  while (!check() && performance.now() < deadline) await delay(10)
  expect(check()).toBe(true)
}

afterEach(() => {
  rejectScan = false
  scanFailures = 0
  cleanupSessionFileWatchForClient('recovery-a')
  cleanupSessionFileWatchForClient('recovery-b')
  for (const watcher of nativeWatchers.splice(0)) watcher.close()
  nativeCallbacks.length = 0
  for (const root of roots.splice(0)) real.rmSync(root, { recursive: true, force: true })
})

describe('session file watcher recovery without native events', () => {
  it('keeps native watching when the initial scan fails and reconciles after recovery', async () => {
    const h = harness()
    rejectScan = true
    await h.watch('recovery-b', 'b')
    expect(nativeCallbacks).toHaveLength(1)
    real.writeFileSync(h.path('b', 'native.txt'), 'visible')
    nativeCallbacks.at(-1)!('change', 'native.txt')
    await notification(() => h.pushes.some(push => push.session === 'b'), 500)
    expect(scanFailures).toBeGreaterThan(0)
    rejectScan = false
    h.pushes.length = 0
    real.writeFileSync(h.path('b', 'recovered.txt'), 'visible')
    await notification(() => h.pushes.some(push => push.session === 'b'))
  })

  it('delivers native notifications even when reconciliation cannot read a directory', async () => {
    const h = harness()
    await h.watch('recovery-b', 'b')
    rejectScan = true
    real.writeFileSync(h.path('b', 'native.txt'), 'visible')
    nativeCallbacks.at(-1)!('change', 'native.txt')
    await notification(() => h.pushes.some(push => push.session === 'b'), 500)
    await delay(1000)
    expect(scanFailures).toBeGreaterThan(0)
  })

  it('continues reconciling after a native watcher error', async () => {
    const h = harness()
    await h.watch('recovery-b', 'b')
    nativeWatchers.at(-1)!.emit('error', new Error('Native notification backend failed'))
    real.writeFileSync(h.path('b', 'recovered.txt'), 'visible')
    await notification(() => h.pushes.some(push => push.session === 'b'))
  })

  it('closes a watcher whose subscription was cancelled while starting', async () => {
    const h = harness()
    const pending = h.watch('recovery-b', 'b')
    await h.unwatch('recovery-b')
    await pending
    expect(nativeWatchers.every(watcher => closedWatchers.has(watcher))).toBe(true)
  })

  it('keeps only the latest overlapping subscription for a client', async () => {
    const h = harness()
    await Promise.all([h.watch('recovery-b', 'a'), h.watch('recovery-b', 'b')])
    expect(nativeWatchers.filter(watcher => !closedWatchers.has(watcher))).toHaveLength(1)
    real.writeFileSync(h.path('a', 'old.txt'), 'old')
    real.writeFileSync(h.path('b', 'new.txt'), 'new')
    await notification(() => h.pushes.length > 0)
    expect(h.pushes.every(push => push.session === 'b')).toBe(true)
    await h.unwatch('recovery-b')
    expect(nativeWatchers.every(watcher => closedWatchers.has(watcher))).toBe(true)
  })

  it('recovers creates and same-size edits for B after A closes, and stops after disconnect', async () => {
    const h = harness()
    await h.watch('recovery-a', 'a')
    await h.watch('recovery-b', 'b')
    await h.unwatch('recovery-a')
    real.writeFileSync(h.path('a', 'closed.txt'), 'ignored')
    real.writeFileSync(h.path('b', 'visible.txt'), 'first')
    await notification(() => h.pushes.some(p => p.id === 'recovery-b' && p.session === 'b'))
    expect(h.pushes.some(p => p.id === 'recovery-a')).toBe(false)

    h.pushes.length = 0
    real.writeFileSync(h.path('b', 'visible.txt'), 'other')
    await notification(() => h.pushes.some(p => p.id === 'recovery-b'))

    cleanupSessionFileWatchForClient('recovery-b')
    h.pushes.length = 0
    real.writeFileSync(h.path('b', 'visible.txt'), 'after')
    await delay(1200)
    expect(h.pushes).toHaveLength(0)
  }, 10000)

  it('recovers nested creates and deletes while ignoring hidden and internal files', async () => {
    const h = harness()
    await h.watch('recovery-b', 'b')
    real.mkdirSync(h.path('b', 'nested'))
    real.writeFileSync(h.path('b', 'nested/result.txt'), 'result')
    await notification(() => h.pushes.length > 0)
    h.pushes.length = 0
    real.unlinkSync(h.path('b', 'nested/result.txt'))
    await notification(() => h.pushes.length > 0)

    h.pushes.length = 0
    real.writeFileSync(h.path('b', 'session.jsonl'), 'internal')
    real.writeFileSync(h.path('b', '.hidden'), 'internal')
    real.mkdirSync(h.path('b', 'nested/.private'))
    real.writeFileSync(h.path('b', 'nested/.private/ignored.txt'), 'internal')
    await delay(1200)
    expect(h.pushes).toHaveLength(0)
    real.writeFileSync(h.path('b', 'nested/control.txt'), 'visible')
    await notification(() => h.pushes.length > 0)
  }, 10000)
})
