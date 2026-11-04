/** A synchronous native session view, published only by durable storage receipts. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@earendil-works/chord';
import {
  defineDoc, type CommitObservation, type CommitPublication, type Conversation,
  type Cursor, type EntryId, type EntryRecord, type Harness, type Tx,
} from '@earendil-works/pi-durable';
import type { AgentMessage } from '../agent-runtime.ts';
import {
  SessionManager, type SessionEntry, type SessionHeader,
} from '../pi/core/session-manager.ts';
import {
  clipFork, detached, importHistory, JOURNAL_KIND, json, nativeManager, persistProjection, type JournalState,
} from './session-journal-projection.ts';

const Journal = defineDoc({
  kind: JOURNAL_KIND, version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: (): JournalState => ({
    owner: 0, header: null, entries: [], ids: {}, records: [], overrides: {},
    leaf: null, compaction: null, start: 0, revision: 0, nonce: '',
  }),
  checkpointWhen: () => false,
});

interface Snapshot {
  header: SessionHeader;
  entries: SessionEntry[];
  leaf: string | null;
}
type Operation =
  | { type: 'append'; entry: SessionEntry }
  | { type: 'leaf'; id: string | null }
  | { type: 'replace'; snapshot: Snapshot };
interface Stage {
  manager: SessionManager;
  operations: Operation[];
  revision: number;
  ended: boolean;
  failure?: Error;
}
interface Candidate {
  stage: Stage;
  count: number;
}

export interface NativeSessionJournalOptions {
  harness: Harness;
  conversation: Conversation;
  context: Context;
  cwd: string;
  /** Used only when no journal has been stored yet, including legacy envelope migration. */
  header?: SessionHeader;
  onObserverError?(error: unknown): void;
}

export interface NativeMessageObserver {
  appended(message: AgentMessage, nativeId: string): void;
  committed(nativeId: string, durableId: EntryId): void;
  discarded?(nativeId: string): void;
}

/**
 * `manager` is a genuine SessionManager proxy, including its nominal TypeScript type.
 * Run each task invocation in `phase`, then call `commit(tx)` inside every runtime.commit
 * that should include its native writes. Await that runtime commit before starting another.
 * A failed callback/storage write drops its candidate; a successful receipt publishes before
 * runtime.commit resolves, even when the phase continues or waits for nested tasks.
 *
 * Idle synchronous writes remain local until `flush()` or the next phase's explicit commit.
 * `close()` discards them. No detached write or second scheduler is started by this adapter.
 */
export class NativeSessionJournal {
  readonly manager: SessionManager;
  private readonly local = new AsyncLocalStorage<Stage>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly stages = new Set<Stage>();
  private readonly messageObservers = new Set<NativeMessageObserver>();
  private readonly messageTags = new WeakMap<object, string>();
  private readonly taggedEntries = new Map<string, string>();
  private readonly observation: CommitObservation;
  private state: JournalState;
  private committed: SessionManager;
  private idle?: Stage;
  private closed = false;
  private failure?: Error;

  private constructor(private readonly options: NativeSessionJournalOptions, state: JournalState) {
    this.state = detached(state);
    this.committed = this.makeManager(state);
    this.manager = new Proxy(this.committed, {
      get: (_target, property) => {
        const value = Reflect.get(this.view(), property);
        if (typeof value !== 'function' || property === 'constructor') return value;
        return (...args: unknown[]) => {
          const mutates = typeof property === 'string' &&
            /^(append|branch|resetLeaf$|newSession$|setSessionFile$|createBranchedSession$|_persist$)/.test(property);
          const stage = mutates ? this.writable() : this.local.getStore() ?? this.idle;
          const manager = stage && !stage.ended ? stage.manager : this.committed;
          if (!mutates) return Reflect.apply(Reflect.get(manager, property), manager, args);
          const before = snapshot(manager);
          try {
            const result = Reflect.apply(Reflect.get(manager, property), manager, args);
            this.capture(stage!, before);
            if (property === 'appendMessage' && typeof result === 'string') {
              const tag = this.messageTag(args[0] as AgentMessage);
              if (tag) this.taggedEntries.set(result, tag);
              this.notify(observer => observer.appended(args[0] as AgentMessage, result));
            }
            return result;
          } catch (error) {
            // branchWithSummary changes its leaf before native _persist can throw.
            stage!.manager = this.makeManager(before);
            throw error;
          }
        };
      },
      set: (_target, property, value) => Reflect.set(this.writable().manager, property, value),
    });
    this.observation = options.harness.observeCommits({
      advance: publication => this.publish(publication),
      end: () => {
        this.failure = new Error('Native session journal lost its durable session');
        this.candidates.clear();
      },
    });
  }

