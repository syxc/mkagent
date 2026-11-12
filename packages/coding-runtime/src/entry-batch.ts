/** Resolve references to earlier drafts inside one durable transaction. */
import type { ConversationId, EntryDraft, EntryId, Tx } from '@earendil-works/pi-durable';

export interface CodingEntryDraft extends EntryDraft {
  references?: { head?: number; edits?: Record<number, number> };
}

/** Append in order, resolving every local reference before passing it to durable. */
export async function appendCodingEntries(
  tx: Tx, conversation: ConversationId, entries: readonly CodingEntryDraft[],
): Promise<EntryId[]> {
  const ids: EntryId[] = [];
  const resolve = (position: number): EntryId => {
    const id = ids[position];
    if (id === undefined) throw new Error('Coding entry references must point to an earlier draft');
    return id;
  };
  for (const { references, ...entry } of entries) {
    if (references?.head !== undefined) entry.head = resolve(references.head);
    if (references?.edits) entry.edits = entry.edits?.map((edit, index) => {
      const target = references.edits![index];
      return target === undefined ? edit : { ...edit, target: resolve(target) };
    });
    ids.push((await tx.appendEntry(conversation, entry)).id);
  }
  return ids;
}
