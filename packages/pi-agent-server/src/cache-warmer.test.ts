/** Returned warm responses use real durable accounting; models and the active request are local fixtures. */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Models, type ModelsSimpleStreamOptions, type Usage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRegistry, defineExtension, defineTask, Harness, LiveDoc, UsageDoc, type HookApi } from '@earendil-works/pi-durable';
import { watchEvents } from './events/watch.ts';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { CacheWarmer } from './cache-warmer.ts';
import { openDurableStorage } from './storage/durable-storage.ts';

const MODEL: Model<'faux'> = {
  id: 'cache-fixture', provider: 'faux', name: 'Cache fixture', api: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4_096,
  cost: { input: 20, output: 2, cacheRead: 0.1, cacheWrite: 25 }, promptCache: { short: 10.05 },
};
const KEY = 'faux/cache-fixture';
const USAGE: Usage = {
  input: 100, output: 4, cacheRead: 18_000, cacheWrite: 20, totalTokens: 18_124,
  cacheWrite1h: 9, reasoning: 3,
  cost: { input: 0.125, output: 0.0625, cacheRead: 0.03125, cacheWrite: 0.015625, total: 0.234375 },
};
const BASE: Usage = {
  input: 40, output: 2, cacheRead: 20, cacheWrite: 4, totalTokens: 66,
  cacheWrite1h: 2, reasoning: 1,
  cost: { input: 0.0625, output: 0.03125, cacheRead: 0.015625, cacheWrite: 0.0078125, total: 0.1171875 },
};
const ZERO: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
type Stop = 'stop' | 'error' | 'aborted';
function response(stopReason: Stop, usage = USAGE): AssistantMessage {
  return {
    role: 'assistant', api: 'faux', provider: 'faux', model: MODEL.id, responseModel: 'resolved-cache-model',
    content: [], timestamp: 1, stopReason, usage: structuredClone(usage),
    ...(stopReason === 'error' ? { errorMessage: 'fixture provider failure' } : {}),
  };
}

function expectedUsage(count: number, initial = ZERO): Usage {
  return {
    input: initial.input + count * USAGE.input,
    output: initial.output + count * USAGE.output,
    cacheRead: initial.cacheRead + count * USAGE.cacheRead,
    cacheWrite: initial.cacheWrite + count * USAGE.cacheWrite,
    totalTokens: initial.totalTokens + count * USAGE.totalTokens,
    cacheWrite1h: (initial.cacheWrite1h ?? 0) + count * USAGE.cacheWrite1h!,
    reasoning: (initial.reasoning ?? 0) + count * USAGE.reasoning!,
    cost: Object.fromEntries(Object.entries(USAGE.cost).map(([key, value]) => [key, initial.cost[key as keyof Usage['cost']] + count * value])) as Usage['cost'],
  };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('cache fixture did not settle')), 2_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

