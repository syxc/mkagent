/** Native synchronous projections over entries committed by the durable host. */
import { SessionManager } from './upstream/core/session-manager.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { copyJson } from '@earendil-works/chord';
import type { EntryId } from '@earendil-works/pi-durable';
import type { CodingEntryDraft } from './entry-batch.ts';
import { _applyBoundaryDrafts } from './upstream/core/boundary-drafts.js';
import { estimateProjectedContextTokens } from './upstream/core/context-tokens.js';

export interface CodingEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface CodingSessionStore {
  id: string;
  cwd: string;
  sessionPath: string;
  read(): Promise<CodingEntry[]>;
  append(entries: CodingEntry[]): Promise<void>;
  compile?(entries: CodingEntry[]): CodingEntryDraft[];
  nativeId?(id: EntryId): string | undefined;
}

const READ_METHODS = [
  'getCwd', 'getSessionDir', 'getSessionId', 'getSessionFile', 'getLeafId',
  'getLeafEntry', 'getEntry', 'getLabel', 'getBranch', 'buildContextEntries',
  'buildSessionProjection', 'getHeader', 'getEntries', 'getTree', 'getSessionName',
] as const;

export class CodingSessionView {
  private snapshot;
  private readonly pending: CodingEntry[] = [];
  private operations: Promise<unknown> = Promise.resolve();
  private readonly stages = new AsyncLocalStorage<{
    manager: SessionManager; entries: CodingEntry[]; active: boolean;
  }>();
  readonly view: Record<string, unknown>;

  constructor(private readonly store: CodingSessionStore) {
    this.snapshot = SessionManager.inMemory(store.cwd, { id: store.id });
    this.view = Object.fromEntries(READ_METHODS.map(name => [name, (...args: unknown[]) => {
      if (name === 'getSessionDir') return store.sessionPath;
      if (name === 'getSessionFile') return undefined;
      return Reflect.apply(this.current[name], this.current, args);
    }]));
  }

  async refresh(): Promise<void> {
    if (this.stages.getStore()?.active) return;
    await this.serialize(async () => {
      await this.flushPending();
      const entries = await this.store.read();
      // Synchronous plugin writes can arrive during the store read.
      const persisted = new Set(entries.map(entry => entry.id));
      const pending = this.pending.filter(entry => !persisted.has(entry.id));
      let parentId = entries.at(-1)?.id ?? null;
      for (const entry of pending) {
        entry.parentId = parentId;
        parentId = entry.id;
      }
      this.pending.splice(0, this.pending.length, ...pending);
      const header = this.snapshot.getHeader();
      this.snapshot = SessionManager.inMemory(this.store.cwd, { id: this.store.id }, [header, ...entries, ...pending]);
    });
  }

  appendEntry(customType: string, data: unknown): void {
    // Validate and detach plugin data before changing the visible branch.
    const json = data === undefined ? undefined : copyJson(data, { omitUndefinedProperties: true });
    this.capture(() => this.current.appendCustomEntry(customType, json));
  }

  setSessionName(name: string): void {
    this.capture(() => this.current.appendSessionInfo(name));
  }

  getSessionName(): string | undefined {
    return this.current.getSessionName();
  }

  contextTokens(): number {
    return estimateProjectedContextTokens(this.current.buildSessionProjection(), this.current.getBranch()).tokens;
  }

  setLabel(entryId: string, label: string | undefined): void {
    this.capture(() => this.current.appendLabelChange(entryId, label));
  }

  private capture(append: () => string): void {
    const id = append();
    const stage = this.stages.getStore();
    (stage?.active ? stage.entries : this.pending).push(this.current.getEntry(id));
  }

  async flush(): Promise<void> {
    if (this.stages.getStore()?.active) return;
    await this.serialize(() => this.flushPending());
  }

  /** Preview native drafts with the upstream validation and projection code. */
  preview(drafts: unknown[]) {
    // Plugin drafts cross into durable JSON while the upstream runner can report invalid entries.
    copyJson(drafts, { omitUndefinedProperties: true });
    const manager = SessionManager.inMemory(this.store.cwd, undefined, [
      this.current.getHeader(), ...this.current.getBranch(),
    ]);
    const entries: CodingEntry[] = _applyBoundaryDrafts(manager, drafts);
    return { manager, entries };
  }

  /** Capture synchronous plugin writes without persisting a speculative boundary. */
  async stage<T>(operation: () => Promise<T>): Promise<{ result: T; entries: CodingEntry[] }> {
    await this.refresh();
    const scope = { manager: this.preview([]).manager, entries: [] as CodingEntry[], active: true };
    try {
      return await this.stages.run(scope, async () => ({ result: await operation(), entries: scope.entries }));
    } finally {
      scope.active = false;
    }
  }

  private get current(): SessionManager {
    const stage = this.stages.getStore();
    return stage?.active ? stage.manager : this.snapshot;
  }

  private async flushPending(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.slice();
      await this.store.append(batch);
      this.pending.splice(0, batch.length);
    }
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.operations.then(operation);
    // A failed append stays pending. The caller sees the failure and may retry.
    this.operations = next.catch(() => {});
    return next;
  }
}
