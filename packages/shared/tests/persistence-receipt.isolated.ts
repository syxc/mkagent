import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fsPromises from 'fs/promises'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionPersistenceQueue } from '../src/sessions/persistence-queue'
import { getSessionFilePath } from '../src/sessions/storage'
import type { StoredSession } from '../src/sessions/types'

let directory: string
let queue: SessionPersistenceQueue
const restore: Array<() => void> = []
const session = (name: string): StoredSession => ({
  id: 'receipt-session',
  workspaceRootPath: directory,
  createdAt: 1,
  lastUsedAt: 1,
  messages: [],
  name,
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'session-receipt-'))
  queue = new SessionPersistenceQueue(60_000)
})

afterEach(async () => {
  for (const operation of restore.splice(0).reverse()) operation()
  queue.cancel('receipt-session')
  await queue.flushAll()
  rmSync(directory, { recursive: true, force: true })
})

test('a failed atomic rename preserves the previously committed record', async () => {
  queue.enqueue(session('Committed'))
  await queue.flush('receipt-session')
  const file = getSessionFilePath(directory, 'receipt-session')
  const committed = readFileSync(file, 'utf8')
  const signature = queue.getLastWrittenSignature('receipt-session')
  const rename = fsPromises.rename
  const failure = new Error('Fixture rename failure')
  const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (to === file) throw failure
    return rename(from, to)
  })
  restore.push(() => renameSpy.mockRestore())
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  restore.push(() => errors.mockRestore())

  queue.enqueue(session('Uncommitted'))
  await queue.flush('receipt-session')

  expect(readFileSync(file, 'utf8')).toBe(committed)
  expect(queue.getLastWrittenSignature('receipt-session')).toBe(signature)
  expect(errors).toHaveBeenCalled()
})

test('strict persistence rejects a failed replacement and a later receipt can succeed', async () => {
  await queue.persist(session('Committed'))
  const file = getSessionFilePath(directory, 'receipt-session')
  const committed = readFileSync(file, 'utf8')
  const signature = queue.getLastWrittenSignature('receipt-session')
  const failure = new Error('Fixture failed receipt')
  const rename = fsPromises.rename
  let fail = true
  const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (to === file && fail) throw failure
    return rename(from, to)
  })
  restore.push(() => renameSpy.mockRestore())

  await expect(queue.persist(session('Uncommitted'))).rejects.toBe(failure)
  expect(readFileSync(file, 'utf8')).toBe(committed)
  expect(queue.getLastWrittenSignature('receipt-session')).toBe(signature)

  fail = false
  await queue.persist(session('Recovered'))
  expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).name).toBe('Recovered')
})

test('a failed write does not reject a successful receipt queued behind it', async () => {
  const file = getSessionFilePath(directory, 'receipt-session')
  const rename = fsPromises.rename
  const failure = new Error('Fixture first receipt failure')
  let first = true
  const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (to === file && first) {
      first = false
      throw failure
    }
    return rename(from, to)
  })
  restore.push(() => renameSpy.mockRestore())

  const rejected = queue.persist(session('Uncommitted'))
  const accepted = queue.persist(session('Committed'))
  await expect(rejected).rejects.toBe(failure)
  await accepted
  expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).name).toBe('Committed')
})

test('strict and debounced saves keep admission order without stealing a later snapshot', async () => {
  const file = getSessionFilePath(directory, 'receipt-session')
  const rename = fsPromises.rename
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const snapshots: string[] = []
  const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (to === file) {
      snapshots.push(JSON.parse(readFileSync(from, 'utf8').split('\n')[0]).name)
      if (snapshots.length === 1) {
        entered.resolve()
        await release.promise
      }
    }
    return rename(from, to)
  })
  restore.push(() => renameSpy.mockRestore())
  restore.push(() => release.resolve())

  queue.enqueue(session('First'))
  const first = queue.flush('receipt-session')
  await entered.promise
  queue.enqueue(session('Second'))
  const second = queue.flush('receipt-session')
  queue.enqueue(session('Superseded'))
  const receipt = queue.persist(session('Receipt'))
  queue.enqueue(session('Later'))
  release.resolve()
  await Promise.all([first, second, receipt])

  expect(snapshots).toEqual(['First', 'Second', 'Receipt'])
  expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).name).toBe('Receipt')
  expect(queue.hasPending('receipt-session')).toBe(true)
  await queue.flush('receipt-session')
  expect(snapshots).toEqual(['First', 'Second', 'Receipt', 'Later'])
})

