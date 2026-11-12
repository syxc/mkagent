import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Harness, createRegistry, type Conversation } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { DurableCodingSessionStore } from '../src/durable-session-store.ts';
import { appendCodingEntries } from '../src/entry-batch.ts';
import { CodingSessionView } from '../src/session-view.ts';
import { SessionManager } from '../src/upstream/core/session-manager.js';
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, convertToLlm } from '../src/upstream/core/messages.js';
import type { AssistantMessage } from '@earendil-works/pi-ai';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function setup() {
  const path = mkdtempSync(join(tmpdir(), 'durable-native-store-'));
  temporary.push(path);
  const options = { registry: createRegistry(), models: builtinModels({ credentials: new InMemoryCredentialStore() }) };
  const open = () => openNodeJsonlStorage(path, BACKGROUND_CONTEXT).then(storage => Harness.open(storage, options, BACKGROUND_CONTEXT));
  const harness = await open();
  const conversation = await harness.root(BACKGROUND_CONTEXT);
  const storeFor = (source: Conversation) => new DurableCodingSessionStore({
    id: 'isolated-session', cwd: path, sessionPath: path, conversation: () => source, context: BACKGROUND_CONTEXT,
  });
  return { harness, conversation, store: storeFor(conversation), storeFor, open };
}

async function managerFor(state: Awaited<ReturnType<typeof setup>>) {
  const manager = SessionManager.inMemory(state.store.cwd, { id: state.store.id });
  return SessionManager.inMemory(state.store.cwd, undefined, [manager.getHeader(), ...await state.store.read()]);
}

async function expectCanonical(state: Awaited<ReturnType<typeof setup>>) {
  const manager = await managerFor(state);
  const actual = convertToLlm(manager.buildSessionProjection().messages);
  expect(actual).toEqual((await state.conversation.context(BACKGROUND_CONTEXT)).messages);
  return actual;
}

