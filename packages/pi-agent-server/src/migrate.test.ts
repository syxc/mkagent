/**
 * Legacy 1.1.0 transcript conversion: entry drafts, compaction head mapping
 * through the id map, tail model/thinking recovery, and crash-safe idempotency.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type EntryRecord, type ToolRegistration } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { migrateLegacySession } from './migrate.ts';

const USAGE = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const LEGACY_LINES = [
  { type: 'session', id: 's-1', version: 3 },
  { type: 'message', id: 'm1', message: { role: 'user', content: 'hi', timestamp: 1 } },
  { type: 'message', id: 'm2', message: {
    role: 'assistant', content: [{ type: 'text', text: 'hello' }],
    api: 'x', provider: 'p', model: 'm', usage: USAGE, stopReason: 'stop', timestamp: 1,
  } },
  { type: 'message', id: 'm3', message: { role: 'user', content: 'second', timestamp: 1 } },
  // Compaction keeping from m2 onward: the summary entry's head must map to
  // the converted m2 entry.
  { type: 'compaction', id: 'c1', summary: 'EARLIER-CONTEXT-SUMMARY', firstKeptEntryId: 'm2' },
  { type: 'message', id: 'm4', message: { role: 'user', content: 'after compaction', timestamp: 1 } },
  { type: 'message', id: 'm5', message: {
    role: 'toolResult', content: [{ type: 'text', text: 'tool out' }], isError: false,
    toolCallId: 't1', toolName: 'read', timestamp: 1,
  } as unknown as object },
  { type: 'custom_message', id: 'cm1', content: 'custom user note', display: 'note' },
  { type: 'usage', id: 'u1' },
  { type: 'thinking_level_change', id: 'tl1', thinkingLevel: 'high' },
  { type: 'model_change', id: 'mc1', provider: 'anthropic', modelId: 'claude-test' },
];

async function openMigrationHarness(storeDir: string): Promise<Harness> {
  const storage = await openNodeJsonlStorage(storeDir, BACKGROUND_CONTEXT);
  return Harness.open(storage, {
    models: () => {
      throw new Error('Model access is not expected during migration');
    },
    registry: createRegistry<ToolRegistration>(),
  }, BACKGROUND_CONTEXT);
}

async function scanRootEntries(harness: Harness): Promise<EntryRecord[]> {
  return harness.commit(async tx => {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100);
    return page.items;
  }, BACKGROUND_CONTEXT) as unknown as Promise<EntryRecord[]>;
}

describe('migrateLegacySession', () => {
  const dirs: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('converts messages, compaction heads, and reports the session tail', async () => {
    const sessionPath = scratch();
    mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'),
      LEGACY_LINES.map(line => JSON.stringify(line)).join('\n') + '\n');

    const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
    try {
      const debugMessages: string[] = [];
      const tail = await migrateLegacySession(harness, sessionPath, m => debugMessages.push(m));

      expect(tail.thinkingLevel).toBe('high');
      expect(tail.model).toEqual({ provider: 'anthropic', modelId: 'claude-test' });
      expect(debugMessages.join('\n')).toContain('Migrated');

      const entries = await scanRootEntries(harness);
      // The session view may reorder around the compaction boundary; the
      // conversion contract is the entry multiset plus the head mapping below.
      const kinds = entries.map(e => e.kind).sort();
      expect(kinds).toEqual([
        'pi.assistant', 'pi.compaction', 'pi.tool-result', 'pi.user', 'pi.user', 'pi.user', 'pi.user',
      ]);

      // Compaction: summary as user message, head mapped through the id map.
      const compaction = entries.find(e => e.kind === 'pi.compaction')!;
      const summaryText = JSON.stringify(compaction.model?.[0]);
      expect(summaryText).toContain('EARLIER-CONTEXT-SUMMARY');
      expect((compaction.data as { reason?: string }).reason).toBe('manual');
      const kept = entries.find(e => e.kind === 'pi.assistant')!;
      expect(compaction.head).toBe(kept.id);

      // Bookkeeping entries (usage, thinking/model changes) are not converted.
      expect(kinds).not.toContain('pi.system');

      const idMap = JSON.parse(readFileSync(join(sessionPath, 'durable-store', 'id-map.json'), 'utf-8')) as Record<string, number>;
      expect(Object.keys(idMap).sort()).toEqual(['c1', 'cm1', 'm1', 'm2', 'm3', 'm4', 'm5']);
      expect(idMap.m2).toBe(kept.id);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('is idempotent: a store that already has entries is left untouched', async () => {
    const sessionPath = scratch();
    mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'),
      LEGACY_LINES.map(line => JSON.stringify(line)).join('\n') + '\n');

    const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
    try {
      await migrateLegacySession(harness, sessionPath, () => {});
      const entriesAfterFirst = await scanRootEntries(harness);

      const tail = await migrateLegacySession(harness, sessionPath, () => {});
      const entriesAfterSecond = await scanRootEntries(harness);

      expect(entriesAfterSecond.length).toBe(entriesAfterFirst.length);
      // The tail is still recovered even when nothing converts.
      expect(tail.thinkingLevel).toBe('high');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('leaves a session without a legacy transcript untouched', async () => {
    const sessionPath = scratch();
    const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
    try {
      const tail = await migrateLegacySession(harness, sessionPath, () => {});
      expect(tail).toEqual({});
      expect(await scanRootEntries(harness)).toEqual([]);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
});
