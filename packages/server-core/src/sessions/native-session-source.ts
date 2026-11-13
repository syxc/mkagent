/** Verify registered native projections without opening a native session writer. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { getSessionPath, parseNativeSessionReference, validateSessionId, type NativeSessionReference } from '@mkagent/shared/sessions'
import type { PiNativeForkPlan } from '../../../shared/src/agent/backend/pi/native-owner-protocol'

type RecordValue = Record<string, unknown>
export interface NativeSourceEntry extends RecordValue {
  id: string
  parentId: string | null
  type: string
  timestamp: string
}
export interface TrustedNativeSession {
  reference: NativeSessionReference
  header: RecordValue
  entries: NativeSourceEntry[]
  entryIds: Array<{ nativeId: string; durableId: number; productMessageId?: string }>
  hasName: boolean
}

function object(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}
function hash(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }

function directories(workspace: string, physicalRoot: string, path: string): void {
  if (realpathSync(workspace) !== physicalRoot) throw new Error('Native workspace changed during verification')
  const parts = relative(workspace, path).split(sep)
  if (parts.some(part => !part || part === '..' || part === '.')) throw new Error('Native projection is outside its workspace')
  let current = workspace
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || realpathSync(current) !== join(physicalRoot, ...parts.slice(0, index + 1))) {
      throw new Error('Native projection directory must not be a symlink')
    }
  }
}

function readRegular(path: string): Buffer {
  const before = lstatSync(path, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('Native projection must be a regular file')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Native projection changed while opening')
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    const named = lstatSync(path, { bigint: true })
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) {
      if (before[field] !== after[field] || after[field] !== named[field]) {
        throw new Error('Native projection changed during verification')
      }
    }
    if (!named.isFile() || named.isSymbolicLink()) throw new Error('Native projection must be a regular file')
    return bytes
  } finally { closeSync(fd) }
}

/** The caller supplies its product record and must separately enforce workspace ownership and runtime locks. */
export function readTrustedNativeSession(options: {
  workspaceRootPath: string
  sessionId: string
  nativeSessionId: string
  reference: NativeSessionReference
}): TrustedNativeSession {
  validateSessionId(options.sessionId)
  if (!isAbsolute(options.workspaceRootPath)) throw new Error('Native workspace path must be absolute')
  const workspace = resolve(options.workspaceRootPath)
  const session = getSessionPath(workspace, options.sessionId)
  const sessionFile = join(session, 'native-session', 'session.jsonl')
  const reference = parseNativeSessionReference(options.reference)
  if (!reference || reference.sessionId !== options.sessionId || reference.nativeSessionId !== options.nativeSessionId
    || reference.sessionFile !== sessionFile) throw new Error('Native projection does not match its product identity and path')
  const nativeDirectory = join(session, 'native-session')
  const metadataDirectory = join(session, 'meta')
  const physicalRoot = realpathSync(workspace)
  directories(workspace, physicalRoot, nativeDirectory)
  directories(workspace, physicalRoot, metadataDirectory)
  const metadata = readRegular(join(metadataDirectory, 'native-session.json'))
  const jsonl = readRegular(sessionFile)
  directories(workspace, physicalRoot, nativeDirectory)
  directories(workspace, physicalRoot, metadataDirectory)
  if (hash(metadata) !== reference.manifestDigest || hash(jsonl) !== reference.digest) {
    throw new Error('Native projection digest does not match its product record')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const manifest: unknown = JSON.parse(decoder.decode(metadata))
  if (!object(manifest)
    || !isDeepStrictEqual(parseNativeSessionReference({ ...manifest, manifestDigest: hash(metadata) }), reference)
    || !Array.isArray(manifest.entryIds)) throw new Error('Native manifest does not match its product record')
  const lines = decoder.decode(jsonl).split('\n')
  if (lines.pop() !== '' || !lines.length || lines.some(line => !line)) throw new Error('Native projection is incomplete')
  const header: unknown = JSON.parse(lines.shift()!)
  if (!object(header) || header.type !== 'session' || header.version !== 3 || header.id !== reference.nativeSessionId
    || !text(header.timestamp) || !text(header.cwd)) throw new Error('Native projection header does not match')
  const ids = new Set<string>()
  const entries: NativeSourceEntry[] = []
  const entryIds: TrustedNativeSession['entryIds'] = []
  let hasName = false
  let name: string | null = null
  for (const [index, line] of lines.entries()) {
    const entry: unknown = JSON.parse(line)
    if (!object(entry) || !text(entry.id) || ids.has(entry.id) || !text(entry.type) || entry.type === 'session'
      || !text(entry.timestamp) || (entry.parentId !== null && (!text(entry.parentId) || !ids.has(entry.parentId)))) {
      throw new Error('Native projection has an invalid entry identity or parent')
    }
    const link: unknown = manifest.entryIds[index]
    if (!object(link) || link.nativeId !== entry.id || !Number.isSafeInteger(link.durableId) || Number(link.durableId) < 0
      || (link.productMessageId !== undefined && !text(link.productMessageId))) {
      throw new Error('Native projection entry mapping does not match')
    }
    ids.add(entry.id)
    entries.push({ ...entry, id: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp })
    entryIds.push({ nativeId: entry.id, durableId: Number(link.durableId),
      ...(link.productMessageId !== undefined ? { productMessageId: link.productMessageId } : {}) })
    if (entry.type === 'session_info') {
      if (typeof entry.name !== 'string') throw new Error('Native session name is invalid')
      hasName = true
      name = entry.name.trim() || null
    }
  }
  if (manifest.entryIds.length !== entries.length || (reference.leaf !== null && !ids.has(reference.leaf))
    || name !== reference.name) throw new Error('Native projection leaf, name or mapping does not match')
  return { reference, header, entries, entryIds, hasName }
}

/** Derive the cutoff from verified native identities, including metadata entries and an empty root. */
export function nativeForkPlan(source: TrustedNativeSession, entryId: string | null, position: 'before' | 'at'): PiNativeForkPlan {
  if (position !== 'before' && position !== 'at') throw new Error('Invalid native fork position')
  if (entryId === null && position === 'at') return { nativeLeafId: null, durableEntryId: null }
  const entry = source.entries.find(value => value.id === entryId)
  if (!entry) throw new Error('Native fork entry was not found')
  if (position === 'before' && (entry.type !== 'message' || !object(entry.message) || entry.message.role !== 'user')) {
    throw new Error('Native before fork requires a user entry')
  }
  const nativeLeafId = position === 'at' ? entry.id : entry.parentId
  const durableEntryId = nativeLeafId === null ? null : source.entryIds.find(link => link.nativeId === nativeLeafId)?.durableId
  if (durableEntryId === undefined) throw new Error('Native fork leaf has no durable identity')
  if (position === 'at') return { nativeLeafId, durableEntryId }
  const content = object(entry.message) ? entry.message.content : undefined
  if (typeof content !== 'string' && !Array.isArray(content)) throw new Error('Native fork user content is invalid')
  const selectedText = typeof content === 'string' ? content : content.flatMap(part =>
    object(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('')
  return { nativeLeafId, durableEntryId, selectedText }
}
