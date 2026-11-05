/** Detached native views and the operations applied inside a journal transaction. */
import type { ConversationId, EntryId } from '@earendil-works/pi-durable';
import type { SessionManager, SessionEntry, SessionHeader } from '../pi/core/session-manager.ts';
import { detached, type JournalState } from './session-journal-projection.ts';

export interface Snapshot {
  header: SessionHeader;
  entries: SessionEntry[];
  leaf: string | null;
}

export type Operation =
  | { type: 'append'; entry: SessionEntry }
  | { type: 'leaf'; id: string | null }
  | { type: 'replace'; snapshot: Snapshot }
  | { type: 'link'; nativeId: string; productMessageId: string };

export interface NativeSessionSnapshot extends Snapshot {
  conversationId: ConversationId;
  revision: number;
  name: string | null;
  entryIds: Array<{ nativeId: string; durableId: EntryId; productMessageId?: string }>;
}

export function snapshot(manager: SessionManager): Snapshot {
  return { header: manager.getHeader()!, entries: manager.getEntries(), leaf: manager.getLeafId() };
}

export function committedSnapshot(
  conversationId: ConversationId, manager: SessionManager,
  state: Pick<JournalState, 'revision' | 'ids' | 'productMessages'>,
): NativeSessionSnapshot {
  const view = snapshot(manager);
  return detached({
    ...view, conversationId, revision: state.revision, name: manager.getSessionName() ?? null,
    entryIds: view.entries.map(entry => {
      const key = `$${entry.id}`;
      const durableId = state.ids[key];
      if (durableId === undefined) throw new Error(`Native entry has no committed durable identity: ${entry.id}`);
      return { nativeId: entry.id, durableId, productMessageId: state.productMessages?.[key] };
    }),
  });
}

export function apply(base: Snapshot, operations: Operation[]): Snapshot {
  let result = detached(base);
  for (const operation of operations) {
    if (operation.type === 'replace') result = detached(operation.snapshot);
    else if (operation.type === 'leaf') {
      if (operation.id !== null && !result.entries.some(entry => entry.id === operation.id)) {
        throw new Error(`Native branch target is no longer visible: ${operation.id}`);
      }
      result.leaf = operation.id;
    } else if (operation.type === 'append') {
      if (result.entries.some(entry => entry.id === operation.entry.id)) continue;
      result.entries.push({ ...detached(operation.entry), parentId: result.leaf });
      result.leaf = operation.entry.id;
    } else if (!result.entries.some(entry => entry.id === operation.nativeId)) {
      throw new Error(`Native product message target is not visible: ${operation.nativeId}`);
    }
  }
  return result;
}