test('receipts preserve external metadata and commit the current message snapshot', async () => {
  await queue.persist(session('Committed'))
  const file = getSessionFilePath(directory, 'receipt-session')
  const [header] = readFileSync(file, 'utf8').trim().split('\n')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(header!), name: 'External', isFlagged: true }) + '\n')
  const data = session('Local')
  data.messages = [{ id: 'accepted', role: 'user', content: 'Local message', timestamp: 2 }]
  await queue.persist(data)

  const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(lines[0].name).toBe('External')
  expect(lines[0].isFlagged).toBe(true)
  expect(lines[1].id).toBe('accepted')
  expect(lines[1].content).toBe('Local message')
})

test('a failed first write does not publish a metadata signature', async () => {
  const writeFile = fsPromises.writeFile
  const file = getSessionFilePath(directory, 'receipt-session')
  const failure = new Error('Fixture temporary write failure')
  const writeSpy = spyOn(fsPromises, 'writeFile').mockImplementation(async (path, ...args) => {
    if (path === file + '.tmp') throw failure
    return writeFile(path, ...args)
  })
  restore.push(() => writeSpy.mockRestore())

  await expect(queue.persist(session('Uncommitted'))).rejects.toBe(failure)
  expect(queue.getLastWrittenSignature('receipt-session')).toBeUndefined()
})

test('cancelling a queued flush prevents it from recreating a deleted session', async () => {
  const file = getSessionFilePath(directory, 'receipt-session')
  const rename = fsPromises.rename
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (to === file) {
      entered.resolve()
      await release.promise
    }
    return rename(from, to)
  })
  restore.push(() => renameSpy.mockRestore())
  restore.push(() => release.resolve())
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  restore.push(() => errors.mockRestore())

  queue.enqueue(session('Active'))
  const active = queue.flush('receipt-session')
  await entered.promise
  queue.enqueue(session('Queued'))
  const queued = queue.flush('receipt-session')
  queue.cancel('receipt-session')
  rmSync(join(directory, 'sessions', 'receipt-session'), { recursive: true, force: true })
  release.resolve()
  await Promise.all([active, queued])

  expect(existsSync(file)).toBe(false)
  expect(errors).toHaveBeenCalledTimes(1)
})

test('cancelling an unstarted receipt rejects it without cancelling later admissions', async () => {
  const file = getSessionFilePath(directory, 'receipt-session')
  const rename = fsPromises.rename
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const snapshots: string[] = []
  const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (to === file) {
      snapshots.push(JSON.parse(readFileSync(from, 'utf8').split('\n')[0]).name)
      if (snapshots.length === 1) {
        entered.resolve()
        await release.promise
      }
    }
    return rename(from, to)
  })
  restore.push(() => renameSpy.mockRestore())
  restore.push(() => release.resolve())

  const active = queue.persist(session('Active'))
  await entered.promise
  const cancelled = queue.persist(session('Cancelled')).then(
    () => undefined,
    error => error,
  )
  queue.cancel('receipt-session')
  const later = queue.persist(session('Later'))
  release.resolve()
  const [, error] = await Promise.all([active, cancelled, later])

  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain('Session persistence cancelled')
  expect(snapshots).toEqual(['Active', 'Later'])
  expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).name).toBe('Later')
})
