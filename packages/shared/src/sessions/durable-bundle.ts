import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redactBrowserPasswordFills } from '../agent/browser-tool-redaction.ts'
import { isCanonicalBrowserToolName } from '../agent/browser-tool-names.ts'
import { BROWSER_INPUT_EVIDENCE, browserInputClassifications, redactBrowserInputEvidence, type BrowserInputClassification } from '../agent/browser-input-evidence.ts'
import { PASSWORD_FILL_MARKER, PASSWORD_TEXT_MARKER, splitBatchCommands, tokenizeCommand } from '../agent/browser-tool-runtime.ts'
import type { BundleFile } from '../utils/bundle-files.ts'
import { mapDurableCommits, mapDurableEntry, type ModelValueMapper } from './model-history-paths.ts'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type ObjectValue = { [key: string]: Json }
type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): { all(...args: (string | number)[]): unknown[]; run(...args: (string | number)[]): unknown }
  close(): void
}

function isObject(value: unknown): value is ObjectValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function walk(value: Json, visit: (value: ObjectValue) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
  } else if (isObject(value)) {
    visit(value)
    for (const item of Object.values(value)) walk(item, visit)
  }
}

function addSecret(secrets: Set<string>, raw: string): void {
  if (!raw) return
  secrets.add(raw)
  try {
    const decoded = tokenizeCommand(raw).join(' ')
    if (decoded) secrets.add(decoded)
  } catch {
    throw new Error('Cannot decode browser command')
  }
}

