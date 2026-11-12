/** Persist native session metadata in the same durable history as model messages. */
import { copyJson, type Context, type JsonValue } from '@earendil-works/chord';
import { randomUUID } from 'node:crypto';
import type { Message } from '@earendil-works/pi-ai';
import {
  defineDoc, type ContextEdit, type Conversation, type Cursor, type EntryDraft, type EntryId, type EntryRecord, type Tx,
} from '@earendil-works/pi-durable';
import type { CodingEntry, CodingSessionStore } from './session-view.ts';
import type { CodingEntryDraft } from './entry-batch.ts';
import { SessionManager, sessionEntryToContextMessages } from './upstream/core/session-manager.js';
import {
  COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, convertToLlm,
} from './upstream/core/messages.js';
import { estimateProjectedContextTokens } from '@earendil-works/pi-coding-agent';

const ENTRY_KIND = 'mkagent.coding.entry.v1';
const EntryIndex = defineDoc({
  kind: 'mkagent.coding.entry-index', version: 1,
  scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: (): { ids: Record<string, EntryId> } => ({ ids: {} }),
  checkpointWhen: () => false,
});
const NextTurn = defineDoc({
  kind: 'mkagent.coding.next-turn', version: 1,
  scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: (): { items: Array<{ id: string; message: JsonValue }> } => ({ items: [] }),
  checkpointWhen: () => false,
});

interface Target {
  record: EntryRecord;
  index?: number;
}

export interface DurableCodingStoreOptions {
  id: string;
  cwd: string;
  sessionPath: string;
  conversation(): Conversation;
  context: Context;
}

export class DurableCodingSessionStore implements CodingSessionStore {
  readonly id: string;
  readonly cwd: string;
  readonly sessionPath: string;
  private readonly targets = new Map<string, Target>();
  private snapshot: CodingEntry[] = [];

