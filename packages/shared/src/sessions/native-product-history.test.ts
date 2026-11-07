import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { partitionNativeProductHistory, type NativeProductTree } from './native-product-history'
import { createSessionHeader, readSessionJsonl, readSessionMessages, serializeSessionMessages, writeSessionJsonl } from './jsonl'
import { sessionPersistenceQueue, canUpdateSdkCwd } from './storage'
import { serializeSession, validateBundle } from './bundle'
import { importNativeArchivedMessages, importSessionMessages, restoreSessionBundleFiles } from './session-files'
import type { StoredSession, StoredMessage } from './types'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const message = (id: string, type: StoredMessage['type'] = 'user'): StoredMessage => ({ id, type, content: 'same', timestamp: 1 })
function tree(): NativeProductTree {
  return {
    leaf: 'result',
    entries: [
      { id: 'root', parentId: null, type: 'message' },
      { id: 'answer', parentId: 'root', type: 'message' },
      { id: 'left', parentId: 'answer', type: 'message' },
      { id: 'call', parentId: 'left', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'exact-call' }] } },
      { id: 'result', parentId: 'call', type: 'message', message: { role: 'toolResult', toolCallId: 'exact-call' } },
      { id: 'right', parentId: 'answer', type: 'message' },
      { id: 'right-answer', parentId: 'right', type: 'message' },
    ],
    entryIds: [
      { nativeId: 'root', productMessageId: 'm-root' }, { nativeId: 'answer', productMessageId: 'm-answer' },
      { nativeId: 'left', productMessageId: 'm-left' }, { nativeId: 'call', productMessageId: 'm-answer' },
      { nativeId: 'right', productMessageId: 'm-right' }, { nativeId: 'right-answer', productMessageId: 'm-right-answer' },
    ],
  }
}
function history() {
  return { messages: [
    message('m-root'), message('m-answer', 'assistant'), message('m-left'),
    { ...message('m-tool', 'tool'), toolUseId: 'exact-call', toolIntent: 'Keep rich tool metadata' },
    message('m-right'), message('m-right-answer', 'assistant'), message('m-error', 'error'),
    message('m-control'), { ...message('m-queued'), isQueued: true },
  ] }
}
const ids = (rows: StoredMessage[]) => rows.map(row => row.id)
const options = { sourceSessionId: 'source', targetSessionId: 'target', leaf: 'right-answer',
  sourceOnlyMessageIds: new Set(['m-control']) }

test('partitions a full product tree by exact IDs and restores metadata and stable order after navigation', () => {
  const original = history()
  const right = partitionNativeProductHistory(original, tree(), options)
  expect(ids(right.messages)).toEqual(['m-root', 'm-answer', 'm-right', 'm-right-answer'])
  expect(original.messages.every(row => row.nativeHistory === undefined)).toBe(true)
  expect(right.nativeArchivedMessages.find(row => row.id === 'm-control')?.nativeHistory).toMatchObject({ sourceSessionId: 'source', anchor: 'result' })
  const left = partitionNativeProductHistory(right, tree(), { ...options, leaf: 'result' })
  expect(ids(left.messages)).toEqual(['m-root', 'm-answer', 'm-left', 'm-tool', 'm-error'])
  expect(left.messages.find(row => row.id === 'm-tool')?.toolIntent).toBe('Keep rich tool metadata')
  const again = partitionNativeProductHistory(left, tree(), options)
  expect(again).toEqual(right)
  const source = partitionNativeProductHistory(left, tree(), { ...options, targetSessionId: 'source', leaf: null })
  expect(ids(source.messages)).toEqual(['m-queued'])
})

test('consumed queued input becomes shared history only after its native identity commits', () => {
  const pending = partitionNativeProductHistory(history(), tree(), { ...options, targetSessionId: 'source', leaf: 'result' })
  expect(pending.messages.find(row => row.id === 'm-queued')?.nativeHistory?.sourceSessionId).toBe('source')
  const before = partitionNativeProductHistory(pending, tree(), options)
  expect(ids(before.nativeArchivedMessages)).toContain('m-queued')
  const consumed = tree()
  consumed.entries = [...consumed.entries, { id: 'accepted', parentId: 'result', type: 'message' }]
  consumed.entryIds = [...consumed.entryIds, { nativeId: 'accepted', productMessageId: 'm-queued' }]
  consumed.leaf = 'accepted'
  pending.messages.find(row => row.id === 'm-queued')!.isQueued = false
  const fork = partitionNativeProductHistory(pending, consumed, { ...options, leaf: 'accepted' })
  expect(ids(fork.messages)).toContain('m-queued')
  expect(fork.messages.find(row => row.id === 'm-queued')?.nativeHistory?.sourceSessionId).toBeUndefined()
})

test('keeps roots explicit, does not infer tool identity from display aliases or ambiguous calls', () => {
  const empty = partitionNativeProductHistory({ messages: [message('root-info', 'info')] }, { entries: [], entryIds: [], leaf: null },
    { sourceSessionId: 'source', targetSessionId: 'target', leaf: null })
  expect(empty.messages[0]?.nativeHistory?.anchor).toBeNull()
  const input = history()
  input.messages[3]!.toolUseId = 'exact-call|display-alias'
  const call = partitionNativeProductHistory(input, tree(), { ...options, leaf: 'call' })
  expect(ids(call.messages)).not.toContain('m-tool')
  const ambiguous = tree()
  ambiguous.entries = [...ambiguous.entries, { id: 'other-call', parentId: 'right', type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 'exact-call' }] } }]
  const result = partitionNativeProductHistory(history(), ambiguous, { ...options, leaf: 'call' })
  expect(result.nativeArchivedMessages.find(row => row.id === 'm-tool')?.nativeHistory?.anchor).toBe('result')
})

