import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension, type Conversation, type Harness } from '@earendil-works/pi-durable';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { NativeSessionJournal } from '@mkagent/pi-durable-coding/durable';
import type { UsageEntry } from '@mkagent/pi-durable-coding/native';
import { CacheWarmer } from '../../pi-durable-coding/src/pi/core/cache-warmer.ts';
import { durableFixture, response } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { DurableKernel } from './kernel.ts';
import type { CodingHost } from './coding-host.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

async function fixture() {
  const answer = response('answer');
  answer.usage.input = 100_000;
  answer.usage.totalTokens = 100_001;
  const root = await durableFixture([answer, response('warm'), response('next answer')]);
  await root.harness.close(BACKGROUND_CONTEXT);
  cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
  const provider = root.models.getProvider('faux')!;
  const warmable = {
    ...root.models.getModel('faux', 'local')!,
    promptCache: { short: 11 },
    cost: { input: 10, output: 10, cacheRead: 0.001, cacheWrite: 0 },
  };
  root.models.setProvider({ ...provider, getModels: () => [warmable], getAllModels: () => [warmable] });
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const warmed = Promise.withResolvers<UsageEntry>();
  const entries: UsageEntry[] = [];
  const errors: string[] = [];
  const kernel = new DurableKernel({
    sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'empty' }),
    coding: { agentDir, globalSettings: { cacheWarming: 'idle', compaction: { enabled: false } }, projectSettings: {} },
    wrapCodingTool: tool => tool,
    hooks: {
      emitEvent: event => {
        const entry = event.entry as UsageEntry | undefined;
        if (event.type === 'entry_appended' && entry?.type === 'usage') {
          entries.push(entry);
          warmed.resolve(entry);
        }
      },
      sessionToolCompleted: () => {}, prefetchToolCall: () => {}, isPrefetchableTool: () => false,
      debugLog: error => errors.push(error),
    },
  });
  cleanup.push(() => kernel.close());
  await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
  await kernel.submitPrompt('question');
  await kernel.waitForIdle();
  const native = (kernel as unknown as { coding: CodingHost }).coding;
  const { harness, conversation } = kernel as unknown as { harness: Harness; conversation: Conversation };
  return { root, kernel, native, harness, conversation, warmed, entries, errors };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function persistedEntry(state: Fixture, id: string) {
  const journal = await NativeSessionJournal.open({
    harness: state.harness, conversation: state.conversation, context: BACKGROUND_CONTEXT, cwd: state.root.directory,
  });
  try { return journal.manager.getEntry(id); }
  finally { journal.close(); }
}

function holdCommit(state: Fixture, fail = false) {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const commit = state.harness.commit.bind(state.harness);
  const held = spyOn(state.harness, 'commit').mockImplementationOnce(async (work, context) => {
    ready.resolve();
    await release.promise;
    if (fail) throw new Error('local warm commit failure');
    return commit(work, context);
  });
  cleanup.push(() => held.mockRestore());
  cleanup.push(() => release.resolve());
  return { ready, release };
}

test('persists idle cache-warming usage before publishing its native entry event', async () => {
  const { root, native, warmed, errors, ...rest } = await fixture();
  const timer = setTimeout(() => warmed.reject(new Error(JSON.stringify({
    calls: root.calls.length,
    usageEntries: native.journal.manager.getEntries().filter(entry => entry.type === 'usage'),
    status: native.session.cacheWarmingStatus,
    errors,
  }))), 3_000);
  let entry: UsageEntry;
  try { entry = await warmed.promise; }
  finally { clearTimeout(timer); }
  expect(root.calls).toHaveLength(2);
  expect(entry.kind).toBe('cache_warm');
  // Read a fresh projection from storage, without calling the host's idle flush or close.
  expect(await persistedEntry({ root, native, warmed, errors, ...rest }, entry.id)).toEqual(entry);
  expect(errors).toEqual([]);
}, 8_000);

