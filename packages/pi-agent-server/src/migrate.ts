/**
 * One-time conversion of a legacy pi 1.1.0 session transcript
 * (`<sessionPath>/.pi-sessions/*.jsonl`, newest file wins) into durable
 * entries on the reserved root conversation.
 *
 * A committed durable document records old → new entry ids with the migrated
 * entries. The `id-map.json` sidecar is restored from it after an interrupted
 * write so branch anchors always refer to committed entries.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, createRegistry, defineDoc, ROOT_CONVERSATION_ID, type ConversationId, type EntryDraft, type EntryId, type ToolRegistration } from '@earendil-works/pi-durable';
import { openDurableStorage } from './storage/durable-storage.ts';
import type { Message, UserMessage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

const LegacyIdMapDoc = defineDoc({
  kind: 'mkagent.legacy-id-map',
  scope: 'session',
  version: 1,
  initial: (): { entries: Record<string, EntryId> | null; branches?: Record<string, ConversationId> } => ({ entries: null }),
  checkpointWhen: () => true,
});

/** What the newest legacy transcript says the session ended with. */
export interface LegacySessionTail {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
}

/** Newest `.jsonl` transcript in the legacy `.pi-sessions` directory. */
export function findMostRecentSessionFile(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(sessionDir, name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path ?? null;
}

/**
 * Branch preflight: a parent that has never opened under the durable kernel
 * gets its legacy transcript converted in place, so the branch copy carries
 * full context. Any existing backend is left unopened: JSONL recovery could
 * truncate another writer's uncommitted sidecars. Remaining conversion and
 * id-map recovery run in the branch copy. No models are touched.
 */
export async function migrateParentStore(sessionPath: string, debugLog: (message: string) => void): Promise<void> {
  const storeDir = join(sessionPath, 'durable-store');
  if (existsSync(join(storeDir, 'main.jsonl')) || existsSync(join(storeDir, 'store.db'))) return;
  if (!findMostRecentSessionFile(join(sessionPath, '.pi-sessions'))) return;
  const storage = await openDurableStorage(storeDir, BACKGROUND_CONTEXT);
  let harness: Harness | undefined;
  try {
    harness = await Harness.open(storage, {
      models: () => { throw new Error('Model access is not expected during migration'); },
      registry: createRegistry<ToolRegistration>(),
    }, BACKGROUND_CONTEXT);
    await migrateLegacySession(harness, sessionPath, debugLog);
  } finally {
    await (harness ?? storage).close(BACKGROUND_CONTEXT);
  }
}

/** Old → new entry ids, for translating branch anchors after a store copy. */
export function readEntryIdMap(storeDir: string): Map<string, EntryId> | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(storeDir, 'id-map.json'), 'utf-8')) as Record<string, EntryId>;
    return new Map(Object.entries(raw));
  } catch {
    return undefined;
  }
}

export async function readLegacyBranchConversation(harness: Harness, anchor: string): Promise<ConversationId | undefined> {
  const migration = await harness.snapshot(LegacyIdMapDoc, BACKGROUND_CONTEXT);
  return migration?.branches?.[anchor];
}

interface LegacyEntryLike {
  type: string;
  id: string;
  parentId?: string | null;
  message?: unknown;
  summary?: string;
  firstKeptEntryId?: string;
  content?: unknown;
  thinkingLevel?: string;
  provider?: string;
  modelId?: string;
  systemMessage?: Extract<Message, { role: 'system' }>;
  targetId?: string;
  replacement?: { content: unknown } | null;
}

function readLegacyEntries(legacyFile: string): LegacyEntryLike[] {
  return readFileSync(legacyFile, 'utf-8').split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => { try { return JSON.parse(line) as LegacyEntryLike; } catch { return null; } })
    .filter((entry): entry is LegacyEntryLike => entry !== null && entry.type !== 'session');
}

/**
 * Convert the newest legacy transcript into durable entries. Returns the tail
 * model/thinking level so the kernel can restore them when the host does not
 * pass its own. Safe on a bare store: the reserved root conversation is
 * created (idempotently) before the conversion commit touches it. Branch copies
 * can read the parent's transcript while writing only to their own store.
 */