  /** Opening is an explicit lifecycle barrier; migration and header initialization are atomic. */
  static async open(options: NativeSessionJournalOptions): Promise<NativeSessionJournal> {
    const state = await options.harness.commit(async tx => {
      const draft = await tx.doc(Journal, options.conversation.id);
      if (draft.header === null || draft.owner !== options.conversation.id) {
        const records: EntryRecord[] = [];
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanEntries({
            conversationId: options.conversation.id, order: 'ascending',
          }, 512, cursor);
          records.push(...page.items);
          cursor = page.next;
        } while (cursor);
        if (draft.header === null) {
          draft.header = json(options.header ??
            SessionManager.inMemory(options.cwd, { id: String(options.conversation.id) }).getHeader());
          importHistory(draft, records);
        } else {
          clipFork(draft, records, options.cwd);
          draft.revision++;
        }
        draft.owner = options.conversation.id;
      }
      return detached(draft);
    }, options.context);
    const journal = new NativeSessionJournal(options, state);
    // Attach before the read barrier so a commit racing open cannot be missed.
    try {
      const latest = await options.harness.snapshot(Journal, options.conversation.id, options.context);
      if (latest && latest.revision >= journal.state.revision) {
        journal.state = detached(latest);
        journal.committed = journal.makeManager(latest);
      }
    } catch (error) {
      journal.close();
      throw error;
    }
    return journal;
  }

  async phase<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    const stage = this.idle ?? this.stage();
    this.idle = undefined;
    try {
      return await this.local.run(stage, async () => {
        const result = await work();
        this.assertAvailable();
        if (stage.operations.length) throw new Error('Native session phase returned with uncommitted writes');
        return result;
      });
    } finally {
      stage.ended = true;
      this.stages.delete(stage);
      this.discardCandidates(stage);
      this.discardMessages(stage);
    }
  }

  /** Pair live message events with their exact native entry and later durable storage receipt. */
  observeMessages(observer: NativeMessageObserver): () => void {
    this.messageObservers.add(observer);
    return () => { this.messageObservers.delete(observer); };
  }

  tagMessage(message: AgentMessage, tag: string): void { this.messageTags.set(message, tag); }
  messageTag(message: AgentMessage): string | undefined { return this.messageTags.get(message); }
  tagEntry(message: AgentMessage, nativeId: string): void {
    const tag = this.messageTag(message);
    if (tag) this.taggedEntries.set(nativeId, tag);
  }

  /** Only tx reads/writes run here. Publication belongs to the later storage receipt. */
  async commit(tx: Tx): Promise<void> {
    this.assertAvailable();
    const stage = this.local.getStore() ?? this.idle;
    if (!stage || !stage.operations.length) return;
    if (stage.ended) throw new Error('Native session phase has ended');
    const count = stage.operations.length;
    const operations = detached(stage.operations.slice(0, count));
    const state = await tx.doc(Journal, this.options.conversation.id);
    if (operations.some(operation => operation.type === 'replace') && state.revision !== stage.revision) {
      throw new Error('Concurrent native session replacement requires a fresh phase');
    }
    const before = nativeManager(state, this.options.cwd);
    const merged = apply(snapshot(before), operations);
    const manager = this.makeManager(merged);
    const existing = new Set(before.getEntries().map(entry => entry.id));
    const added = merged.entries.filter(entry => !existing.has(entry.id));
    await persistProjection(tx, this.options.conversation.id, state, manager, added,
      operations.some(operation => operation.type !== 'append'));
    for (const entry of added) {
      const tag = this.taggedEntries.get(entry.id);
      if (tag) {
        state.tags ??= {};
        state.tags[tag] = entry.id;
      }
    }
    state.header = json(merged.header);
    // Push ordinary appends so durable records incremental document operations.
    if (operations.some(operation => operation.type === 'replace')) state.entries = json(merged.entries) as typeof state.entries;
    else state.entries.push(...json(added) as typeof state.entries);
    state.leaf = merged.leaf;
    state.revision++;
    const nonce = randomUUID();
    state.nonce = nonce;
    this.candidates.set(nonce, { stage, count });
  }

  /** Permitted outside-run lifecycle barrier. A failure drops the pending idle view. */
  async flush(): Promise<void> {
    this.assertAvailable();
    if (this.local.getStore()) throw new Error('Use the task runtime commit inside a native session phase');
    const stage = this.idle;
    if (this.stages.size > (stage ? 1 : 0)) throw new Error('Cannot flush while native session phases are active');
    if (!stage) return;
    try {
      await this.options.harness.commit(tx => this.commit(tx), this.options.context);
      this.assertAvailable();
      if (stage.operations.length) throw new Error('Native session flush did not receive a durable receipt');
    } finally {
      stage.ended = true;
      this.stages.delete(stage);
      if (this.idle === stage) this.idle = undefined;
      this.discardCandidates(stage);
      this.discardMessages(stage);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.observation.detach();
    for (const stage of this.stages) stage.ended = true;
    this.stages.clear();
    this.idle = undefined;
    this.candidates.clear();
    this.messageObservers.clear();
    this.taggedEntries.clear();
  }

  /** Committed identities only; provisional entries deliberately have no durable ID. */
  durableId(nativeId: string): EntryId | undefined {
    return this.state.ids[`$${nativeId}`];
  }

  /** Resolve an append inside the transaction that is also placing its original host submission. */
  async durableIdIn(tx: Tx, nativeId: string): Promise<EntryId | undefined> {
    return (await tx.doc(Journal, this.options.conversation.id)).ids[`$${nativeId}`];
  }

  async hasMessageTagIn(tx: Tx, tag: string): Promise<boolean> {
    return (await tx.doc(Journal, this.options.conversation.id)).tags?.[tag] !== undefined;
  }

  nativeIds(durableId: EntryId): string[] {
    return Object.entries(this.state.ids).filter(([, id]) => id === durableId).map(([id]) => id.slice(1));
  }

  /** Works after recovery when model/task message objects no longer share native object identity. */
  entryForMessage(message: AgentMessage): SessionEntry | undefined {
    const canonical = json(message);
    return this.view().getEntries().findLast(entry =>
      entry.type === 'message' && (entry.message === message || isDeepStrictEqual(json(entry.message), canonical)));
  }

  private stage(): Stage {
    const stage = { manager: this.makeManager(this.state), operations: [], revision: this.state.revision, ended: false };
    this.stages.add(stage);
    return stage;
  }

  private view(): SessionManager {
    const stage = this.local.getStore() ?? this.idle;
    return stage && !stage.ended ? stage.manager : this.committed;
  }

  private writable(): Stage {
    this.assertAvailable();
    const stage = this.local.getStore();
    if (stage?.ended) throw new Error('Native session phase has ended');
    return stage ?? (this.idle ??= this.stage());
  }

  private makeManager(state: Pick<JournalState, 'header' | 'entries' | 'leaf'> | Snapshot): SessionManager {
    const manager = nativeManager({
      header: json(state.header), entries: json(state.entries) as JournalState['entries'], leaf: state.leaf,
    }, this.options.cwd);
    manager._persist = entry => {
      this.assertAvailable();
      json(entry); // Throw synchronously while native append can still roll back.
    };
    return manager;
  }

  private capture(stage: Stage, before: Snapshot): void {
    const after = snapshot(stage.manager);
    const unchangedPrefix = before.header.id === after.header.id &&
      before.entries.every((entry, index) => JSON.stringify(entry) === JSON.stringify(after.entries[index]));
    if (!unchangedPrefix) {
      stage.operations.push({ type: 'replace', snapshot: detached(after) });
      return;
    }
    const added = after.entries.slice(before.entries.length);
    if (added.length) {
      if (added[0].parentId !== before.leaf) stage.operations.push({ type: 'leaf', id: added[0].parentId });
      for (const entry of added) stage.operations.push({ type: 'append', entry: detached(entry) });
    } else if (after.leaf !== before.leaf) stage.operations.push({ type: 'leaf', id: after.leaf });
  }

  private publish(publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (change.type !== 'document' || change.kind !== 'change' ||
        change.record.kind !== JOURNAL_KIND || change.conversationId !== this.options.conversation.id) continue;
      const state = detached(change.value) as JournalState;
      const candidate = this.candidates.get(state.nonce);
      this.state = state;
      // Never publish the mutable stage itself, even if the callback has already appended more.
      this.committed = this.makeManager(state);
      if (candidate) {
        candidate.stage.operations.splice(0, candidate.count);
        candidate.stage.revision = state.revision;
        this.candidates.delete(state.nonce);
      }
      for (const stage of this.stages) {
        try {
          stage.manager = this.makeManager(apply(snapshot(this.committed), stage.operations));
          if (!stage.operations.some(operation => operation.type === 'replace')) stage.revision = state.revision;
        } catch (error) {
          // A conflicting local branch must fail its phase without detaching the receipt observer.
          stage.failure = error instanceof Error ? error : new Error(String(error));
          stage.manager = this.makeManager(state);
          stage.operations = [];
        }
      }
    }
    for (const change of publication.changes) {
      if (change.type !== 'entry' || change.value.conversationId !== this.options.conversation.id) continue;
      for (const nativeId of this.nativeIds(change.value.id)) {
        this.notify(observer => observer.committed(nativeId, change.value.id));
      }
    }
  }

  private discardCandidates(stage: Stage): void {
    for (const [nonce, candidate] of this.candidates) if (candidate.stage === stage) this.candidates.delete(nonce);
  }

  private discardMessages(stage: Stage): void {
    for (const operation of stage.operations) {
      if (operation.type === 'append' && this.durableId(operation.entry.id) === undefined)
        this.notify(observer => observer.discarded?.(operation.entry.id));
    }
  }

  private notify(work: (observer: NativeMessageObserver) => void): void {
    for (const observer of this.messageObservers) {
      try { work(observer); } catch (error) {
        // Observation cannot roll back a native append or detach the storage receipt listener.
        try { this.options.onObserverError?.(error); } catch { /* Error reporting is observational too. */ }
      }
    }
  }

  private assertAvailable(): void {
    if (this.failure) throw this.failure;
    if (this.local.getStore()?.failure) throw this.local.getStore()!.failure;
    if (this.closed) throw new Error('Native session journal is closed');
  }
}

function snapshot(manager: SessionManager): Snapshot {
  return { header: manager.getHeader()!, entries: manager.getEntries(), leaf: manager.getLeafId() };
}

function apply(base: Snapshot, operations: Operation[]): Snapshot {
  let result = detached(base);
  for (const operation of operations) {
    if (operation.type === 'replace') result = detached(operation.snapshot);
    else if (operation.type === 'leaf') {
      if (operation.id !== null && !result.entries.some(entry => entry.id === operation.id)) {
        throw new Error(`Native branch target is no longer visible: ${operation.id}`);
      }
      result.leaf = operation.id;
    } else {
      if (result.entries.some(entry => entry.id === operation.entry.id)) continue;
      result.entries.push({ ...detached(operation.entry), parentId: result.leaf });
      result.leaf = operation.entry.id;
    }
  }
  return result;
}