const fixtures: Array<{ dir: string; warmer: CacheWarmer; harness: Harness }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.warmer.stop();
    await fixture.harness.close(BACKGROUND_CONTEXT);
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function setup(backend: 'sqlite' | 'jsonl', responses: Array<AssistantMessage | Error | Promise<AssistantMessage>>, initial?: Usage, retention: 'short' | 'long' | 'none' = 'short') {
  const dir = mkdtempSync(join(tmpdir(), 'cache-warmer-usage-'));
  const storeDir = join(dir, 'durable-store');
  const calls: ModelsSimpleStreamOptions[] = [];
  const started = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  let checks = 0;
  const model = { ...MODEL, promptCache: retention === 'long' ? { long: 10.05 } : { short: 10.05, long: 10.05 } };
  const models = {
    getModel: () => model,
    streamSimple: (_model: unknown, _context: unknown, options: ModelsSimpleStreamOptions) => {
      const next = responses[calls.length];
      calls.push(options);
      started.resolve();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('unexpected extra warm request');
      const stream = createAssistantMessageEventStream();
      void Promise.resolve(next).then(message => {
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        } else stream.push({ type: 'done', reason: 'stop', message });
      });
      return stream;
    },
  } as unknown as Models;
  const request = defineTask({
    name: 'cache-request-fixture', version: 1,
    initial: () => ({
      phase: 'request', model: { provider: MODEL.provider, modelId: MODEL.id }, thinkingLevel: 'off',
      streamOptions: { cacheRetention: retention },
    }),
    phases: { request: async () => { throw new Error('The fixture request must not be scheduled'); } },
    abort: async () => { throw new Error('The fixture request must not be scheduled'); },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'cache-request-fixture', tasks: [request] }));
  const storage = await (backend === 'jsonl' ? openNodeJsonlStorage(storeDir, BACKGROUND_CONTEXT) : openDurableStorage(storeDir, BACKGROUND_CONTEXT));
  const harness = await Harness.open(storage, { models: () => models, registry }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT);
  const warmer = new CacheWarmer(() => root, () => harness, async () => {
    checks++;
    if (calls.length < responses.length) return true;
    done.resolve();
    return false;
  });
  fixtures.push({ dir, warmer, harness });
  await root.configure({ model: { provider: MODEL.provider, modelId: MODEL.id }, thinkingLevel: 'off' }, BACKGROUND_CONTEXT);
  const taskId = await root.commit(async tx => {
    if (initial) {
      (await tx.doc(UsageDoc, root.id)).models[KEY] = structuredClone(initial);
      await tx.appendEntry(root.id, { kind: 'pi.assistant', model: [response('stop', initial)] });
    }
    const id = await tx.createTask(request, {}, { ownership: { kind: 'conversation' } });
    (await tx.doc(LiveDoc, root.id)).run = { taskId: id, inputs: [] };
    return id;
  }, BACKGROUND_CONTEXT);
  const start = async () => {
    const context = await root.context(BACKGROUND_CONTEXT);
    const api = { models, taskId, conversationId: root.id, snapshot: harness.snapshot.bind(harness) } as HookApi;
    await warmer.capture({ messages: context.messages }, api, BACKGROUND_CONTEXT);
    // Forecast tokens differ from returned usage: accounting must use only the response.
    warmer.observe({ ...ZERO, input: 20_000, totalTokens: 20_000 });
  };
  const ledger = async () => (await harness.snapshot(UsageDoc, root.id, BACKGROUND_CONTEXT))!;
  const entries = async () => (await root.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT)).items.filter(entry => entry.kind === 'mkagent.usage');
  return { warmer, harness, root, calls, started: started.promise, done: done.promise, start, ledger, entries, storeDir, checks: () => checks };
}

