import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remapSessionFileReferences } from '@mkagent/shared/sessions'
import type { PiNativeOwnerRequest } from '../../../shared/src/agent/backend/pi/native-owner-protocol'
import { closeNativeForkProof, prepareNativeForkProof, verifyNativeForkTarget } from './native-session-fork'
import type { NativeSourceEntry } from './native-session-source'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

function fixture() {
  const workspaceRootPath = mkdtempSync(join(tmpdir(), 'product-fork-proof-'))
  roots.push(workspaceRootPath)
  const sourcePath = join(workspaceRootPath, 'sessions', 'source')
  const entries: NativeSourceEntry[] = [
    { id: 'root', parentId: null, type: 'message', timestamp: '2026-11-05',
      message: { role: 'user', content: 'root' } },
    { id: 'left', parentId: 'root', type: 'message', timestamp: '2026-11-05',
      message: { role: 'user', content: 'same text' } },
    { id: 'right', parentId: 'root', type: 'message', timestamp: '2026-11-05',
      message: { role: 'user', content: 'same text' }, file: join(sourcePath, 'attachments', 'inactive.md') },
    { id: 'label', parentId: 'right', type: 'label', timestamp: '2026-11-05', targetId: 'right', label: 'inactive' },
  ]
  const links = entries.map((entry, index) => ({ nativeId: entry.id, durableId: index + 1, productMessageId: `p-${entry.id}` }))
  const write = (sessionId = 'source', options: {
    entries?: NativeSourceEntry[]; links?: typeof links; leaf?: string | null; revision?: number;
    nativeId?: string; conversationId?: number; parentSession?: string;
  } = {}) => {
    const sessionPath = join(workspaceRootPath, 'sessions', sessionId)
    mkdirSync(join(sessionPath, 'native-session'), { recursive: true })
    mkdirSync(join(sessionPath, 'meta'), { recursive: true })
    const records = options.entries ?? entries
    const nativeSessionId = options.nativeId ?? `native-${sessionId}`
    const header = { type: 'session', version: 3, id: nativeSessionId, cwd: workspaceRootPath, timestamp: '2026-11-05',
      ...(options.parentSession ? { parentSession: options.parentSession } : {}) }
    const sessionFile = join(sessionPath, 'native-session', 'session.jsonl')
    const body = [header, ...records].map(row => JSON.stringify(row)).join('\n') + '\n'
    const lastName = records.findLast(row => row.type === 'session_info')?.name
    const name = typeof lastName === 'string' ? lastName.trim() || null : null
    const manifest = { version: 1 as const, sessionId, nativeSessionId, sessionFile,
      conversationId: options.conversationId ?? 1, revision: options.revision ?? 4,
      leaf: options.leaf === undefined ? 'left' : options.leaf, name, digest: hash(body), entryIds: options.links ?? links }
    const metadata = JSON.stringify(manifest) + '\n'
    writeFileSync(sessionFile, body)
    writeFileSync(join(sessionPath, 'meta', 'native-session.json'), metadata)
    const { entryIds: _links, ...reference } = manifest
    return { workspaceRootPath, sessionId, nativeSessionId, reference: { ...reference, manifestDigest: hash(metadata) } }
  }
  const identity = write()
  const request: PiNativeOwnerRequest = { sourceNativeSessionId: identity.nativeSessionId,
    sourceReference: identity.reference, inputId: 'command-input',
    operation: { type: 'fork', entryId: 'left', position: 'before' },
    fork: { nativeLeafId: 'root', durableEntryId: 1, selectedText: 'same text' } }
  return { workspaceRootPath, sourcePath, entries, links, write, identity, request }
}

