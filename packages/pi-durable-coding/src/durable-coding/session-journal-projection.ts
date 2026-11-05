/** Translate native contributions to durable heads and edits, without resetting the transcript. */
import { copyJson, type JsonValue } from '@earendil-works/chord';
import type {
  ContextEdit, ConversationId, EntryDraft, EntryId, EntryRecord, Tx,
} from '@earendil-works/pi-durable';
import { convertToLlm } from '../pi/core/messages.ts';
import {
  SessionManager, sessionEntryToContextMessages,
  type SessionEntry, type SessionHeader, type SessionProjection,
} from '../pi/core/session-manager.ts';
import { contextBoundary, installLegacyProjection, LEGACY_EDIT, LEGACY_HEAD } from './legacy-session-context.ts';

export const NATIVE_ENTRY_KIND = 'mkagent.coding.entry.v1';
export const JOURNAL_KIND = 'mkagent.coding.native-journal';

type Contribution = { id: EntryId; model: JsonValue[]; head: boolean };
export type JournalState = {
  owner: number;
  header: JsonValue;
  entries: JsonValue[];
  ids: Record<string, EntryId>;
  records: Contribution[];
  overrides: Record<string, { by: EntryId; messages: JsonValue[] }>;
  leaf: string | null;
  compaction: string | null;
  start: number;
  revision: number;
  treeRevision?: number;
  nonce: string;
  tags?: Record<string, string>;
  productMessages?: Record<string, string>;
};

export function json(value: unknown): JsonValue {
  return copyJson(value, { omitUndefinedProperties: true });
}

export function detached<T>(value: T): T {
  // Values cross this boundary only after native JSON validation or durable schema validation.
  return json(value) as T;
}

export function nativeManager(state: Pick<JournalState, 'header' | 'entries' | 'leaf'>, cwd: string): SessionManager {
  const manager = SessionManager.inMemory(cwd, undefined, [
    detached(state.header) as unknown as SessionHeader,
    ...detached(state.entries) as unknown as SessionEntry[],
  ]);
  if (state.leaf === null) manager.resetLeaf();
  else manager.branch(state.leaf);
  return installLegacyProjection(manager);
}

function messages(entry: SessionEntry) {
  return convertToLlm(sessionEntryToContextMessages(entry));
}

/** Seed a journal from the previous native envelope and ordinary durable message entries. */
export function importHistory(state: JournalState, records: EntryRecord[]): void {
  let parentId: string | null = null;
  for (const record of records) {
    state.records.push({
      id: record.id, model: json(record.model ?? []) as JsonValue[], head: record.head !== undefined,
    });
    if (record.head !== undefined) state.start = record.head;
    const add = (entry: SessionEntry) => {
      state.entries.push(json(entry));
      state.ids[`$${entry.id}`] = record.id;
      parentId = entry.id;
    };
    if (record.kind === NATIVE_ENTRY_KIND) {
      const entry = detached(record.data) as unknown as SessionEntry;
      if (!entry || typeof entry.id !== 'string' || typeof entry.type !== 'string') {
        throw new Error(`Invalid native session envelope at durable entry ${record.id}`);
      }
      add(entry);
      if (contextBoundary(entry)) state.compaction = entry.id;
    } else {
      if (record.head !== undefined) {
        const id = `d-${record.id}-head`;
        const first = state.entries.find(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
          && typeof entry.id === 'string' && state.ids[`$${entry.id}`] >= record.head!);
        const firstKeptEntryId = first && typeof first === 'object' && !Array.isArray(first) ? String(first.id) : id;
        add({ type: 'custom', customType: LEGACY_HEAD, id, parentId, timestamp: new Date(0).toISOString(),
          data: { firstKeptEntryId, messages: detached(record.model ?? []) } });
        state.compaction = id;
      } else for (const [index, message] of (record.model ?? []).entries()) add({
        type: 'message', id: `d-${record.id}-${index}`, parentId,
        timestamp: new Date(message.timestamp).toISOString(), message: detached(message),
      });
      if (record.head === undefined && !record.model?.length) add({
        type: 'custom', customType: 'durable.entry', id: `d-${record.id}-0`, parentId,
        timestamp: new Date(0).toISOString(), data: { kind: record.kind, data: record.data },
      });
      for (const [index, edit] of (record.edits ?? []).entries()) add({
        type: 'custom', customType: LEGACY_EDIT, id: `d-${record.id}-edit-${index}`, parentId,
        timestamp: new Date(0).toISOString(),
        data: { targets: Object.entries(state.ids).filter(([, id]) => id === edit.target).map(([id]) => id.slice(1)),
          messages: detached(edit.action === 'replace' ? edit.messages : []) },
      });
    }
    for (const edit of record.edits ?? []) {
      state.overrides[String(edit.target)] = {
        by: record.id, messages: json(edit.action === 'replace' ? edit.messages : []) as JsonValue[],
      };
    }
  }
  state.leaf = parentId;
}

