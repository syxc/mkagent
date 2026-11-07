import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeSessionReference } from '@mkagent/shared/sessions'
import { nativeForkPlan, readTrustedNativeSession } from './native-session-source'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const workspaceRootPath = mkdtempSync(join(tmpdir(), 'native-source-'))
  roots.push(workspaceRootPath)
  const sessionId = 'test-session'
  const session = join(workspaceRootPath, 'sessions', sessionId)
  mkdirSync(join(session, 'native-session'), { recursive: true })
  mkdirSync(join(session, 'meta'))
  const sessionFile = join(session, 'native-session', 'session.jsonl')
  const manifestFile = join(session, 'meta', 'native-session.json')
  const header = { type: 'session', version: 3, id: 'native-id', timestamp: '2026-11-05T00:00:00Z', cwd: workspaceRootPath }
  const entries = [
    { type: 'message', id: 'root', parentId: null, timestamp: header.timestamp, message: { role: 'user', content: 'root' } },
    { type: 'message', id: 'left', parentId: 'root', timestamp: header.timestamp, message: { role: 'user', content: [
      { type: 'text', text: 'same ' }, { type: 'image', data: 'fixture' }, { type: 'text', text: 'text' },
    ] } },
    { type: 'label', id: 'label', parentId: 'left', timestamp: header.timestamp, targetId: 'left', label: 'left branch' },
    { type: 'message', id: 'right', parentId: 'root', timestamp: header.timestamp, message: { role: 'user', content: 'same text' } },
    { type: 'session_info', id: 'name', parentId: 'right', timestamp: header.timestamp, name: '' },
  ]
  const entryIds = entries.map((entry, index) => ({ nativeId: entry.id, durableId: index + 1, productMessageId: `product-${entry.id}` }))
  const write = (records: unknown[] = entries, links: unknown[] = entryIds, leaf: string | null = 'left'): NativeSessionReference => {
    const jsonl = [header, ...records].map(value => JSON.stringify(value)).join('\n') + '\n'
    const manifest = { version: 1 as const, sessionId, nativeSessionId: header.id, conversationId: 1,
      revision: 4, sessionFile, leaf, name: null, digest: hash(jsonl), entryIds: links }
    const metadata = JSON.stringify(manifest) + '\n'
    writeFileSync(sessionFile, jsonl)
    writeFileSync(manifestFile, metadata)
    const { entryIds: _links, ...reference } = manifest
    return { ...reference, manifestDigest: hash(metadata) }
  }
  const reference = write()
  const options = { workspaceRootPath, sessionId, nativeSessionId: header.id, reference }
  return { options, session, sessionFile, manifestFile, entries, entryIds, write }
}

test('reads the full tree without changing files and derives exact native fork identities', () => {
  const f = fixture()
  const bytes = readFileSync(f.sessionFile)
  const before = lstatSync(f.sessionFile)
  const source = readTrustedNativeSession(f.options)
  expect(source.entries).toEqual(f.entries)
  expect(source.hasName).toBe(true)
  expect(source.reference.leaf).toBe('left')
  expect(nativeForkPlan(source, 'left', 'before')).toEqual({ nativeLeafId: 'root', durableEntryId: 1, selectedText: 'same text' })
  expect(nativeForkPlan(source, 'right', 'before')).toEqual({ nativeLeafId: 'root', durableEntryId: 1, selectedText: 'same text' })
  expect(nativeForkPlan(source, 'label', 'at')).toEqual({ nativeLeafId: 'label', durableEntryId: 3 })
  expect(nativeForkPlan(source, 'root', 'before')).toEqual({ nativeLeafId: null, durableEntryId: null, selectedText: 'root' })
  expect(nativeForkPlan(source, null, 'at')).toEqual({ nativeLeafId: null, durableEntryId: null })
  expect(() => nativeForkPlan(source, 'label', 'before')).toThrow('user entry')
  expect(readFileSync(f.sessionFile)).toEqual(bytes)
  expect(lstatSync(f.sessionFile).mtimeMs).toBe(before.mtimeMs)
})

for (const field of ['digest', 'manifestDigest', 'nativeSessionId', 'sessionId', 'sessionFile', 'revision', 'leaf', 'name'] as const) {
  test(`rejects a product reference with a mismatched ${field}`, () => {
    const f = fixture()
    const reference = { ...f.options.reference, [field]: field === 'revision' ? 8 : field.endsWith('igest') ? '0'.repeat(64) : 'different' }
    expect(() => readTrustedNativeSession({ ...f.options, reference })).toThrow()
  })
}

for (const part of ['sessions', 'session', 'native-session', 'meta', 'jsonl', 'manifest']) {
  test(`rejects a symlink at ${part}`, () => {
    const f = fixture()
    const path = part === 'sessions' ? join(f.options.workspaceRootPath, 'sessions')
      : part === 'session' ? f.session : part === 'jsonl' ? f.sessionFile
        : part === 'manifest' ? f.manifestFile : join(f.session, part)
    const original = path + '.original'
    renameSync(path, original)
    symlinkSync(original, path)
    expect(() => readTrustedNativeSession(f.options)).toThrow()
  })
}

for (const corruption of ['duplicate', 'missing-parent', 'mapping', 'truncated', 'header']) {
  test(`rejects ${corruption} even when the supplied reference matches its hashes`, () => {
    const f = fixture()
    const records: unknown[] = [...f.entries]
    const links = [...f.entryIds]
    if (corruption === 'duplicate') records.push(f.entries[0])
    if (corruption === 'missing-parent') records[1] = { ...f.entries[1], parentId: 'absent' }
    if (corruption === 'mapping') links[1] = { ...links[1]!, nativeId: 'wrong' }
    const reference = f.write(records, links)
    if (corruption === 'truncated' || corruption === 'header') {
      const jsonl = readFileSync(f.sessionFile, 'utf8')
      const changed = corruption === 'truncated' ? jsonl.slice(0, -1) : jsonl.replace('"native-id"', '"wrong-id"')
      writeFileSync(f.sessionFile, changed)
      reference.digest = hash(changed)
      const metadata = JSON.parse(readFileSync(f.manifestFile, 'utf8'))
      metadata.digest = reference.digest
      const content = JSON.stringify(metadata) + '\n'
      writeFileSync(f.manifestFile, content)
      reference.manifestDigest = hash(content)
    }
    expect(() => readTrustedNativeSession({ ...f.options, reference })).toThrow()
  })
}

test('accepts a committed empty tree and distinguishes an absent name from a clear', () => {
  const f = fixture()
  const reference = f.write([], [], null)
  const source = readTrustedNativeSession({ ...f.options, reference })
  expect(source.entries).toEqual([])
  expect(source.hasName).toBe(false)
  expect(nativeForkPlan(source, null, 'at')).toEqual({ nativeLeafId: null, durableEntryId: null })
})
