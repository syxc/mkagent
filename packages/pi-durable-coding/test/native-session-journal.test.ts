import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyJson, type Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type AssistantMessage, type Usage } from '@earendil-works/pi-ai';
import {
  createRegistry, defineExtension, defineTask, Harness, MemoryStorage,
  type CommitResult, type EntryDraft, type Seq, type Storage, type StorageWrite, type TaskId,
} from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { NativeSessionJournal } from '../src/durable-coding/session-journal.ts';
import { convertToLlm } from '../src/native-messages.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const context = BACKGROUND_CONTEXT;
const harnesses: Harness[] = [];
const journals: NativeSessionJournal[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const harness of harnesses.splice(0)) {
    try { await harness.close(context); } catch { /* A storage-failure test closes the failed session. */ }
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const usage: Usage = {
  input: 7, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 14,
  cost: { input: 0.07, output: 0.04, cacheRead: 0.02, cacheWrite: 0.01, total: 0.14 },
};
const user = (content: string, timestamp = 1) => ({ role: 'user' as const, content, timestamp });
function assistant(): AssistantMessage {
  return {
    role: 'assistant', api: 'faux', provider: 'local', model: 'fixture', usage,
    timestamp: 2, stopReason: 'toolUse',
    content: [
      { type: 'thinking', thinking: 'complete reasoning', thinkingSignature: 'signed' },
      { type: 'text', text: 'calling fixture' },
      { type: 'toolCall', id: 'call-1', name: 'fixture', arguments: { nested: ['all', 3] } },
    ],
  };
}

const options = () => ({
  registry: createRegistry(), models: createModels(),
  settings: { retry: { enabled: false }, compaction: { enabled: false } },
});

async function setup(storage: Storage = new MemoryStorage()) {
  const harness = await Harness.open(storage, options(), context);
  harnesses.push(harness);
  const conversation = await harness.root(context);
  const journal = await NativeSessionJournal.open({ harness, conversation, context, cwd: '/tmp/native-journal-fixture' });
  journals.push(journal);
  const write = (work: () => void) => journal.phase(async () => {
    work();
    await conversation.commit(tx => journal.commit(tx), context);
  });
  const equivalent = async () => {
    const actual = convertToLlm(journal.manager.buildSessionProjection().messages);
    expect((await conversation.context(context)).messages).toEqual(actual);
    return actual;
  };
  return { harness, conversation, journal, manager: journal.manager, write, equivalent };
}

class ControlledStorage extends MemoryStorage {
  fail = false;
  pause?: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> };
  override async commit(
    batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, ctx: Context,
  ): Promise<CommitResult> {
    if (this.fail) throw new Error('injected storage failure after callback');
    const pause = this.pause;
    this.pause = undefined;
    if (pause) {
      pause.entered.resolve();
      await pause.release.promise;
    }
    return super.commit(batches, receive, ctx);
  }
}