describe('durable native session storage', () => {
  test('preserves a core replacement order while keeping native child provenance', async () => {
    const state = await setup();
    try {
      const a = { role: 'user' as const, content: 'A', timestamp: 1 };
      const b = { role: 'user' as const, content: 'B', timestamp: 2 };
      const record = await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'test.multiple', model: [a, b],
      }), BACKGROUND_CONTEXT);
      await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'test.replace', edits: [{ target: record.id, action: 'replace', messages: [b, a, b] }],
      }), BACKGROUND_CONTEXT);
      expect((await expectCanonical(state)).map(message => message.content)).toEqual(['B', 'A', 'B']);
      const manager = await managerFor(state);
      const id = manager.appendContextEdit(`d-${record.id}-0`, { content: 'edited A' });
      await state.conversation.commit(tx => appendCodingEntries(tx, state.conversation.id,
        state.store.compile([manager.getEntry(id)])), BACKGROUND_CONTEXT);
      expect((await expectCanonical(state)).map(message => message.content)).toEqual(['B', 'edited A', 'B']);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  for (const action of ['omit', 'empty'] as const) test(`restores a core ${action} with a later native replacement`, async () => {
    const state = await setup();
    try {
      const record = await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'pi.user', model: [{ role: 'user', content: 'A', timestamp: 1 }],
      }), BACKGROUND_CONTEXT);
      await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'test.edit', edits: [action === 'omit' ? { target: record.id, action: 'omit' }
          : { target: record.id, action: 'replace', messages: [] }],
      }), BACKGROUND_CONTEXT);
      expect(await expectCanonical(state)).toHaveLength(0);
      const manager = await managerFor(state);
      const id = manager.appendContextEdit(`d-${record.id}-0`, { content: 'B' });
      await state.conversation.commit(tx => appendCodingEntries(tx, state.conversation.id,
        state.store.compile([manager.getEntry(id)])), BACKGROUND_CONTEXT);
      expect((await expectCanonical(state)).map(message => message.content)).toEqual(['B']);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('keeps a later message of one durable contribution across native compaction and subsequent edits', async () => {
    const state = await setup();
    try {
      const record = await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'test.multiple', model: [
          { role: 'user', content: 'first message', timestamp: 1 },
          { role: 'user', content: 'second message', timestamp: 2 },
        ],
      }), BACKGROUND_CONTEXT);
      const manager = await managerFor(state);
      const id = manager.appendCompaction('summary', `d-${record.id}-1`, 20, undefined, true);
      await state.conversation.commit(tx => appendCodingEntries(tx, state.conversation.id,
        state.store.compile([manager.getEntry(id)])), BACKGROUND_CONTEXT);
      expect((await expectCanonical(state)).at(-1)?.content).toBe('second message');
      const restored = await managerFor(state);
      const edit = restored.appendContextEdit(`d-${record.id}-1`, { content: 'edited second' });
      await state.conversation.commit(tx => appendCodingEntries(tx, state.conversation.id,
        state.store.compile([restored.getEntry(edit)])), BACKGROUND_CONTEXT);
      expect((await expectCanonical(state)).at(-1)?.content).toBe('edited second');
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('restores a persisted native omission with a later native replacement', async () => {
    const state = await setup();
    try {
      const manager = await managerFor(state);
      const target = manager.appendCustomMessageEntry('reminder', 'original', false);
      await state.conversation.commit(tx => appendCodingEntries(tx, state.conversation.id,
        state.store.compile([manager.getEntry(target)])), BACKGROUND_CONTEXT);
      for (const replacement of [null, { content: 'restored' }]) {
        const current = await managerFor(state);
        const id = current.appendContextEdit(target, replacement);
        await state.conversation.commit(tx => appendCodingEntries(tx, state.conversation.id,
          state.store.compile([current.getEntry(id)])), BACKGROUND_CONTEXT);
        const messages = await expectCanonical(state);
        expect(messages).toHaveLength(replacement ? 1 : 0);
        if (replacement) expect(messages[0]?.content).toEqual([{ type: 'text', text: 'restored' }]);
      }
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('retains a system contribution inside a core compaction range', async () => {
    const state = await setup();
    try {
      const kept = await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'pi.user', model: [{ role: 'user', content: 'kept', timestamp: 1 }],
      }), BACKGROUND_CONTEXT);
      await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'pi.system', model: [{ role: 'system', content: 'retained system', timestamp: 2 }],
      }), BACKGROUND_CONTEXT);
      await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'pi.compaction', head: kept.id,
        model: [{ role: 'user', content: 'summary', timestamp: 3 }],
      }), BACKGROUND_CONTEXT);
      const messages = await expectCanonical(state);
      expect(messages[0]?.content).toBe('retained system');
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('uses durable assistant filtering, tool result order and missing results', async () => {
    const state = await setup();
    try {
      const assistant: AssistantMessage = {
        role: 'assistant', content: [], api: 'openai-completions', provider: 'test', model: 'test',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: 1,
      };
      await state.conversation.commit(async tx => {
        for (const stopReason of ['aborted', 'error', 'deferred'] as const) {
          await tx.appendEntry(state.conversation.id, { kind: 'pi.assistant', model: [{ ...assistant, stopReason }] });
        }
        await tx.appendEntry(state.conversation.id, { kind: 'pi.assistant', model: [{
          ...assistant, stopReason: 'toolUse', content: ['a', 'b', 'c'].map(id =>
            ({ type: 'toolCall', id, name: 'test', arguments: {} })),
        }] });
        for (const toolCallId of ['b', 'a']) {
          await tx.appendEntry(state.conversation.id, { kind: 'pi.tool-result', model: [{
            role: 'toolResult', toolCallId, toolName: 'test', content: [{ type: 'text', text: toolCallId }],
            isError: false, timestamp: 2,
          }] });
        }
      }, BACKGROUND_CONTEXT);
      const messages = await expectCanonical(state);
      expect(messages.map(message => message.role)).toEqual(['assistant', 'toolResult', 'toolResult', 'toolResult']);
      expect(messages.slice(1).map(message => message.toolCallId)).toEqual(['a', 'b', 'c']);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('preserves a non-self head marker and the retained range', async () => {
    const state = await setup();
    try {
      const kept = await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'pi.user', model: [{ role: 'user', content: 'kept', timestamp: 1 }],
      }), BACKGROUND_CONTEXT);
      await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'extension.checkpoint', head: kept.id,
        model: [{ role: 'user', content: 'checkpoint', timestamp: 2 }],
      }), BACKGROUND_CONTEXT);
      const messages = await expectCanonical(state);
      expect(messages.map(message => message.content)).toEqual(['checkpoint', 'kept']);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('compiles a compaction anchored to metadata in the same batch', async () => {
    const state = await setup();
    try {
      await state.store.read();
      const manager = SessionManager.inMemory(state.store.cwd, { id: state.store.id });
      const anchor = manager.appendCustomEntry('checkpoint', { ready: true });
      const kept = manager.appendCustomMessageEntry('retained', 'keep me', false);
      const compacted = manager.appendCompaction('earlier summary', anchor, 20, undefined, true);
      const entries = [anchor, kept, compacted].map(id => manager.getEntry(id));
      expect(() => state.store.compile(entries)).not.toThrow();
      const compiled = state.store.compile(entries);
      await state.conversation.commit(tx => appendCodingEntries(tx, state.conversation.id, compiled), BACKGROUND_CONTEXT);
      const view = new CodingSessionView(state.store);
      await view.refresh();
      expect(convertToLlm(view.view.buildSessionProjection().messages))
        .toEqual((await state.conversation.context(BACKGROUND_CONTEXT)).messages);
      expect(view.view.getEntry(anchor).customType).toBe('checkpoint');
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  for (const native of [false, true]) for (const replacement of [[], [
    { role: 'user' as const, content: 'replacement one', timestamp: 2 },
    { role: 'user' as const, content: 'replacement two', timestamp: 3 },
  ]]) test(`restores complete core edits of ${native ? 'native' : 'core'} entries (${replacement.length} messages)`, async () => {
    const state = await setup();
    try {
      const record = await state.conversation.commit(async tx => {
        if (!native) return tx.appendEntry(state.conversation.id, {
          kind: 'pi.user', model: [{ role: 'user', content: 'original', timestamp: 1 }],
        });
        const manager = SessionManager.inMemory(state.store.cwd, { id: state.store.id });
        const id = manager.appendCustomMessageEntry('test', 'original', false);
        return tx.appendEntry(state.conversation.id, state.store.compile([manager.getEntry(id)])[0]!);
      }, BACKGROUND_CONTEXT);
      await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'test.core-edit', edits: [replacement.length
          ? { target: record.id, action: 'replace', messages: replacement }
          : { target: record.id, action: 'omit' }],
      }), BACKGROUND_CONTEXT);
      const view = new CodingSessionView(state.store);
      await view.refresh();
      expect(convertToLlm(view.view.buildSessionProjection().messages))
        .toEqual((await state.conversation.context(BACKGROUND_CONTEXT)).messages);
      expect(convertToLlm(view.view.buildSessionProjection().messages)).toHaveLength(replacement.length);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('persists metadata once, restores stable IDs, and isolates a fork', async () => {
    const state = await setup();
    try {
      const anchor = await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'pi.user', model: [{ role: 'user', content: 'first', timestamp: 1 }],
      }), BACKGROUND_CONTEXT);
      const view = new CodingSessionView(state.store);
      await view.refresh();
      view.appendEntry('counter', { count: 1 });
      view.setSessionName('root');
      view.setLabel(`d-${anchor.id}-0`, 'anchor');
      await view.flush();
      const entries = await state.store.read();
      await state.store.append(entries.filter(entry => entry.type !== 'message'));
      expect(await state.store.read()).toEqual(entries);
      const fork = await state.conversation.fork(anchor.id, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
      const child = new CodingSessionView(state.storeFor(fork));
      await child.refresh();
      expect(child.getSessionName()).toBeUndefined();
      child.setSessionName('child');
      await child.flush();
      await view.refresh();
      expect(view.getSessionName()).toBe('root');
      await state.harness.close(BACKGROUND_CONTEXT);
      const reopened = await state.open();
      try {
        const root = await reopened.root(BACKGROUND_CONTEXT);
        expect(await state.storeFor(root).read()).toEqual(entries);
      } finally { await reopened.close(BACKGROUND_CONTEXT); }
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('compiles custom messages, edits and compaction into the same model projection', async () => {
    const state = await setup();
    try {
      const record = await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'pi.user', model: [{ role: 'user', content: 'original', timestamp: 1 }],
      }), BACKGROUND_CONTEXT);
      const entries = await state.store.read();
      const manager = SessionManager.inMemory(state.store.cwd, { id: state.store.id });
      const header = manager.getHeader();
      const preview = SessionManager.inMemory(state.store.cwd, undefined, [header, ...entries]);
      const added: string[] = [];
      added.push(preview.appendCustomEntry('state', { ready: true }));
      added.push(preview.appendCustomMessageEntry('reminder', 'remember', false, { source: 'test' }));
      added.push(preview.appendContextEdit(`d-${record.id}-0`, { content: 'modified' }));
      added.push(preview.appendCompaction('earlier summary', `d-${record.id}-0`, 20, undefined, true));
      const compiled = state.store.compile(added.map(id => preview.getEntry(id)));
      await state.conversation.commit(async tx => {
        for (const draft of compiled) await tx.appendEntry(state.conversation.id, draft);
      }, BACKGROUND_CONTEXT);
      const durable = await state.conversation.context(BACKGROUND_CONTEXT);
      const restored = SessionManager.inMemory(state.store.cwd, undefined, [header, ...await state.store.read()]);
      expect(durable.messages).toEqual(convertToLlm(restored.buildSessionProjection().messages));
      expect(durable.messages.some(message => message.role === 'user' && message.content === 'modified')).toBe(true);
      expect(durable.messages.some(message => message.role === 'user'
        && Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text === 'remember'))).toBe(true);
      expect(restored.getEntries().filter(entry => entry.customType === 'state')).toHaveLength(1);
      expect(restored.getEntries().filter(entry => entry.type === 'message')).toHaveLength(1);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('projects core compaction and context edits while retaining raw metadata history', async () => {
    const state = await setup();
    try {
      await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'pi.user', model: [{ role: 'user', content: 'old', timestamp: 1 }],
      }), BACKGROUND_CONTEXT);
      const kept = await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'pi.user', model: [{ role: 'user', content: 'kept', timestamp: 2 }],
      }), BACKGROUND_CONTEXT);
      await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'pi.compaction', head: kept.id,
        model: [{ role: 'user', content: [{ type: 'text', text: COMPACTION_SUMMARY_PREFIX + 'summary' + COMPACTION_SUMMARY_SUFFIX }], timestamp: 3 }],
      }), BACKGROUND_CONTEXT);
      await state.conversation.commit(tx => tx.appendEntry(state.conversation.id, {
        kind: 'test.edit', edits: [{ target: kept.id, action: 'replace', messages: [{ role: 'user', content: 'edited', timestamp: 2 }] }],
      }), BACKGROUND_CONTEXT);
      const view = new CodingSessionView(state.store);
      await view.refresh();
      const projection = view.view.buildSessionProjection();
      expect(convertToLlm(projection.messages)).toEqual((await state.conversation.context(BACKGROUND_CONTEXT)).messages);
      expect(view.view.getEntries().filter(entry => entry.type === 'message')).toHaveLength(2);
      expect(state.store.resolveEntry(`d-${kept.id}-0`)).toBe(kept.id);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });
});
