import { watch } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface SessionFileWatcher {
  close(): void
}

const ignored = (name: string) => name === 'session.jsonl' || name.startsWith('.')

async function fingerprint(root: string): Promise<string> {
  const entries: unknown[] = []
  const visit = async (directory: string, relative = '') => {
    try {
      const children = await readdir(directory, { withFileTypes: true })
      children.sort((a, b) => a.name.localeCompare(b.name))
      for (const child of children) {
        if (ignored(child.name)) continue
        const path = join(directory, child.name)
        const key = join(relative, child.name)
        try {
          if (child.isDirectory()) {
            entries.push([key, 'directory'])
            await visit(path, key)
          } else {
            // Do not follow links outside the session while checking metadata.
            const stats = await lstat(path)
            entries.push([key, stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino])
          }
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  await visit(root)
  return JSON.stringify(entries)
}

export async function watchSessionFiles(
  path: string,
  onChange: () => void,
  onError: (error: unknown) => void,
): Promise<SessionFileWatcher> {
  let previous: string | undefined
  try {
    previous = await fingerprint(path)
  } catch (error) {
    onError(error)
  }
  let closed = false
  let scanning = false
  let debounce: ReturnType<typeof setTimeout> | undefined

  const notify = () => {
    if (closed) return
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      if (!closed) onChange()
    }, 100)
  }

  const reconcile = async (): Promise<void> => {
    if (closed || scanning) return
    scanning = true
    try {
      const next = await fingerprint(path)
      if (!closed) {
        const changed = next !== previous
        previous = next
        if (changed) notify()
      }
    } catch (error) {
      if (!closed) onError(error)
    } finally {
      scanning = false
    }
  }

  const watcher = watch(path, { recursive: true }, (_event, filename) => {
    if (closed || (filename && String(filename).split(/[\\/]/).some(ignored))) return
    notify()
  })
  watcher.on('error', onError)
  // Native directory notifications can be lost. Reconcile visible metadata
  // while subscribed, without reading file contents or overlapping scans.
  const poll = setInterval(() => { void reconcile() }, 1000)
  poll.unref()
  return {
    close() {
      if (closed) return
      closed = true
      clearTimeout(debounce)
      clearInterval(poll)
      watcher.close()
    },
  }
}
