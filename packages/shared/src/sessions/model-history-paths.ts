import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Json } from './durable-bundle.ts'
export type { Json }

export type ModelValueMapper = (value: Json) => Json
const object = (value: Json | undefined): value is { [key: string]: Json } =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Map model contributions only; document deltas depend on their original string lengths. */
export function mapDurableEntry(entry: Json, map: ModelValueMapper): Json {
  if (!object(entry)) return entry
  return {
    ...entry,
    ...(entry.model !== undefined ? { model: map(entry.model) } : {}),
    ...(Array.isArray(entry.edits) ? { edits: entry.edits.map(edit =>
      object(edit) && edit.action === 'replace' && edit.messages !== undefined
        ? { ...edit, messages: map(edit.messages) } : edit) } : {}),
  }
}

export function mapDurableCommits(records: Json[], map: ModelValueMapper): Json[] {
  return records.map(record => object(record) && Array.isArray(record.writes)
    ? { ...record, writes: record.writes.map(write => object(write) && write.type === 'entry' && write.value !== undefined
      ? { ...write, value: mapDurableEntry(write.value, map) } : write) }
    : record)
}

export function mapLegacyRecords(records: Json[], map: ModelValueMapper): Json[] {
  return records.map(record => {
    if (!object(record)) return record
    const fields = record.type === 'message' ? ['message']
      : record.type === 'custom_message' ? ['content']
        : record.type === 'context_edit' ? ['replacement']
          : record.type === 'compaction' || record.type === 'branch_summary' ? ['summary', 'systemMessage'] : []
    const output = { ...record }
    for (const field of fields) if (output[field] !== undefined) output[field] = map(output[field]!)
    return output
  })
}

function regular(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return false
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Model history must be a regular file')
  return true
}

function rewriteJsonl(path: string, map: (records: Json[]) => Json[]): void {
  if (!regular(path)) return
  const original = readFileSync(path, 'utf8')
  if (original && !original.endsWith('\n')) throw new Error('Incomplete model history')
  const lines = original.split('\n')
  const output = lines.map(line => {
    if (!line.trim()) return line
    const value = JSON.parse(line) as Json
    const mapped = map([value])[0]
    return JSON.stringify(mapped) === JSON.stringify(value) ? line : JSON.stringify(mapped)
  }).join('\n')
  if (output !== original) writeFileSync(path, output)
}

/** Rewrite only a new import or branch copy, before its runtime storage opens. */
export function rewriteStoredModelHistory(sessionPath: string, map: ModelValueMapper): void {
  const store = join(sessionPath, 'durable-store')
  const root = lstatSync(store, { throwIfNoEntry: false })
  if (root && (root.isSymbolicLink() || !root.isDirectory())) throw new Error('Invalid model history directory')
  rewriteJsonl(join(store, 'main.jsonl'), records => mapDurableCommits(records, map))
  const databasePath = join(store, 'store.db')
  if (regular(databasePath)) {
    const loaded = typeof Bun !== 'undefined' ? require('bun:sqlite') : require('node:sqlite')
    const Database = (loaded.Database ?? loaded.DatabaseSync) as new (path: string) => {
      exec(sql: string): void
      prepare(sql: string): { all(): unknown[]; run(record: string, id: number): unknown }
      close(): void
    }
    const db = new Database(databasePath)
    try {
      db.exec('BEGIN')
      const update = db.prepare('UPDATE entries SET record = ? WHERE id = ?')
      for (const row of db.prepare('SELECT id, record FROM entries').all() as Array<{ id: number; record: string }>) {
        const original = JSON.parse(row.record) as Json
        const mapped = mapDurableEntry(original, map)
        if (JSON.stringify(mapped) !== JSON.stringify(original)) update.run(JSON.stringify(mapped), row.id)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    } finally {
      db.close()
    }
  }
  const legacy = join(sessionPath, '.pi-sessions')
  const legacyRoot = lstatSync(legacy, { throwIfNoEntry: false })
  if (legacyRoot) {
    if (legacyRoot.isSymbolicLink() || !legacyRoot.isDirectory()) throw new Error('Invalid legacy history directory')
    for (const name of readdirSync(legacy).filter(name => name.endsWith('.jsonl'))) {
      rewriteJsonl(join(legacy, name), records => mapLegacyRecords(records, map))
    }
  }
}