for (const backend of ['sqlite', 'jsonl'] as const) describe(`CacheWarmer ${backend} accounting`, () => {
  for (const stopReason of ['stop', 'error', 'aborted'] as const) for (const existing of [false, true]) {
    it(`records ${stopReason} usage once ${existing ? 'in an existing' : 'in a new'} model bucket`, async () => {
      const message = response(stopReason);
      const fixture = await setup(backend, [message], existing ? BASE : undefined);
      await fixture.start();
      await bounded(fixture.done);
      fixture.warmer.stop();
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0]).toMatchObject({ maxTokens: 1, maxRetries: 0, cacheRetention: 'short' });
      expect((await fixture.ledger()).models).toEqual({ [KEY]: expectedUsage(1, existing ? BASE : ZERO) });
      const entries = await fixture.entries();
      expect(entries).toHaveLength(1);
      expect<unknown>(entries[0]!.data).toEqual({ kind: 'cache_warm', provider: 'faux', model: 'resolved-cache-model', usage: USAGE });
      expect(message.usage).toEqual(USAGE);
      expect(fixture.checks()).toBe(2);
    });
  }

  for (const stopReason of ['stop', 'error', 'aborted'] as const) {
    it(`does not add cost for a zero-usage ${stopReason} response`, async () => {
      const fixture = await setup(backend, [response(stopReason, ZERO)], BASE);
      await fixture.start();
      await bounded(fixture.done);
      fixture.warmer.stop();
      expect((await fixture.ledger()).models).toEqual({ [KEY]: BASE });
      const entries = await fixture.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.data).toMatchObject({ usage: ZERO });
    });
  }

  it('does not fabricate usage or an entry for an exception without a response', async () => {
    const fixture = await setup(backend, [new Error('fixture transport failed without response')], BASE);
    await fixture.start();
    await bounded(fixture.done);
    fixture.warmer.stop();
    expect(fixture.calls).toHaveLength(1);
    expect((await fixture.ledger()).models).toEqual({ [KEY]: BASE });
    expect(await fixture.entries()).toEqual([]);
  });

  it('preserves retry scheduling and persisted cumulative usage across mixed results', async () => {
    const fixture = await setup(backend, [response('stop'), response('error'), new Error('no response'), response('aborted'), response('stop', ZERO)], BASE);
    await fixture.start();
    await bounded(fixture.done);
    fixture.warmer.stop();
    expect(fixture.calls).toHaveLength(5);
    expect(fixture.checks()).toBe(6);
    const expected = { [KEY]: expectedUsage(3, BASE) };
    expect((await fixture.ledger()).models).toEqual(expected);
    expect(await fixture.entries()).toHaveLength(4);
    await fixture.harness.close(BACKGROUND_CONTEXT);
    const reopened = await Harness.open(await openDurableStorage(fixture.storeDir, BACKGROUND_CONTEXT), {
      registry: createRegistry(), models: () => { throw new Error('No model calls while reopening the ledger'); },
    }, BACKGROUND_CONTEXT);
    try {
      expect((await reopened.snapshot(UsageDoc, fixture.root.id, BACKGROUND_CONTEXT))?.models).toEqual(expected);
      expect((await (await reopened.root(BACKGROUND_CONTEXT)).entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(entry => entry.kind === 'mkagent.usage')).toHaveLength(4);
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
    }
  });

  it('warms with explicit long retention when only the long TTL is supported', async () => {
    const fixture = await setup(backend, [response('stop')], BASE, 'long');
    await fixture.start();
    await bounded(fixture.done);
    fixture.warmer.stop();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]!.cacheRetention).toBe('long');
    expect((await fixture.ledger()).models).toEqual({ [KEY]: expectedUsage(1, BASE) });
    expect(await fixture.entries()).toHaveLength(1);
  });

  it('does not warm with explicit none retention even when both TTLs are supported', async () => {
    const fixture = await setup(backend, [response('stop')], BASE, 'none');
    await fixture.start();
    await Bun.sleep(150);
    expect(fixture.calls).toEqual([]);
    expect(fixture.checks()).toBe(0);
    expect((await fixture.ledger()).models).toEqual({ [KEY]: BASE });
    expect(await fixture.entries()).toEqual([]);
  });

  it('records returned usage after cancellation without scheduling another warm', async () => {
    const release = Promise.withResolvers<AssistantMessage>();
    const fixture = await setup(backend, [release.promise], BASE);
    const watch = await watchEvents(fixture.harness, fixture.root.id, BACKGROUND_CONTEXT);
    const accounted = Promise.withResolvers<void>();
    watch.start(async events => {
      if (events.some(event => event.type === 'entry_appended' && event.entry.kind === 'mkagent.usage')) accounted.resolve();
    });
    try {
      await fixture.start();
      await bounded(fixture.started);
      fixture.warmer.stop();
      expect(fixture.calls[0]!.signal?.aborted).toBe(true);
      release.resolve(response('aborted'));
      await bounded(accounted.promise);
      expect((await fixture.ledger()).models).toEqual({ [KEY]: expectedUsage(1, BASE) });
      expect(await fixture.entries()).toHaveLength(1);
      await Bun.sleep(150);
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.checks()).toBe(1);
    } finally {
      release.resolve(response('aborted'));
      await watch.stop();
    }
  });
});
