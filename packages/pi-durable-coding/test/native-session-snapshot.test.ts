import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import {
  createRegistry, Harness, MemoryStorage,
  type CommitResult, type Seq, type Storage, type StorageWrite,
} from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { NativeSessionJournal } from '../src/durable-coding/session-journal.ts';
import type { NativeSessionSnapshot } from '../src/durable-coding/session-journal-state.ts';

const journals: NativeSessionJournal[] = [];
const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const harness of harnesses.splice(0)) {
    try { await harness.close(context); } catch { /* Injected storage failures close the harness. */ }
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const user = (content: string) => ({ role: 'user' as const, content, timestamp: 1 });
async function open(storage: Storage) {
  const harness = await Harness.open(storage, {
    registry: createRegistry(), models: createModels(),
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, context);
  harnesses.push(harness);
  const conversation = await harness.root(context);
  const journal = await NativeSessionJournal.open({
    harness, conversation, context, cwd: '/tmp/native-snapshot-fixture',
  });
  journals.push(journal);
  const write = (work: () => void) => journal.phase(async () => {
    work();
    await conversation.commit(tx => journal.commit(tx), context);
  });
  return { harness, conversation, journal, manager: journal.manager, write };
}

class ControlledStorage extends MemoryStorage {
  fail = false;
  pause?: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> };
  override async commit(
    batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, ctx: Context,
  ): Promise<CommitResult> {
    if (this.fail) throw new Error('snapshot receipt refused');
    const pause = this.pause;
    this.pause = undefined;
    if (pause) {
      pause.entered.resolve();
      await pause.release.promise;
    }
    return super.commit(batches, receive, ctx);
  }
}

test('committed snapshots exclude staged names and links until the storage receipt', async () => {
  const storage = new ControlledStorage();
  const { journal, manager, write } = await open(storage);
  const initial = journal.committedSnapshot();
  const observed: NativeSessionSnapshot[] = [];
  journal.observeCommitted(snapshot => {
    snapshot.entries.length = 0;
    throw new Error('observer cannot poison another observer');
  });
  const stop = journal.observeCommitted(snapshot => { observed.push(snapshot); });
  const pause = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  storage.pause = pause;
  let id = '';
  const pending = write(() => {
    id = manager.appendMessage(user('pending'));
    journal.linkMessage(id, 'product-input');
    manager.appendSessionInfo('Pending name');
    expect(journal.committedSnapshot()).toEqual(initial);
  });
  await pause.entered.promise;
  expect(journal.committedSnapshot()).toEqual(initial);
  expect(observed).toHaveLength(0);
  pause.release.resolve();
  await pending;
  expect(observed).toHaveLength(1);
  expect(observed[0]!.entries).toHaveLength(2);
  expect(observed[0]!.name).toBe('Pending name');
  expect(observed[0]!.entryIds.find(entry => entry.nativeId === id)).toEqual({
    nativeId: id, durableId: journal.durableId(id), productMessageId: 'product-input',
  });
  observed[0]!.entries.length = 0;
  expect(journal.committedSnapshot().entries).toHaveLength(2);
  stop();
  await write(() => { manager.appendSessionInfo(''); });
  expect(journal.committedSnapshot().name).toBeNull();
  expect(observed).toHaveLength(1);
});

test('full committed trees and many-to-one product links survive JSONL recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-snapshot-'));
  directories.push(directory);
  const first = await open(await openNodeJsonlStorage(directory, context));
  let root = '';
  let inactive = '';
  await first.write(() => {
    root = first.manager.appendMessage(user('repeat'));
    first.journal.linkMessage(root, 'product-shared');
    inactive = first.manager.appendMessage(user('repeat'));
    first.journal.linkMessage(inactive, 'product-inactive');
    first.manager.branch(root);
    first.journal.markTreeNavigation();
    const active = first.manager.appendMessage({
      role: 'user', timestamp: 2,
      content: [{ type: 'text', text: 'attachment' }, { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }],
    });
    first.journal.linkMessage(active, 'product-shared');
    first.manager.appendLabelChange(inactive, 'saved inactive branch');
    first.manager.branch(root);
  });
  const committed = first.journal.committedSnapshot();
  expect(committed.leaf).toBe(root);
  expect(committed.treeRevision).toBe(committed.revision);
  expect(committed.entries.at(-1)!.id).not.toBe(root);
  expect(committed.entryIds.filter(entry => entry.productMessageId === 'product-shared')).toHaveLength(2);
  first.journal.close();
  await first.harness.close(context);
  harnesses.splice(harnesses.indexOf(first.harness), 1);
  const recovered = await open(await openNodeJsonlStorage(directory, context));
  expect(recovered.journal.committedSnapshot()).toEqual(committed);
  expect(recovered.manager.getLabel(inactive)).toBe('saved inactive branch');
  expect(recovered.manager.buildSessionContext().messages).toEqual([user('repeat')]);
});

test('link-only commits do not add model records and reject reassignment', async () => {
  const { journal, manager, conversation, write } = await open(new MemoryStorage());
  let id = '';
  await write(() => { id = manager.appendMessage(user('original')); });
  const records = (await conversation.entries({}, 20, undefined, context)).items.length;
  const before = journal.committedSnapshot().revision;
  await write(() => { journal.linkMessage(id, 'original-product'); });
  expect(journal.committedSnapshot().revision).toBe(before + 1);
  expect((await conversation.entries({}, 20, undefined, context)).items).toHaveLength(records);
  await expect(write(() => { journal.linkMessage(id, 'replacement-product'); })).rejects.toThrow('already linked');
  expect(journal.committedSnapshot().entryIds[0]!.productMessageId).toBe('original-product');
  await expect(write(() => { journal.linkMessage('missing', 'unrelated'); })).rejects.toThrow('not visible');
});

test('a refused commit publishes neither a snapshot nor a product association', async () => {
  const storage = new ControlledStorage();
  const { journal, manager, write } = await open(storage);
  await write(() => { manager.appendMessage(user('committed')); });
  const before = journal.committedSnapshot();
  const observed: NativeSessionSnapshot[] = [];
  journal.observeCommitted(snapshot => { observed.push(snapshot); });
  storage.fail = true;
  await expect(write(() => {
    const id = manager.appendMessage(user('refused'));
    journal.linkMessage(id, 'never-published');
    journal.markTreeNavigation();
  })).rejects.toThrow('snapshot receipt refused');
  expect(observed).toHaveLength(0);
  expect(journal.committedSnapshot()).toEqual(before);
});