test.each(['idle', 'close'])('a failed warm commit does not interrupt %s cleanup', async operation => {
  const state = await fixture();
  const gate = holdCommit(state, true);
  await gate.ready.promise;
  const disposed = spyOn(state.native.session, 'dispose');
  cleanup.push(() => disposed.mockRestore());
  const completion = (operation === 'idle' ? state.native.waitForIdle() : state.native.close())
    .then(() => undefined, error => error.message);
  // Let the waiter join the blocked background job before rejecting its commit.
  await new Promise<void>(resolve => setImmediate(resolve));
  gate.release.resolve();
  expect(await completion).toBeUndefined();
  expect(state.errors.filter(error => error.includes('local warm commit failure'))).toHaveLength(1);
  expect(state.entries).toEqual([]);
  expect(state.native.session.cacheWarmingStatus?.state).toBe('inactive');
  if (operation === 'close') {
    expect(disposed).toHaveBeenCalledTimes(1);
    await expect(state.native.journal.phase(async () => {})).rejects.toThrow('closed');
  }
}, 8_000);

test('publishes the committed usage entry when a foreground run rebases its parent', async () => {
  const state = await fixture();
  const gate = holdCommit(state);
  await gate.ready.promise;
  await state.kernel.submitPrompt('next question');
  await state.native.session.waitForIdle();
  await state.native.flush();
  const parent = state.native.journal.manager.getLeafId();
  gate.release.resolve();
  const entry = await state.warmed.promise;
  expect(state.root.calls).toHaveLength(3);
  const persisted = await persistedEntry(state, entry.id);
  expect(persisted).toMatchObject({ type: 'usage', parentId: parent });
  expect(entry).toEqual(persisted);
}, 8_000);

test('keeps refresh pending until its commit receipt before scheduling another request', async () => {
  const state = await fixture();
  const gate = holdCommit(state);
  await gate.ready.promise;
  expect(state.native.session.cacheWarmingStatus?.state).toBe('refreshing');
  expect(state.entries).toEqual([]);
  gate.release.resolve();
  await state.warmed.promise;
  expect(state.native.session.cacheWarmingStatus?.state).toBe('scheduled');
}, 8_000);

test('close aborts an in-flight warm request before disposing its native session', async () => {
  const state = await fixture();
  const started = Promise.withResolvers<AbortSignal>();
  const network = spyOn(state.native.models, 'streamSimple').mockImplementation((_model, _context, options) => {
    if (!options?.signal) throw new Error('Missing cache warming signal');
    const stream = createAssistantMessageEventStream();
    options.signal.addEventListener('abort', () => {
      stream.push({ type: 'error', reason: 'aborted', error: response('cancelled', 'aborted') });
    }, { once: true });
    started.resolve(options.signal);
    return stream;
  });
  cleanup.push(() => network.mockRestore());
  const signal = await started.promise;
  await state.native.close();
  expect(signal.aborted).toBe(true);
  expect(state.entries).toEqual([]);
  expect(state.errors).toEqual([]);
  await expect(state.native.journal.phase(async () => {})).rejects.toThrow('closed');
}, 8_000);

test('an append failure escapes the network catch and stops further cache warming', async () => {
  const state = await fixture();
  state.native.session.cancelCacheWarming();
  const requested = Promise.withResolvers<void>();
  const failures: string[] = [];
  const warmer = new CacheWarmer({
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: response('warm') }));
      requested.resolve();
      return stream;
    },
  }, {
    getBranch: () => state.native.journal.manager.getBranch(),
    appendUsage: () => { throw new Error('local append failure'); },
  }, () => 'idle', async event => event.action, async work => {
    try { return await work(); }
    catch (error) { failures.push((error as Error).message); throw error; }
  });
  cleanup.push(() => warmer.cancel());
  warmer.start({ model: state.native.session.model!, context: { messages: [] }, options: {} }, () => true);
  warmer.onAgentSettled();
  await requested.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(failures).toEqual(['local append failure']);
  expect(warmer.status).toMatchObject({ state: 'inactive', reason: 'cache usage persistence failed' });
}, 8_000);