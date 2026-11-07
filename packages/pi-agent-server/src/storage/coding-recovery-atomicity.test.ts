/** A rejected adoption receipt must leave the same live session safe to retry. */
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { TaskId } from '@earendil-works/pi-durable';
import { DurableLoopBinding, NativeSessionJournal } from '@mkagent/pi-durable-coding/durable';
import { createAgentSession, createHostResources, ModelRuntime } from '@mkagent/pi-durable-coding/native';
import { durableFixture } from '../../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { CodingMigrationDoc } from './coding-migration.ts';
import { LegacyCodingAdoption } from './coding-recovery.ts';

for (const boundary of ['admitSession', 'commitSession'] as const)
test(`rolls back native queues after ${boundary} rejects, then adopts once`, async () => {
  const root = await durableFixture([]);
  const context = BACKGROUND_CONTEXT;
  const journal = await NativeSessionJournal.open({ ...root, context, cwd: root.directory });
  const durable = new DurableLoopBinding({ kernel: root, journal });
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const resources = createHostResources({
    cwd: root.directory, agentDir,
    globalSettings: { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' },
    disabledBuiltinExtensions: ['codemode', 'tool-search', 'mcp'],
  });
  await resources.resourceLoader.reload();
  const modelRuntime = await ModelRuntime.bind({
    models: () => root.models, credentials: ModelRuntime.createCredentials(new InMemoryCredentialStore()),
  });
  const { session } = await createAgentSession({
    ...resources, cwd: root.directory, agentDir, modelRuntime, model: root.models.getModel('faux', 'local'),
    sessionManager: journal.manager, durable, baseToolsOverride: {}, tools: [],
  });
  const adoption = new LegacyCodingAdoption(root.harness, root.conversation, session, journal, durable);
  // Isolate admission failure from task execution; document and queue transactions remain real.
  const admit = spyOn(durable, 'admitSession').mockResolvedValue(999 as TaskId);
  const commit = spyOn(durable, 'commitSession');
  try {
    await journal.flush();
    await root.conversation.commit(async tx => {
      const marker = await tx.doc(CodingMigrationDoc, root.conversation.id);
      marker.status = 'staged';
      marker.recovery = {
        conversationId: root.conversation.id, live: {}, tasks: [], taskDocuments: [],
        continuation: { taskId: 888, checkpoint: { phase: 'prepare', attempt: 1, codingPrepared: true } },
        queued: [{ id: 777, mode: 'steer', content: 'accepted once' }],
        submissions: [{ id: 777, type: 'input', status: 'queued' }],
      } as unknown as JsonValue;
    }, context);
    const before = structuredClone(session.exportDurableState());
    if (boundary === 'admitSession') admit.mockRejectedValueOnce(new Error('injected adoption failure'));
    else commit.mockRejectedValueOnce(new Error('injected adoption failure'));
    await expect(adoption.adopt()).rejects.toThrow('injected adoption failure');
    expect(session.exportDurableState()).toEqual(before);
    expect((await root.harness.snapshot(CodingMigrationDoc, root.conversation.id, context))?.status).toBe('staged');
    await Promise.all([adoption.adopt(), adoption.adopt()]);
    expect(session.exportDurableState().steering).toEqual(['accepted once']);
    expect(session.exportDurableState().queues.steering).toHaveLength(1);
    expect((await root.harness.snapshot(CodingMigrationDoc, root.conversation.id, context))?.status).toBe('adopted');
  } finally {
    admit.mockRestore();
    commit.mockRestore();
    adoption.close();
    session.dispose();
    await durable.close();
    journal.close();
    await root.harness.close(context);
    rmSync(root.directory, { recursive: true, force: true });
  }
});
