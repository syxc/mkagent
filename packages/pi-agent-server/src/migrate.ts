/**
 * One-time conversion of a legacy pi 1.1.0 session transcript
 * (`<sessionPath>/.pi-sessions/*.jsonl`, newest file wins) into durable
 * entries on the reserved root conversation.
 *
 * Idempotent without a marker file: a store that already has entries is left
 * untouched, so a crashed conversion simply resumes on the next open. The
 * `id-map.json` sidecar records old → new entry ids for branch anchors and is
 * rewritten after every successful conversion.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, createRegistry, ROOT_CONVERSATION_ID, type EntryDraft, type EntryId, type ToolRegistration } from '@earendil-works/pi-durable';
import { openDurableStorage } from './storage/durable-storage.ts';
import type { Message, UserMessage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

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
 * full context. No-op when the parent already has a migrated store. No models
 * are touched — migration only commits entries.
 */
export async function migrateParentStore(sessionPath: string, debugLog: (message: string) => void): Promise<void> {
  const storeDir = join(sessionPath, 'durable-store');
  if (existsSync(join(storeDir, 'id-map.json'))) return;
  if (!findMostRecentSessionFile(join(sessionPath, '.pi-sessions'))) return;
  const storage = await openDurableStorage(storeDir, BACKGROUND_CONTEXT);
  const harness = await Harness.open(storage, {
    models: () => { throw new Error('Model access is not expected during migration'); },
    registry: createRegistry<ToolRegistration>(),
  }, BACKGROUND_CONTEXT);
  try {
    await migrateLegacySession(harness, sessionPath, debugLog);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
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

interface LegacyEntryLike {
  type: string;
  id: string;
  message?: unknown;
  summary?: string;
  firstKeptEntryId?: string;
  content?: unknown;
  thinkingLevel?: string;
  provider?: string;
  modelId?: string;
}

/**
 * Convert the newest legacy transcript into durable entries. Returns the tail
 * model/thinking level so the kernel can restore them when the host does not
 * pass its own. Safe on a bare store: the reserved root conversation is
 * created (idempotently) before the conversion commit touches it.
 */
export async function migrateLegacySession(
  harness: Harness,
  sessionPath: string,
  debugLog: (message: string) => void,
): Promise<LegacySessionTail> {
  const storeDir = join(sessionPath, 'durable-store');
  const tail: LegacySessionTail = {};
  await harness.root(BACKGROUND_CONTEXT);

  const legacyFile = findMostRecentSessionFile(join(sessionPath, '.pi-sessions'));
  const lines = legacyFile
    ? readFileSync(legacyFile, 'utf-8').split('\n').filter(line => line.trim().length > 0)
    : [];
  const legacyEntries = lines
    .map(line => { try { return JSON.parse(line) as LegacyEntryLike; } catch { return null; } })
    .filter((entry): entry is LegacyEntryLike => entry !== null && entry.type !== 'session');

  let converted = 0;
  await harness.commit(async tx => {
    // Skip when the root conversation already carries context (resume, or a
    // branch copy that already contains the converted transcript).
    const existing = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1);
    if (existing.items.length > 0) return 0;

    const idMap: Record<string, EntryId> = {};
    for (const entry of legacyEntries) {
      const draft = toDurableDraft(entry, idMap);
      if (!draft) continue;
      const appended = await tx.appendEntry(ROOT_CONVERSATION_ID, draft);
      idMap[entry.id] = appended.id;
      converted++;
    }
    writeFileSync(join(storeDir, 'id-map.json'), JSON.stringify(idMap));
    return converted;
  }, BACKGROUND_CONTEXT);

  for (const entry of legacyEntries) {
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
function toDurableDraft(entry: LegacyEntryLike, idMap: Record<string, EntryId>): EntryDraft | undefined {
  switch (entry.type) {
    case 'message': {
      const message = entry.message as Message | undefined;
      if (!message) return undefined;
      if (message.role === 'user') return { kind: 'pi.user', model: [message] };
      if (message.role === 'assistant') return { kind: 'pi.assistant', model: [message] };
      if (message.role === 'toolResult') return { kind: 'pi.tool-result', model: [message] };
      // TUI-only messages (bash execution echoes, custom) never reached the model.
      return undefined;
    }
    case 'compaction': {
      if (typeof entry.summary !== 'string') return undefined;
      const kept = entry.firstKeptEntryId ? idMap[entry.firstKeptEntryId] : undefined;
      return {
        kind: 'pi.compaction',
        model: [{ role: 'user', content: [{ type: 'text', text: entry.summary }], timestamp: Date.now() }],
        data: { reason: 'manual' },
        // The summary starts the new context; an unmappable first-kept entry
        // falls back to a summary-only context.
        head: kept ?? 'self',
      };
    }
    case 'custom_message':
      return {
        kind: 'pi.user',
        model: [{ role: 'user', content: entry.content as UserMessage['content'], timestamp: Date.now() }],
      };
    default:
      // usage, label, custom, session_info, thinking_level_change,
      // model_change, branch_summary, context_edit: bookkeeping or dropped.
      return undefined;
  }
}
