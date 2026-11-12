import { afterEach, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { normalizeContext } from '@earendil-works/pi-ai';
import { LiveDoc } from '@earendil-works/pi-durable';
import { Agent } from '../src/agent-runtime.ts';
import { DurableLoopBinding } from '../src/durable-coding/engine.ts';
import { durableFixture, response } from './fixtures/durable-harness.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(answers = [response('summary')]) {
  const root = await durableFixture(answers);
  const binding = new DurableLoopBinding({ kernel: root });
  cleanup.push(async () => {
    await binding.close();
    await root.harness.close(context);
    rmSync(root.directory, { recursive: true, force: true });
  });
  binding.bindSummary(async (model, input, options) => (await root.models.streamSimple(model, input, options)).result());
  await binding.backend();
  const wait = spyOn(root.harness, 'waitForTask');
  cleanup.push(async () => { wait.mockRestore(); });
  const model = root.models.getModel('faux', 'local')!;
  const input = normalizeContext({ messages: [{ role: 'user', content: 'summarize history', timestamp: 1 }] });
  return { root, binding, model, input, wait };
}

test('native summary responses persist as durable tasks while request credentials stay live', async () => {
  const f = await fixture();
  const stream = await f.binding.summaryStream(f.model, f.input, {
    apiKey: 'fixture-secret', headers: { authorization: 'fixture-header' }, env: { FIXTURE: 'fixture-env' },
  });
  expect(await stream.result()).toEqual(response('summary'));
  const id = f.wait.mock.calls[0]![0];
  const saved = await f.root.harness.getTask(id, context);
  expect(saved?.kind).toBe('pi.coding.summary');
  expect(saved?.input).toEqual({ bindingKey: expect.any(String), model: { provider: 'faux', modelId: 'local' }, context: f.input,
    options: { cacheRetention: 'none' } });
  expect(f.root.calls).toEqual([f.input]);
  await f.binding.close();
  await f.root.harness.close(context);
  const reopened = await f.root.open();
  try {
    const receipt = await reopened.waitForTask(id, context);
    expect(receipt.state.outcome).toEqual({ status: 'completed', result: { response: response('summary') } });
    expect(f.root.calls).toHaveLength(1);
  } finally { await reopened.close(context); }
});

test('native summary errors preserve their response and usage for native retry policy', async () => {
  const f = await fixture([response('temporary failure', 'error')]);
  const result = await (await f.binding.summaryStream(f.model, f.input)).result();
  expect(result).toEqual(response('temporary failure', 'error'));
  const saved = await f.root.harness.getTask(f.wait.mock.calls[0]![0], context);
  expect(saved?.state.outcome).toEqual({ status: 'completed', result: { response: result } });
});

test('native summary preserves live model routing and request options without storing them', async () => {
  const f = await fixture();
  const model = { ...f.model, id: 'dynamic', baseUrl: 'http://unused-routing.invalid' };
  f.binding.bindSummary(async (actual, input, options) => {
    expect(actual).toBe(model);
    expect(input).toEqual(f.input);
    expect(options).toMatchObject({ apiKey: 'fixture-secret', headers: { authorization: 'fixture-header' },
      env: { FIXTURE: 'fixture-env' }, maxTokens: 731, cacheRetention: 'none', sessionId: 'summary-routing' });
    return response('dynamic summary');
  });
  const result = await (await f.binding.summaryStream(model, f.input, {
    apiKey: 'fixture-secret', headers: { authorization: 'fixture-header' }, env: { FIXTURE: 'fixture-env' },
    maxTokens: 731, sessionId: 'summary-routing',
  })).result();
  expect(result).toEqual(response('dynamic summary'));
  const saved = await f.root.harness.getTask(f.wait.mock.calls[0]![0], context);
  expect(saved?.input).toEqual({ bindingKey: expect.any(String), model: { provider: 'faux', modelId: 'dynamic' },
    context: f.input, options: { cacheRetention: 'none', sessionId: 'summary-routing' } });
});

