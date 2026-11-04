import { writeFile, rename } from 'fs/promises'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
}

interface ActiveWrite {
  promise: Promise<void>
  cancellation: { cancelled: boolean }
}

interface HeaderMetadataSignature {
  name?: string
  isFlagged?: boolean
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    isFlagged: header.isFlagged,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    isFlagged: diskHeader.isFlagged,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive enqueues into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, ActiveWrite>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private debounceMs: number

  constructor(debounceMs = 500) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      void this.flush(session.id)
    }, this.debounceMs)

    this.pending.set(session.id, { data: session, timer })
  }

  /**
   * Persist a snapshot through the same writer as debounced saves.
   * Resolves after replacement succeeds and rejects on a write failure.
   */
  persist(session: StoredSession): Promise<void> {
    this.takePending(session.id)
    return this.scheduleWrite(session, true)
  }

  private takePending(sessionId: string): StoredSession | undefined {
    const entry = this.pending.get(sessionId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(sessionId)
    return entry.data
  }

  private async scheduleWrite(data: StoredSession, requireReceipt: boolean): Promise<void> {
    const sessionId = data.id
    const inProgress = this.writeInProgress.get(sessionId)
    const cancellation = inProgress && !inProgress.cancellation.cancelled
      ? inProgress.cancellation
      : { cancelled: false }
    // A failed receipt must not poison later saves. Each caller still observes
    // the result of its own write, even when another write follows immediately.
    const writePromise = (inProgress?.promise.catch(() => {}) ?? Promise.resolve()).then(() => {
      if (cancellation.cancelled) {
        if (requireReceipt) throw new Error(`Session persistence cancelled: ${sessionId}`)
        return
      }
      return this.write(data)
    })
    const active = { promise: writePromise, cancellation }
    this.writeInProgress.set(sessionId, active)
    try {
      await writePromise
    } finally {
      if (this.writeInProgress.get(sessionId) === active) {
        this.writeInProgress.delete(sessionId)
      }
    }
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(data: StoredSession): Promise<void> {
    const sessionId = data.id
    const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
    let finalSignature: string | undefined
    try {
      ensureSessionsDir(data.workspaceRootPath)
      ensureSessionDir(data.workspaceRootPath, sessionId)

      const filePath = getSessionFilePath(data.workspaceRootPath, sessionId)

      // Prepare session with portable paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
        lastUsedAt: Date.now(),
      }

      // Create JSONL content: header + messages (one per line)
      // Filter out intermediate messages - they're transient streaming status updates
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)
      const lines = [
        makeSessionPathPortable(JSON.stringify(header), sessionDir),
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ]

      // Atomic write: write to .tmp then rename over the real file.
      // If the process crashes mid-write, only the .tmp is corrupted —
      // the original session.jsonl remains intact.
      //
      // Update signature BEFORE the write so that fs.watch events fired
      // during replacement are correctly identified as self-writes.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions.
      finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(sessionId, finalSignature)

      const tmpFile = filePath + '.tmp'
      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      await rename(tmpFile, filePath)
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
    } catch (error) {
      if (finalSignature !== undefined && this.lastWrittenHeaderSignature.get(sessionId) === finalSignature) {
        if (previousSig === undefined) this.lastWrittenHeaderSignature.delete(sessionId)
        else this.lastWrittenHeaderSignature.set(sessionId, previousSig)
      }
      throw error
    }
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string): Promise<void> {
    // Claim this snapshot before yielding; a queued flush must not consume
    // newer data admitted after a strict receipt was requested.
    const data = this.takePending(sessionId)
    try {
      await (data ? this.scheduleWrite(data, false) : this.writeInProgress.get(sessionId)?.promise)
    } catch (error) {
      // Timer-driven saves retain their best-effort behavior. Transactions
      // that require an acknowledgement use persist() instead.
      console.error(`[PersistenceQueue] Failed to write session ${sessionId}:`, error)
    }
  }

  /**
   * Cancel writes that have not started (e.g., when deleting the session).
   * An active filesystem operation must finish before its directory is removed.
   */
  cancel(sessionId: string): void {
    const inProgress = this.writeInProgress.get(sessionId)
    if (inProgress) inProgress.cancellation.cancelled = true
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    this.lastWrittenHeaderSignature.delete(sessionId)
  }

  /**
   * Drain all pending and active writes. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    while (this.pending.size || this.writeInProgress.size) {
      const sessionIds = new Set([...this.pending.keys(), ...this.writeInProgress.keys()])
      await Promise.all([...sessionIds].map(id => this.flush(id)))
    }
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