/** Redact known browser calls and reject records whose other copies cannot be proven safe. */
export function redactHistory(values: Json[], secrets: Set<string>): Json[] {
  const results = new Map<string, string[]>()
  const failed = new Set<string>()
  const add = <K>(map: Map<K, string[]>, key: K, value: Json): void => {
    const items = map.get(key) ?? []
    const collect = (item: Json): void => {
      if (typeof item === 'string') items.push(item)
      else if (Array.isArray(item)) item.forEach(collect)
      else if (isObject(item)) Object.values(item).forEach(collect)
    }
    collect(value)
    map.set(key, items)
  }
  walk(values, value => {
    if (value.role === 'toolResult' && typeof value.toolCallId === 'string' && typeof value.toolName === 'string' && isCanonicalBrowserToolName(value.toolName)) {
      add(results, value.toolCallId, value.content ?? '')
      if (value.isError === true) failed.add(value.toolCallId)
    }
  })
  const calls: Array<{ call: ObjectValue; result: string; classifications?: BrowserInputClassification[] }> = []
  const nestedIds = new Set<string>()
  const nestedResults = new Map<number, { document: ObjectValue; result: ObjectValue }>()
  const nestedDocuments = new Map<number, ObjectValue>()
  const records = values.flat()
  const evidence = new Map<number, ObjectValue>()
  for (const record of records) {
    if (!isObject(record)) continue
    const entries = record.type === 'commit' && Array.isArray(record.writes)
      ? record.writes.flatMap(write => isObject(write) && write.type === 'entry' ? [write.value] : []) : [record]
    for (const entry of entries) {
      if (!isObject(entry) || entry.kind !== BROWSER_INPUT_EVIDENCE) continue
      if (typeof entry.byTaskId !== 'number' || typeof entry.conversationId !== 'number' || !isObject(entry.data)
        || entry.data.version !== 1 || typeof entry.data.callId !== 'string') throw new Error('Invalid browser input evidence')
      const previous = evidence.get(entry.byTaskId)
      if (previous && (previous.conversationId !== entry.conversationId || JSON.stringify(previous.data) !== JSON.stringify(entry.data))) {
        throw new Error('Conflicting browser input evidence')
      }
      evidence.set(entry.byTaskId, entry)
    }
  }
  const tasks = new Map<number, ObjectValue>()
  for (const record of records) {
    if (!isObject(record)) continue
    const writes = record.type === 'commit' && Array.isArray(record.writes) ? record.writes
      : record.type === 'record' ? [record.payload] : [record]
    for (const write of writes) {
      if (!isObject(write)) continue
      const task = write.type === 'task' ? write.value : write
      if (!isObject(task) || task.kind !== 'pi.tool' || typeof task.id !== 'number') continue
      const previous = tasks.get(task.id)
      if (!previous || (isObject(task.state) && task.state.status === 'terminal')) tasks.set(task.id, task)
    }
  }
  const classificationsFor = (task: ObjectValue, call: ObjectValue): BrowserInputClassification[] | undefined => {
    const persisted = typeof task.id === 'number' ? evidence.get(task.id) : undefined
    if (!persisted) return undefined
    const data = persisted.data as ObjectValue
    const classifications = browserInputClassifications(data.classifications, isObject(call.arguments) ? call.arguments.command : undefined)
    const latest = typeof task.id === 'number' ? tasks.get(task.id) : undefined
    const state = latest?.state
    if (persisted.conversationId !== task.conversationId || data.callId !== call.id || !classifications
      || classifications.includes('unknown') || !isObject(state) || state.status !== 'terminal'
      || !isObject(state.outcome) || state.outcome.status !== 'completed') throw new Error('Unresolved browser input evidence')
    return classifications
  }
  const directTasks = new Map<string, ObjectValue>()
  for (const task of tasks.values()) {
    if (isObject(task.input) && task.input.kind === 'model' && typeof task.input.callId === 'string') {
      directTasks.set(JSON.stringify([task.conversationId, task.input.assistant, task.input.callId]), task)
    }
  }
  const directCalls = new Map<ObjectValue, ObjectValue>()
  for (const record of records) {
    if (!isObject(record)) continue
    const entries = record.type === 'commit' && Array.isArray(record.writes)
      ? record.writes.flatMap(write => isObject(write) && write.type === 'entry' ? [write.value] : []) : [record]
    for (const entry of entries) {
      if (!isObject(entry) || !Array.isArray(entry.model)) continue
      walk(entry.model, call => {
        if (call.type !== 'toolCall') return
        const task = directTasks.get(JSON.stringify([entry.conversationId, entry.id, call.id]))
        if (task) directCalls.set(call, task)
      })
    }
  }
  for (const record of records) {
    if (!isObject(record)) continue
    const documents = record.type === 'commit' && Array.isArray(record.writes)
      ? record.writes.flatMap(write => isObject(write) && write.type === 'document.create' ? [write.record] : []) : [record]
    for (const document of documents) {
      if (isObject(document) && document.kind === 'pi.tool.nested-call' && typeof document.id === 'number'
        && isObject(document.scope) && document.scope.kind === 'task') nestedDocuments.set(document.id, document)
    }
  }
  for (const record of records) {
    if (!isObject(record)) continue
    const value = record.type === 'record' ? record.payload : record
    if (!isObject(value) || value.type !== 'document' || typeof value.id !== 'number' || !isObject(value.content)) continue
    const document = nestedDocuments.get(value.id)
    if (!document) continue
    const content = value.content
    const results = content.kind === 'base' && isObject(content.value) ? [content.value.result]
      : content.kind === 'delta' && Array.isArray(content.ops) ? content.ops.flatMap(operation =>
        Array.isArray(operation) && operation[0] === 's' && Array.isArray(operation[1])
          && operation[1].length === 1 && operation[1][0] === 'result' ? [operation[2]] : []) : []
    for (const result of results) {
      if (!isObject(result) || typeof result.taskId !== 'number' || typeof result.isError !== 'boolean'
        || !Array.isArray(result.diagnostics) || typeof result.durationMs !== 'number') continue
      const previous = nestedResults.get(result.taskId)
      if (previous && (previous.document.id !== document.id || JSON.stringify(previous.result) !== JSON.stringify(result))) {
        throw new Error('Conflicting nested browser results')
      }
      nestedResults.set(result.taskId, { document, result })
    }
  }
  walk(values, value => {
    if (value.kind !== 'pi.tool' || !isObject(value.input) || value.input.kind !== 'nested' || !isObject(value.input.call)) return
    const call = value.input.call
    if (typeof call.name !== 'string' || !isCanonicalBrowserToolName(call.name)) return
    if (!isObject(call.arguments)) throw new Error('Invalid nested browser call')
    const command = call.arguments.command
    const parts = typeof command === 'string'
      ? splitBatchCommands(command.trim()).map(tokenizeCommand)
      : Array.isArray(command) && command.every(item => typeof item === 'string') ? [command] : []
    if (!parts.length) throw new Error('Invalid nested browser command')
    const classifications = classificationsFor(value, call)
    if (classifications) {
      if (typeof call.id !== 'string') throw new Error('Invalid nested browser call')
      nestedIds.add(call.id)
      calls.push({ call, result: '', classifications })
      return
    }
    const match = typeof value.id === 'number' ? nestedResults.get(value.id) : undefined
    const nested = match && isObject(match.document.scope) && match.document.scope.taskId === value.input.parent
      && match.document.key === value.input.key ? match.result : undefined
    const text = new Map<string, string[]>()
    if (nested?.structuredOutput !== undefined) add(text, '', nested.structuredOutput)
    const result = text.get('')?.join('\n') ?? ''
    const entries = parts.filter(part => ['fill', 'type', 'paste'].includes(part[0]?.toLowerCase() ?? ''))
    // Nested receipts omit output; only persisted results can establish what each input contained.
    if (entries.length && (!nested || nested.isError || (entries.length > 1 && entries.some(part => part[0]?.toLowerCase() !== 'fill')))) {
      throw new Error('Unresolved nested browser input')
    }
    for (const part of entries) {
      const password = !!redactBrowserPasswordFills(call.name, { command: part }, result, { redactPlaceholders: true })
      const ordinary = part[0]?.toLowerCase() === 'fill'
        && result.includes(`Filled element ${part[1]} with "${part.slice(2).join(' ')}"\nValue length: ${part.slice(2).join(' ').length} characters`)
      if (password === ordinary) throw new Error('Unresolved nested browser input')
    }
    if (typeof call.id !== 'string') throw new Error('Invalid nested browser call')
    nestedIds.add(call.id)
    calls.push({ call, result })
  })
  walk(values, value => {
    if (value.type !== 'toolCall' || typeof value.name !== 'string' || !isCanonicalBrowserToolName(value.name)) return
    if (typeof value.id === 'string' && nestedIds.has(value.id)) return
    const task = directCalls.get(value)
    const classifications = task ? classificationsFor(task, value) : undefined
    if (classifications) {
      calls.push({ call: value, result: '', classifications })
      return
    }
    const result = typeof value.id === 'string' ? results.get(value.id)?.join('\n') : undefined
    if (result === undefined) throw new Error('Browser tool result is missing')
    // A failed interaction can occur after a partial input; older output also omitted field type.
    if ((typeof value.id === 'string' && failed.has(value.id)) || /\bFilled element \S+ \(\d+ characters\)/.test(result)
      || /\bTyped \d+ characters into focused element\b/.test(result)
      || /\bPasted \d+ characters\b/.test(result)) {
      const command = isObject(value.arguments) ? value.arguments.command : undefined
      const parts = typeof command === 'string'
        ? splitBatchCommands(command.trim()).map(tokenizeCommand)
        : Array.isArray(command) && command.every(item => typeof item === 'string') ? [command] : []
      if (!parts.length) throw new Error('Invalid browser command')
      const fallback = parts.filter(part => part[0]?.toLowerCase() === 'fill' && part[1])
        .map(part => `${PASSWORD_FILL_MARKER} ${part[1]}`).join('\n')
      calls.push({ call: value, result: `${result}\n${fallback}\n${PASSWORD_TEXT_MARKER}` })
    } else {
      calls.push({ call: value, result })
    }
  })
  const replacements = new Map<string, Json>()
  for (const { call, result, classifications } of calls) {
    if (typeof call.name !== 'string' || !isObject(call.arguments)) throw new Error('Invalid browser tool call')
    const onRedact = (value: string | readonly unknown[]): void => {
      if (typeof value === 'string') addSecret(secrets, value)
      else for (const item of value) {
        if (typeof item !== 'string') throw new Error('Invalid browser command')
        if (item) secrets.add(item)
      }
    }
    const redacted = classifications
      ? { ...call.arguments, command: redactBrowserInputEvidence(call.arguments.command as string | string[], classifications, onRedact) }
      : redactBrowserPasswordFills(call.name, call.arguments, result, { redactPlaceholders: true, placeholder: '', onRedact })
    if (!redacted) continue
    const original = call.arguments.command
    const replacement = redacted.command as Json
    if (original === undefined || replacement === undefined) throw new Error('Invalid browser command')
    if (typeof call.id !== 'string') throw new Error('Invalid browser tool call')
    const key = JSON.stringify([call.id, original])
    const previous = replacements.get(key)
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(replacement)) throw new Error('Conflicting browser redactions')
    replacements.set(key, replacement)
  }
  const replace = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(replace)
    if (!isObject(value)) return value
    const callId = typeof value.id === 'string' ? value.id : value.callId
    const browserCall = typeof value.name === 'string' && isCanonicalBrowserToolName(value.name) && typeof callId === 'string'
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (browserCall && key === 'arguments' && isObject(item) && item.command !== undefined) {
        const replacement = replacements.get(JSON.stringify([callId, item.command]))
        if (replacement !== undefined) return [key, replace({ ...item, command: replacement })]
      }
      return [key, replace(item)]
    }))
  }
  const output = values.map(replace)
  assertNoHistorySecrets(output, secrets)
  return output
}

