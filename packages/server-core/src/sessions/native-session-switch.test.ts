import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeSessionReference } from '@mkagent/shared/sessions'
import type { NativeSourceEntry } from './native-session-source'
import { closeNativeSwitchProof, prepareNativeSwitchProof, verifyNativeSwitchTarget } from './native-session-switch'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const workspaceRootPath = mkdtempSync(join(tmpdir(), 'native-switch-proof-'))
  roots.push(workspaceRootPath)
  const session = join(workspaceRootPath, 'sessions', 'target')
  mkdirSync(join(session, 'native-session'), { recursive: true })
  mkdirSync(join(session, 'meta'), { recursive: true })
  const entries: NativeSourceEntry[] = [
    { id: 'root', parentId: null, type: 'message', timestamp: '2026-11-05', message: { role: 'user', content: 'root' } },
    { id: 'left', parentId: 'root', type: 'message', timestamp: '2026-11-05', message: { role: 'user', content: 'left' } },
    { id: 'right', parentId: 'root', type: 'message', timestamp: '2026-11-05', message: { role: 'user', content: 'inactive' } },
  ]
  const write = (options: {
    entries?: NativeSourceEntry[]; leaf?: string; revision?: number; nativeSessionId?: string; conversationId?: number;
    productId?: string;
  } = {}) => {
    const records = options.entries ?? entries
    const sessionFile = join(session, 'native-session', 'session.jsonl')
    const nativeSessionId = options.nativeSessionId ?? 'native-target'
    const header = { type: 'session', version: 3, id: nativeSessionId, cwd: workspaceRootPath, timestamp: '2026-11-05' }
    const jsonl = [header, ...records].map(row => JSON.stringify(row)).join('\n') + '\n'
    const lastName = records.findLast(row => row.type === 'session_info')?.name
    const manifest = { version: 1, sessionId: 'target', nativeSessionId, sessionFile,
      conversationId: options.conversationId ?? 1, revision: options.revision ?? 4, leaf: options.leaf ?? 'left',
      name: typeof lastName === 'string' ? lastName.trim() || null : null, digest: hash(jsonl),
      entryIds: records.map((row, index) => ({ nativeId: row.id, durableId: index + 1,
        productMessageId: index === 0 ? options.productId ?? 'p-root' : `p-${row.id}` })) }
    const metadata = JSON.stringify(manifest) + '\n'
    writeFileSync(sessionFile, jsonl)
    writeFileSync(join(session, 'meta', 'native-session.json'), metadata)
    const { entryIds: _entryIds, ...base } = manifest
    const reference: NativeSessionReference = { ...base, version: 1, manifestDigest: hash(metadata) }
    return { workspaceRootPath, sessionId: 'target', nativeSessionId, reference }
  }
  const identity = write()
  return { entries, identity, write }
}

test('switch accepts released shutdown additions and resumes the same complete target tree', () => {
  const f = fixture()
  const prepared = prepareNativeSwitchProof(f.identity)
  const records = [...f.entries,
    { id: 'shutdown', parentId: 'left', type: 'custom', timestamp: '2026-11-05', customType: 'shutdown', data: {} },
    { id: 'clear', parentId: 'shutdown', type: 'session_info', timestamp: '2026-11-05', name: '' }]
  const released = f.write({ entries: records, leaf: 'clear', revision: 5 })
  const closed = closeNativeSwitchProof(prepared, released)
  expect(closed.tree.entries).toEqual(records)
  expect(closed.tree.hasName).toBe(true)
  expect(() => verifyNativeSwitchTarget(closed, f.write({ entries: records, leaf: 'clear', revision: 6 }))).not.toThrow()
})

const changes = [
  { name: 'native identity', options: { nativeSessionId: 'other-native' } },
  { name: 'conversation identity', options: { conversationId: 2 } },
  { name: 'older revision', options: { revision: 3 } },
  { name: 'known product mapping', options: { productId: 'changed-root' } },
]
for (const change of changes) test(`switch rejects a released target with changed ${change.name}`, () => {
  const f = fixture()
  const prepared = prepareNativeSwitchProof(f.identity)
  expect(() => closeNativeSwitchProof(prepared, f.write(change.options))).toThrow()
})

test('switch rejects removed or rewritten inactive history after release', () => {
  const f = fixture()
  const prepared = prepareNativeSwitchProof(f.identity)
  expect(() => closeNativeSwitchProof(prepared, f.write({ entries: f.entries.slice(0, 2) }))).toThrow()
  expect(() => closeNativeSwitchProof(prepared, f.write({
    entries: f.entries.map(row => row.id === 'right' ? { ...row, message: { role: 'user', content: 'forged' } } : row),
  }))).toThrow()
})

test('switch binding rejects a different leaf, name or inactive branch', () => {
  const f = fixture()
  const closed = closeNativeSwitchProof(prepareNativeSwitchProof(f.identity), f.identity)
  expect(() => verifyNativeSwitchTarget(closed, f.write({ leaf: 'right' }))).toThrow()
  expect(() => verifyNativeSwitchTarget(closed, f.write({
    entries: [...f.entries, { id: 'name', parentId: 'left', type: 'session_info', timestamp: '2026-11-05', name: 'changed' }],
  }))).toThrow()
  expect(() => verifyNativeSwitchTarget(closed, f.write({
    entries: f.entries.map(row => row.id === 'right' ? { ...row, message: { role: 'user', content: 'forged' } } : row),
  }))).toThrow()
})