test('concurrent internal summaries preserve the conversation generation progress', async () => {
  const f = await fixture([]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  f.binding.bindSummary(async () => {
    if (++requests === 2) entered.resolve();
    await release.promise;
    return response('internal summary');
  });
  await f.root.conversation.commit(async tx => {
    (await tx.doc(LiveDoc, f.root.conversation.id)).generation = { attempt: 7 };
  }, context);
  const first = await f.binding.summaryStream(f.model, f.input);
  const second = await f.binding.summaryStream(f.model, f.input);
  try {
    await entered.promise;
    expect((await f.root.harness.snapshot(LiveDoc, f.root.conversation.id, context))?.generation).toEqual({ attempt: 7 });
  } finally { release.resolve(); }
  expect(await first.result()).toEqual(response('internal summary'));
  expect(await second.result()).toEqual(response('internal summary'));
  expect(requests).toBe(2);
  expect((await f.root.harness.snapshot(LiveDoc, f.root.conversation.id, context))?.generation).toEqual({ attempt: 7 });
});

test('native summary cancellation aborts its owned task and waits for request cancellation', async () => {
  const f = await fixture([]);
  const entered = Promise.withResolvers<void>();
  let cancelled = false;
  f.binding.bindSummary(async (_model, _input, options) => {
    const signal = options!.signal!;
    entered.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => {
      cancelled = true;
      resolve();
    }, { once: true }));
    return response('cancelled', 'aborted');
  });
  const controller = new AbortController();
  const stream = await f.binding.summaryStream(f.model, f.input, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  expect((await stream.result()).stopReason).toBe('aborted');
  expect(cancelled).toBe(true);
  const saved = await f.root.harness.getTask(f.wait.mock.calls[0]![0], context);
  expect(saved?.state.outcome.status).toBe('aborted');
});

test('a summary inside native session preparation belongs to the same durable lifecycle', async () => {
  const f = await fixture([response('continued')]);
  let checked = false;
  f.binding.bindSummary(async () => {
    const tasks = (await f.root.harness.inspect(context)).tasks.map(task => task.record);
    const parent = tasks.find(task => task.kind === 'pi.coding.session');
    const summary = tasks.find(task => task.kind === 'pi.coding.summary');
    expect(parent).toBeDefined();
    expect(summary?.owner).toBe(parent!.id);
    checked = true;
    return response('owned summary');
  });
  const agent = new Agent({
    durable: f.binding, initialState: { model: f.model },
    streamFn: (model, input, options) => f.root.models.streamSimple(model, input, options),
  });
  await f.binding.settleSession({
    start: async () => {
      expect(await (await f.binding.summaryStream(f.model, f.input)).result()).toEqual(response('owned summary'));
      await agent.prompt('continue after compaction');
    },
    continue: async () => { throw new Error('Unexpected continuation'); },
    recover: async () => { throw new Error('Unexpected recovery'); },
    post: async () => false, beforeSettle: async () => false,
    finalize: async completion => { expect(completion.status).toBe('completed'); },
    aborted: () => false,
  });
  expect(checked).toBe(true);
  expect(await f.binding.pendingSession()).toBeUndefined();
});

test('native summary signals its provider before a delayed durable abort commit completes', async () => {
  const f = await fixture([]);
  const entered = Promise.withResolvers<void>();
  const abortEntered = Promise.withResolvers<void>();
  const releaseAbort = Promise.withResolvers<void>();
  let cancelled = false;
  f.binding.bindSummary(async (_model, _input, options) => {
    entered.resolve();
    await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => {
      cancelled = true;
      resolve();
    }, { once: true }));
    return response('cancelled', 'aborted');
  });
  const abort = f.root.harness.abortTask.bind(f.root.harness);
  const delayed = spyOn(f.root.harness, 'abortTask').mockImplementation(async (id, ctx) => {
    abortEntered.resolve();
    await releaseAbort.promise;
    return abort(id, ctx);
  });
  const controller = new AbortController();
  const stream = await f.binding.summaryStream(f.model, f.input, { signal: controller.signal });
  try {
    await entered.promise;
    controller.abort();
    await abortEntered.promise;
    expect(cancelled).toBe(true);
  } finally {
    releaseAbort.resolve();
    await stream.result();
    delayed.mockRestore();
  }
});
