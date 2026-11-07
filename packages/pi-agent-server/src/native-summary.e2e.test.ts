/** Native compaction keeps its Pi formatting while every model request runs as a durable task. */
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { defineExtension, type Harness, type TaskId } from '@earendil-works/pi-durable';
import { DurableKernel } from './kernel.ts';
import { durableFixture, response } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import type { NativeSessionJournal } from '@mkagent/pi-durable-coding/durable';
import type { AgentSession } from '@mkagent/pi-durable-coding/native';

test('real coding compaction, bug-report and branch summaries run through durable summary tasks', async () => {
  const root = await durableFixture([
    response('first answer'), response('second answer'), response('saved native summary'),
    response('saved turn prefix'), response('bug report summary'), response('saved branch summary'),
  ]);
  await root.harness.close(context);
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const kernel = new DurableKernel({
    sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'empty' }), wrapCodingTool: tool => tool,
    coding: { agentDir, resourcePolicy: 'host-only',
      globalSettings: { cacheWarming: 'off', retry: { enabled: false },
        compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } } },
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: () => {} },
  });
  const native = kernel as unknown as {
    harness: Harness;
    coding: { waitForIdle(): Promise<void>; journal: NativeSessionJournal;
      session: Pick<AgentSession, 'summarizeForBugReport' | 'navigateTree'> };
  };
  try {
    await kernel.open({ model: { provider: 'faux', modelId: 'local' } });
    for (const message of ['first history', 'second history']) {
      await kernel.submitPrompt(message);
      await native.coding.waitForIdle();
    }
    const wait = spyOn(native.harness, 'waitForTask');
    try {
      const compacted = await kernel.compact();
      expect(compacted.summary).toContain('saved native summary');
      expect(native.coding.journal.committedSnapshot().entries.some(entry => entry.type === 'compaction')).toBe(true);
      expect(await native.coding.session.summarizeForBugReport({ signal: new AbortController().signal }))
        .toBe('bug report summary');
      const before = native.coding.journal.committedSnapshot();
      const target = before.entries.find(entry => entry.type === 'message' && entry.message.role === 'user')!;
      const navigation = await native.coding.journal.phase(async () => {
        const result = await native.coding.session.navigateTree(target.id, { summarize: true });
        await native.harness.commit(tx => native.coding.journal.commit(tx), context);
        return result;
      });
      expect(navigation.editorText).toBe('first history');
      expect(navigation.cancelled).toBe(false);
      expect(native.coding.journal.committedSnapshot().entries.some(entry =>
        entry.type === 'branch_summary' && entry.summary.includes('saved branch summary'))).toBe(true);
      const tasks = await Promise.all(wait.mock.calls.map(([id]) => native.harness.getTask(id as TaskId, context)));
      const summaries = tasks.filter(task => task?.kind === 'pi.coding.summary');
      expect(summaries).toHaveLength(4);
      expect(summaries.every(task => task?.state.status === 'terminal' && task.state.outcome.status === 'completed')).toBe(true);
      expect(JSON.stringify(root.calls[2])).toContain('first history');
      expect(root.calls).toHaveLength(6);
    } finally { wait.mockRestore(); }
  } finally {
    await kernel.close();
    rmSync(root.directory, { recursive: true, force: true });
  }
}, 20_000);
