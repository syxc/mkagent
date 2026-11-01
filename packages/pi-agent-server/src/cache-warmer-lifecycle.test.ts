/** Real kernel/storage shutdown with local providers that can return billed usage after abort. */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEmitter } from 'node:events';
import { createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, type AssistantMessage, type Model, type Usage } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { awaitWithContext, BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRegistry, defineExtension, defineTool, Harness, UsageDoc, type Conversation } from '@earendil-works/pi-durable';
import { DurableKernel } from './kernel.ts';
import type { CacheWarmer } from './cache-warmer.ts';
import { openDurableStorage } from './storage/durable-storage.ts';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';

// Bun's Process.on memoryPressure overload can hide Node's inherited generic event typing.
const processEvents = process as EventEmitter;

const MODEL: Model<'faux'> = {
  id: 'cache-close', provider: 'faux', name: 'Cache close fixture', api: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4_096,
  cost: { input: 20, output: 2, cacheRead: 0.1, cacheWrite: 25 },
  promptCache: { short: 10.05, long: 10.05 },
};
const MAIN: Usage = {
  input: 20_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 20_001,
  cost: { input: 0.5, output: 0.125, cacheRead: 0, cacheWrite: 0, total: 0.625 },
};
const WARM: Usage = {
  input: 0, output: 1, cacheRead: 20_000, cacheWrite: 0, totalTokens: 20_001,
  cost: { input: 0, output: 0.0078125, cacheRead: 0.015625, cacheWrite: 0, total: 0.0234375 },
};
const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function message(stopReason: AssistantMessage['stopReason'], usage: Usage, content: AssistantMessage['content'] = []): AssistantMessage {
  return { role: 'assistant', api: 'faux', provider: 'faux', model: MODEL.id, content, usage: structuredClone(usage), stopReason, timestamp: 1 };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('cache lifecycle fixture did not settle')), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}
function closing(kernel: DurableKernel) {
  let finished = false;
  const done = kernel.close().then(() => { finished = true; });
  return { done, finished: () => finished };
}