describe('transactional native session journal', () => {
  test('observes identical message objects by distinct entry IDs across committed phases', async () => {
    const { journal, manager, write } = await setup();
    const message = assistant();
    const appended: Array<{ message: unknown; id: string }> = [];
    const committed: Array<{ id: string; durableId: number }> = [];
    const stop = journal.observeMessages({
      appended: (message, id) => appended.push({ message, id }),
      committed: (id, durableId) => committed.push({ id, durableId }),
    });
    const ids: string[] = [];
    await write(() => { ids.push(manager.appendMessage(message)); });
    await write(() => { ids.push(manager.appendMessage(message)); });
    expect(appended.map(value => value.message === message)).toEqual([true, true]);
    expect(appended.map(value => value.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(2);
    expect(committed.map(value => value.id)).toEqual(ids);
    expect(new Set(committed.map(value => value.durableId)).size).toBe(2);
    expect(committed.map(value => value.durableId)).toEqual(ids.map(id => journal.durableId(id)));
    stop();
    await write(() => { manager.appendMessage(message); });
    expect(appended).toHaveLength(2);
  });

  test('publishes no message identity for a refused receipt and contains observer failures', async () => {
    const storage = new ControlledStorage();
    const { journal, manager, write, equivalent } = await setup(storage);
    const appended: string[] = [];
    const committed: string[] = [];
    journal.observeMessages({
      appended: () => { throw new Error('synthetic observer failure'); },
      committed: () => { throw new Error('synthetic observer failure'); },
    });
    journal.observeMessages({
      appended: (_message, id) => appended.push(id),
      committed: id => committed.push(id),
    });
    await write(() => { manager.appendMessage(user('observed input')); });
    expect(committed).toEqual([appended[0]!]);
    expect(await equivalent()).toHaveLength(1);
    storage.fail = true;
    await expect(write(() => { manager.appendMessage(user('refused input')); })).rejects.toThrow('injected storage failure');
    expect(appended).toHaveLength(2);
    expect(committed).toEqual([appended[0]!]);
    expect(journal.durableId(appended[1]!)).toBeUndefined();
    expect(manager.getEntries()).toHaveLength(1);
  });

  test('keeps the native sync API and persists idle writes only at an explicit barrier', async () => {
    const { journal, manager, conversation, equivalent } = await setup();
    expect(manager).toBeInstanceOf(SessionManager);
    const append = manager.appendCustomEntry;
    const id = append('extension.state', { nested: [1, 'two'] });
    manager.appendModelChange('local', 'fixture');
    manager.appendThinkingLevelChange('high');
    manager.appendSessionInfo('Named session');
    manager.appendLabelChange(id, 'bookmark');
    manager.appendUsage('cache_warm', 'local', 'fixture', usage);
    expect(manager.getEntry(id)?.id).toBe(id);
    expect(manager.getLabel(id)).toBe('bookmark');
    expect(manager.buildSessionContext()).toMatchObject({
      thinkingLevel: 'high', model: { provider: 'local', modelId: 'fixture' },
    });
    expect(manager.getSessionName()).toBe('Named session');
    expect((await conversation.entries({}, 20, undefined, context)).items).toHaveLength(0);
    expect(journal.durableId(id)).toBeUndefined();
    await journal.flush();
    expect(journal.nativeIds(journal.durableId(id)!)).toEqual([id]);
    expect(manager.getTree()[0].label).toBe('bookmark');
    expect((await conversation.entries({}, 20, undefined, context)).items).toHaveLength(6);
    await equivalent();
  });

  test('does not publish inside the callback or while storage has no receipt', async () => {
    const storage = new ControlledStorage();
    const { journal, manager, conversation } = await setup(storage);
    const pause = { entered: gate(), release: gate() };
    storage.pause = pause;
    let id = '';
    const running = journal.phase(async () => {
      id = manager.appendMessage(user('provisional'));
      expect(manager.buildSessionContext().messages).toEqual([user('provisional')]);
      await conversation.commit(async tx => {
        await journal.commit(tx);
        expect(journal.durableId(id)).toBeUndefined();
      }, context);
    });
    await pause.entered.promise;
    expect(manager.getEntries()).toEqual([]);
    expect(manager.getLeafId()).toBeNull();
    expect(journal.durableId(id)).toBeUndefined();
    pause.release.resolve();
    await running;
    expect(manager.getLeafId()).toBe(id);
    expect(journal.durableId(id)).toBeDefined();
  });

  test('rolls back entries, leaf, labels and settings when the parent callback aborts', async () => {
    const { journal, manager, conversation, write, equivalent } = await setup();
    let root = '';
    await write(() => { root = manager.appendMessage(user('committed')); });
    const before = structuredClone(manager.getEntries());
    await expect(journal.phase(async () => {
      manager.appendLabelChange(root, 'uncommitted label');
      manager.appendThinkingLevelChange('high');
      manager.appendModelChange('other', 'uncommitted');
      manager.resetLeaf();
      manager.appendCustomEntry('uncommitted');
      await conversation.commit(async tx => {
        await journal.commit(tx);
        throw new Error('abort parent transaction');
      }, context);
    })).rejects.toThrow('abort parent transaction');
    expect(manager.getEntries()).toEqual(before);
    expect(manager.getLeafId()).toBe(root);
    expect(manager.getLabel(root)).toBeUndefined();
    expect(manager.buildSessionContext().thinkingLevel).toBe('off');
    expect(manager.buildSessionContext().model).toBeNull();
    await equivalent();
  });

  test('fails the async boundary and preserves the committed view after storage rejects the callback result', async () => {
    const storage = new ControlledStorage();
    const { journal, manager, conversation, write } = await setup(storage);
    await write(() => { manager.appendMessage(user('durable')); });
    const before = structuredClone(manager.getEntries());
    let failedId = '';
    storage.fail = true;
    await expect(journal.phase(async () => {
      failedId = manager.appendMessage(user('must disappear'));
      await conversation.commit(tx => journal.commit(tx), context);
    })).rejects.toThrow();
    expect(manager.getEntries()).toEqual(before);
    expect(journal.durableId(failedId)).toBeUndefined();
    await expect(journal.flush()).rejects.toThrow();
  });

  test('publishes detached candidates between several commits in one still-running phase', async () => {
    const { journal, manager, conversation } = await setup();
    const published = gate();
    const proceed = gate();
    let a = '';
    let b = '';
    const running = journal.phase(async () => {
      a = manager.appendMessage(user('first'));
      await conversation.commit(async tx => {
        await journal.commit(tx);
        b = manager.appendCustomEntry('after-candidate', { still: 'local' });
      }, context);
      expect(manager.getEntry(b)).toBeDefined();
      published.resolve();
      await proceed.promise;
      await conversation.commit(tx => journal.commit(tx), context);
    });
    await published.promise;
    expect(manager.getEntries().map(entry => entry.id)).toEqual([a]);
    expect(journal.durableId(a)).toBeDefined();
    expect(journal.durableId(b)).toBeUndefined();
    proceed.resolve();
    await running;
    expect(manager.getEntries().map(entry => entry.id)).toEqual([a, b]);
    expect(journal.durableId(b)).toBeDefined();
  });

  test('merges concurrent metadata phases without dropping entries or branch-local settings', async () => {
    const { journal, manager, conversation, write, equivalent } = await setup();
    await write(() => { manager.appendMessage(user('root')); });
    const aReady = gate();
    const bReady = gate();
    const aCommit = gate();
    const bCommit = gate();
    let a = '';
    let b = '';
    const first = journal.phase(async () => {
      a = manager.appendCustomEntry('tool.a', { value: 'a' });
      manager.appendThinkingLevelChange('high');
      aReady.resolve();
      await aCommit.promise;
      await conversation.commit(tx => journal.commit(tx), context);
    });
    const second = journal.phase(async () => {
      b = manager.appendCustomEntry('tool.b', { value: 'b' });
      manager.appendModelChange('local', 'fixture');
      bReady.resolve();
      await bCommit.promise;
      await conversation.commit(tx => journal.commit(tx), context);
    });
    await Promise.all([aReady.promise, bReady.promise]);
    aCommit.resolve();
    bCommit.resolve();
    await Promise.all([first, second]);
    expect(manager.getBranch().filter(entry => entry.type === 'custom').map(entry => entry.id)).toEqual([a, b]);
    expect(manager.buildSessionContext()).toMatchObject({
      thinkingLevel: 'high', model: { provider: 'local', modelId: 'fixture' },
    });
    expect(manager.getEntryCount()).toBe(5);
    await equivalent();
  });

  test('stores complete assistant and tool messages once and reopens JSONL with stable native identities', async () => {
    const path = await mkdtemp(join(tmpdir(), 'native-session-journal-'));
    directories.push(path);
    const storage = await openNodeJsonlStorage(path, context);
    const state = await setup(storage);
    const message = assistant();
    const result = {
      role: 'toolResult' as const, toolCallId: 'call-1', toolName: 'fixture', isError: false, timestamp: 3,
      content: [{ type: 'text' as const, text: 'complete result' }, { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }],
      details: { custom: [1, 2, 3] },
    };
    let id = '';
    await state.write(() => {
      state.manager.appendMessage(user('question'));
      id = state.manager.appendMessage(message);
      state.manager.appendMessage(result);
      state.manager.appendCustomEntry('plugin.state', { retained: true });
      state.manager.appendLabelChange(id, 'answer');
    });
    const before = structuredClone(state.manager.getEntries());
    const leaf = state.manager.getLeafId();
    const durableId = state.journal.durableId(id)!;
    expect(state.journal.entryForMessage(structuredClone(message))?.id).toBe(id);
    await state.equivalent();
    const raw = (await state.conversation.entries({}, 30, undefined, context)).items;
    expect(raw.flatMap(entry => entry.model ?? []).filter(item => item.role === 'assistant')).toHaveLength(1);
    expect(raw.flatMap(entry => entry.model ?? []).filter(item => item.role === 'toolResult')).toHaveLength(1);
    state.journal.close();
    await state.harness.close(context);
    const reopened = await setup(await openNodeJsonlStorage(path, context));
    expect(reopened.manager.getEntries()).toEqual(before);
    expect(reopened.manager.getLeafId()).toBe(leaf);
    expect(reopened.manager.getLabel(id)).toBe('answer');
    expect(reopened.journal.durableId(id)).toBe(durableId);
    expect(reopened.journal.entryForMessage(message)?.id).toBe(id);
    expect(reopened.manager.getEntry(id)).toMatchObject({ message: { usage, content: message.content } });
    await reopened.equivalent();
  });

  test('uses durable edits for omission/replacement and a true compaction head with a system baseline', async () => {
    const { journal, manager, conversation, write, equivalent } = await setup();
    let target = '';
    let firstKept = '';
    await write(() => {
      manager.appendMessage({ role: 'system', content: 'old system', timestamp: 0 });
      manager.appendMessage(user('summarized'));
      firstKept = manager.appendMessage(user('kept'));
      manager.appendMessage({ role: 'system', content: 'current system', timestamp: 2 });
      target = manager.appendCustomMessageEntry('reminder', 'original', false);
    });
    await write(() => { manager.appendContextEdit(target, null); });
    expect((await conversation.context(context)).messages.some(item => JSON.stringify(item).includes('original'))).toBe(false);
    await write(() => { manager.appendContextEdit(target, { content: 'replacement' }); });
    let compaction = '';
    await write(() => { compaction = manager.appendCompaction('summary', firstKept, 80, { full: 'details' }, true, usage); });
    const projected = await equivalent();
    expect(projected[0]).toMatchObject({ role: 'system', content: 'old system\n\ncurrent system' });
    expect(projected).toHaveLength(4);
    const view = await conversation.context(context);
    expect(view.head?.id).toBe(journal.durableId(compaction));
    expect(view.head?.head).toBe(journal.durableId(firstKept));
    expect(view.head?.model).toHaveLength(2);
    expect((await conversation.entries({}, 40, undefined, context)).items.some(entry =>
      entry.edits?.some(edit => edit.target === journal.durableId(target) && edit.action === 'replace'))).toBe(true);
    await write(() => { manager.appendContextEdit(target, null); });
    expect(await equivalent()).toHaveLength(3);
    await write(() => { manager.appendContextEdit(target, { content: 'restored' }); });
    expect(await equivalent()).toHaveLength(4);
  });

  test('restores a native branch before compaction using durable head/edits without copying assistant models', async () => {
    const { harness, manager, journal, conversation, write, equivalent } = await setup();
    let root = '';
    let tail = '';
    await write(() => {
      root = manager.appendMessage(user('root'));
      tail = manager.appendMessage(user('abandoned'));
    });
    await write(() => { manager.appendContextEdit(root, { content: 'edited on abandoned path' }); });
    await write(() => { manager.appendCompaction('compressed', tail, 50); });
    await write(() => { manager.branch(root); });
    expect(await equivalent()).toEqual([user('root')]);
    expect(manager.getLeafId()).toBe(root);
    const reopenedAtRoot = await NativeSessionJournal.open({
      harness, conversation, context, cwd: '/tmp/native-journal-fixture',
    });
    journals.push(reopenedAtRoot);
    expect(reopenedAtRoot.manager.getLeafId()).toBe(root);
    expect(reopenedAtRoot.manager.buildSessionContext()).toEqual(manager.buildSessionContext());
    await write(() => { manager.branchWithSummary(root, 'branch summary', { source: 'test' }); });
    expect(await equivalent()).toHaveLength(2);
    const reopened = await NativeSessionJournal.open({
      harness, conversation, context, cwd: '/tmp/native-journal-fixture',
    });
    journals.push(reopened);
    expect(reopened.manager.getLeafId()).toBe(manager.getLeafId());
    expect(reopened.manager.getEntries()).toEqual(manager.getEntries());
    const raw = (await conversation.entries({}, 40, undefined, context)).items;
    expect(raw.filter(entry => entry.kind.endsWith('.head.v1')).every(entry => !entry.model?.some(message => message.role === 'assistant'))).toBe(true);
    expect(journal.durableId(root)).toBeDefined();
  });

  test('inherits native IDs, labels and leaf through a durable fork', async () => {
    const { journal, harness, manager, conversation, write } = await setup();
    let root = '';
    let forkAt = '';
    await write(() => {
      root = manager.appendMessage(user('inherited'));
      forkAt = manager.appendLabelChange(root, 'inherited label');
    });
    await write(() => { manager.appendMessage(user('parent only')); });
    const child = await conversation.fork(journal.durableId(forkAt)!, { ownership: { kind: 'ownerless' } }, context);
    const fork = await NativeSessionJournal.open({ harness, conversation: child, context, cwd: '/tmp/native-journal-fixture' });
    journals.push(fork);
    expect(fork.manager.getSessionId()).not.toBe(manager.getSessionId());
    expect(fork.manager.getLeafId()).toBe(forkAt);
    expect(fork.manager.getLabel(root)).toBe('inherited label');
    expect(fork.durableId(root)).toBe(journal.durableId(root));
    fork.manager.appendMessage(user('child only'));
    await fork.flush();
    expect((await child.context(context)).messages).toEqual(convertToLlm(fork.manager.buildSessionContext().messages));
    expect(manager.buildSessionContext().messages.map(message => message.content)).toEqual(['inherited', 'parent only']);
  });

  for (const rootOnly of [false, true]) test(`opens a complete native fork at ${rootOnly ? 'the empty root' : 'an inactive leaf'}`, async () => {
    const { harness, manager, journal, conversation, write } = await setup();
    let root = '';
    let left = '';
    let right = '';
    await write(() => {
      root = manager.appendMessage(user('root'));
      journal.linkMessage(root, 'product-root');
      left = manager.appendMessage(user('left'));
      journal.linkMessage(left, 'product-left');
      manager.appendLabelChange(left, 'preserved left label');
    });
    await write(() => {
      manager.branch(root);
      right = manager.appendMessage(user('right'));
      journal.linkMessage(right, 'product-right');
    });
    const before = journal.committedSnapshot();
    const child = await conversation.fork(journal.durableId(right)!, { ownership: { kind: 'ownerless' } }, context);
    const header = SessionManager.inMemory('/tmp/native-journal-fixture', { id: `fork-${rootOnly}` }).getHeader()!;
    const leaf = rootOnly ? null : left;
    const fork = await NativeSessionJournal.open({
      harness, conversation: child, context, cwd: '/tmp/native-journal-fixture', header, forkLeaf: leaf,
    });
    journals.push(fork);
    expect(fork.manager.getLeafId()).toBe(leaf);
    expect(fork.manager.getSessionId()).toBe(header.id);
    expect(fork.manager.getEntries()).toEqual(before.entries);
    expect(fork.manager.getLabel(left)).toBe('preserved left label');
    expect(fork.committedSnapshot().entryIds).toEqual(before.entryIds);
    expect((await child.context(context)).messages).toEqual(rootOnly ? [] : [user('root'), user('left')]);
    expect(journal.committedSnapshot()).toEqual(before);
    fork.close();
    const reopened = await NativeSessionJournal.open({ harness, conversation: child, context, cwd: '/tmp/native-journal-fixture' });
    journals.push(reopened);
    expect(reopened.manager.getSessionId()).toBe(header.id);
    expect(reopened.manager.getLeafId()).toBe(leaf);
    expect(reopened.manager.getEntry(right)).toEqual(manager.getEntry(right));
  });

  test('an invalid fork leaf cannot commit its replacement header or discard inherited state', async () => {
    const { harness, manager, journal, conversation, write } = await setup();
    let root = '';
    await write(() => { root = manager.appendMessage(user('inherited')); });
    const before = journal.committedSnapshot();
    const child = await conversation.fork(journal.durableId(root)!, { ownership: { kind: 'ownerless' } }, context);
    const header = SessionManager.inMemory('/tmp/native-journal-fixture', { id: 'valid-retry' }).getHeader()!;
    await expect(NativeSessionJournal.open({
      harness, conversation: child, context, cwd: '/tmp/native-journal-fixture', header, forkLeaf: 'missing-leaf',
    })).rejects.toThrow();
    const fork = await NativeSessionJournal.open({
      harness, conversation: child, context, cwd: '/tmp/native-journal-fixture', header, forkLeaf: root,
    });
    journals.push(fork);
    expect(fork.manager.getSessionId()).toBe(header.id);
    expect(fork.manager.getLeafId()).toBe(root);
    expect(fork.committedSnapshot().entries).toEqual(before.entries);
    expect(journal.committedSnapshot()).toEqual(before);
  });

  test('fork value mapping preserves identity even when the mapper mutates its input', async () => {
    const { harness, manager, journal, conversation, write } = await setup();
    let id = '';
    await write(() => { id = manager.appendMessage(user('inherited')); });
    const before = journal.committedSnapshot();
    const child = await conversation.fork(journal.durableId(id)!, { ownership: { kind: 'ownerless' } }, context);
    await expect(NativeSessionJournal.open({
      harness, conversation: child, context, cwd: '/tmp/native-journal-fixture', forkLeaf: id,
      mapForkEntry: entry => { entry.id = 'changed'; return entry; },
    })).rejects.toThrow('cannot change entry identity');
    const fork = await NativeSessionJournal.open({
      harness, conversation: child, context, cwd: '/tmp/native-journal-fixture', forkLeaf: id,
    });
    journals.push(fork);
    expect(fork.committedSnapshot().entries).toEqual(before.entries);
    expect(journal.committedSnapshot()).toEqual(before);
  });

  test('cuts a durable fork at the selected entry inside one multi-entry transaction', async () => {
    const { journal, harness, manager, conversation, write } = await setup();
    let selected = '';
    let later = '';
    await write(() => {
      selected = manager.appendMessage(user('selected'));
      later = manager.appendMessage(user('later in the same transaction'));
      manager.appendLabelChange(selected, 'later label');
    });
    const child = await conversation.fork(journal.durableId(selected)!, { ownership: { kind: 'ownerless' } }, context);
    const fork = await NativeSessionJournal.open({ harness, conversation: child, context, cwd: '/tmp/native-journal-fixture' });
    journals.push(fork);
    expect(fork.manager.getLeafId()).toBe(selected);
    expect(fork.manager.getEntry(later)).toBeUndefined();
    expect(fork.manager.getLabel(selected)).toBeUndefined();
    expect(fork.manager.buildSessionContext().messages).toEqual((await child.context(context)).messages);
  });

  test('attaches edits to the native identity so forks at edits and compactions have matching context', async () => {
    const { journal, harness, manager, conversation, write } = await setup();
    let edit = '';
    let compact = '';
    await write(() => {
      const root = manager.appendMessage(user('root'));
      const kept = manager.appendMessage(user('kept'));
      edit = manager.appendContextEdit(root, { content: 'edited root' });
      compact = manager.appendCompaction('summary', kept, 30);
      manager.appendMessage(user('after fork points'));
    });
    for (const id of [edit, compact]) {
      const child = await conversation.fork(journal.durableId(id)!, { ownership: { kind: 'ownerless' } }, context);
      const fork = await NativeSessionJournal.open({ harness, conversation: child, context, cwd: '/tmp/native-journal-fixture' });
      journals.push(fork);
      expect(fork.manager.getLeafId()).toBe(id);
      expect(convertToLlm(fork.manager.buildSessionContext().messages)).toEqual((await child.context(context)).messages);
      fork.manager.appendCustomEntry('after fork');
      await fork.flush();
      expect(convertToLlm(fork.manager.buildSessionContext().messages)).toEqual((await child.context(context)).messages);
    }
  });

  test('migrates previous native envelopes and supports native session replacement and synchronous persist rollback', async () => {
    const storage = new MemoryStorage();
    const harness = await Harness.open(storage, options(), context);
    harnesses.push(harness);
    const conversation = await harness.root(context);
    const native = SessionManager.inMemory('/tmp/native-journal-fixture', { id: 'legacy-session' });
    const id = native.appendMessage(user('legacy'));
    const record = await conversation.commit(tx => tx.appendEntry(conversation.id, {
      kind: 'mkagent.coding.entry.v1', data: copyJson(native.getEntry(id)), model: [user('legacy')],
    }), context);
    const journal = await NativeSessionJournal.open({
      harness, conversation, context, cwd: native.getCwd(), header: native.getHeader()!,
    });
    journals.push(journal);
    expect(journal.manager.getSessionId()).toBe('legacy-session');
    expect(journal.durableId(id)).toBe(record.id);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => journal.manager.appendCustomEntry('invalid', circular)).toThrow();
    expect(journal.manager.getLeafId()).toBe(id);
    expect(journal.manager.getEntryCount()).toBe(1);
    journal.manager.newSession({ id: 'next-native-session' });
    journal.manager.appendCustomEntry('new session');
    await journal.flush();
    expect(journal.manager.getSessionId()).toBe('next-native-session');
    expect((await conversation.context(context)).messages).toEqual([]);
  });

  test('imports ordinary durable heads and full-message edits without rewriting history or losing fork provenance', async () => {
    const harness = await Harness.open(new MemoryStorage(), options(), context);
    harnesses.push(harness);
    const conversation = await harness.root(context);
    const append = (draft: EntryDraft) =>
      conversation.commit(tx => tx.appendEntry(conversation.id, draft), context);
    const first = await append({ kind: 'legacy.user', model: [user('earliest')] });
    const kept = await append({ kind: 'legacy.user', model: [user('kept')] });
    await append({ kind: 'legacy.user', model: [user('tail')] });
    const edit = await append({ kind: 'legacy.edit', edits: [
      { target: first.id, action: 'replace', messages: [user('complete replacement', 9), user('extra message', 10)] },
    ] });
    const head = await append({ kind: 'legacy.head', head: kept.id,
      model: [{ role: 'system', content: 'retained prompt', timestamp: 11 }] });
    const replacement = [user('new metadata', 30), user('second contribution', 31)];
    const last = await append({ kind: 'legacy.edit', edits: [{ target: kept.id, action: 'replace', messages: replacement }] });
    const before = (await conversation.entries({}, 50, undefined, context)).items;
    const journal = await NativeSessionJournal.open({ harness, conversation, context, cwd: '/tmp/native-journal-fixture' });
    journals.push(journal);
    const equivalent = async () => expect(convertToLlm(journal.manager.buildSessionContext().messages))
      .toEqual((await conversation.context(context)).messages);
    await equivalent();
    expect(journal.manager.buildSessionContext().messages).toEqual([
      { role: 'system', content: 'retained prompt', timestamp: 11 }, ...replacement, user('tail'),
    ]);
    expect((await conversation.entries({}, 50, undefined, context)).items).toEqual(before);
    journal.manager.appendCustomEntry('native continuation');
    await journal.flush();
    await equivalent();
    for (const anchor of [edit.id, head.id, last.id]) {
      const child = await conversation.fork(anchor, { ownership: { kind: 'ownerless' } }, context);
      const fork = await NativeSessionJournal.open({ harness, conversation: child, context, cwd: '/tmp/native-journal-fixture' });
      journals.push(fork);
      expect(convertToLlm(fork.manager.buildSessionContext().messages)).toEqual((await child.context(context)).messages);
      fork.manager.appendMessage(user('fork continuation'));
      await fork.flush();
      expect(convertToLlm(fork.manager.buildSessionContext().messages)).toEqual((await child.context(context)).messages);
    }
    const reopened = await NativeSessionJournal.open({ harness, conversation, context, cwd: '/tmp/native-journal-fixture' });
    journals.push(reopened);
    expect(reopened.manager.buildSessionContext()).toEqual(journal.manager.buildSessionContext());
  });

  test('publishes every real TaskRuntime receipt before a nested task completes', async () => {
    let journal!: NativeSessionJournal;
    let firstId = '';
    let secondId = '';
    const Child = defineTask<{}, { phase: 'run' }, {}>({
      name: 'test.journal-child', version: 1, initial: () => ({ phase: 'run' }),
      phases: { run: async (_task, runtime) => journal.phase(async () => {
        expect(journal.manager.getEntry(firstId)).toBeDefined();
        secondId = journal.manager.appendCustomEntry('nested child');
        await runtime.commit(async tx => {
          await journal.commit(tx);
          return { status: 'terminal', outcome: { status: 'completed', result: {} } };
        }, context);
      }) },
      abort: async (_task, runtime) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
    });
    const Parent = defineTask<{}, { phase: 'run' }, {}>({
      name: 'test.journal-parent', version: 1, initial: () => ({ phase: 'run' }),
      phases: { run: async (_task, runtime) => journal.phase(async () => {
        firstId = journal.manager.appendCustomEntry('parent first commit');
        let child!: TaskId;
        await runtime.commit(async tx => {
          child = await tx.createTask(Child, {}, { ownership: { kind: 'task', taskId: runtime.taskId } });
          await journal.commit(tx);
        }, context);
        expect(journal.durableId(firstId)).toBeDefined();
        await runtime.waitForTask(child, context);
        expect(journal.manager.getEntry(secondId)).toBeDefined();
        journal.manager.appendCustomEntry('parent final commit');
        await runtime.commit(async tx => {
          await journal.commit(tx);
          return { status: 'terminal', outcome: { status: 'completed', result: {} } };
        }, context);
      }) },
      abort: async (_task, runtime) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'test.native-journal', tasks: [Parent, Child] }));
    const harness = await Harness.open(new MemoryStorage(), { ...options(), registry }, context);
    harnesses.push(harness);
    const conversation = await harness.root(context);
    journal = await NativeSessionJournal.open({ harness, conversation, context, cwd: '/tmp/native-journal-fixture' });
    journals.push(journal);
    const task = await conversation.commit(tx => tx.createTask(Parent, {}, { ownership: { kind: 'conversation' } }), context);
    const settled = await harness.waitForTask(task, context);
    expect(settled.state.outcome.status).toBe('completed');
    expect(journal.manager.getEntries().map(entry => entry.type === 'custom' ? entry.customType : entry.type))
      .toEqual(['parent first commit', 'nested child', 'parent final commit']);
  });
});
