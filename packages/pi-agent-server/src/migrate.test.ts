/**
 * Legacy 1.1.0 transcript conversion: entry drafts, compaction head mapping
 * through the id map, tail model/thinking recovery, and crash-safe idempotency.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type EntryRecord, type TaskId, type TaskRecord, type ToolRegistration } from '@earendil-works/pi-durable';
import { JsonlStorage, openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { commitWrites } from '@earendil-works/pi-durable/testing';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { migrateLegacySession, migrateParentStore, readLegacyBranchConversation } from './migrate.ts';
import { openDurableStorage } from './storage/durable-storage.ts';

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

async function openMigrationHarness(storeDir: string, backend: 'jsonl' | 'sqlite' = 'jsonl'): Promise<Harness> {
  const storage = await (backend === 'jsonl'
    ? openNodeJsonlStorage(storeDir, BACKGROUND_CONTEXT)
    : openDurableStorage(storeDir, BACKGROUND_CONTEXT));
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

function storeFiles(storeDir: string): Record<string, Buffer> {
  return Object.fromEntries(readdirSync(storeDir).sort().map(name => [name, readFileSync(join(storeDir, name))]));
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
      expect(summaryText).toContain('The conversation history before this point was compacted into the following summary:');
      expect(summaryText).toContain('<summary>\\nEARLIER-CONTEXT-SUMMARY\\n</summary>');
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

  for (const chain of ['active', 'inactive', 'flat'] as const) {
    const inactive = chain === 'inactive';
    it(`keeps only the latest compaction baseline on the ${chain} chain`, async () => {
      const sessionPath = scratch();
      mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
      const transcript = [
        { type: 'session', id: 's-1', version: 3 },
        { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'shared', timestamp: 1 } },
        { type: 'message', id: 'kept', parentId: 'root', message: { role: 'user', content: 'retained', timestamp: 2 } },
        { type: 'compaction', id: 'first', parentId: 'kept', summary: 'old summary', firstKeptEntryId: 'kept', systemMessage: { role: 'system', content: 'old baseline', timestamp: 2 } },
        { type: 'message', id: 'middle', parentId: 'first', message: { role: 'user', content: 'between compactions', timestamp: 3 } },
        { type: 'message', id: 'old-system', parentId: 'middle', message: { role: 'system', content: 'retained old system', timestamp: 3 } },
        { type: 'compaction', id: 'last', parentId: 'old-system', summary: 'latest summary', firstKeptEntryId: 'kept', systemMessage: { role: 'system', content: 'latest baseline', timestamp: 3 } },
        { type: 'message', id: 'after', parentId: 'last', message: { role: 'user', content: 'after compaction', timestamp: 4 } },
        ...(inactive ? [{ type: 'message', id: 'active', parentId: 'root', message: { role: 'user', content: 'other branch', timestamp: 5 } }] : []),
      ];
      const legacyLines = chain === 'flat' ? transcript.map(({ parentId, ...entry }) => entry) : transcript;
      writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'), legacyLines.map(line => JSON.stringify(line)).join('\n') + '\n');
      const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
      try {
        await migrateLegacySession(harness, sessionPath, () => {});
        const conversation = inactive
          ? await harness.conversation((await readLegacyBranchConversation(harness, 'after'))!, BACKGROUND_CONTEXT)
          : await harness.root(BACKGROUND_CONTEXT);
        const messages = (await conversation!.context(BACKGROUND_CONTEXT)).messages;
        expect(messages.map(message => ({ role: message.role, text: typeof message.content === 'string'
          ? message.content : message.content.map(part => 'text' in part ? part.text : '').join('') }))).toEqual([
          { role: 'system', text: 'latest baseline' },
          { role: 'user', text: expect.stringContaining('<summary>\nlatest summary\n</summary>') },
          { role: 'user', text: 'retained' },
          { role: 'user', text: 'between compactions' },
          { role: 'user', text: 'after compaction' },
        ]);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    });

    it(`retains messages after a metadata compaction anchor on the ${chain} chain`, async () => {
      const sessionPath = scratch();
      mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
      const transcript = [
        { type: 'session', id: 's-1', version: 3 },
        { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'discarded', timestamp: 1 } },
        { type: 'model_change', id: 'metadata', parentId: 'root', provider: 'test', modelId: 'test' },
        { type: 'message', id: 'kept', parentId: 'metadata', message: { role: 'user', content: 'retained', timestamp: 2 } },
        { type: 'compaction', id: 'last', parentId: 'kept', summary: 'latest summary', firstKeptEntryId: 'metadata' },
        ...(inactive ? [{ type: 'message', id: 'active', parentId: 'root', message: { role: 'user', content: 'other branch', timestamp: 3 } }] : []),
      ];
      const legacyLines = chain === 'flat' ? transcript.map(({ parentId, ...entry }) => entry) : transcript;
      writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'), legacyLines.map(line => JSON.stringify(line)).join('\n') + '\n');
      const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
      try {
        await migrateLegacySession(harness, sessionPath, () => {});
        const conversation = inactive
          ? await harness.conversation((await readLegacyBranchConversation(harness, 'last'))!, BACKGROUND_CONTEXT)
          : await harness.root(BACKGROUND_CONTEXT);
        const messages = JSON.stringify((await conversation!.context(BACKGROUND_CONTEXT)).messages);
        expect(messages).toContain('latest summary');
        expect(messages).toContain('retained');
        expect(messages).not.toContain('discarded');
        expect(messages).not.toContain('other branch');
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    });
  }

  for (const input of [false, true]) it(`keeps a post-compaction system message in order${input ? ' after a user message' : ''}`, async () => {
    const sessionPath = scratch();
    mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'discarded', timestamp: 1 } },
      { type: 'compaction', id: 'compact', parentId: 'root', summary: 'summary', firstKeptEntryId: 'root' },
      ...(input ? [{ type: 'message', id: 'input', parentId: 'compact', message: { role: 'user', content: 'new input', timestamp: 2 } }] : []),
      { type: 'message', id: 'assistant', parentId: input ? 'input' : 'compact', message: {
        role: 'assistant', content: [{ type: 'text', text: 'assistant' }], api: 'x', provider: 'p', model: 'm', usage: USAGE, stopReason: 'stop', timestamp: 2,
      } },
      { type: 'message', id: 'system', parentId: 'assistant', message: { role: 'system', content: 'later system', timestamp: 3 } },
    ];
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'), transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
    const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
    try {
      await migrateLegacySession(harness, sessionPath, () => {});
      const messages = (await (await harness.root(BACKGROUND_CONTEXT)).context(BACKGROUND_CONTEXT)).messages;
      expect(messages.map(message => message.role)).toEqual(['user', 'user', ...(input ? ['user'] : []), 'assistant', 'system']);
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

  it('migrates only the active parent chain in a branched legacy transcript', async () => {
    const sessionPath = scratch();
    mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'shared', timestamp: 1 } },
      { type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: 'abandoned', timestamp: 2 } },
      { type: 'thinking_level_change', id: 'c', parentId: 'b', thinkingLevel: 'high' },
      { type: 'message', id: 'd', parentId: 'a', message: { role: 'user', content: 'active', timestamp: 3 } },
      { type: 'thinking_level_change', id: 'e', parentId: 'd', thinkingLevel: 'low' },
    ];
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'),
      transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
    const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
    try {
      const tail = await migrateLegacySession(harness, sessionPath, () => {});
      const entries = await scanRootEntries(harness);
      expect(JSON.stringify(entries)).toContain('shared');
      expect(JSON.stringify(entries)).toContain('active');
      expect(JSON.stringify(entries)).not.toContain('abandoned');
      expect(tail.thinkingLevel).toBe('low');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('retains branch summaries in migrated model context', async () => {
    const sessionPath = scratch();
    mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'shared', timestamp: 1 } },
      { type: 'message', id: 'abandoned', parentId: 'root', message: { role: 'user', content: 'abandoned', timestamp: 2 } },
      { type: 'branch_summary', id: 'summary', parentId: 'root', fromId: 'abandoned', summary: 'decisions from abandoned branch', timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'message', id: 'next', parentId: 'summary', message: { role: 'user', content: 'continue', timestamp: 3 } },
    ];
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'), transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
    const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
    try {
      await migrateLegacySession(harness, sessionPath, () => {});
      const context = await (await harness.root(BACKGROUND_CONTEXT)).context(BACKGROUND_CONTEXT);
      expect(JSON.stringify(context.messages)).toContain('decisions from abandoned branch');
      expect(JSON.stringify(context.messages)).not.toContain('"content":"abandoned"');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('preserves legacy context edits without changing sibling branches', async () => {
    const sessionPath = scratch();
    mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'unredacted legacy content', timestamp: 1 } },
      { type: 'message', id: 'omit', parentId: 'root', message: { role: 'user', content: 'omitted legacy content', timestamp: 2 } },
      { type: 'message', id: 'sibling', parentId: 'omit', message: { role: 'user', content: 'sibling content', timestamp: 2 } },
      { type: 'context_edit', id: 'edit', parentId: 'omit', targetId: 'root', replacement: { content: 'replacement content' } },
      { type: 'context_edit', id: 'remove', parentId: 'edit', targetId: 'omit', replacement: null },
      { type: 'message', id: 'next', parentId: 'remove', message: { role: 'user', content: 'continue', timestamp: 3 } },
    ];
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'), transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
    const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
    try {
      await migrateLegacySession(harness, sessionPath, () => {});
      const context = await (await harness.root(BACKGROUND_CONTEXT)).context(BACKGROUND_CONTEXT);
      const messages = JSON.stringify(context.messages);
      expect(messages).toContain('replacement content');
      expect(messages).not.toContain('unredacted legacy content');
      expect(messages).not.toContain('omitted legacy content');
      const siblingId = await readLegacyBranchConversation(harness, 'sibling');
      expect(siblingId).toBeDefined();
      const sibling = await harness.conversation(siblingId!, BACKGROUND_CONTEXT);
      const siblingMessages = JSON.stringify((await sibling!.context(BACKGROUND_CONTEXT)).messages);
      expect(siblingMessages).toContain('unredacted legacy content');
      expect(siblingMessages).toContain('omitted legacy content');
      expect(siblingMessages).not.toContain('replacement content');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('preserves edits on an inactive legacy branch', async () => {
    const sessionPath = scratch();
    mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'root', timestamp: 1 } },
      { type: 'message', id: 'old', parentId: 'root', message: { role: 'user', content: 'original old', timestamp: 2 } },
      { type: 'context_edit', id: 'old-edit', parentId: 'old', targetId: 'old', replacement: { content: 'edited old' } },
      { type: 'message', id: 'old-next', parentId: 'old-edit', message: { role: 'user', content: 'old next', timestamp: 3 } },
      { type: 'message', id: 'active', parentId: 'root', message: { role: 'user', content: 'active', timestamp: 4 } },
    ];
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'), transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
    const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
    try {
      await migrateLegacySession(harness, sessionPath, () => {});
      const id = await readLegacyBranchConversation(harness, 'old-next');
      expect(id).toBeDefined();
      const branch = await harness.conversation(id!, BACKGROUND_CONTEXT);
      const messages = JSON.stringify((await branch!.context(BACKGROUND_CONTEXT)).messages);
      expect(messages).toContain('edited old');
      expect(messages).not.toContain('original old');
      expect(messages).not.toContain('active');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('retries migration after the transaction rolls back', async () => {
    const sessionPath = scratch();
    mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'),
      LEGACY_LINES.map(line => JSON.stringify(line)).join('\n') + '\n');

    const harness = await openMigrationHarness(join(sessionPath, 'durable-store'));
    try {
      await harness.root(BACKGROUND_CONTEXT);
      const commit = harness.commit.bind(harness);
      let fail = true;
      harness.commit = (async (change, context) => commit(async tx => {
        const result = await change(tx);
        if (fail) {
          fail = false;
          throw new Error('injected migration commit failure');
        }
        return result;
      }, context)) as typeof harness.commit;

      await expect(migrateLegacySession(harness, sessionPath, () => {}))
        .rejects.toThrow('injected migration commit failure');
      expect(await scanRootEntries(harness)).toEqual([]);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }

    await migrateParentStore(sessionPath, () => {});
    const retried = await openMigrationHarness(join(sessionPath, 'durable-store'));
    try {
      await migrateLegacySession(retried, sessionPath, () => {});
      expect((await scanRootEntries(retried)).length).toBeGreaterThan(0);
    } finally {
      await retried.close(BACKGROUND_CONTEXT);
    }
  });

  it('finishes inactive branch migration after its transaction rolls back', async () => {
    const sessionPath = scratch();
    const storeDir = join(sessionPath, 'durable-store');
    mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'shared', timestamp: 1 } },
      { type: 'message', id: 'inactive', parentId: 'root', message: { role: 'user', content: 'other branch', timestamp: 2 } },
      { type: 'message', id: 'active', parentId: 'root', message: { role: 'user', content: 'current branch', timestamp: 3 } },
    ];
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'), transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
    const first = await openMigrationHarness(storeDir);
    try {
      await first.root(BACKGROUND_CONTEXT);
      const commit = first.commit.bind(first);
      let commits = 0;
      first.commit = (async (change, context) => commit(async tx => {
        const result = await change(tx);
        if (++commits === 2) throw new Error('injected branch commit failure');
        return result;
      }, context)) as typeof first.commit;
      await expect(migrateLegacySession(first, sessionPath, () => {})).rejects.toThrow('injected branch commit failure');
    } finally {
      await first.close(BACKGROUND_CONTEXT);
    }
    unlinkSync(join(storeDir, 'id-map.json'));

    await migrateParentStore(sessionPath, () => {});

    const resumed = await openMigrationHarness(storeDir);
    try {
      await migrateLegacySession(resumed, sessionPath, () => {});
      expect(Object.keys(JSON.parse(readFileSync(join(storeDir, 'id-map.json'), 'utf8'))).sort()).toEqual(['active', 'inactive', 'root']);
      const branch = await readLegacyBranchConversation(resumed, 'inactive');
      expect(branch).toBeDefined();
      expect(JSON.stringify((await (await resumed.conversation(branch!, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)).messages)).toContain('other branch');
    } finally {
      await resumed.close(BACKGROUND_CONTEXT);
    }
  });

  it('leaves an in-flight JSONL sidecar intact before its commit marker', async () => {
    const sessionPath = scratch();
    const storeDir = join(sessionPath, 'durable-store');
    mkdirSync(join(sessionPath, '.pi-sessions'));
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'), LEGACY_LINES.map(line => JSON.stringify(line)).join('\n') + '\n');
    const migrated = await openMigrationHarness(storeDir);
    try {
      await migrateLegacySession(migrated, sessionPath, () => {});
    } finally {
      await migrated.close(BACKGROUND_CONTEXT);
    }

    const fs = new NodeExecutionEnv({ cwd: sessionPath });
    const storage = await JsonlStorage.open(storeDir, fs, BACKGROUND_CONTEXT);
    const release = Promise.withResolvers<void>();
    let committing: Promise<unknown> | undefined;
    let before: Buffer | undefined;
    let after: Buffer | undefined;
    let updated: TaskRecord<null, { progress: number }, null> | undefined;
    try {
      const task: TaskRecord<null, { progress: number }, null> = {
        id: await storage.mintId<TaskId<null>>(), conversationId: ROOT_CONVERSATION_ID,
        kind: 'migration-preflight-test', version: 1, input: null, background: false,
        abortRequested: false, state: { status: 'running', checkpoint: null },
      };
      await commitWrites(storage, [{ type: 'task', value: task }], BACKGROUND_CONTEXT);
      const sidecar = join(storeDir, `task-${task.id}.jsonl`);
      const committed = readFileSync(sidecar);
      const mainBefore = readFileSync(join(storeDir, 'main.jsonl'));
      const reached = Promise.withResolvers<void>();
      const append = fs.appendFile.bind(fs);
      // Pause the real writer after sidecar append, before the main commit marker.
      fs.appendFile = async (path, ...args) => {
        if (path === join(storeDir, 'main.jsonl')) {
          reached.resolve();
          await release.promise;
        }
        return append(path, ...args);
      };
      updated = { ...task, state: { status: 'running', checkpoint: { progress: 1 } } };
      committing = commitWrites(storage, [{ type: 'task', value: updated }], BACKGROUND_CONTEXT);
      await reached.promise;
      before = readFileSync(sidecar);
      expect(before.length).toBeGreaterThan(committed.length);
      expect(readFileSync(join(storeDir, 'main.jsonl')).equals(mainBefore)).toBe(true);
      await migrateParentStore(sessionPath, () => {});
      after = readFileSync(sidecar);
    } finally {
      release.resolve();
      try {
        await committing;
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    }
    expect(after!.equals(before!)).toBe(true);
    const reopened = await openNodeJsonlStorage(storeDir, BACKGROUND_CONTEXT);
    try {
      expect(await reopened.task(updated!.id, BACKGROUND_CONTEXT)).toEqual(updated);
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
    }
  });

  for (const backend of ['jsonl', 'sqlite'] as const) {
    for (const partial of [false, true]) for (const missingSidecar of [false, true]) for (const running of [false, true]) {
      it(`does not rewrite a ${partial ? 'partially ' : ''}migrated ${backend} parent (${running ? 'running' : 'idle'}, ${missingSidecar ? 'missing' : 'present'} id map)`, async () => {
        const sessionPath = scratch();
        const storeDir = join(sessionPath, 'durable-store');
        mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
        const transcript = [
          { type: 'session', id: 's-1', version: 3 },
          { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'shared', timestamp: 1 } },
          { type: 'message', id: 'inactive', parentId: 'root', message: { role: 'user', content: 'other branch', timestamp: 2 } },
          { type: 'message', id: 'active', parentId: 'root', message: { role: 'user', content: 'current branch', timestamp: 3 } },
        ];
        writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'), transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
        const harness = await openMigrationHarness(storeDir, backend);
        try {
          if (partial) {
            await harness.root(BACKGROUND_CONTEXT);
            const commit = harness.commit.bind(harness);
            let commits = 0;
            harness.commit = (async (change, context) => commit(async tx => {
              const result = await change(tx);
              if (++commits === 2) throw new Error('injected branch commit failure');
              return result;
            }, context)) as typeof harness.commit;
            await expect(migrateLegacySession(harness, sessionPath, () => {})).rejects.toThrow('injected branch commit failure');
          } else {
            await migrateLegacySession(harness, sessionPath, () => {});
          }
        } finally {
          await harness.close(BACKGROUND_CONTEXT);
        }
        const storage = await openDurableStorage(storeDir, BACKGROUND_CONTEXT);
        try {
          const task: TaskRecord<null, null, null> = {
            id: await storage.mintId<TaskId<null>>(), conversationId: ROOT_CONVERSATION_ID,
            kind: 'migration-preflight-test', version: 1, input: null, background: false,
            abortRequested: false, restarts: 2, state: { status: 'running', checkpoint: null },
          };
          if (running) await commitWrites(storage, [{ type: 'task', value: task }], BACKGROUND_CONTEXT);
          const migration = await storage.findDocument({ kind: 'mkagent.legacy-id-map', scope: { kind: 'session' } }, 'current', BACKGROUND_CONTEXT);
          const before = await storage.document(migration!.id, 'current', BACKGROUND_CONTEXT);
          if (partial) expect(before?.value.branches).not.toHaveProperty('inactive');
          else expect(before?.value.branches).toHaveProperty('inactive');
          if (missingSidecar) unlinkSync(join(storeDir, 'id-map.json'));
          const filesBefore = storeFiles(storeDir);

          await migrateParentStore(sessionPath, () => {});

          expect(storeFiles(storeDir)).toEqual(filesBefore);
          expect(existsSync(join(storeDir, 'id-map.json'))).toBe(!missingSidecar);
          if (running) expect(await storage.task(task.id, BACKGROUND_CONTEXT)).toEqual(task);
          expect(await storage.document(migration!.id, 'current', BACKGROUND_CONTEXT)).toEqual(before);
        } finally {
          await storage.close(BACKGROUND_CONTEXT);
        }
      });
    }
  }

  it('restores the id map from the committed migration after reopening', async () => {
    const sessionPath = scratch();
    const storeDir = join(sessionPath, 'durable-store');
    mkdirSync(join(sessionPath, '.pi-sessions'), { recursive: true });
    writeFileSync(join(sessionPath, '.pi-sessions', 'legacy.jsonl'),
      LEGACY_LINES.map(line => JSON.stringify(line)).join('\n') + '\n');

    const first = await openMigrationHarness(storeDir);
    let expected: string;
    try {
      await migrateLegacySession(first, sessionPath, () => {});
      expected = readFileSync(join(storeDir, 'id-map.json'), 'utf8');
    } finally {
      await first.close(BACKGROUND_CONTEXT);
    }
    unlinkSync(join(storeDir, 'id-map.json'));

    const resumed = await openMigrationHarness(storeDir);
    try {
      await migrateLegacySession(resumed, sessionPath, () => {});
      expect(readFileSync(join(storeDir, 'id-map.json'), 'utf8')).toBe(expected!);
    } finally {
      await resumed.close(BACKGROUND_CONTEXT);
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
