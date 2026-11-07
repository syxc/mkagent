import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { BACKGROUND_CONTEXT, awaitWithContext } from '@earendil-works/chord/context';
import { GenerationTask, defineExtension, hook, section, LiveDoc } from '@earendil-works/pi-durable';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { durableFixture, response } from './fixtures/durable-harness.ts';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const text = (content: unknown) => JSON.stringify(content);

describe('versioned durable coding boundaries', () => {
  test('honors turn_end continuation after an error without retrying the failed request', async () => {
    const state = await durableFixture([response('permanent failure', 'error'), response('recovered')]);
    temporary.push(state.directory);
    const events: string[] = [];
    state.registry.install(defineExtension({
      name: 'failure-continuation', hooks: [hook(GenerationTask, {
        codingBoundary: boundary => {
          events.push(`${boundary.type}:${boundary.outcome}`);
          return boundary.type === 'turn_end' && boundary.turnIndex === 0 ? {
            entries: [{ kind: 'test.recovery', model: [{ role: 'user', content: 'new recovery input', timestamp: 2 }] }],
            continue: true,
          } : undefined;
        },
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      expect(state.calls).toHaveLength(2);
      expect(JSON.stringify(state.calls[1].messages.at(-1)?.content)).toContain('new recovery input');
      expect(events).toEqual(['turn_end:error', 'turn_end:completed', 'agent_before_settle:completed']);
      expect(state.reports).toEqual([]);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  for (const version of [1, 2, 3]) test(`migrates a stored version ${version} preparation into coding events`, async () => {
    const state = await durableFixture([response('migrated')]);
    temporary.push(state.directory);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let paused = true;
    let prepares = 0;
    state.registry.install(defineExtension({
      name: 'legacy-prepare',
      sections: [section('legacy-gate', async (_input, context) => {
        if (paused) {
          entered.resolve();
          await awaitWithContext(release.promise, context);
        }
        return 'legacy';
      })],
    }));
    let reopened: Awaited<ReturnType<typeof state.open>> | undefined;
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      await entered.promise;
      const live = await state.harness.snapshot(LiveDoc, state.conversation.id, BACKGROUND_CONTEXT);
      await state.harness.close(BACKGROUND_CONTEXT);
      reopened = await state.open();
      await reopened.commit(async tx => {
        const task = await tx.task(live!.run!.taskId);
        tx.setTask({ ...task!, version });
      }, BACKGROUND_CONTEXT);
      state.registry.install(defineExtension({
        name: 'migrated-events', hooks: [hook(GenerationTask, {
          codingPrepare: () => { prepares++; return { entries: [{ kind: 'test.migrated' }] }; },
        })],
      }));
      paused = false;
      reopened.resume();
      expect((await (await reopened.submission(submission.id, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      expect((await reopened.getTask(live!.run!.taskId, BACKGROUND_CONTEXT))?.version).toBe(4);
      const conversation = await reopened.root(BACKGROUND_CONTEXT);
      expect((await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items
        .filter(entry => entry.kind === 'test.migrated')).toHaveLength(1);
      expect(prepares).toBe(1);
      expect(state.reports).toEqual([]);
    } finally {
      release.resolve();
      await reopened?.close(BACKGROUND_CONTEXT);
      await state.harness.close(BACKGROUND_CONTEXT);
    }
  });

  for (const point of ['handler', 'committed'] as const) test(`recovers preparation interrupted at ${point} without duplicate entries`, async () => {
    const state = await durableFixture([response('recovered')]);
    temporary.push(state.directory);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let paused = true;
    let prepares = 0;
    state.registry.install(defineExtension({
      name: 'prepare-recovery',
      hooks: [hook(GenerationTask, {
        codingPrepare: async (_event, _api, context) => {
          prepares++;
          if (point === 'handler' && paused) {
            entered.resolve();
            await awaitWithContext(release.promise, context);
          }
          return { entries: [{ kind: 'test.prepared' }] };
        },
      })],
      sections: [section('recovery-gate', async (_input, context) => {
        if (point === 'committed' && paused) {
          entered.resolve();
          await awaitWithContext(release.promise, context);
        }
        return 'recovery';
      })],
    }));
    let reopened: Awaited<ReturnType<typeof state.open>> | undefined;
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      await entered.promise;
      const live = await state.harness.snapshot(LiveDoc, state.conversation.id, BACKGROUND_CONTEXT);
      expect((await state.harness.getTask(live!.run!.taskId, BACKGROUND_CONTEXT))?.state.checkpoint.phase)
        .toBe(point === 'handler' ? 'codingPrepare' : 'prepare');
      await state.harness.close(BACKGROUND_CONTEXT);
      paused = false;
      reopened = await state.open();
      reopened.resume();
      expect((await (await reopened.submission(submission.id, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      const conversation = await reopened.root(BACKGROUND_CONTEXT);
      const { items } = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      expect(items.filter(entry => entry.kind === 'test.prepared')).toHaveLength(1);
      expect(prepares).toBe(point === 'handler' ? 2 : 1);
      expect(state.calls).toHaveLength(1);
      expect(state.reports).toEqual([]);
    } finally {
      release.resolve();
      await reopened?.close(BACKGROUND_CONTEXT);
      await state.harness.close(BACKGROUND_CONTEXT);
    }
  });

  test('uses the agent configuration changed by preparation handlers in the same provider request', async () => {
    const state = await durableFixture([response('answer')]);
    temporary.push(state.directory);
    state.registry.install(defineExtension({
      name: 'visible-tools', tools: [{
        name: 'visible', description: 'Visible before preparation', parameters: { type: 'object', properties: {} },
        execute: async () => ({ output: [] }),
      }],
    }));
    state.registry.install(defineExtension({
      name: 'prepare-tools', hooks: [hook(GenerationTask, {
        codingPrepare: async () => {
          await state.conversation.configure({ tools: [] }, BACKGROUND_CONTEXT);
        },
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      expect(getCurrentTools(state.calls[0].messages)).toEqual([]);
      expect(state.reports).toEqual([]);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('keeps local entry references relative to each hook batch', async () => {
    const state = await durableFixture([response('answer')]);
    temporary.push(state.directory);
    for (const owner of ['first', 'second']) state.registry.install(defineExtension({
      name: `coding-${owner}`, hooks: [hook(GenerationTask, {
        codingBoundary: boundary => boundary.type !== 'turn_end' ? undefined : {
          entries: [
            { kind: `test.${owner}` },
            { kind: `test.edit-${owner}`, edits: [{ target: 0, action: 'omit' }], references: { edits: { 0: 0 } } },
          ],
        },
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      const { items } = await state.conversation.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
      for (const owner of ['first', 'second']) {
        expect(items.find(entry => entry.kind === `test.edit-${owner}`)?.edits?.[0].target)
          .toBe(items.find(entry => entry.kind === `test.${owner}`)?.id);
      }
      expect(state.reports).toEqual([]);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  for (const ending of ['reset', 'turn_limit']) test(`settles native hooks before a tool round ends with ${ending}`, async () => {
    const toolResponse = { ...response(''), stopReason: 'toolUse' as const,
      content: [{ type: 'toolCall' as const, id: 'unknown-call', name: 'missing', arguments: {} }],
    };
    const state = await durableFixture([toolResponse, response('after reset')]);
    temporary.push(state.directory);
    if (ending === 'turn_limit') await state.conversation.configure({ maxTurns: 1 }, BACKGROUND_CONTEXT);
    const events: string[] = [];
    state.registry.install(defineExtension({
      name: 'coding', hooks: [hook(GenerationTask, {
        afterRun: () => { events.push('afterRun'); },
        codingBoundary: async (boundary, api, context) => {
          events.push(`${boundary.type}:${boundary.outcome}`);
          if (ending !== 'reset' || boundary.type !== 'turn_end' || state.calls.length !== 1) return;
          const conversation = (await api.conversation(api.conversationId, context))!;
          await conversation.submit({ type: 'write', entry: { kind: 'test.reset', head: 'self' } }, context);
          await conversation.submit({ type: 'input', content: 'after reset', whenBusy: 'followUp' }, context);
        },
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      const outcome = await submission.wait(BACKGROUND_CONTEXT);
      expect(outcome.status).toBe('unanswered');
      expect(outcome.reason).toBe(ending);
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(events.slice(0, 2)).toEqual([
        'turn_end:completed', `agent_before_settle:${ending === 'reset' ? 'aborted' : 'error'}`,
      ]);
      expect(events.filter(event => event === 'afterRun')).toHaveLength(ending === 'reset' ? 1 : 0);
      expect(state.calls).toHaveLength(ending === 'reset' ? 2 : 1);
      expect(state.reports).toEqual([]);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('continues from queued model writes before clearing the hook decision', async () => {
    const state = await durableFixture([response('first'), response('second')]);
    temporary.push(state.directory);
    const events: string[] = [];
    state.registry.install(defineExtension({
      name: 'coding', hooks: [hook(GenerationTask, {
        codingBoundary: async (boundary, api, context) => {
          events.push(`${boundary.type}:${boundary.turnIndex}`);
          if (boundary.type !== 'turn_end' || boundary.turnIndex !== 0) return;
          const conversation = (await api.conversation(api.conversationId, context))!;
          await conversation.submit({
            type: 'write', entry: { kind: 'test.queued', model: [{ role: 'user', content: 'queued-context', timestamp: 2 }] },
          }, context);
          return { continue: true };
        },
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      const outcome = await submission.wait(BACKGROUND_CONTEXT);
      expect(outcome.status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(state.calls).toHaveLength(2);
      expect(text(state.calls[1].messages.at(-1)?.content)).toContain('queued-context');
      expect(events).toEqual(['turn_end:0', 'turn_end:1', 'agent_before_settle:1']);
      expect(state.reports).toEqual([]);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  for (const queuedAt of ['turn_end', 'agent_before_settle']) test(`retains reset input ownership until afterRun finishes from ${queuedAt}`, async () => {
    const state = await durableFixture([response('first'), response('second')]);
    temporary.push(state.directory);
    let queued: Awaited<ReturnType<typeof state.conversation.submit>> | undefined;
    const events: string[] = [];
    state.registry.install(defineExtension({
      name: 'coding', hooks: [hook(GenerationTask, {
        afterRun: () => { events.push('afterRun'); },
        codingBoundary: async (boundary, api, context) => {
          events.push(boundary.type);
          if (boundary.type !== queuedAt || queued) return;
          const conversation = (await api.conversation(api.conversationId, context))!;
          await conversation.submit({ type: 'write', entry: { kind: 'test.reset', head: 'self' } }, context);
          queued = await conversation.submit({ type: 'input', content: 'after-reset', whenBusy: 'followUp' }, context);
        },
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(state.calls).toHaveLength(2);
      const receipt = await state.harness.submission(queued!.id, BACKGROUND_CONTEXT);
      expect((await receipt!.status(BACKGROUND_CONTEXT)).status).toBe('done');
      expect(text(state.calls[1].messages.at(-1)?.content)).toContain('after-reset');
      expect(events).toEqual(['turn_end', 'agent_before_settle', 'afterRun', 'turn_end', 'agent_before_settle', 'afterRun']);
      expect(state.reports).toEqual([]);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('commits the assistant, then turn drafts, then settle drafts before completing the input', async () => {
    const state = await durableFixture([response('answer')]);
    temporary.push(state.directory);
    const before = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: Array<{ event: string; kinds: string[] }> = [];
    state.registry.install(defineExtension({
      name: 'coding',
      hooks: [hook(GenerationTask, {
        codingBoundary: async (boundary, api, context) => {
          const view = await api.context(api.conversationId, context);
          events.push({ event: boundary.type, kinds: view.entries.map(entry => entry.kind) });
          if (boundary.type === 'agent_before_settle') {
            before.resolve();
            await awaitWithContext(release.promise, context);
          }
          return { entries: [{ kind: `test.${boundary.type}` }] };
        },
      })],
    }));
    try {
      let settled = false;
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      const done = submission.wait(BACKGROUND_CONTEXT).then(result => { settled = true; return result; });
      await before.promise;
      expect(settled).toBe(false);
      expect(events.map(item => item.event)).toEqual(['turn_end', 'agent_before_settle']);
      expect(events[0].kinds.at(-1)).toBe('pi.assistant');
      expect(events[1].kinds.at(-1)).toBe('test.turn_end');
      release.resolve();
      expect((await done).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect((await state.conversation.context(BACKGROUND_CONTEXT)).entries.map(entry => entry.kind).slice(-3))
        .toEqual(['pi.assistant', 'test.turn_end', 'test.agent_before_settle']);
      expect(state.reports).toEqual([]);
    } finally { release.resolve(); await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('continues from turn edits without settling and counts every response', async () => {
    const state = await durableFixture([response('first'), response('second')]);
    temporary.push(state.directory);
    const events: string[] = [];
    state.registry.install(defineExtension({
      name: 'coding', hooks: [hook(GenerationTask, {
        codingBoundary: boundary => {
          events.push(`${boundary.type}:${boundary.turnIndex}`);
          return boundary.type === 'turn_end' && boundary.turnIndex === 0
            ? { entries: [{ kind: 'test.continue', model: [{ role: 'user', content: 'again', timestamp: 2 }] }], continue: true }
            : undefined;
        },
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(events).toEqual(['turn_end:0', 'turn_end:1', 'agent_before_settle:1']);
      expect(state.calls).toHaveLength(2);
      expect(text(state.calls[1].messages.at(-1)?.content)).toContain('again');
      expect(state.reports).toEqual([]);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('reports a metadata-only continuation and still settles the answer normally', async () => {
    const state = await durableFixture([response('answer')]);
    temporary.push(state.directory);
    state.registry.install(defineExtension({
      name: 'coding', hooks: [hook(GenerationTask, {
        codingBoundary: boundary => boundary.type === 'turn_end'
          ? { entries: [{ kind: 'test.metadata', data: { saved: true } }], continue: true } : undefined,
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(state.calls).toHaveLength(1);
      expect(state.reports.map(report => report.kind)).toEqual(['extension_error']);
      expect((await state.conversation.context(BACKGROUND_CONTEXT)).entries.some(entry => entry.kind === 'test.metadata')).toBe(true);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('runs new before-settle context before queued follow-ups', async () => {
    const state = await durableFixture([response('first'), response('second'), response('third')]);
    temporary.push(state.directory);
    state.registry.install(defineExtension({
      name: 'coding', hooks: [hook(GenerationTask, {
        codingBoundary: async (boundary, api, context) => {
          if (boundary.type !== 'agent_before_settle' || boundary.turnIndex !== 0) return undefined;
          const conversation = (await api.conversation(api.conversationId, context))!;
          await conversation.submit({ type: 'input', content: 'follow-up', whenBusy: 'followUp' }, context);
          return { entries: [{ kind: 'test.context', model: [{ role: 'user', content: 'boundary-input', timestamp: 2 }] }], continue: true };
        },
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(state.calls).toHaveLength(3);
      expect(text(state.calls[1].messages.at(-1)?.content)).toContain('boundary-input');
      expect(text(state.calls[1].messages)).not.toContain('follow-up');
      expect(text(state.calls[2].messages.at(-1)?.content)).toContain('follow-up');
      expect(state.reports).toEqual([]);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('keeps onYield content and queued context writes when a coding hook continues', async () => {
    const state = await durableFixture([response('first'), response('second')]);
    temporary.push(state.directory);
    let yielded = false;
    state.registry.install(defineExtension({
      name: 'coding', hooks: [hook(GenerationTask, {
        onYield: () => { if (yielded) return undefined; yielded = true; return { continue: 'yield-input' }; },
        codingBoundary: async (boundary, api, context) => {
          if (boundary.type !== 'turn_end' || boundary.turnIndex !== 0) return undefined;
          const conversation = (await api.conversation(api.conversationId, context))!;
          await conversation.submit({
            type: 'write', entry: { kind: 'test.queued', model: [{ role: 'user', content: 'queued-write', timestamp: 2 }] },
          }, context);
          return { continue: true };
        },
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(state.calls).toHaveLength(2);
      expect(text(state.calls[1].messages)).toContain('queued-write');
      expect(text(state.calls[1].messages.at(-1)?.content)).toContain('yield-input');
      expect(state.reports).toEqual([]);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('dispatches failed turns before retry and settles only after recovery', async () => {
    const state = await durableFixture([response('overloaded 503', 'error'), response('recovered')], {
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    });
    temporary.push(state.directory);
    const events: string[] = [];
    state.registry.install(defineExtension({
      name: 'coding', hooks: [hook(GenerationTask, {
        codingBoundary: boundary => { events.push(`${boundary.type}:${boundary.turnIndex}:${boundary.outcome}`); },
      })],
    }));
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(events).toEqual(['turn_end:0:error', 'turn_end:1:completed', 'agent_before_settle:1:completed']);
      expect(state.calls).toHaveLength(2);
      expect(state.reports).toEqual([]);
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  });
});