export async function migrateLegacySession(
  harness: Harness,
  sessionPath: string,
  debugLog: (message: string) => void,
  legacySessionPath = sessionPath,
): Promise<LegacySessionTail> {
  const storeDir = join(sessionPath, 'durable-store');
  const tail: LegacySessionTail = {};
  await harness.root(BACKGROUND_CONTEXT);

  const legacyFile = findMostRecentSessionFile(join(legacySessionPath, '.pi-sessions'));
  if (!legacyFile) return tail;
  const legacyEntries = readLegacyEntries(legacyFile);
  const entriesById = new Map(legacyEntries.map(entry => [entry.id, entry]));
  let activeEntries = legacyEntries;
  if (legacyEntries.some(entry => 'parentId' in entry)) {
    const path: LegacyEntryLike[] = [];
    const seen = new Set<string>();
    let current: LegacyEntryLike | undefined = legacyEntries.at(-1);
    while (current) {
      if (seen.has(current.id)) throw new Error('Legacy session has a parent cycle');
      seen.add(current.id);
      path.push(current);
      if (!current.parentId) break;
      const parent = entriesById.get(current.parentId);
      if (!parent) throw new Error(`Legacy session parent not found: ${current.parentId}`);
      current = parent;
    }
    activeEntries = path.reverse();
  }

  let converted = 0;
  const committedMap = await harness.commit(async tx => {
    // Skip when the root conversation already carries context (resume, or a
    // branch copy that already contains the converted transcript).
    const existing = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1);
    const migration = await tx.doc(LegacyIdMapDoc);
    if (existing.items.length > 0) return migration.entries ? { ...migration.entries } : null;

    const idMap: Record<string, EntryId> = {};
    const branches: Record<string, ConversationId> = {};
    for (const entry of activeEntries) {
      const draft = toDurableDraft(entry, idMap, entriesById);
      if (!draft) continue;
      const appended = await tx.appendEntry(ROOT_CONVERSATION_ID, draft);
      idMap[entry.id] = appended.id;
      converted++;
    }
    migration.entries = idMap;
    migration.branches = branches;
    return idMap;
  }, BACKGROUND_CONTEXT);

  if (committedMap) {
    writeFileSync(join(storeDir, 'id-map.json'), JSON.stringify(committedMap));
  }

  const activeIds = new Set(activeEntries.map(entry => entry.id));
  if (committedMap && legacyEntries.some(entry => 'parentId' in entry)) {
    for (const entry of legacyEntries) {
      if (activeIds.has(entry.id) || committedMap[entry.id] !== undefined
        || (entry.type !== 'context_edit' && !toDurableDraft(entry, committedMap, entriesById))) continue;
      const path: LegacyEntryLike[] = [];
      const seen = new Set<string>();
      let current: LegacyEntryLike | undefined = entry;
      let base: LegacyEntryLike | undefined;
      while (current) {
        if (seen.has(current.id)) throw new Error('Legacy session has a parent cycle');
        seen.add(current.id);
        if (committedMap[current.id] !== undefined) {
          base = current;
          break;
        }
        path.push(current);
        if (!current.parentId) break;
        const parent = entriesById.get(current.parentId);
        if (!parent) throw new Error(`Legacy session parent not found: ${current.parentId}`);
        current = parent;
      }
      path.reverse();
      const imported = await harness.commit(async tx => {
        const migration = await tx.doc(LegacyIdMapDoc);
        if (migration.entries?.[entry.id] !== undefined) return { ...migration.entries };
        const idMap = { ...migration.entries };
        const branches = { ...migration.branches };
        let target: ConversationId;
        if (base) {
          const baseId = idMap[base.id];
          if (baseId === undefined) throw new Error(`Legacy branch anchor not found: ${base.id}`);
          const parent = branches[base.id] ?? ROOT_CONVERSATION_ID;
          target = (await tx.forkConversation(parent, baseId, { ownership: { kind: 'ownerless' } })).id;
        } else {
          target = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id;
        }
        for (const item of path) {
          const draft = toDurableDraft(item, idMap, entriesById);
          if (!draft) continue;
          const appended = await tx.appendEntry(target, draft);
          idMap[item.id] = appended.id;
          branches[item.id] = target;
        }
        migration.entries = idMap;
        migration.branches = branches;
        return idMap;
      }, BACKGROUND_CONTEXT);
      Object.assign(committedMap, imported);
      writeFileSync(join(storeDir, 'id-map.json'), JSON.stringify(committedMap));
    }
  }

  for (const entry of activeEntries) {
    if (entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string') {
      tail.thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === 'model_change' && entry.provider && entry.modelId) {
      tail.model = { provider: entry.provider, modelId: entry.modelId };
    }
  }
  if (converted > 0) {
    debugLog(`Migrated ${converted} legacy session entries from ${legacyFile}`);
  }
  return tail;
}

