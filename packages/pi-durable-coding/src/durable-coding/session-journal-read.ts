/** Read a paused store's native journal without initializing documents or scheduling work. */
import type { Context } from '@earendil-works/chord';
import type { ConversationId, EntryId, EntryRecord, JsonObject, Storage } from '@earendil-works/pi-durable';
import { JOURNAL_KIND, NATIVE_ENTRY_KIND, nativeManager, type JournalState } from './session-journal-projection.ts';
import { committedSnapshot, type NativeSessionSnapshot } from './session-journal-state.ts';

type JournalView = Pick<JournalState, 'header' | 'entries' | 'leaf' | 'revision' | 'ids' | 'productMessages' | 'treeRevision'>;

/** Return detached committed native state; the caller must keep the store paused for the entire read. */
export async function readNativeSessionSnapshot(
  storage: Pick<Storage, 'findDocument' | 'document' | 'entry'>,
  conversationId: ConversationId,
  context: Context,
): Promise<NativeSessionSnapshot> {
  const record = await storage.findDocument({
    kind: JOURNAL_KIND, scope: { kind: 'conversation', conversationId },
  }, 'current', context);
  if (!record) throw new Error('Committed native session journal is missing');
  const document = await storage.document(record.id, 'current', context);
  if (!document || document.record.id !== record.id || document.record.kind !== JOURNAL_KIND
    || document.record.key !== undefined || document.record.scope.kind !== 'conversation'
    || document.record.scope.conversationId !== conversationId
    || document.record.history !== 'rewindable' || document.record.fork !== 'asOf' || document.version !== 1) {
    throw new Error('Committed native session journal definition does not match');
  }
  const { state, cwd } = journalView(document.value, conversationId);
  const result = committedSnapshot(conversationId, nativeManager(state, cwd), state);
  const envelopes = new Map<EntryId, EntryRecord>();
  for (const [index, link] of result.entryIds.entries()) {
    let envelope = envelopes.get(link.durableId);
    if (!envelope) {
      envelope = (await storage.entry(conversationId, link.durableId, context))?.entry;
      if (!envelope) throw new Error('Native journal durable mapping is not visible in its conversation');
      envelopes.set(link.durableId, envelope);
    }
    const entry = result.entries[index]!;
    // Forks remap journal paths without rewriting the original envelope's arbitrary data.
    if (envelope.kind === NATIVE_ENTRY_KIND) {
      if (!object(envelope.data) || envelope.data.id !== entry.id
        || envelope.data.parentId !== entry.parentId || envelope.data.type !== entry.type) {
        throw new Error('Native journal durable envelope identity does not match');
      }
    } else if (!entry.id.startsWith(`d-${envelope.id}-`)) {
      throw new Error('Native journal durable envelope kind does not match');
    }
  }
  return result;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function journalView(value: JsonObject, conversationId: ConversationId): { state: JournalView; cwd: string } {
  const header = value.header;
  const ids = value.ids;
  const products = value.productMessages;
  if (value.owner !== conversationId || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !object(header) || header.type !== 'session' || typeof header.id !== 'string' || !header.id
    || typeof header.cwd !== 'string' || !Number.isSafeInteger(header.version) || Number(header.version) < 1
    || typeof header.timestamp !== 'string' || !Array.isArray(value.entries) || !object(ids)
    || (products !== undefined && !object(products))
    || (value.treeRevision !== undefined && (!Number.isSafeInteger(value.treeRevision)
      || Number(value.treeRevision) < 1 || Number(value.treeRevision) > Number(value.revision)))) {
    throw new Error('Invalid committed native session journal');
  }
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)
      || typeof entry.type !== 'string' || !entry.type || entry.type === 'session'
      || typeof entry.timestamp !== 'string' || (entry.parentId !== null
        && (typeof entry.parentId !== 'string' || !seen.has(entry.parentId)))) {
      throw new Error('Invalid committed native session tree');
    }
    const id = ids[`$${entry.id}`];
    const product = products?.[`$${entry.id}`];
    if (!Number.isSafeInteger(id) || Number(id) < 0
      || (product !== undefined && (typeof product !== 'string' || !product))) {
      throw new Error('Invalid committed native session mapping');
    }
    seen.add(entry.id);
  }
  if (value.leaf !== null && (typeof value.leaf !== 'string' || !seen.has(value.leaf))) {
    throw new Error('Invalid committed native session leaf');
  }
  // Storage JSON crosses into the native view only after its projection fields are checked.
  return { state: value as JournalView, cwd: header.cwd };
}