interface WarmRequest { signal?: AbortSignal; settled: boolean; finish(): void }
const fixtures: Array<{ kernel: DurableKernel; dir: string; release(): void }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.release();
    await bounded(fixture.kernel.close());
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function setup(options: { backend?: 'sqlite' | 'jsonl'; holdSecondMain?: boolean; failWarm?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cache-warmer-close-'));
  const storeDir = join(dir, 'durable-store');
  if (options.backend === 'jsonl') {
    const initial = await openNodeJsonlStorage(storeDir, BACKGROUND_CONTEXT);
    await initial.commit([], BACKGROUND_CONTEXT);
    await initial.close(BACKGROUND_CONTEXT);
  }
  const tool = Promise.withResolvers<void>();
  const main = Promise.withResolvers<void>();
  const secondMain = Promise.withResolvers<void>();
  const requests: WarmRequest[] = [];
  const waiters: Array<{ count: number; resolve(request: WarmRequest): void }> = [];
  let mainCalls = 0;
  const models = builtinModels({ credentials: new InMemoryCredentialStore() });
  models.setProvider(createProvider({
    id: 'faux', name: 'Faux', baseUrl: MODEL.baseUrl, models: [MODEL],
    auth: { apiKey: { name: 'Fixture key', resolve: async () => ({ auth: { apiKey: 'fake-local-key' } }) } },
    api: { faux: {
      stream() { throw new Error('Unexpected stream'); },
      streamSimple(_model, _context, requestOptions) {
        const stream = createAssistantMessageEventStream();
        if (requestOptions?.maxTokens === 1) {
          const request: WarmRequest = {
            signal: requestOptions.signal, settled: false,
            finish() {
              if (request.settled) return;
              request.settled = true;
              stream.push({ type: 'error', reason: 'aborted', error: message('aborted', WARM) });
            },
          };
          requests.push(request);
          for (const waiter of waiters) if (requests.length >= waiter.count) waiter.resolve(requests[waiter.count - 1]!);
          if (options.failWarm) {
            request.settled = true;
            throw new Error('Fixture warm failed without a response');
          }
          // Warm requests deliberately ignore abort until the test releases their late usage.
          return stream;
        }
        mainCalls++;
        let settled = false;
        const send = (response: AssistantMessage) => {
          if (settled) return;
          settled = true;
          requestOptions?.signal?.removeEventListener('abort', abort);
          if (response.stopReason === 'aborted') stream.push({ type: 'error', reason: 'aborted', error: response });
          else stream.push({ type: 'done', reason: response.stopReason as 'stop' | 'toolUse', message: response });
        };
        const abort = () => send(message('aborted', ZERO));
        requestOptions?.signal?.addEventListener('abort', abort, { once: true });
        if (requestOptions?.signal?.aborted) abort();
        if (mainCalls === 1) {
          queueMicrotask(() => send(message('toolUse', MAIN, [{ type: 'toolCall', id: 'held-tool', name: 'held_tool', arguments: {} }])));
        } else if (options.holdSecondMain) {
          secondMain.resolve();
          void main.promise.then(() => send(message('stop', ZERO)));
        } else queueMicrotask(() => send(message('stop', ZERO)));
        return stream;
      },
    } },
  }));
  const kernel = new DurableKernel({
    sessionPath: dir, cwd: dir, modelsSource: () => models,
    hooks: { emitEvent: () => {}, debugLog: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {}, isPrefetchableTool: () => false },
    toolsExtension: defineExtension({ name: 'held-tool', tools: [defineTool({
      name: 'held_tool', description: 'Wait locally for the lifecycle fixture.', parameters: { type: 'object', properties: {} } as never,
      execute: async (_args, _api, context) => {
        await awaitWithContext(tool.promise, context);
        return { output: [{ type: 'text' as const, text: 'tool finished' }] };
      },
    })] }),
  });
  const release = () => { tool.resolve(); main.resolve(); for (const request of requests) request.finish(); };
  fixtures.push({ kernel, dir, release });
  await kernel.open({ model: { provider: MODEL.provider, modelId: MODEL.id, contextWindow: MODEL.contextWindow } });
  const internal = kernel as unknown as { harness: Harness; conversation: Conversation; cacheWarmer: CacheWarmer };
  const waitWarm = (count: number) => requests.length >= count ? Promise.resolve(requests[count - 1]!)
    : bounded(new Promise<WarmRequest>(resolve => { waiters.push({ count, resolve }); }));
  return { kernel, storeDir, requests, waitWarm, internal, releaseTool: () => tool.resolve(), secondMain: secondMain.promise, release, mainCalls: () => mainCalls };
}

async function checkPersisted(storeDir: string, count: number, expectedEntries = count) {
  const harness = await Harness.open(await openDurableStorage(storeDir, BACKGROUND_CONTEXT), {
    registry: createRegistry(), models: () => { throw new Error('No models while reading the reopened ledger'); },
  }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const ledger = await harness.snapshot(UsageDoc, root.id, BACKGROUND_CONTEXT);
    expect(ledger?.models['faux/cache-close']).toEqual({
      input: MAIN.input, output: MAIN.output + count * WARM.output,
      cacheRead: count * WARM.cacheRead, cacheWrite: 0, totalTokens: MAIN.totalTokens + count * WARM.totalTokens,
      cost: { input: MAIN.cost.input, output: MAIN.cost.output + count * WARM.cost.output,
        cacheRead: count * WARM.cost.cacheRead, cacheWrite: 0, total: MAIN.cost.total + count * WARM.cost.total },
    });
    const entries = (await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(entry => entry.kind === 'mkagent.usage');
    expect(entries).toHaveLength(expectedEntries);
    for (const entry of entries) expect<unknown>(entry.data).toEqual({ kind: 'cache_warm', provider: 'faux', model: MODEL.id, usage: count ? WARM : ZERO });
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}

describe('cache warmer shutdown', () => {
  for (const backend of ['sqlite', 'jsonl'] as const) it(`waits for a late ${backend} warm response and persists its usage before close`, async () => {
    const fixture = await setup({ backend });
    await fixture.kernel.submitPrompt('start the held tool');
    const request = await fixture.waitWarm(1);
    const close = closing(fixture.kernel);
    let waited = false;
    try {
      expect(request.signal?.aborted).toBe(true);
      await Bun.sleep(100);
      waited = !close.finished();
    } finally { request.finish(); await bounded(close.done); }
    expect(waited).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    await checkPersisted(fixture.storeDir, 1);
    await checkPersisted(fixture.storeDir, 1);
  });

  it('drains a replaced old warm as well as the current request without blocking capture', async () => {
    const fixture = await setup({ holdSecondMain: true });
    await fixture.kernel.submitPrompt('first request');
    const old = await fixture.waitWarm(1);
    fixture.releaseTool();
    await bounded(fixture.secondMain);
    const current = await fixture.waitWarm(2);
    expect(old.signal?.aborted).toBe(true);
    expect(old.settled).toBe(false);
    const close = closing(fixture.kernel);
    let waitedForOld = false;
    try {
      expect(current.signal?.aborted).toBe(true);
      current.finish();
      await Bun.sleep(100);
      waitedForOld = !close.finished();
    } finally { old.finish(); current.finish(); await bounded(close.done); }
    expect(waitedForOld).toBe(true);
    expect(fixture.requests).toHaveLength(2);
    await checkPersisted(fixture.storeDir, 2);
  });

  it('does not capture or send another warm during a pending close', async () => {
    const fixture = await setup({ holdSecondMain: true });
    await fixture.kernel.submitPrompt('first request');
    const request = await fixture.waitWarm(1);
    const close = closing(fixture.kernel);
    try {
      await Bun.sleep(20);
      expect(close.finished()).toBe(false);
      fixture.releaseTool();
      await bounded(fixture.secondMain);
      expect(fixture.mainCalls()).toBe(2);
      await Bun.sleep(150);
      expect(fixture.requests).toHaveLength(1);
    } finally { fixture.release(); await bounded(close.done); }
    await checkPersisted(fixture.storeDir, 1);
  });

  it('includes a refresh still awaiting request validation in the drain', async () => {
    const fixture = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const state = fixture.internal.cacheWarmer as unknown as { isCurrent: (...args: unknown[]) => Promise<boolean> };
    const validate = state.isCurrent.bind(state);
    state.isCurrent = async (...args) => { entered.resolve(); await release.promise; return validate(...args); };
    await fixture.kernel.submitPrompt('hold validation');
    await bounded(entered.promise);
    const close = closing(fixture.kernel);
    let waited = false;
    try { await Bun.sleep(100); waited = !close.finished(); }
    finally { release.resolve(); await bounded(close.done); }
    expect(waited).toBe(true);
    expect(fixture.requests).toEqual([]);
    await checkPersisted(fixture.storeDir, 0);
  });

  it('includes a returned response awaiting its usage commit in the drain', async () => {
    const fixture = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const conversation = fixture.internal.conversation;
    const commit: typeof conversation.commit = conversation.commit.bind(conversation);
    conversation.commit = async (change, context) => { entered.resolve(); await release.promise; return commit(change, context); };
    await fixture.kernel.submitPrompt('hold the usage commit');
    const request = await fixture.waitWarm(1);
    request.finish();
    await bounded(entered.promise);
    const close = closing(fixture.kernel);
    let waited = false;
    try { await Bun.sleep(100); waited = !close.finished(); }
    finally { release.resolve(); await bounded(close.done); }
    expect(waited).toBe(true);
    await checkPersisted(fixture.storeDir, 1);
  });

  it('joins unexpected refresh rejections without an unhandled rejection', async () => {
    const fixture = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const unhandled: unknown[] = [];
    const observe = (error: unknown) => { unhandled.push(error); };
    processEvents.on('unhandledRejection', observe);
    const state = fixture.internal.cacheWarmer as unknown as { refresh: () => Promise<void> };
    state.refresh = async () => { entered.resolve(); await release.promise; throw new Error('fixture refresh failure'); };
    try {
      await fixture.kernel.submitPrompt('hold a failing refresh');
      await bounded(entered.promise);
      const close = closing(fixture.kernel);
      let waited = false;
      try { await Bun.sleep(100); waited = !close.finished(); }
      finally { release.resolve(); await bounded(close.done); }
      expect(waited).toBe(true);
      await Bun.sleep(0);
      expect(unhandled).toEqual([]);
    } finally { release.resolve(); processEvents.off('unhandledRejection', observe); }
  });

  it('observes a rejected refresh even before close begins', async () => {
    const fixture = await setup();
    const entered = Promise.withResolvers<void>();
    const unhandled: unknown[] = [];
    const observe = (error: unknown) => { unhandled.push(error); };
    processEvents.on('unhandledRejection', observe);
    const state = fixture.internal.cacheWarmer as unknown as { refresh: () => Promise<void> };
    state.refresh = async () => { entered.resolve(); throw new Error('fixture unjoined refresh failure'); };
    try {
      await fixture.kernel.submitPrompt('reject before close');
      await bounded(entered.promise);
      await Bun.sleep(25);
      expect(unhandled).toEqual([]);
      await bounded(fixture.kernel.close());
    } finally { processEvents.off('unhandledRejection', observe); }
  });

  it('closes after a request failure and repeated synchronous stops', async () => {
    const fixture = await setup({ failWarm: true });
    await fixture.kernel.submitPrompt('fail the warm');
    await fixture.waitWarm(1);
    fixture.internal.cacheWarmer.stop();
    fixture.internal.cacheWarmer.stop();
    await bounded(Promise.all([fixture.kernel.close(), fixture.kernel.close()]));
    await bounded(fixture.kernel.close());
    expect(fixture.requests).toHaveLength(1);
    await checkPersisted(fixture.storeDir, 0, 1);
  });

  it('closes an idle kernel repeatedly without waiting for a timer', async () => {
    const fixture = await setup();
    fixture.internal.cacheWarmer.stop();
    await bounded(Promise.all([fixture.kernel.close(), fixture.kernel.close()]));
    await bounded(fixture.kernel.close());
    expect(fixture.requests).toEqual([]);
    expect(fixture.mainCalls()).toBe(0);
  });
});