/**
 * One legacy entry → one durable entry draft. Entries outside the model
 * context (usage, labels, TUI-only messages, …) convert to `undefined` and are
 * skipped. `idMap` translates a compaction's `firstKeptEntryId` to the new ids.
 */
function toDurableDraft(entry: LegacyEntryLike, idMap: Record<string, EntryId>, entries: Map<string, LegacyEntryLike>): EntryDraft | undefined {
  switch (entry.type) {
    case 'message': {
      const message = entry.message as Message | undefined;
      if (!message) return undefined;
      // Legacy system messages are not durable prompt baselines.
      if (message.role === 'system') return { kind: 'mkagent.legacy-system', model: [message] };
      if (message.role === 'user') return { kind: 'pi.user', model: [message] };
      if (message.role === 'assistant') return { kind: 'pi.assistant', model: [message] };
      if (message.role === 'toolResult') return { kind: 'pi.tool-result', model: [message] };
      // TUI-only messages (bash execution echoes, custom) never reached the model.
      return undefined;
    }
    case 'compaction': {
      if (typeof entry.summary !== 'string') return undefined;
      const retained: LegacyEntryLike[] = [];
      if (entry.firstKeptEntryId && 'parentId' in entry) {
        const seen = new Set<string>();
        let current = entry;
        while (current.parentId) {
          if (seen.has(current.id)) throw new Error('Legacy session has a parent cycle');
          seen.add(current.id);
          const parent = entries.get(current.parentId);
          if (!parent) throw new Error(`Legacy session parent not found: ${current.parentId}`);
          retained.push(parent);
          if (parent.id === entry.firstKeptEntryId) break;
          current = parent;
        }
        if (retained.at(-1)?.id !== entry.firstKeptEntryId) retained.length = 0;
        retained.reverse();
      } else if (entry.firstKeptEntryId) {
        let retaining = false;
        for (const item of entries.values()) {
          if (item.id === entry.id) break;
          if (item.id === entry.firstKeptEntryId) retaining = true;
          if (retaining) retained.push(item);
        }
      }
      const kept = retained.map(item => idMap[item.id]).find(id => id !== undefined);
      // Legacy compaction drops system messages within the retained range.
      const edits = retained.flatMap(item => {
        const target = idMap[item.id];
        return target !== undefined && item.type === 'message' && (item.message as Message | undefined)?.role === 'system'
          ? [{ target, action: 'omit' as const }] : [];
      });
      return {
        kind: 'pi.compaction',
        // Keeping the baseline on the head entry also removes it with an older compaction.
        model: [
          { role: 'user', content: [{ type: 'text', text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${entry.summary}\n</summary>` }], timestamp: Date.now() },
          ...(entry.systemMessage ? [entry.systemMessage] : []),
        ],
        data: { reason: 'manual' },
        ...(edits.length ? { edits } : {}),
        head: kept ?? 'self',
      };
    }
    case 'context_edit': {
      const target = entry.targetId ? idMap[entry.targetId] : undefined;
      const source = entry.targetId ? entries.get(entry.targetId) : undefined;
      const original = source && toDurableDraft(source, idMap, entries)?.model?.[0];
      if (target === undefined || !original || !('content' in original) || entry.replacement === undefined) {
        throw new Error(`Invalid legacy context edit: ${entry.id}`);
      }
      if (entry.replacement === null) return { kind: 'pi.context-edit', edits: [{ target, action: 'omit' }] };
      const content = entry.replacement.content;
      if (typeof content !== 'string' && !Array.isArray(content)) throw new Error(`Invalid legacy context edit: ${entry.id}`);
      const replacement = {
        ...original,
        content: (original.role === 'assistant' || original.role === 'toolResult') && typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : content,
      } as Message;
      return { kind: 'pi.context-edit', edits: [{ target, action: 'replace', messages: [replacement] }] };
    }
    case 'branch_summary':
      if (!entry.summary) return undefined;
      return {
        kind: 'pi.user',
        model: [{ role: 'user', content: [{ type: 'text', text: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${entry.summary}</summary>` }], timestamp: Date.now() }],
      };
    case 'custom_message':
      return {
        kind: 'pi.user',
        model: [{ role: 'user', content: entry.content as UserMessage['content'], timestamp: Date.now() }],
      };
    default:
      // usage, label, custom, session_info, thinking_level_change,
      // model_change: bookkeeping or dropped.
      return undefined;
  }
}