/** A rewindable document is transaction-granular; a fork can cut inside that transaction. */
export function clipFork(state: JournalState, records: EntryRecord[], cwd: string): void {
  const visible = new Map(records.map(record => [record.id, record]));
  const entries = state.entries as unknown as SessionEntry[];
  const kept = entries.filter(entry => visible.has(state.ids[`$${entry.id}`]));
  if (kept.length !== entries.length) state.leaf = kept.at(-1)?.id ?? null;
  state.entries = json(kept) as JsonValue[];
  state.ids = Object.fromEntries(Object.entries(state.ids).filter(([, id]) => visible.has(id)));
  if (state.tags) state.tags = Object.fromEntries(Object.entries(state.tags)
    .filter(([, nativeId]) => state.ids[`$${nativeId}`] !== undefined));
  if (state.productMessages) state.productMessages = Object.fromEntries(Object.entries(state.productMessages)
    .filter(([nativeId]) => state.ids[nativeId] !== undefined));
  // A host may remap model file references in a copied store before opening it.
  state.records = state.records.filter(record => visible.has(record.id)).map(record => ({
    ...record, model: json(visible.get(record.id)!.model ?? []) as JsonValue[],
  }));
  state.overrides = {};
  state.start = 0;
  for (const record of records) {
    if (record.head !== undefined) state.start = record.head;
    for (const edit of record.edits ?? []) state.overrides[String(edit.target)] = {
      by: record.id, messages: json(edit.action === 'replace' ? edit.messages : []) as JsonValue[],
    };
  }
  const projection = nativeManager(state, cwd).buildSessionProjection();
  state.compaction = projection.entries[0] && contextBoundary(projection.entries[0].sourceEntry)
    ? projection.entries[0].sourceEntry.id : null;
}

/**
 * Each native message has one durable owner. Branches restore or hide those owners with edits;
 * only a compaction checkpoint/summary is carried by a new head marker.
 */
export async function persistProjection(
  tx: Tx, conversation: ConversationId, state: JournalState, manager: SessionManager,
  added: SessionEntry[], branched: boolean,
): Promise<void> {
  const finalLeaf = manager.getLeafId();
  let leaf = state.leaf;
  const projectionAt = (id: string | null) => {
    if (id === null) manager.resetLeaf();
    else manager.branch(id);
    return manager.buildSessionProjection();
  };
  const append = async (draft: EntryDraft) => {
    const record = await tx.appendEntry(conversation, draft);
    state.records.push({
      id: record.id, model: json(record.model ?? []) as JsonValue[], head: record.head !== undefined,
    });
    for (const edit of record.edits ?? []) state.overrides[String(edit.target)] = {
      by: record.id, messages: json(edit.action === 'replace' ? edit.messages : []) as JsonValue[],
    };
    if (record.head !== undefined) state.start = record.head;
    return record;
  };
  const branch = async (id: string | null) => {
    const projection = projectionAt(id);
    const compaction = projection.entries[0] && contextBoundary(projection.entries[0].sourceEntry)
      ? projection.entries[0] : undefined;
    const kept = projection.entries
      .filter(item => !contextBoundary(item.sourceEntry))
      .map(item => state.ids[`$${item.sourceEntry.id}`])
      .filter((target): target is EntryId => target !== undefined);
    const head = kept.length ? Math.min(...kept) as EntryId : 'self';
    const prefix = convertToLlm(compaction?.messages ?? []);
    await append({
      kind: `${JOURNAL_KIND}.head.v1`, data: { leaf: id, compaction: compaction?.sourceEntry.id ?? null }, head,
      ...(prefix.length ? { model: detached(prefix) } : {}),
      edits: corrections(state, projection, head === 'self' ? Infinity : head),
    });
    state.compaction = compaction?.sourceEntry.id ?? null;
    leaf = id;
  };
  for (const entry of added) {
    if (Object.hasOwn(state.ids, `$${entry.id}`)) continue;
    if (entry.parentId !== leaf) await branch(entry.parentId);
    const model = messages(entry);
    const isCompaction = entry.type === 'compaction';
    const firstKept = isCompaction && entry.firstKeptEntryId !== entry.id
      ? state.ids[`$${entry.firstKeptEntryId}`] : undefined;
    if (isCompaction && entry.firstKeptEntryId !== entry.id && firstKept === undefined) {
      throw new Error(`Compaction target is not persisted: ${entry.firstKeptEntryId}`);
    }
    const projection = projectionAt(entry.id);
    const edits = corrections(state, projection, isCompaction ? firstKept ?? Infinity : state.start);
    const record = await append({
      kind: NATIVE_ENTRY_KIND, data: json(entry),
      ...(model.length ? { model: detached(model) } : {}),
      ...(isCompaction ? { head: firstKept ?? 'self' } : {}),
      ...(edits.length ? { edits } : {}),
    });
    state.ids[`$${entry.id}`] = record.id;
    if (isCompaction) state.compaction = entry.id;
    leaf = entry.id;
  }
  if (leaf !== finalLeaf || (branched && !added.length)) await branch(finalLeaf);
  if (finalLeaf === null) manager.resetLeaf();
  else manager.branch(finalLeaf);
}

function corrections(state: JournalState, projection: SessionProjection, start: number): ContextEdit[] {
  const desired = new Map<EntryId, ReturnType<typeof convertToLlm>>();
  for (const item of projection.entries) {
    if (contextBoundary(item.sourceEntry)) continue;
    const id = state.ids[`$${item.sourceEntry.id}`];
    // The current entry is not assigned its durable ID until appendEntry returns.
    if (id === undefined) continue;
    desired.set(id, [...desired.get(id) ?? [], ...convertToLlm(item.messages)]);
  }
  const edits: ContextEdit[] = [];
  for (const record of state.records) {
    if (record.head || record.id < start) continue;
    const target = desired.get(record.id) ?? [];
    const override = state.overrides[String(record.id)];
    const actual = override && override.by >= start ? override.messages : record.model;
    if (JSON.stringify(actual) === JSON.stringify(json(target))) continue;
    edits.push(target.length
      ? { target: record.id, action: 'replace', messages: detached(target) }
      : { target: record.id, action: 'omit' });
  }
  return edits;
}
