/** Rebuild native path APIs from receipts without creating another session writer. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeSessionJournal, NativeSessionSnapshot } from '@mkagent/pi-durable-coding/durable';

interface NativeSessionManifest {
  version: 1;
  sessionId: string;
  nativeSessionId: string;
  conversationId: number;
  revision: number;
  treeRevision?: number;
  sessionFile: string;
  leaf: string | null;
  name: string | null;
  digest: string;
  entryIds: NativeSessionSnapshot['entryIds'];
}

export interface NativeSessionDescriptor extends NativeSessionManifest {
  manifestDigest: string;
  /** Receipt metadata, derived from the committed full tree; not part of the v1 manifest. */
  hasName: boolean;
}

interface ProjectionOptions {
  sessionPath: string;
  sessionId: string;
  published?(descriptor: NativeSessionDescriptor): void;
  error?(error: unknown): void;
}

export function nativeSessionPaths(sessionPath: string) {
  return {
    sessionFile: join(sessionPath, 'native-session', 'session.jsonl'),
    manifestFile: join(sessionPath, 'meta', 'native-session.json'),
  };
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Encode exactly the bytes used by path projection and paused-store verification. */
export function encodeNativeSessionProjection(
  snapshot: NativeSessionSnapshot, options: Pick<ProjectionOptions, 'sessionPath' | 'sessionId'>,
) {
  const jsonl = [snapshot.header, ...snapshot.entries].map(value => JSON.stringify(value)).join('\n') + '\n';
  const manifest: NativeSessionManifest = {
    version: 1, sessionId: options.sessionId, nativeSessionId: snapshot.header.id,
    conversationId: snapshot.conversationId, revision: snapshot.revision,
    sessionFile: nativeSessionPaths(options.sessionPath).sessionFile, leaf: snapshot.leaf, name: snapshot.name,
    digest: digest(jsonl), entryIds: snapshot.entryIds,
    ...(snapshot.treeRevision === undefined ? {} : { treeRevision: snapshot.treeRevision }),
  };
  const metadata = JSON.stringify(manifest) + '\n';
  return { jsonl, metadata, descriptor: { ...manifest, manifestDigest: digest(metadata),
    hasName: snapshot.entries.some(entry => entry.type === 'session_info') } };
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Native projection directory must not be a symlink');
}

async function replace(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {}); // The successful rename has already consumed the temporary.
  }
}

export class NativeSessionProjection {
  readonly paths;
  private pending = Promise.resolve();
  private descriptor?: NativeSessionDescriptor;
  private failure?: unknown;
  private closed = false;
  private readonly detach: () => void;

  constructor(private readonly journal: NativeSessionJournal, private readonly options: ProjectionOptions) {
    this.paths = nativeSessionPaths(options.sessionPath);
    this.detach = journal.observeCommitted(snapshot => this.enqueue(snapshot));
    this.enqueue(journal.committedSnapshot());
  }

  private report(error: unknown): void {
    try { this.options.error?.(error); } catch { /* Diagnostics cannot reject a journal receipt. */ }
  }

  private enqueue(snapshot: NativeSessionSnapshot): void {
    if (this.closed) return;
    this.pending = this.pending.then(async () => {
      const { jsonl, metadata, descriptor } = encodeNativeSessionProjection(snapshot, this.options);
      await directory(join(this.options.sessionPath, 'native-session'));
      await directory(join(this.options.sessionPath, 'meta'));
      await replace(this.paths.sessionFile, jsonl);
      // A torn pair fails digest validation until a later receipt or explicit rebuild repairs it.
      await replace(this.paths.manifestFile, metadata);
      this.descriptor = descriptor;
      this.failure = undefined;
      try { this.options.published?.(structuredClone(this.descriptor)); }
      catch (error) { this.report(error); }
    }).catch(error => {
      this.failure = error;
      this.report(error);
    });
  }

  /** Wait for every receipt already observed, including receipts arriving while IO is pending. */
  async flush(): Promise<NativeSessionDescriptor> {
    let pending: Promise<void>;
    do {
      pending = this.pending;
      await pending;
    } while (pending !== this.pending);
    if (this.failure !== undefined || !this.descriptor) {
      throw new Error('Native session projection failed; its journal commit remains authoritative', { cause: this.failure });
    }
    return structuredClone(this.descriptor);
  }

  /** Retrying projection IO never runs a native hook or repeats an already committed task. */
  rebuild(): Promise<NativeSessionDescriptor> {
    if (this.closed) return Promise.reject(new Error('Native session projection is closed'));
    this.enqueue(this.journal.committedSnapshot());
    return this.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.detach();
    await this.pending;
  }
}

function manifest(value: unknown, sessionFile: string): value is NativeSessionManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.sessionId !== 'string' || !item.sessionId
    || typeof item.nativeSessionId !== 'string' || !item.nativeSessionId
    || !Number.isSafeInteger(item.conversationId) || Number(item.conversationId) < 0
    || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0
    || (item.treeRevision !== undefined && (!Number.isSafeInteger(item.treeRevision)
      || Number(item.treeRevision) < 1 || Number(item.treeRevision) > Number(item.revision)))
    || item.sessionFile !== sessionFile || (item.leaf !== null && typeof item.leaf !== 'string')
    || (item.name !== null && typeof item.name !== 'string')
    || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest)
    || !Array.isArray(item.entryIds)) return false;
  const ids = new Set<string>();
  for (const entry of item.entryIds) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.nativeId !== 'string' || !entry.nativeId || ids.has(entry.nativeId)
      || !Number.isSafeInteger(entry.durableId) || entry.durableId < 0
      || (entry.productMessageId !== undefined && (typeof entry.productMessageId !== 'string' || !entry.productMessageId))) return false;
    ids.add(entry.nativeId);
  }
  return item.leaf === null || ids.has(item.leaf);
}

/** Callers must also match this result to their trusted product record before switching. */
export async function readNativeSessionDescriptor(sessionPath: string): Promise<NativeSessionDescriptor> {
  const paths = nativeSessionPaths(sessionPath);
  const [metadata, jsonl] = await Promise.all([
    readFile(paths.manifestFile, 'utf8'), readFile(paths.sessionFile, 'utf8'),
  ]);
  const value: unknown = JSON.parse(metadata);
  if (!manifest(value, paths.sessionFile) || value.digest !== digest(jsonl)) throw new Error('Native session projection does not match its manifest');
  const header: unknown = JSON.parse(jsonl.slice(0, jsonl.indexOf('\n')));
  if (!header || typeof header !== 'object' || !('id' in header) || header.id !== value.nativeSessionId) {
    throw new Error('Native projection session identity does not match');
  }
  return { ...value, manifestDigest: digest(metadata),
    hasName: jsonl.trimEnd().split('\n').slice(1).some(line => JSON.parse(line).type === 'session_info') };
}
