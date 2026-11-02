import { cpSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { expandSessionPath, makeSessionPathPortable } from './jsonl.ts'
import { normalizePath } from '../utils/paths.ts'
import type { StoredMessage } from './types.ts'
import type { SessionBundle } from './bundle.ts'

function assertSafeSessionReferences(serialized: string): void {
  if (/\{\{SESSION_PATH\}\}(?:\/[^/\s"'<>]*)*\/\.\.(?=\/|[\s"'<>]|$)/u.test(serialized)) {
    throw new Error('Session file reference contains path traversal')
  }
}

export function remapSessionFileReferences<T>(value: T, sourcePath: string, targetPath: string): T {
  const serialized = makeSessionPathPortable(JSON.stringify(value), sourcePath)
  assertSafeSessionReferences(serialized)
  return JSON.parse(expandSessionPath(serialized, targetPath)) as T
}

export function importSessionMessages(bundle: SessionBundle, targetPath: string): StoredMessage[] {
  const roots = new Set<string>()
  if (bundle.session.header.workspaceRootPath) roots.add(normalizePath(bundle.session.header.workspaceRootPath) + '/sessions/' + bundle.session.header.id)
  const files = new Set(bundle.files.map(file => file.relativePath))
  // Old v1 packages stored absolute paths, sometimes alongside a "~" header.
  // Infer those source roots only from structured references proven by bundled files.
  const marker = '/sessions/' + bundle.session.header.id + '/'
  for (const message of bundle.session.messages) {
    const paths = [message.planPath, ...(message.attachments ?? []).flatMap(attachment =>
      [attachment.storedPath, attachment.thumbnailPath, attachment.markdownPath])]
    for (const path of paths) {
      if (!path) continue
      const normalized = normalizePath(path)
      const offset = normalized.lastIndexOf(marker)
      if (offset >= 0 && files.has(normalized.slice(offset + marker.length))) {
        roots.add(normalized.slice(0, offset + marker.length - 1))
      }
    }
  }
  let serialized = JSON.stringify(bundle.session.messages)
  for (const root of roots) serialized = makeSessionPathPortable(serialized, root)
  assertSafeSessionReferences(serialized)
  return JSON.parse(expandSessionPath(serialized, targetPath)) as StoredMessage[]
}

/** Copy only retained message files. Runtime stores are copied by the kernel. */
export function copyReferencedSessionFiles(messages: StoredMessage[], sourcePath: string, targetPath: string): void {
  const serialized = makeSessionPathPortable(JSON.stringify(messages), sourcePath)
  assertSafeSessionReferences(serialized)
  const portable = (path: string) => JSON.stringify(`{{SESSION_PATH}}/${normalizePath(relative(sourcePath, path))}`).slice(1, -1)
  const referenced = (path: string) => {
    const escaped = portable(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(escaped + String.raw`(?=$|[/\\\s"'\x60<>(){}\[\],;])`, 'u').test(serialized)
  }
  const hasDescendants = (path: string) => serialized.includes(portable(path) + '/')
  const excluded = new Set(['durable-store', '.pi-sessions', 'tmp', 'session.jsonl', 'session.jsonl.tmp'])
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name)
      if (!referenced(source) && !hasDescendants(source)) continue
      if (directory === sourcePath && excluded.has(entry.name)) {
        throw new Error(`Cannot copy a runtime file as an attachment: ${entry.name}`)
      }
      const stat = lstatSync(source)
      if (stat.isSymbolicLink()) throw new Error('Cannot copy a symbolic link from a session')
      if (stat.isDirectory()) {
        walk(source)
      } else if (stat.isFile() && referenced(source)) {
        const target = join(targetPath, relative(sourcePath, source))
        mkdirSync(dirname(target), { recursive: true })
        cpSync(source, target, { force: false, errorOnExist: true, dereference: false })
        if (!lstatSync(target).isFile()) throw new Error('Cannot copy a symbolic link from a session')
      } else {
        throw new Error('Cannot copy a non-regular session file')
      }
    }
  }
  // Required UI files must not silently disappear when the source file is absent.
  for (const message of messages) {
    const paths = [
      message.planPath,
      ...(message.attachments ?? []).flatMap(attachment => [attachment.storedPath, attachment.thumbnailPath, attachment.markdownPath]),
    ]
    for (const path of paths) {
      if (!path) continue
      const encoded = makeSessionPathPortable(JSON.stringify(path), sourcePath)
      if (!encoded.startsWith('"{{SESSION_PATH}}/')) continue
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('Cannot copy a symbolic link from a session')
      if (!stat.isFile()) throw new Error('Cannot copy a non-regular session file')
    }
  }
  walk(sourcePath)
}
