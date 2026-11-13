import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeNativeUserHistory } from './native-user-history'
import { partitionNativeProductHistory } from '../../../shared/src/sessions/native-product-history'
import type { NativeSourceEntry } from './native-session-source'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const workspace = () => { const root = mkdtempSync(join(tmpdir(), 'native-user-history-')); roots.push(root); return root }
const image = { type: 'image', mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==' }
function input(id: string, content: unknown, parentId: string | null = null): NativeSourceEntry {
  return { id, type: 'message', parentId, timestamp: new Date(1).toISOString(),
    message: { role: 'user', hostMessageId: `native-user-${id}`, content: 'transformed model input',
      hostUserInput: { version: 1, content }, timestamp: 1 } }
}
function tree(entries: NativeSourceEntry[]) {
  return { entries, entryIds: entries.map((entry, durableId) => ({
    nativeId: entry.id, productMessageId: `native-user-${entry.id}`, durableId,
  })), leaf: entries.at(-1)?.id ?? null }
}

test('materializes only explicit committed plugin input and preserves raw multiline content', () => {
  const root = workspace()
  const native = tree([input('one', '第一行\nsecond line'), input('two', '第一行\nsecond line', 'one')])
  native.entries.push({ id: 'legacy', parentId: 'two', type: 'message', timestamp: new Date(1).toISOString(),
    message: { role: 'user', content: 'unlinked legacy input', timestamp: 1 } })
  const rows = materializeNativeUserHistory(native, root, 'session', [])
  expect(rows.map(row => [row.id, row.content])).toEqual([
    ['native-user-one', '第一行\nsecond line'], ['native-user-two', '第一行\nsecond line'],
  ])
  expect(materializeNativeUserHistory(native, root, 'session', rows)).toEqual([])
  native.entryIds[0]!.productMessageId = 'other'
  expect(() => materializeNativeUserHistory(native, root, 'session', [])).toThrow('committed identity')
})

test('stores image-only and multi-image input with stable files and validates bytes on retry', () => {
  const root = workspace()
  const native = tree([input('images', [image, image])])
  const rows = materializeNativeUserHistory(native, root, 'session', [])
  expect(rows[0]!.content).toBe('')
  const attachments = rows[0]!.attachments!
  expect(attachments).toHaveLength(2)
  expect(attachments[0]!.id).not.toBe(attachments[1]!.id)
  for (const attachment of attachments) {
    const bytes = readFileSync(attachment.storedPath)
    expect(bytes.toString('base64')).toBe(image.data)
    expect(attachment.size).toBe(bytes.length)
  }
  expect(materializeNativeUserHistory(native, root, 'session', [])).toEqual(rows)
  unlinkSync(attachments[0]!.storedPath)
  expect(materializeNativeUserHistory(native, root, 'session', rows)).toEqual([])
  expect(readFileSync(attachments[0]!.storedPath).toString('base64')).toBe(image.data)
  writeFileSync(attachments[0]!.storedPath, 'different bytes')
  expect(() => materializeNativeUserHistory(native, root, 'session', rows)).toThrow('committed bytes')
  unlinkSync(attachments[0]!.storedPath)
  symlinkSync(attachments[1]!.storedPath, attachments[0]!.storedPath)
  expect(() => materializeNativeUserHistory(native, root, 'session', rows)).toThrow('regular file')
})

test('equivalent workspace spellings preserve native image paths and retry identity', () => {
  const root = workspace()
  const native = tree([input('image', [image])])
  const rows = materializeNativeUserHistory(native, root, 'session', [])
  expect(readFileSync(rows[0]!.attachments![0]!.storedPath).toString('base64')).toBe(image.data)
  for (const suffix of ['/', '//', '/.']) {
    expect(materializeNativeUserHistory(native, root + suffix, 'session', [])).toEqual(rows)
    expect(materializeNativeUserHistory(native, root + suffix, 'session', rows)).toEqual([])
  }
})

test('inserts late plugin rows before their native successor, preserves other row order and archives branches', () => {
  const root = workspace()
  const native = tree([input('one', 'same'), input('two', 'same', 'one')])
  native.entries.push({ id: 'answer', type: 'message', parentId: 'two', timestamp: new Date(1).toISOString() })
  native.entryIds.push({ nativeId: 'answer', productMessageId: 'answer', durableId: 2 })
  native.leaf = 'answer'
  const existing = [
    { id: 'notice', type: 'info' as const, content: 'keep before answer', nativeHistory: { order: 0, anchor: null } },
    { id: 'answer', type: 'assistant' as const, content: 'reply', nativeHistory: { order: 1 } },
    { id: 'after', type: 'info' as const, content: 'keep after answer', nativeHistory: { order: 2, anchor: null } },
  ]
  const options = { sourceSessionId: 'session', targetSessionId: 'session', leaf: 'answer',
    additionalMessages: materializeNativeUserHistory(native, root, 'session', existing) }
  const merged = partitionNativeProductHistory({ messages: existing }, native, options)
  expect(merged.messages.map(row => row.id)).toEqual(['notice', 'native-user-one', 'native-user-two', 'answer', 'after'])
  expect(merged.messages.map(row => row.nativeHistory!.order)).toEqual([0, 1, 2, 3, 4])
  const previous = partitionNativeProductHistory(merged, native, { ...options, additionalMessages: [], leaf: 'one' })
  expect(previous.messages.map(row => row.id)).toEqual(['notice', 'native-user-one', 'after'])
  expect(previous.nativeArchivedMessages.map(row => row.id)).toEqual(['native-user-two', 'answer'])
  expect(partitionNativeProductHistory(previous, native, { ...options, additionalMessages: [] })).toEqual(merged)
})
