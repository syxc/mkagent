/** Fixtures were written by the released 1.4.0 SDK, not by the SDK under test. */
import { describe, expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createRegistry, Harness, LiveDoc, type ConversationId, type Cursor, type EntryId,
  type EntryRecord, type TaskId,
} from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { migrateLegacySession, readEntryIdMap } from './migrate.ts';
import { openDurableStorage } from './storage/durable-storage.ts';

for (const backend of ['sqlite', 'jsonl'] as const) describe(`1.4.0 ${backend} upgrade`, () => {
  it('preserves context, document migrations, paginated fork ancestry and continuation after reopen', async () => {
    const source = join(import.meta.dir, '../test-fixtures/pi-durable-1.4.0', backend);
    const expected = JSON.parse(readFileSync(join(source, 'expected.json'), 'utf8'));
    expect(expected.sdk).toBe('1.4.0');
    const session = mkdtempSync(join(tmpdir(), 'durable-upgrade-'));
    const store = join(session, 'durable-store');
    cpSync(source, store, { recursive: true, filter: path => !['store.db-shm', 'store.db-wal'].includes(basename(path)) });
    const open = async () => Harness.open(await openDurableStorage(store, context), {
      registry: createRegistry(), models: () => { throw new Error('Upgrade fixture must not access a model'); },
    }, context);
    let harness = await open();
    try {
      const root = await harness.root(context);
      expect((await root.context(context)).messages).toEqual(expected.rootMessages);
      const live = await harness.snapshot(LiveDoc, root.id, context);
      expect(live?.run).toMatchObject({ taskId: expected.ids.generation, inputs: [], turns: 0 });
      expect(live?.compactions).toEqual([{ taskId: expected.ids.compaction, trigger: 'threshold', blocking: false, attempt: 1 }]);
      expect(live?.compactionFailure).toEqual({ taskId: expected.ids.compaction, trigger: 'manual', error: 'old fixture failure' });
      mkdirSync(join(session, '.pi-sessions'));
      writeFileSync(join(session, '.pi-sessions', 'fixture.jsonl'), readFileSync(join(source, '../legacy.jsonl')));
      await migrateLegacySession(harness, session, () => {});
      expect(Object.fromEntries(readEntryIdMap(store)!)).toEqual(expected.idMap);
      const grandchild = (await harness.conversation(expected.ids.grandchild as ConversationId, context))!;
      const entries: EntryRecord[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await grandchild.entries({ order: 'ascending' }, 2, cursor, context);
        entries.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
      expect(entries.map(entry => entry.conversationId)).toContain(expected.ids.child);
      expect(entries.map(entry => entry.conversationId)).toContain(expected.ids.grandchild);
      expect(entries.some(entry => entry.id === expected.idMap.m4)).toBe(true);
      expect(entries.some(entry => entry.model?.[0]?.role === 'assistant' && entry.model[0].content.some(block => block.type === 'toolCall'))).toBe(false);
      const before = (await grandchild.context(context)).messages;
      const appended = await grandchild.commit(tx => tx.appendEntry(grandchild.id, {
        kind: 'pi.user', model: [{ role: 'user', content: 'written by 1.5.0', timestamp: 6 }],
      }), context);
      expect(appended.id).toBeGreaterThan(Math.max(...entries.map(entry => entry.id), ...Object.values(expected.ids) as number[]));
      const fork = await grandchild.fork(appended.id as EntryId, { ownership: { kind: 'ownerless' } }, context);
      await harness.close(context);
      harness = await open();
      const restored = (await harness.conversation(fork.id, context))!;
      expect((await restored.context(context)).messages).toEqual([...before, appended.model![0]]);
      expect((await (await harness.root(context)).context(context)).messages).toEqual(expected.rootMessages);
    } finally {
      await harness.close(context);
      rmSync(session, { recursive: true, force: true });
    }
  });

  it('migrates and settles old generation and tool tasks through the real scheduler', async () => {
    const source = join(import.meta.dir, '../test-fixtures/pi-durable-1.4.0', backend);
    const expected = JSON.parse(readFileSync(join(source, 'expected.json'), 'utf8'));
    const session = mkdtempSync(join(tmpdir(), 'durable-task-upgrade-'));
    cpSync(source, session, { recursive: true, filter: path => !['store.db-shm', 'store.db-wal'].includes(basename(path)) });
    const storage = await openDurableStorage(session, context);
    const generation = (await storage.task(expected.ids.generation as TaskId, context))!;
    const tool = (await storage.task(expected.ids.tool as TaskId, context))!;
    expect([generation.version, tool.version]).toEqual([1, 2]);
    const harness = await Harness.open(storage, {
      registry: createRegistry(), models: () => { throw new Error('No model is configured in this fixture'); },
    }, context);
    try {
      const [newGeneration, newTool] = await Promise.all([
        harness.waitForTask(expected.ids.generation as TaskId, context),
        harness.waitForTask(expected.ids.tool as TaskId, context),
      ]);
      expect([newGeneration.version, newTool.version]).toEqual([2, 3]);
      expect([newGeneration.input, newTool.input]).toEqual([generation.input, tool.input]);
      expect(newGeneration.state.status).toBe('terminal');
      expect(newTool.state.status).toBe('terminal');
      expect((await harness.snapshot(LiveDoc, expected.ids.root as ConversationId, context))?.run).toBeUndefined();
    } finally {
      await harness.close(context);
      rmSync(session, { recursive: true, force: true });
    }
  });
});
