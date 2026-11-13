/** Materialize explicitly tagged plugin inputs from an already verified, committed native tree. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { StoredAttachment, StoredMessage } from '@mkagent/core/types'
import { getSessionPath, validateSessionId } from '@mkagent/shared/sessions'
import type { TrustedNativeSession } from './native-session-source'

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function attachmentDirectory(workspace: string, sessionId: string): string {
  validateSessionId(sessionId)
  const physical = realpathSync(workspace)
  let path = workspace
  for (const part of ['sessions', sessionId, 'attachments']) {
    path = join(path, part)
    try { mkdirSync(path) }
    catch (error) { if (!object(error) || error.code !== 'EEXIST') throw error }
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || realpathSync(path) !== join(physical, relative(workspace, path))) {
      throw new Error('Native input attachments require regular session directories')
    }
  }
  return path
}

function verifyFile(path: string, bytes: Buffer): void {
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Native input attachment must be a regular file')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    const existing = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    const named = lstatSync(path, { bigint: true })
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) {
      if (before[key] !== opened[key] || opened[key] !== after[key] || after[key] !== named[key]) {
        throw new Error('Native input attachment changed during verification')
      }
    }
    if (!existing.equals(bytes)) throw new Error('Native input attachment conflicts with committed bytes')
  } finally { closeSync(fd) }
}

function storeImage(directory: string, productId: string, index: number, image: Record<string, unknown>): StoredAttachment {
  if (typeof image.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    || typeof image.mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/.test(image.mimeType)) {
    throw new Error('Native input image encoding is invalid')
  }
  const bytes = Buffer.from(image.data, 'base64')
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== image.data.replace(/=+$/, '')) {
    throw new Error('Native input image bytes are invalid')
  }
  const extensions: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
  }
  const extension = extensions[image.mimeType] ?? 'image'
  const id = 'native-' + createHash('sha256').update(`${productId}\0${index}`).digest('hex')
  const path = join(directory, `${id}.${extension}`)
  const temporary = join(directory, `.${id}.${randomUUID()}.tmp`)
  try {
    // Link a complete temporary file exclusively, so a crash cannot leave a partial named attachment.
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    try { linkSync(temporary, path) }
    catch (error) { if (!object(error) || error.code !== 'EEXIST') throw error }
    verifyFile(path, bytes)
  } finally {
    try { unlinkSync(temporary) }
    catch (error) { if (!object(error) || error.code !== 'ENOENT') throw error }
  }
  return { id, type: 'image', name: `plugin-image-${index + 1}.${extension}`,
    mimeType: image.mimeType, size: bytes.length, storedPath: path }
}

export function materializeNativeUserHistory(
  tree: Pick<TrustedNativeSession, 'entries' | 'entryIds'>, workspace: string, sessionId: string, existing: readonly StoredMessage[],
): StoredMessage[] {
  if (getSessionPath(workspace, sessionId) !== join(workspace, 'sessions', sessionId)) {
    throw new Error('Native input session path is invalid')
  }
  const links = new Map(tree.entryIds.map(link => [link.nativeId, link.productMessageId]))
  const rows = new Map(existing.map(row => [row.id, row]))
  const added: StoredMessage[] = []
  for (const entry of tree.entries) {
    const message = entry.message
    if (entry.type !== 'message' || !object(message) || message.hostUserInput === undefined) continue
    const input = message.hostUserInput
    const id = message.hostMessageId
    if (message.role !== 'user' || !object(input) || input.version !== 1
      || typeof id !== 'string' || !id.startsWith('native-user-') || links.get(entry.id) !== id
      || typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)
      || (typeof input.content !== 'string' && !Array.isArray(input.content))) {
      throw new Error('Native plugin input metadata does not match its committed identity')
    }
    const parts: unknown[] = typeof input.content === 'string' ? [{ type: 'text', text: input.content }] : input.content
    const text: string[] = []
    const attachments: StoredAttachment[] = []
    for (const part of parts) {
      if (!object(part)) throw new Error('Native plugin input content is invalid')
      if (part.type === 'text' && typeof part.text === 'string') text.push(part.text)
      else if (part.type === 'image') {
        attachments.push(storeImage(attachmentDirectory(workspace, sessionId), id, attachments.length, part))
      } else throw new Error('Native plugin input content is invalid')
    }
    const row: StoredMessage = { id, type: 'user', content: text.join('\n'), timestamp: message.timestamp,
      ...(attachments.length ? { attachments } : {}) }
    const previous = rows.get(id)
    if (previous) {
      if (previous.type !== row.type || previous.content !== row.content
        || (previous.attachments?.length ?? 0) !== attachments.length
        || attachments.some((attachment, index) => {
          const stored = previous.attachments?.[index]
          return !stored || stored.id !== attachment.id || stored.storedPath !== attachment.storedPath
            || stored.size !== attachment.size || stored.mimeType !== attachment.mimeType
        })) throw new Error('Native plugin input conflicts with an existing product message')
      continue
    }
    rows.set(id, row)
    added.push(row)
  }
  return added
}
