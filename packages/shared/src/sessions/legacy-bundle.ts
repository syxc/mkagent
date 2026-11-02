import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoHistorySecrets, redactHistory, type Json } from './durable-bundle.ts'
import { mapLegacyRecords, type ModelValueMapper } from './model-history-paths.ts'
import { MAX_BUNDLE_SIZE_BYTES, type BundleFile } from '../utils/bundle-files.ts'

type RecordValue = { [key: string]: Json }
const ENTRY_TYPES = new Set([
  'message', 'compaction', 'context_edit', 'branch_summary', 'custom_message',
  'usage', 'label', 'custom', 'session_info', 'thinking_level_change', 'model_change',
])
const object = (value: Json | undefined): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function content(value: Json | undefined, role = 'user', allowString = role === 'user' || role === 'system'): boolean {
  if (typeof value === 'string') return allowString
  return Array.isArray(value) && value.every(block => {
    if (!object(block)) return false
    if (block.type === 'text') return typeof block.text === 'string'
    if (block.type === 'image') return (role === 'user' || role === 'toolResult')
      && typeof block.data === 'string' && typeof block.mimeType === 'string'
    if (block.type === 'thinking') return role === 'assistant' && typeof block.thinking === 'string'
    if (block.type === 'toolCall') return role === 'assistant' && typeof block.id === 'string'
      && typeof block.name === 'string' && object(block.arguments)
    return false
  })
}

function validateRecords(values: Json[]): void {
  const header = values[0]
  if (!object(header) || header.type !== 'session' || typeof header.id !== 'string'
    || ![1, 2, 3].includes(header.version as number)) throw new Error('Invalid legacy session header')
  const entries = new Map<string, RecordValue>()
  for (const value of values.slice(1)) {
    if (!object(value) || typeof value.type !== 'string' || !ENTRY_TYPES.has(value.type)
      || typeof value.id !== 'string' || !value.id || entries.has(value.id)
      || (value.parentId != null && typeof value.parentId !== 'string')) throw new Error('Invalid legacy session entry')
    if (value.type === 'message') {
      const message = value.message
      if (!object(message) || !['user', 'assistant', 'system', 'toolResult', 'bashExecution', 'custom'].includes(String(message.role))
        || (!['bashExecution', 'custom'].includes(String(message.role)) && !content(message.content, String(message.role)))) throw new Error('Invalid legacy message')
      if (message.role === 'toolResult' && (typeof message.toolCallId !== 'string' || typeof message.toolName !== 'string')) {
        throw new Error('Invalid legacy tool result')
      }
    }
    if (value.type === 'compaction' || value.type === 'branch_summary') {
      if (typeof value.summary !== 'string') throw new Error('Invalid legacy summary')
      if (value.firstKeptEntryId != null && (typeof value.firstKeptEntryId !== 'string' || !entries.has(value.firstKeptEntryId))) {
        throw new Error('Invalid legacy compaction anchor')
      }
      if (value.systemMessage !== undefined && (!object(value.systemMessage) || value.systemMessage.role !== 'system'
        || !content(value.systemMessage.content, 'system'))) throw new Error('Invalid legacy system message')
    }
    if (value.type === 'custom_message' && !content(value.content)) throw new Error('Invalid legacy custom message')
    if (value.type === 'context_edit') {
      const target = typeof value.targetId === 'string' ? entries.get(value.targetId) : undefined
      const role = target && object(target.message) ? String(target.message.role) : 'user'
      if (!target || (value.replacement !== null && (!object(value.replacement)
        || !content(value.replacement.content, role, true)))) throw new Error('Invalid legacy context edit')
    }
    entries.set(value.id, value)
  }
  const checked = new Set<string>()
  for (const id of entries.keys()) {
    const path = new Set<string>()
    let current: string | null = id
    while (current && !checked.has(current)) {
      if (path.has(current)) throw new Error('Legacy session has a parent cycle')
      const entry = entries.get(current)
      if (!entry) throw new Error('Legacy session parent not found')
      path.add(current)
      current = entry.parentId as string | null ?? null
    }
    for (const item of path) checked.add(item)
  }
}

/** Export one validated transcript; first open performs the existing durable migration. */
export function collectLegacyBundle(directory: string, secrets: Set<string>, map: ModelValueMapper = value => value): BundleFile[] {
  const root = lstatSync(directory, { throwIfNoEntry: false })
  if (!root) return []
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Legacy history must be a directory, not a symlink')
  const names = readdirSync(directory).filter(name => name.endsWith('.jsonl'))
  const files = names.map(name => {
    const stat = lstatSync(join(directory, name))
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Legacy transcript must be a regular file, not a symlink')
    return { name, stat }
  })
  const latest = files.reduce<(typeof files)[number] | undefined>((best, file) =>
    !best || file.stat.mtimeMs > best.stat.mtimeMs ? file : best, undefined)
  if (!latest) return []
  if (latest.stat.size > MAX_BUNDLE_SIZE_BYTES) throw new Error('Legacy history exceeds bundle size limit')
  const path = join(directory, latest.name)
  const original = readFileSync(path, 'utf8')
  if (!original.endsWith('\n')) throw new Error('Incomplete legacy JSONL record')
  const records = original.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Json)
  validateRecords(records)
  const mapped = mapLegacyRecords(redactHistory(records, secrets), map)
  assertNoHistorySecrets(mapped, secrets)
  const output = mapped.map(record => JSON.stringify(record)).join('\n') + '\n'
  const afterRoot = lstatSync(directory)
  if (afterRoot.isSymbolicLink() || !afterRoot.isDirectory() || afterRoot.ino !== root.ino || afterRoot.dev !== root.dev
    || readdirSync(directory).filter(name => name.endsWith('.jsonl')).join('\0') !== names.join('\0')) {
    throw new Error('Legacy history changed during export')
  }
  for (const file of files) {
    const after = lstatSync(join(directory, file.name))
    if (!after.isFile() || after.isSymbolicLink() || after.ino !== file.stat.ino || after.dev !== file.stat.dev
      || after.mtimeMs !== file.stat.mtimeMs || after.size !== file.stat.size) throw new Error('Legacy history changed during export')
  }
  if (readFileSync(path, 'utf8') !== original) throw new Error('Legacy history changed during export')
  const bytes = Buffer.from(output)
  return [{ relativePath: '.pi-sessions/legacy.jsonl', contentBase64: bytes.toString('base64'), size: bytes.length }]
}
