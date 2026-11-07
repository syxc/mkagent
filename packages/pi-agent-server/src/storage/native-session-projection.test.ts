import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { NativeSessionJournal } from '@mkagent/pi-durable-coding/durable';
import { NativeSessionProjection, nativeSessionPaths, readNativeSessionDescriptor } from './native-session-projection.ts';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(before?: (path: string) => Promise<void>,
  published?: ConstructorParameters<typeof NativeSessionProjection>[1]['published']) {
  const path = await mkdtemp(join(tmpdir(), 'native-path-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  const harness = await Harness.open(new MemoryStorage(), {
    registry: createRegistry(), models: createModels(),
  }, context);
  cleanup.push(() => harness.close(context));
  const conversation = await harness.root(context);
  const paths = nativeSessionPaths(path);
  const journal = await NativeSessionJournal.open({
    harness, conversation, context, cwd: path, sessionFile: paths.sessionFile,
  });
  cleanup.push(async () => journal.close());
  await before?.(path);
  const projection = new NativeSessionProjection(journal, { sessionPath: path, sessionId: 'product-fixture', published });
  cleanup.push(() => projection.close());
  const write = (work: () => void) => journal.phase(async () => {
    work();
    await conversation.commit(tx => journal.commit(tx), context);
  });
  return { path, paths, journal, projection, manager: journal.manager, write };
}

test('stable native paths contain only committed entries and preserve the complete tree', async () => {
  const state = await fixture();
  const initial = await state.projection.flush();
  expect(state.manager.getSessionFile()).toBe(state.paths.sessionFile);
  expect(state.manager.getSessionDir()).toBe(join(state.path, 'native-session'));
  const root = state.manager.appendMessage({ role: 'user', content: 'same', timestamp: 1 });
  state.journal.linkMessage(root, 'input-1');
  const inactive = state.manager.appendMessage({ role: 'user', content: 'same', timestamp: 1 });
  state.journal.linkMessage(inactive, 'input-2');
  state.manager.appendLabelChange(inactive, 'inactive label');
  state.manager.branch(root);
  expect(await readNativeSessionDescriptor(state.path)).toEqual(initial);
  await state.journal.flush();
  const committed = await state.projection.flush();
  expect(committed.leaf).toBe(root);
  expect(committed.sessionId).toBe('product-fixture');
  expect(committed.nativeSessionId).toBe(state.journal.committedSnapshot().header.id);
  expect(committed.entryIds.map(entry => entry.productMessageId).filter(Boolean)).toEqual(['input-1', 'input-2']);
  const rows = (await readFile(state.paths.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(rows).toEqual([state.journal.committedSnapshot().header, ...state.journal.committedSnapshot().entries]);
  expect(rows.at(-1).id).not.toBe(committed.leaf);
  expect(await readNativeSessionDescriptor(state.path)).toEqual(committed);
});

test('projection rebuild repairs tampering without changing the committed journal', async () => {
  const state = await fixture();
  await state.write(() => { state.manager.appendMessage({ role: 'user', content: 'durable', timestamp: 1 }); });
  const committed = await state.projection.flush();
  const journal = state.journal.committedSnapshot();
  await writeFile(state.paths.sessionFile, 'tampered\n');
  await expect(readNativeSessionDescriptor(state.path)).rejects.toThrow('does not match');
  expect(await state.projection.rebuild()).toEqual(committed);
  expect(state.journal.committedSnapshot()).toEqual(journal);
  expect(await readNativeSessionDescriptor(state.path)).toEqual(committed);
});

test('name receipts distinguish unset from clearing and follow the full tree across leaf changes', async () => {
  const state = await fixture();
  expect((await state.projection.flush()).hasName).toBe(false);
  let root = '';
  await state.write(() => {
    root = state.manager.appendMessage({ role: 'user', content: 'root', timestamp: 1 });
    state.manager.appendSessionInfo('Global name');
    state.manager.branch(root);
  });
  expect(await state.projection.flush()).toMatchObject({ name: 'Global name', hasName: true, leaf: root });
  await state.write(() => { state.manager.appendSessionInfo(''); state.manager.branch(root); });
  expect(await state.projection.flush()).toMatchObject({ name: null, hasName: true, leaf: root });
  const manifest = JSON.parse(await readFile(state.paths.manifestFile, 'utf8'));
  expect(manifest.hasName).toBeUndefined();
  expect(await readNativeSessionDescriptor(state.path)).toMatchObject({ name: null, hasName: true });
});

test('a torn manifest fails closed while the durable receipt and recovery identity survive', async () => {
  const state = await fixture();
  await state.projection.flush();
  await unlink(state.paths.manifestFile);
  await mkdir(state.paths.manifestFile);
  let id = '';
  await state.write(() => {
    id = state.manager.appendMessage({ role: 'user', content: 'already committed', timestamp: 1 });
    state.journal.linkMessage(id, 'accepted-input');
  });
  await expect(state.projection.flush()).rejects.toThrow('journal commit remains authoritative');
  expect(state.journal.durableId(id)).toBeDefined();
  const committed = state.journal.committedSnapshot();
  await rm(state.paths.manifestFile, { recursive: true });
  const repaired = await state.projection.rebuild();
  expect(repaired.revision).toBe(committed.revision);
  expect(repaired.entryIds.find(entry => entry.nativeId === id)?.productMessageId).toBe('accepted-input');
  expect(state.journal.committedSnapshot()).toEqual(committed);
  expect(await readNativeSessionDescriptor(state.path)).toEqual(repaired);
});

test('projection refuses child directory symlinks before writing through them', async () => {
  let other = '';
  const state = await fixture(async path => {
    other = join(path, 'other');
    await mkdir(other);
    await symlink(other, join(path, 'native-session'));
  });
  await expect(state.projection.flush()).rejects.toThrow('journal commit remains authoritative');
  await expect(readFile(join(other, 'session.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(state.journal.committedSnapshot().entries).toHaveLength(0);
});

test('a delayed product receipt keeps its exact projection files fixed before later revisions', async () => {
  const admitted = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<void>();
  const state = await fixture(undefined, async descriptor => {
    if (descriptor.revision === 1) { admitted.resolve(); await receipt.promise; }
  });
  await state.projection.flush();
  try {
    await state.write(() => { state.manager.appendMessage({ role: 'user', content: 'first', timestamp: 1 }); });
    await admitted.promise;
    await state.write(() => { state.manager.appendMessage({ role: 'user', content: 'second', timestamp: 2 }); });
    expect((await readNativeSessionDescriptor(state.path)).revision).toBe(1);
    expect(state.journal.committedSnapshot().revision).toBe(2);
  } finally { receipt.resolve(); }
  expect((await state.projection.flush()).revision).toBe(2);
});

test('a failed product receipt blocks overwrites until explicit idempotent rebuild', async () => {
  let fail = true;
  const state = await fixture(undefined, async descriptor => {
    if (descriptor.revision > 0 && fail) throw new Error('Product storage unavailable');
  });
  await state.projection.flush();
  await state.write(() => { state.manager.appendMessage({ role: 'user', content: 'committed', timestamp: 1 }); });
  await expect(state.projection.flush()).rejects.toThrow('journal commit remains authoritative');
  await state.write(() => { state.manager.appendMessage({ role: 'user', content: 'later', timestamp: 2 }); });
  await expect(state.projection.flush()).rejects.toThrow('journal commit remains authoritative');
  expect((await readNativeSessionDescriptor(state.path)).revision).toBe(1);
  fail = false;
  expect((await state.projection.rebuild()).revision).toBe(2);
  expect((await state.projection.rebuild()).revision).toBe(2);
});