  constructor(private readonly options: DurableCodingStoreOptions) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sessionPath = options.sessionPath;
  }

  /** Reconstruct a stable native branch from a bounded, fork-aware raw history. */
  async read(): Promise<CodingEntry[]> {
    const conversation = this.options.conversation();
    const { context } = this.options;
    const tail = (await conversation.entries({}, 1, undefined, context)).items[0]?.id;
    const raw: EntryRecord[] = [];
    if (tail !== undefined) {
      let cursor: Cursor | undefined;
      do {
        const page = await conversation.entries({ order: 'ascending', maxEntryId: tail }, 512, cursor, context);
        raw.push(...page.items);
        cursor = page.next;
      } while (cursor);
    }
    const entries: CodingEntry[] = [];
    const firstIds = new Map<EntryId, string>();
    this.targets.clear();
    let parentId: string | null = null;
    const add = (entry: CodingEntry, record: EntryRecord, index?: number) => {
      entry.durableEntryOrder = record.id;
      if (record.head !== undefined) entry.durableHead = record.head;
      if (!firstIds.has(record.id)) entry.durableContext = {
        id: record.id, kind: record.kind, model: record.model, head: record.head, edits: record.edits,
      };
      entry.parentId = parentId;
      parentId = entry.id;
      firstIds.set(record.id, firstIds.get(record.id) ?? entry.id);
      this.targets.set(entry.id, { record, index });
      entries.push(entry);
    };
    for (const record of raw) {
      const timestamp = new Date(record.model?.[0]?.timestamp ?? 0).toISOString();
      const base = { id: `d-${record.id}-0`, parentId, timestamp };
      if (record.kind === ENTRY_KIND) {
        // Only this adapter writes this versioned payload; detach the stored JSON.
        add(JSON.parse(JSON.stringify(record.data)), record, record.model?.length ? 0 : undefined);
      } else if (record.head !== undefined) {
        if (record.kind === 'pi.compaction') {
          const text = record.model?.flatMap(message => typeof message.content === 'string'
            ? [message.content] : message.content.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n') ?? '';
          const summary = text.startsWith(COMPACTION_SUMMARY_PREFIX) && text.endsWith(COMPACTION_SUMMARY_SUFFIX)
            ? text.slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length) : text;
          const manager = this.manager(entries);
          add({
            ...base, type: 'compaction', summary,
            firstKeptEntryId: record.head === record.id ? base.id : firstIds.get(record.head),
            tokensBefore: estimateProjectedContextTokens(manager.buildSessionProjection(), manager.getBranch()).tokens,
          }, record, 0);
          // A core compaction may carry arbitrary valid messages, not only Pi's wrapped summary.
          entries.at(-1)!.durableModelMessages = record.model ?? [];
          entries.at(-1)!.durableBaseMessages = record.model ?? [];
        } else {
          // A reset starts a new branch path while retaining old entries for history.
          if (record.head === record.id) parentId = null;
          add({ ...base, type: 'custom', customType: record.head === record.id ? 'durable.reset' : 'durable.head', data: record.data }, record);
          for (const [index, message] of (record.model ?? []).entries()) {
            add({ ...base, id: `d-${record.id}-m${index}`, type: 'message', message }, record, index);
          }
        }
      } else {
        for (const [index, message] of (record.model ?? []).entries()) {
          add({ ...base, id: `d-${record.id}-${index}`, type: 'message', message }, record, index);
        }
        if (!record.model?.length) add({
          ...base, type: 'custom', customType: 'durable.entry', data: { kind: record.kind, data: record.data },
        }, record);
      }
      for (const edit of record.edits ?? []) {
        const affected = [...this.targets].filter(([, target]) => target.record.id === edit.target);
        const assigned = new Map<string, unknown[]>();
        const orders = new Map<string, number[]>();
        const payload = record.kind === ENTRY_KIND ? record.data as CodingEntry : undefined;
        const sources = payload?.durableEditSources as string[] | undefined;
        if (edit.action === 'replace') for (const [position, message] of edit.messages.entries()) {
          const exact = affected.find(([id]) => {
            const entry = entries.find(item => item.id === id)!;
            return convertToLlm(sessionEntryToContextMessages(entry))
              .some((original: Message) => JSON.stringify(original) === JSON.stringify(message));
          });
          const id = sources?.[position] ?? exact?.[0] ?? affected[0]?.[0];
          if (id) {
            assigned.set(id, [...(assigned.get(id) ?? []), message]);
            orders.set(id, [...(orders.get(id) ?? []), position]);
          }
        }
        for (const [id] of affected) {
          const entry = entries.find(item => item.id === id)!;
          entry.durableBaseMessages ??= sessionEntryToContextMessages(entry);
          entry.durableBaseOrder ??= (entry.durableBaseMessages as unknown[]).map((_, index) =>
            (this.targets.get(id)!.index ?? 0) + index);
          // Durable edits replace an entire contribution, including its roles, timestamps and message count.
          entry.durableModelMessages = assigned.get(id) ?? [];
          entry.durableMessageOrder = orders.get(id) ?? [];
          // An empty contribution hides the message; a later native replacement still edits its original identity.
          if (payload?.type !== 'context_edit' && assigned.has(id)) {
            entry.durableBaseMessages = entry.durableModelMessages;
            entry.durableBaseOrder = entry.durableMessageOrder;
          }
          entry.durableModelOrder = record.id;
        }
      }
    }
    this.snapshot = entries;
    return entries;
  }

  /** Retry metadata writes by native ID, atomically with their duplicate index. */
  async append(entries: CodingEntry[]): Promise<void> {
    const drafts = this.compile(entries);
    if (drafts.some(draft => draft.model || draft.head !== undefined || draft.edits)) {
      throw new Error('Model-visible native entries require a durable boundary or write submission');
    }
    const conversation = this.options.conversation();
    await conversation.commit(async tx => {
      const index = await tx.doc(EntryIndex, conversation.id);
      for (const [position, entry] of entries.entries()) {
        const key = `$${entry.id}`;
        if (this.targets.has(entry.id) || Object.hasOwn(index.ids, key)) continue;
        const stored = await tx.appendEntry(conversation.id, drafts[position]!);
        index.ids[key] = stored.id;
      }
    }, this.options.context);
  }

  /** Keep next-input context durable without adding it to the current history. */
  async queueNextTurn(message: unknown): Promise<void> {
    const item = { id: randomUUID(), message: copyJson(message, { omitUndefinedProperties: true }) };
    const conversation = this.options.conversation();
    await conversation.commit(async tx => {
      (await tx.doc(NextTurn, conversation.id)).items.push(item);
    }, this.options.context);
  }

  async pendingNextTurn(): Promise<Array<{ id: string; message: JsonValue }>> {
    const conversation = this.options.conversation();
    return conversation.commit(async tx => {
      const pending = await tx.doc(NextTurn, conversation.id);
      // Durable tracks document mutation with proxies; Chord copies their JSON values.
      return pending.items.map(item => ({ id: item.id, message: copyJson(item.message) }));
    }, this.options.context);
  }

  /** Remove precisely the messages appended by this input's transaction. */
  async consumeNextTurn(tx: Tx, ids: string[]): Promise<void> {
    const pending = await tx.doc(NextTurn, this.options.conversation().id);
    const consumed = new Set(ids);
    pending.items = pending.items.filter(item => !consumed.has(item.id));
  }

  /** Compile validated native entries into durable context edits and head markers. */
  compile(entries: CodingEntry[]): CodingEntryDraft[] {
    const source = this.snapshot.slice();
    const local = new Map<string, number>();
    return entries.map((entry, position) => {
      local.set(entry.id, position);
      source.push(entry);
      const manager = this.manager(source);
      const projection = manager.buildSessionProjection();
      const draft: EntryDraft = { kind: ENTRY_KIND, data: JSON.parse(JSON.stringify(entry)) };
      if (entry.type === 'custom_message' || entry.type === 'message') {
        return { ...draft, model: this.messages(projection, new Set([entry.id])) };
      }
      if (entry.type === 'context_edit') {
        const target = this.resolveEntry(String(entry.targetId));
        const reference = local.get(String(entry.targetId));
        if (target === undefined && reference === undefined) throw new Error(`Context edit target is not persisted: ${entry.targetId}`);
        return {
          ...draft, data: { ...entry, durableEditSources: this.messageSources(projection, target, String(entry.targetId)) },
          edits: [this.edit(projection, target, String(entry.targetId))],
          ...(target === undefined ? { references: { edits: { 0: reference! } } } : {}),
        };
      }
      if (entry.type === 'compaction') {
        const self = entry.firstKeptEntryId === null || entry.firstKeptEntryId === entry.id;
        const target = self ? undefined : this.resolveEntry(String(entry.firstKeptEntryId));
        const reference = self ? undefined : local.get(String(entry.firstKeptEntryId));
        if (!self && target === undefined && reference === undefined) throw new Error(`Compaction target is not persisted: ${entry.firstKeptEntryId}`);
        return {
          ...draft, data: { ...entry, durableEditSources: this.messageSources(projection, target, String(entry.firstKeptEntryId)) },
          head: target ?? 'self', model: this.messages(projection, new Set([entry.id])),
          ...(self ? {} : { edits: [this.edit(projection, target, String(entry.firstKeptEntryId))] }),
          ...(reference === undefined || target !== undefined ? {} : { references: { head: reference, edits: { 0: reference } } }),
        };
      }
      return draft;
    });
  }

  /** Resolve native branch anchors only among entries visible in this conversation. */
  resolveEntry(id: string): EntryId | undefined {
    return this.targets.get(id)?.record.id;
  }

  /** Find the stable native ID of a committed durable message entry. */
  nativeId(id: EntryId): string | undefined {
    return [...this.targets].find(([, target]) => target.record.id === id)?.[0];
  }

  private manager(entries: CodingEntry[]) {
    return SessionManager.inMemory(this.cwd, { id: this.id }, [
      { type: 'session', version: 3, id: this.id, cwd: this.cwd, timestamp: new Date(0).toISOString() },
      ...entries,
    ]);
  }

  private edit(projection: ReturnType<SessionManager['buildSessionProjection']>, target: EntryId | undefined, nativeId: string): ContextEdit {
    const nativeIds = target === undefined ? new Set([nativeId])
      : new Set([...this.targets].filter(([, item]) => item.record.id === target).map(([id]) => id));
    const messages = this.messages(projection, nativeIds);
    // The batch appender replaces zero with the earlier draft's committed ID.
    const id = target ?? 0 as EntryId;
    return messages.length ? { target: id, action: 'replace', messages } : { target: id, action: 'omit' };
  }

  private messageSources(projection: ReturnType<SessionManager['buildSessionProjection']>, target: EntryId | undefined, nativeId: string): string[] {
    return projection.entries.flatMap((item: { sourceEntry: CodingEntry; messages: unknown[] }) =>
      (target === undefined ? item.sourceEntry.id === nativeId : this.resolveEntry(item.sourceEntry.id) === target)
        ? convertToLlm(item.messages).map(() => item.sourceEntry.id) : []);
  }

  private messages(projection: ReturnType<SessionManager['buildSessionProjection']>, ids: Set<string>): Message[] {
    return convertToLlm(projection.entries
      .filter((item: { sourceEntry: CodingEntry }) => ids.has(item.sourceEntry.id))
      .flatMap((item: { messages: unknown[] }) => item.messages));
  }
}