export function assertNoHistorySecrets(value: Json, secrets: Set<string>): void {
  if (typeof value === 'string') {
    for (const secret of secrets) if (value.includes(secret)) throw new Error('Unresolved browser password copy')
  } else if (Array.isArray(value)) {
    for (const item of value) assertNoHistorySecrets(item, secrets)
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) { assertNoHistorySecrets(key, secrets); assertNoHistorySecrets(item, secrets) }
  }
}

function bundleFile(name: string, content: Buffer): BundleFile {
  return { relativePath: `durable-store/${name}`, contentBase64: content.toString('base64'), size: content.length }
}

/** Snapshot durable history with browser password inputs removed; reject unknown storage formats. */
export function collectDurableBundle(storeDir: string, secrets: Set<string> = new Set(), map: ModelValueMapper = value => value): BundleFile[] {
  const root = lstatSync(storeDir, { throwIfNoEntry: false })
  if (!root) return []
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Durable store root must be a directory, not a symlink')
  const entries = readdirSync(storeDir, { withFileTypes: true })
  if (entries.some(entry => !entry.isFile())) throw new Error('Unknown durable store item')
  const names = entries.map(entry => entry.name)
  const metadata = ['session-id.txt', 'conversation-id.txt', 'id-map.json']
  if (names.includes('main.jsonl')) {
    if (names.some(name => name !== 'main.jsonl' && !/^(?:doc|task)-(?:0|[1-9]\d*)\.jsonl$/.test(name) && !metadata.includes(name))) throw new Error('Unknown durable JSONL file')
    const files = names.filter(name => !metadata.includes(name)).sort().map(name => ({ name, text: readFileSync(join(storeDir, name), 'utf8') }))
    const after = readdirSync(storeDir, { withFileTypes: true })
    if (after.some(entry => !entry.isFile()) || after.map(entry => entry.name).sort().join('\0') !== names.slice().sort().join('\0')) throw new Error('Durable store changed during export')
    for (const file of files) {
      if (file.text !== readFileSync(join(storeDir, file.name), 'utf8')) throw new Error('Durable store changed during export')
      if (file.text && !file.text.endsWith('\n')) throw new Error('Incomplete durable JSONL record')
    }
    const records = files.map(file => file.text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Json))
    const main = records[files.findIndex(file => file.name === 'main.jsonl')]!
    const confirmed = new Map<string, string>()
    const required = new Set<string>()
    const liveTasks = new Map<number, string[]>()
    const documentRecords = new Map<number, string[]>()
    const disposableDocuments = new Set<number>()
    const retiredDocuments = new Set<number>()
    let previousSeq = 0
    for (const marker of main) {
      if (!isObject(marker) || typeof marker.seq !== 'number' || !Number.isSafeInteger(marker.seq)
        || marker.seq <= previousSeq || !Array.isArray(marker.writes)) throw new Error('Invalid durable JSONL marker')
      previousSeq = marker.seq
      for (const operation of marker.writes) {
        if (!isObject(operation) || typeof operation.type !== 'string') throw new Error('Invalid durable JSONL operation')
        const doc = operation.type === 'document.create' && isObject(operation.record) ? operation.record.id : operation.id
        const prefix = operation.type === 'task.sidecar' ? 'task' : operation.type === 'document.create' || operation.type === 'document.change' ? 'doc' : undefined
        if (prefix) {
          if (typeof doc !== 'number' || typeof operation.ordinal !== 'number') throw new Error('Invalid durable JSONL reference')
          const key = JSON.stringify([`${prefix}-${doc}.jsonl`, marker.seq, operation.ordinal])
          if (confirmed.has(key)) throw new Error('Duplicate durable JSONL reference')
          confirmed.set(key, operation.type)
          required.add(key)
          const target = prefix === 'task' ? liveTasks : documentRecords
          target.set(doc, [...(target.get(doc) ?? []), key])
          if (operation.type === 'document.create' && isObject(operation.record) && isObject(operation.record.scope)
            && (operation.record.scope.kind !== 'conversation' || operation.record.history === 'latest')) disposableDocuments.add(doc)
        }
        if (operation.type === 'task' && isObject(operation.value) && typeof operation.value.id === 'number') {
          for (const key of liveTasks.get(operation.value.id) ?? []) required.delete(key)
        }
        if (operation.type === 'document.retire' && typeof operation.id === 'number' && disposableDocuments.has(operation.id)) {
          retiredDocuments.add(operation.id)
          for (const key of documentRecords.get(operation.id) ?? []) required.delete(key)
        }
      }
    }
    files.forEach((file, index) => {
      let previous: { seq: number; ordinal: number } | undefined
      for (const record of records[index]!) {
        if (file.name !== 'main.jsonl' && isObject(record)) {
          if (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 1
            || typeof record.ordinal !== 'number' || !Number.isSafeInteger(record.ordinal) || record.ordinal < 0
            || (previous && (record.seq < previous.seq || (record.seq === previous.seq && record.ordinal <= previous.ordinal)))) {
            throw new Error('Invalid durable JSONL sidecar order')
          }
          previous = { seq: record.seq, ordinal: record.ordinal }
          const key = JSON.stringify([file.name, record.seq, record.ordinal])
          const operation = confirmed.get(key)
          if (!operation || !isObject(record.payload)) throw new Error('Uncommitted durable JSONL sidecar')
          if (operation === 'task.sidecar') {
            if (record.payload.type !== 'task' || !isObject(record.payload.value)
              || file.name !== `task-${record.payload.value.id}.jsonl`) throw new Error('Mismatched durable JSONL task')
          } else if (record.payload.type !== 'document' || file.name !== `doc-${record.payload.id}.jsonl`
            || (operation === 'document.create' && (!isObject(record.payload.content) || record.payload.content.kind !== 'base'))) {
            throw new Error('Mismatched durable JSONL document')
          }
          required.delete(key)
          if (isObject(record.payload) && record.payload.type === 'document' && typeof record.payload.id === 'number'
            && disposableDocuments.has(record.payload.id) && !retiredDocuments.has(record.payload.id)
            && isObject(record.payload.content) && record.payload.content.kind === 'base') {
            for (const earlier of documentRecords.get(record.payload.id) ?? []) {
              if (earlier === key) break
              required.delete(earlier)
            }
          }
        }
        if (!isObject(record) || record.format !== 1 || typeof record.seq !== 'number'
          || (file.name === 'main.jsonl' ? record.type !== 'commit' || !Array.isArray(record.writes)
            : record.type !== 'record' || !isObject(record.payload))) throw new Error('Unknown durable JSONL record')
        if (file.name === 'main.jsonl' && Array.isArray(record.writes)) {
          const known = ['conversation', 'entry', 'submission', 'task', 'task.sidecar', 'document.create', 'document.change', 'document.retire']
          if (record.writes.some(write => !isObject(write) || typeof write.type !== 'string' || !known.includes(write.type))) throw new Error('Unknown durable JSONL operation')
        } else if (isObject(record.payload) && !['task', 'document'].includes(String(record.payload.type))) {
          throw new Error('Unknown durable JSONL payload')
        }
      }
    })
    if (required.size) throw new Error('Missing durable JSONL sidecar')
    const redacted = redactHistory(records, secrets).map(values => mapDurableCommits(values as Json[], map))
    assertNoHistorySecrets(redacted, secrets)
    const output = files.map((file, index) => bundleFile(file.name, Buffer.from((redacted[index] as Json[]).map(value => JSON.stringify(value) + '\n').join(''))))
    return [...output, ...metadata.filter(name => names.includes(name)).map(name => bundleFile(name, readFileSync(join(storeDir, name))))]
  }
  if (!names.includes('store.db') || names.some(name => !['store.db', 'store.db-wal', 'store.db-shm', ...metadata].includes(name))) throw new Error('Unsupported durable store format')
  const loaded = typeof Bun !== 'undefined' ? require('bun:sqlite') : require('node:sqlite')
  const Database = (loaded.Database ?? loaded.DatabaseSync) as new (path: string, options?: object) => SqliteDatabase
  const temp = mkdtempSync(join(tmpdir(), 'mkagent-durable-export-'))
  try {
    const snapshot = join(temp, 'snapshot.db')
    const source = new Database(join(storeDir, 'store.db'), { readonly: true })
    try { source.prepare('VACUUM INTO ?').run(snapshot) } finally { source.close() }
    const db = new Database(snapshot)
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
      const expected: Record<string, string[]> = {
        durable_schema: ['singleton', 'version'],
        durable_metadata: ['singleton', 'next_id', 'next_seq'],
        record_ids: ['id', 'record_type'],
        conversations: ['id', 'owner_conversation_id', 'owner_task_id', 'record'],
        entries: ['id', 'conversation_id', 'head', 'commit_seq', 'record'],
        tasks: ['id', 'conversation_id', 'kind', 'status', 'abort_requested', 'background', 'record'],
        submissions: ['id', 'conversation_id', 'request_id', 'status', 'record'],
        documents: ['id', 'kind', 'family', 'key_value', 'scope_kind', 'owner_id', 'created_at', 'retired_at', 'record'],
        document_revisions: ['document_id', 'seq', 'kind', 'version', 'content'],
      }
      if (tables.length !== Object.keys(expected).length || tables.some(table => !Object.hasOwn(expected, table.name))) throw new Error('Unknown durable database schema')
      for (const [table, known] of Object.entries(expected)) {
        const actual = db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>
        if (actual.length !== known.length || actual.some(column => !known.includes(column.name))) throw new Error('Unknown durable database column')
      }
      const versions = db.prepare('SELECT version FROM durable_schema').all() as Array<{ version: number }>
      if (versions.length !== 1 || versions[0]!.version < 1 || versions[0]!.version > 2) throw new Error('Unsupported durable database version')
      const columns = [
        ['conversations', 'record'], ['entries', 'record'], ['tasks', 'record'],
        ['submissions', 'record'], ['documents', 'record'], ['document_revisions', 'content'],
      ] as const
      const rows = columns.map(([table, column]) => ({
        table, column,
        values: db.prepare(`SELECT rowid AS row_id, ${column} AS value${table === 'document_revisions' ? ', document_id, kind' : ''} FROM ${table}`).all() as Array<{ row_id: number; value: string; document_id?: number; kind?: string }>,
      }))
      const values = rows.flatMap(group => group.values.map(row => {
        const value = JSON.parse(row.value) as Json
        if (group.table !== 'document_revisions') return value
        if (typeof row.document_id !== 'number' || (row.kind !== 'base' && row.kind !== 'delta')) throw new Error('Unknown durable database revision')
        return { type: 'document', id: row.document_id, content: { kind: row.kind, [row.kind === 'base' ? 'value' : 'ops']: value } }
      }))
      const redacted = redactHistory(values, secrets)
      let index = 0
      for (const group of rows) {
        const update = db.prepare(`UPDATE ${group.table} SET ${group.column} = ? WHERE rowid = ?`)
        for (const row of group.values) {
          const redactedValue = redacted[index++]!
          const result = group.table === 'entries' ? mapDurableEntry(redactedValue, map) : redactedValue
          assertNoHistorySecrets(result, secrets)
          if (group.table === 'document_revisions' && (!isObject(result) || !isObject(result.content))) throw new Error('Invalid durable database revision')
          const value = group.table === 'document_revisions' ? (result as ObjectValue).content as ObjectValue : undefined
          const encoded = JSON.stringify(value ? value[row.kind === 'base' ? 'value' : 'ops'] : result)
          if (encoded !== JSON.stringify(JSON.parse(row.value))) update.run(encoded, row.row_id)
        }
      }
      db.exec('VACUUM')
    } finally { db.close() }
    return [bundleFile('store.db', readFileSync(snapshot)), ...metadata.filter(name => names.includes(name)).map(name => bundleFile(name, readFileSync(join(storeDir, name))))]
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