test.each(['multiple results', 'duplicate call parts', 'exact product association'])('tool identity stays conservative with %s', variant => {
  expect(ids(partitionNativeProductHistory(history(), tree(), { ...options, leaf: 'result' }).messages)).toContain('m-tool')
  const native = tree()
  if (variant === 'duplicate call parts') {
    native.entries = native.entries.map(entry => entry.id !== 'call' ? entry : { ...entry,
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'exact-call' }, { type: 'toolCall', id: 'exact-call' }] } })
    native.leaf = 'right-answer'
  } else {
    native.entries = [...native.entries, { id: 'other-result', parentId: 'call', type: 'message',
      message: { role: 'toolResult', toolCallId: 'exact-call', content: [{ type: 'text', text: 'later result' }] } }]
    native.leaf = 'other-result'
    if (variant === 'exact product association') {
      native.entryIds = [...native.entryIds, { nativeId: 'other-result', productMessageId: 'm-tool' }]
    }
  }
  const input = history()
  input.messages[3]!.content = 'later result display metadata'
  const earlier = partitionNativeProductHistory(input, native, { ...options, leaf: 'result' })
  expect(ids(earlier.messages)).not.toContain('m-tool')
  const current = partitionNativeProductHistory(earlier, native, { ...options, leaf: native.leaf })
  expect(ids(current.messages)).toContain('m-tool')
})

test('rejects conflicting IDs, invalid order and unknown native anchors without changing input', () => {
  expect(() => partitionNativeProductHistory({ messages: [message('same-id')],
    nativeArchivedMessages: [{ ...message('same-id'), content: 'different' }] }, tree(), options)).toThrow('Conflicting')
  expect(() => partitionNativeProductHistory({ messages: [{ ...message('bad'), nativeHistory: { order: -1 } }] }, tree(), options)).toThrow('Invalid')
  expect(() => partitionNativeProductHistory({ messages: [{ ...message('bad'), nativeHistory: { order: 0, anchor: 'missing' } }] }, tree(), options)).toThrow('anchor')
  expect(() => partitionNativeProductHistory(history(), tree(), { ...options, leaf: 'missing' })).toThrow('leaf')
})

function fixture(): { stored: StoredSession; file: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'native-product-history-'))
  roots.push(root)
  const path = join(root, 'sessions', '260101-native-history')
  mkdirSync(join(path, 'attachments'), { recursive: true })
  writeFileSync(join(path, 'attachments', 'inactive.md'), 'inactive product attachment')
  const stored: StoredSession = { id: '260101-native-history', workspaceRootPath: root, createdAt: 1, lastUsedAt: 1,
    ...partitionNativeProductHistory(history(), tree(), options),
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } }
  stored.nativeArchivedMessages![0]!.planPath = join(path, 'attachments', 'inactive.md')
  return { stored, path, file: join(path, 'session.jsonl') }
}

test('sync and queue writers preserve archives, portable paths and active-only header metadata', async () => {
  const f = fixture()
  writeSessionJsonl(f.file, f.stored)
  const first = readSessionJsonl(f.file)!
  expect(first.nativeArchivedMessages).toEqual(f.stored.nativeArchivedMessages)
  expect(readSessionMessages(f.file)).toEqual(f.stored.messages)
  expect(first.nativeArchivedMessages?.[0]).not.toHaveProperty('nativeArchived')
  expect(readFileSync(f.file, 'utf8')).toContain('{{SESSION_PATH}}/attachments/inactive.md')
  const header = createSessionHeader(first)
  expect(header.messageCount).toBe(4)
  expect(header.lastFinalMessageId).toBe('m-right-answer')
  expect(header).not.toHaveProperty('nativeArchivedMessages')
  expect(canUpdateSdkCwd({ ...first, messages: [], sdkSessionId: undefined })).toBe(false)
  await sessionPersistenceQueue.persist({ ...first, name: 'metadata changed' })
  const after = readSessionJsonl(f.file)!
  expect(after.name).toBe('metadata changed')
  expect(after.nativeArchivedMessages).toEqual(first.nativeArchivedMessages)
  const reserved = JSON.parse(serializeSessionMessages({ messages: [{ ...message('marker'), nativeArchived: true } as StoredMessage] }, dirname(f.file))[0]!)
  expect(reserved).not.toHaveProperty('nativeArchived')
})

test('bundles use version 2 for native history and retain both partitions and paths while v1 remains valid', () => {
  const f = fixture()
  writeSessionJsonl(f.file, f.stored)
  const bundle = serializeSession(f.stored.workspaceRootPath, f.stored.id)!
  expect(bundle.version).toBe(2)
  expect(validateBundle(bundle)).toBe(true)
  expect(validateBundle({ ...bundle, version: 1 })).toBe(false)
  const target = join(roots[0]!, 'target')
  expect(importSessionMessages(bundle, target)).toEqual(f.stored.messages)
  expect(importNativeArchivedMessages(bundle, target)?.[0]?.planPath).toBe(join(target, 'attachments', 'inactive.md'))
  restoreSessionBundleFiles(bundle, target)
  expect(readFileSync(join(target, 'attachments', 'inactive.md'), 'utf8')).toBe('inactive product attachment')
  writeSessionJsonl(f.file, { ...f.stored, messages: [message('ordinary')], nativeArchivedMessages: undefined })
  const ordinary = serializeSession(f.stored.workspaceRootPath, f.stored.id)!
  expect(ordinary.version).toBe(1)
  expect(validateBundle(ordinary)).toBe(true)
})
