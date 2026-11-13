import { afterEach, expect, test } from 'bun:test';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import {
  createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID,
  type CommitResult, type JsonObject, type Seq, type StorageWrite,
} from '@earendil-works/pi-durable';
import { NativeSessionJournal, readNativeSessionSnapshot } from '../src/durable-coding/index.ts';
import { JOURNAL_KIND } from '../src/durable-coding/session-journal-projection.ts';

class WatchedStorage extends MemoryStorage {
  blockWrites = false;
  writes = 0;
  override commit(
    batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, ctx: Context,
  ): Promise<CommitResult> {
    if (this.blockWrites) throw new Error('Readonly inspection must never write');
    this.writes++;
    return super.commit(batches, receive, ctx);
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const storage = new WatchedStorage();
  const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
  cleanup.push(async () => { storage.blockWrites = false; await harness.close(context); });
  const conversation = await harness.root(context);
  const journal = await NativeSessionJournal.open({ harness, conversation, context, cwd: '/tmp/native-read-fixture' });
  cleanup.push(async () => journal.close());
  const manager = journal.manager;
  const root = manager.appendMessage({ role: 'user', content: 'root', timestamp: 1 });
  const left = manager.appendMessage({ role: 'user', content: 'left', timestamp: 2 });
  manager.appendLabelChange(left, 'label');
  manager.branch(root);
  const right = manager.appendMessage({ role: 'user', content: 'right', timestamp: 3 });
  journal.linkMessage(root, 'same-product');
  journal.linkMessage(right, 'same-product');
  manager.appendSessionInfo('');
  manager.branch(left);
  await journal.flush();
  const plain = await conversation.commit(tx => tx.appendEntry(conversation.id, { kind: 'plain', data: {} }), context);
  const address = { kind: JOURNAL_KIND, scope: { kind: 'conversation' as const, conversationId: conversation.id } };
  const stored = async () => {
    const record = (await storage.findDocument(address, 'current', context))!;
    return (await storage.document(record.id, 'current', context))!;
  };
  const replace = async (change: (value: JsonObject) => void, version = 1) => {
    journal.close();
    const document = await stored();
    const value = structuredClone(document.value);
    change(value);
    await storage.commit([[{ type: 'document.change', id: document.record.id,
      content: { kind: 'base', version, value } }]], () => {}, context);
  };
  return { storage, journal, conversation, stored, replace, plain: plain.id };
}

test('reads complete detached committed state without migration, receipts or writes', async () => {
  const f = await fixture();
  const before = await f.stored();
  const expected = f.journal.committedSnapshot();
  const writes = f.storage.writes;
  f.storage.blockWrites = true;
  const snapshot = await readNativeSessionSnapshot(f.storage, f.conversation.id, context);
  expect(snapshot).toEqual(expected);
  expect(snapshot.entries.at(-1)?.type).toBe('session_info');
  expect(snapshot.leaf).not.toBe(snapshot.entries.at(-1)?.id);
  expect(snapshot.entryIds.filter(entry => entry.productMessageId === 'same-product')).toHaveLength(2);
  snapshot.entries[0]!.id = 'changed-return-value';
  expect(await readNativeSessionSnapshot(f.storage, f.conversation.id, context)).toEqual(expected);
  expect(await f.stored()).toEqual(before);
  expect(f.storage.writes).toBe(writes);
});

test('missing journals fail without creating a document or opening a harness', async () => {
  const storage = new WatchedStorage();
  storage.blockWrites = true;
  await expect(readNativeSessionSnapshot(storage, ROOT_CONVERSATION_ID, context)).rejects.toThrow('missing');
  expect(storage.writes).toBe(0);
});

test.each(['version', 'owner', 'tree', 'leaf', 'mapping', 'visibility', 'envelope', 'kind'])(
  'refuses a copied journal with invalid %s and leaves it untouched', async variant => {
    const f = await fixture();
    await f.replace(value => {
      const entries = value.entries as JsonObject[];
      const ids = value.ids as JsonObject;
      const first = entries[0]!;
      if (variant === 'owner') value.owner = 999;
      if (variant === 'tree') first.parentId = first.id!;
      if (variant === 'leaf') value.leaf = 'missing-leaf';
      if (variant === 'mapping') delete ids[`$${first.id}`];
      if (variant === 'visibility') ids[`$${first.id}`] = 999_999;
      if (variant === 'envelope') first.type = 'custom';
      if (variant === 'kind') ids[`$${first.id}`] = f.plain;
    }, variant === 'version' ? 2 : 1);
    const before = await f.stored();
    f.storage.blockWrites = true;
    await expect(readNativeSessionSnapshot(f.storage, f.conversation.id, context)).rejects.toThrow();
    expect(await f.stored()).toEqual(before);
  },
);

test('accepts remapped journal content while preserving original durable envelope identity', async () => {
  const f = await fixture();
  await f.replace(value => {
    const first = (value.entries as JsonObject[])[0]!;
    (first.message as JsonObject).content = 'remapped target attachment path';
  });
  f.storage.blockWrites = true;
  const snapshot = await readNativeSessionSnapshot(f.storage, f.conversation.id, context);
  expect((snapshot.entries[0] as { message: { content: string } }).message.content).toBe('remapped target attachment path');
});