test('derives before-null and nonactive metadata-at anchors independently', () => {
  const f = fixture()
  const root = prepareNativeForkProof(f.identity, { ...f.request,
    operation: { type: 'fork', entryId: 'root', position: 'before' },
    fork: { nativeLeafId: null, durableEntryId: null, selectedText: 'root' } })
  expect(root.record).toMatchObject({ nativeLeafId: null, durableEntryId: null, inputId: 'command-input' })
  const label = prepareNativeForkProof(f.identity, { ...f.request,
    operation: { type: 'fork', entryId: 'label', position: 'at' }, fork: { nativeLeafId: 'label', durableEntryId: 4 } })
  expect(label.record.nativeLeafId).toBe('label')
  expect(label.tree.reference.leaf).toBe('left')
})

for (const forged of ['nativeLeafId', 'durableEntryId', 'selectedText'] as const) {
  test(`rejects a forged ${forged} before source close`, () => {
    const f = fixture()
    const fork = { ...f.request.fork!, [forged]: forged === 'durableEntryId' ? 99 : 'forged' }
    expect(() => prepareNativeForkProof(f.identity, { ...f.request, fork })).toThrow('anchor')
  })
}

test('accepts shutdown appends and cleared names while retaining the prepared leaf and mapping', () => {
  const f = fixture()
  const prepared = prepareNativeForkProof(f.identity, f.request)
  const entries = [...f.entries, { id: 'shutdown-name', parentId: 'left', type: 'session_info', timestamp: '2026-11-05', name: '' }]
  const links = [...f.links, { nativeId: 'shutdown-name', durableId: 5, productMessageId: 'shutdown-product' }]
  const closed = closeNativeForkProof(prepared, f.write('source', { entries, links, leaf: 'shutdown-name', revision: 5 }))
  expect(closed.record.nativeLeafId).toBe('root')
  expect(closed.tree.hasName).toBe(true)
  expect(closed.record.source.name).toBeNull()
  expect(closed.tree.entries).toHaveLength(5)
  const targetPath = join(f.workspaceRootPath, 'sessions', 'target')
  const target = f.write('target', { entries: remapSessionFileReferences(entries, f.sourcePath, targetPath), links,
    leaf: 'root', conversationId: 2, revision: 6, parentSession: closed.record.source.sessionFile })
  expect(() => verifyNativeForkTarget(closed, target)).not.toThrow()
})

for (const changed of ['content', 'mapping', 'conversation', 'revision'] as const) {
  test(`rejects a closed source that replaces prepared ${changed}`, () => {
    const f = fixture()
    const proof = prepareNativeForkProof(f.identity, f.request)
    const entries = structuredClone(f.entries)
    const links = structuredClone(f.links)
    if (changed === 'content') entries[1]!.message = { role: 'user', content: 'replaced' }
    if (changed === 'mapping') links[0]!.durableId = 99
    const identity = f.write('source', { entries, links,
      conversationId: changed === 'conversation' ? 2 : 1, revision: changed === 'revision' ? 3 : 5 })
    expect(() => closeNativeForkProof(proof, identity)).toThrow('prepared')
  })
}

for (const changed of ['identity', 'conversation', 'revision', 'parent', 'leaf', 'mapping', 'inactive', 'paths'] as const) {
  test(`rejects a bound target with mismatched ${changed}`, () => {
    const f = fixture()
    const proof = prepareNativeForkProof(f.identity, f.request)
    const targetPath = join(f.workspaceRootPath, 'sessions', 'target')
    const entries = changed === 'paths' ? structuredClone(f.entries)
      : remapSessionFileReferences(f.entries, f.sourcePath, targetPath)
    const links = structuredClone(f.links)
    if (changed === 'inactive') { entries.pop(); links.pop() }
    if (changed === 'mapping') links[0]!.durableId = 99
    const identity = f.write('target', { entries, links, nativeId: changed === 'identity' ? f.identity.nativeSessionId : undefined,
      conversationId: changed === 'conversation' ? 1 : 2, revision: changed === 'revision' ? 4 : 5,
      parentSession: changed === 'parent' ? '/foreign/session.jsonl' : f.identity.reference.sessionFile,
      leaf: changed === 'leaf' ? 'right' : 'root' })
    expect(() => verifyNativeForkTarget(proof, identity)).toThrow('target')
  })
}
