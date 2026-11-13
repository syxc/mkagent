/** Native settlement uses real durable tasks and local deterministic model streams. */
import { afterEach, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Model } from '@earendil-works/pi-ai';
import {
  createRegistry, defineDoc, Harness, MemoryStorage,
  type CommitResult, type Seq, type Storage, type StorageWrite, type TaskId,
} from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createCodingRunTask, type LoopExecution } from '../src/durable-coding/run-task.ts';
import {
  createCodingSessionTask, type CodingSessionCompletion, type CodingSessionOperation,
  type CodingSessionTaskCheckpoint, type CodingSessionTaskRuntime,
} from '../src/durable-coding/session-task.ts';
import { response } from './fixtures/durable-harness.ts';

const context = BACKGROUND_CONTEXT;
const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close(context)));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function untilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

const NativeDoc = defineDoc({
  kind: 'test.native-session-state', version: 1, scope: 'conversation',
  history: 'latest', fork: 'initial', checkpointWhen: () => true,
  initial: () => ({
    transcript: [] as string[], accepted: [] as string[], queued: [] as string[],
    boundaries: 0, posts: 0, finalizations: 0, completion: '',
  }),
});

const model: Model<'faux'> = {
  id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

class RecordingStorage extends MemoryStorage {
  readonly batches: Array<readonly StorageWrite[]> = [];
  override commit(
    batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, ctx: Context,
  ): Promise<CommitResult> {
    return super.commit(batches, (index, seq) => {
      this.batches.push(batches[index]);
      receive(index, seq);
    }, ctx);
  }
}

interface Options {
  requests?: { value: number };
  onPhase?(phase: CodingSessionTaskCheckpoint, runtime: CodingSessionTaskRuntime): Promise<void>;
  afterChild?(runtime: CodingSessionTaskRuntime, child: TaskId): Promise<void>;
  beforeRun?(runtime: CodingSessionTaskRuntime): Promise<void>;
  post?(runtime: CodingSessionTaskRuntime): Promise<boolean>;
  beforeSettle?(runtime: CodingSessionTaskRuntime): Promise<boolean>;
  finalize?(completion: CodingSessionCompletion, runtime: CodingSessionTaskRuntime): Promise<void>;
  onRequest?(): void;
  hangRequest?: boolean;
  aborted?: boolean;
  doubleAdmission?: boolean;
}

async function open(storage: Storage = new MemoryStorage(), options: Options = {}) {
  const scope = new AsyncLocalStorage<CodingSessionTaskRuntime>();
  const requests = options.requests ?? { value: 0 };
  const operations: Array<{ operation: CodingSessionOperation; child?: TaskId }> = [];
  let native = NativeDoc.definition.initial();
  const persist = async (tx: Parameters<LoopExecution['commit']>[0]) => {
    Object.assign(await tx.doc(NativeDoc, conversation.id), structuredClone(native));
  };
  const loop: LoopExecution = {
    config: { model, convertToLlm: () => [] }, context: { messages: [], tools: [] },
    streamFn: (_model, _messages, settings) => {
      requests.value++;
      const stream = createAssistantMessageEventStream();
      if (options.hangRequest) {
        const abort = () => stream.push({ type: 'error', reason: 'aborted', error: response('aborted', 'aborted') });
        if (settings?.signal?.aborted) abort();
        else settings?.signal?.addEventListener('abort', abort, { once: true });
      } else {
        queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: response(`answer-${requests.value}`) }));
      }
      options.onRequest?.();
      return stream;
    },
    emit: async event => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        native.transcript.push(...event.message.content.flatMap(part => part.type === 'text' ? [part.text] : []));
      }
    },
    resolveModel: () => model, resolveTool: () => undefined, prepareToolBatch: () => {},
    commit: persist, phase: (_runtime, work) => work(),
  };
  const Run = createCodingRunTask(() => loop, { create: async () => { throw new Error('No tools in this fixture'); } });
  const Session = createCodingSessionTask(() => ({
    phase: (runtime, work) => scope.run(runtime, async () => {
      const record = await runtime.getTask(runtime.taskId, context);
      if (record && 'checkpoint' in record.state) {
        await options.onPhase?.(record.state.checkpoint as CodingSessionTaskCheckpoint, runtime);
      }
      return work();
    }),
    run: async (operation, child) => {
      const runtime = scope.getStore()!;
      operations.push(child ? { operation, child } : { operation });
      await options.beforeRun?.(runtime);
      const id = child ?? await runtime.admitChild((tx, owner) => tx.createTask(Run, {
        messages: [], prompts: [], tools: [], model: { provider: 'faux', modelId: 'local' }, reasoning: 'low',
      }, { ownership: { kind: 'task', taskId: owner } }));
      if (options.doubleAdmission) {
        expect(await runtime.admitChild(async () => { throw new Error('Duplicate admission'); })).toBe(id);
      }
      await runtime.waitForTask(id, context);
      await options.afterChild?.(runtime, id);
    },
    post: async () => { native.posts++; return options.post?.(scope.getStore()!) ?? false; },
    beforeSettle: async () => { native.boundaries++; return options.beforeSettle?.(scope.getStore()!) ?? false; },
    finalize: async completion => {
      native.finalizations++;
      native.completion = completion.status;
      await options.finalize?.(completion, scope.getStore()!);
    },
    aborted: () => options.aborted ?? false,
    commit: persist,
  }));
  const registry = createRegistry();
  registry.install({ name: 'native-session-test', tasks: [Session, Run] });
  const harness = await Harness.open(storage, {
    registry, models: createModels(), settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, context);
  harnesses.push(harness);
  const conversation = await harness.root(context);
  native = structuredClone(await harness.snapshot(NativeDoc, conversation.id, context) ?? native);
  const start = () => conversation.commit(
    tx => tx.createTask(Session, {}, { ownership: { kind: 'conversation' } }), context,
  );
  return { harness, conversation, Session, requests, operations, start, native };
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'durable-native-session-'));
  directories.push(path);
  return path;
}

test('installs session v1, admits one owned run atomically, and settles in native order', async () => {
  const storage = new RecordingStorage();
  const opened = await open(storage, {
    doubleAdmission: true, beforeRun: async () => { opened.native.accepted.push('initial-prompt'); },
  });
  expect(opened.Session.definition.name).toBe('pi.coding.session');
  expect(opened.Session.definition.version).toBe(1);
  const id = await opened.start();
  expect((await opened.harness.waitForTask(id, context)).state.outcome.status).toBe('completed');
  expect(opened.requests.value).toBe(1);
  expect(opened.native).toMatchObject({ transcript: ['answer-1'], posts: 1, boundaries: 1, finalizations: 1 });
  const admission = storage.batches.find(batch => batch.some(write =>
    write.type === 'task' && write.value.kind === 'pi.coding.run' && write.value.owner === id));
  expect(admission).toBeDefined();
  expect(admission!.some(write => write.type === 'task' && write.value.id === id
    && write.value.state.status === 'running'
    && (write.value.state.checkpoint as CodingSessionTaskCheckpoint).phase === 'running'
    && 'child' in (write.value.state.checkpoint as object))).toBe(true);
  expect(admission!.some(write => write.type.startsWith('document.'))).toBe(true);
});

test('JSONL reopen in the run-completion to post window preserves the boundary', async () => {
  const path = await directory();
  const entered = gate();
  const requests = { value: 0 };
  const first = await open(await openNodeJsonlStorage(path, context), {
    requests,
    onPhase: async (state, runtime) => {
      if (state.phase === 'post') { entered.resolve(); await untilAbort(runtime.signal); }
    },
  });
  const id = await first.start();
  first.harness.resume();
  await entered.promise;
  expect(first.native.posts).toBe(0);
  await first.harness.close(context);
  const second = await open(await openNodeJsonlStorage(path, context), { requests });
  expect((await second.harness.waitForTask(id, context)).state.outcome.status).toBe('completed');
  expect(second.native).toMatchObject({ transcript: ['answer-1'], posts: 1, boundaries: 1, finalizations: 1 });
  expect(requests.value).toBe(1);
  expect(second.operations).toEqual([]);
});

test('JSONL reopen rejoins a completed committed child without another model request', async () => {
  const path = await directory();
  const entered = gate();
  const requests = { value: 0 };
  let child: TaskId | undefined;
  const first = await open(await openNodeJsonlStorage(path, context), {
    requests, afterChild: async (runtime, id) => { child = id; entered.resolve(); await untilAbort(runtime.signal); },
  });
  const id = await first.start();
  first.harness.resume();
  await entered.promise;
  expect((await first.harness.getTask(child!, context))?.state.status).toBe('terminal');
  await first.harness.close(context);
  const second = await open(await openNodeJsonlStorage(path, context), { requests });
  expect((await second.harness.waitForTask(id, context)).state.outcome.status).toBe('completed');
  expect(requests.value).toBe(1);
  expect(second.operations).toEqual([{ operation: 'start', child }]);
  expect(second.native.transcript).toEqual(['answer-1']);
});

test('commits a successful boundary, accepted followup, and continuation together before reopen', async () => {
  const path = await directory();
  const entered = gate();
  const requests = { value: 0 };
  const first = await open(await openNodeJsonlStorage(path, context), {
    requests,
    beforeSettle: async () => {
      first.native.queued.push('followup');
      first.native.accepted.push('followup');
      return true;
    },
    onPhase: async (state, runtime) => {
      if (state.phase === 'run' && state.operation === 'continue') {
        entered.resolve();
        await untilAbort(runtime.signal);
      }
    },
  });
  const id = await first.start();
  first.harness.resume();
  await entered.promise;
  expect(await first.harness.snapshot(NativeDoc, first.conversation.id, context)).toMatchObject({
    accepted: ['followup'], queued: ['followup'], boundaries: 1,
  });
  await first.harness.close(context);
  let resumedBoundaries = 0;
  const second = await open(await openNodeJsonlStorage(path, context), {
    requests, beforeSettle: async () => { resumedBoundaries++; return false; },
  });
  expect((await second.harness.waitForTask(id, context)).state.outcome.status).toBe('completed');
  expect(second.operations).toEqual([{ operation: 'continue' }]);
  expect(second.native).toMatchObject({
    transcript: ['answer-1', 'answer-2'], accepted: ['followup'], queued: ['followup'], boundaries: 2, finalizations: 1,
  });
  expect(resumedBoundaries).toBe(1);
  expect(requests.value).toBe(2);
});

for (const stage of ['post', 'before-settle', 'finalize'] as const) {
  test(`JSONL reopen does not replay an uncertain ${stage} callback`, async () => {
    const path = await directory();
    const entered = gate();
    let effects = 0;
    const unsafe = async (runtime: CodingSessionTaskRuntime) => {
      effects++;
      entered.resolve();
      await untilAbort(runtime.signal);
      return false;
    };
    const first = await open(await openNodeJsonlStorage(path, context), {
      ...(stage === 'post' ? { post: unsafe }
        : stage === 'before-settle' ? { beforeSettle: unsafe }
        : { finalize: async (_completion: CodingSessionCompletion, runtime: CodingSessionTaskRuntime) => { await unsafe(runtime); } }),
    });
    first.native.accepted.push('accepted-before-interruption');
    first.native.queued.push('pending-before-interruption');
    const id = await first.start();
    first.harness.resume();
    await entered.promise;
    await first.harness.close(context);
    const second = await open(await openNodeJsonlStorage(path, context), {
      post: async runtime => stage === 'post' ? unsafe(runtime) : false,
      beforeSettle: async runtime => stage === 'before-settle' ? unsafe(runtime) : false,
      finalize: async (_completion, runtime) => { if (stage === 'finalize') await unsafe(runtime); },
    });
    const outcome = (await second.harness.waitForTask(id, context)).state.outcome;
    expect(outcome).toMatchObject({
      status: 'failed', error: { detail: { code: 'native_session_interrupted', stage } },
    });
    expect(effects).toBe(1);
    expect(second.native).toMatchObject({
      transcript: ['answer-1'], accepted: ['accepted-before-interruption'], queued: ['pending-before-interruption'],
    });
    expect(second.native.finalizations).toBe(stage === 'finalize' ? 0 : 1);
  });
}

test('a native post continuation skips the first boundary and uses a new owned child', async () => {
  let posts = 0;
  const opened = await open(new MemoryStorage(), { post: async () => ++posts === 1 });
  const id = await opened.start();
  expect((await opened.harness.waitForTask(id, context)).state.outcome.status).toBe('completed');
  expect(opened.operations).toEqual([{ operation: 'start' }, { operation: 'continue' }]);
  expect(opened.native).toMatchObject({ posts: 2, boundaries: 1, finalizations: 1 });
  expect(opened.requests.value).toBe(2);
});

test('abort joins the owned child, releases native waits, and finalizes once', async () => {
  const entered = gate();
  const opened = await open(new MemoryStorage(), { hangRequest: true, onRequest: entered.resolve });
  const id = await opened.start();
  opened.harness.resume();
  await entered.promise;
  await opened.harness.abortTask(id, context);
  expect((await opened.harness.waitForTask(id, context)).state.outcome.status).toBe('aborted');
  expect(opened.native).toMatchObject({ posts: 0, boundaries: 0, finalizations: 1, completion: 'aborted' });
  expect((await opened.harness.inspect(context)).tasks).toHaveLength(0);
});

test('a pre-aborted session runs cleanup without creating a child', async () => {
  const opened = await open(new MemoryStorage(), { aborted: true });
  const id = await opened.start();
  expect((await opened.harness.waitForTask(id, context)).state.outcome.status).toBe('aborted');
  expect(opened.operations).toEqual([]);
  expect(opened.requests.value).toBe(0);
  expect(opened.native.finalizations).toBe(1);
});

test('abort during finalization stops with uncertainty and never repeats settled delivery', async () => {
  const entered = gate();
  let effects = 0;
  const opened = await open(new MemoryStorage(), {
    finalize: async (_completion, runtime) => {
      effects++;
      entered.resolve();
      try { await untilAbort(runtime.signal); } catch {}
    },
  });
  const id = await opened.start();
  opened.harness.resume();
  await entered.promise;
  await opened.harness.abortTask(id, context);
  expect((await opened.harness.waitForTask(id, context)).state.outcome).toMatchObject({
    status: 'failed', error: { detail: { stage: 'finalize', code: 'native_session_interrupted' } },
  });
  expect(effects).toBe(1);
  expect(opened.native.finalizations).toBe(1);
});

test('abort during an unsafe boundary gives cleanup an uncertainty diagnostic', async () => {
  const entered = gate();
  let effects = 0;
  let completion: CodingSessionCompletion | undefined;
  const opened = await open(new MemoryStorage(), {
    beforeSettle: async runtime => {
      effects++;
      entered.resolve();
      await untilAbort(runtime.signal);
      return true;
    },
    finalize: async value => { completion = value; },
  });
  opened.native.accepted.push('followup');
  const id = await opened.start();
  opened.harness.resume();
  await entered.promise;
  await opened.harness.abortTask(id, context);
  expect((await opened.harness.waitForTask(id, context)).state.outcome).toMatchObject({
    status: 'failed', error: { detail: { stage: 'before-settle', code: 'native_session_interrupted' } },
  });
  expect(completion).toMatchObject({ status: 'failed', stage: 'before-settle', uncertain: true });
  expect(opened.native.accepted).toEqual(['followup']);
  expect(effects).toBe(1);
  expect(opened.native.finalizations).toBe(1);
});

test('an interrupted run before admission is reported without repeating native prompt hooks', async () => {
  const path = await directory();
  const entered = gate();
  let hooks = 0;
  const first = await open(await openNodeJsonlStorage(path, context), {
    beforeRun: async runtime => { hooks++; entered.resolve(); await untilAbort(runtime.signal); },
  });
  const id = await first.start();
  first.harness.resume();
  await entered.promise;
  await first.harness.close(context);
  const second = await open(await openNodeJsonlStorage(path, context), {
    beforeRun: async () => { hooks++; },
  });
  expect((await second.harness.waitForTask(id, context)).state.outcome).toMatchObject({
    status: 'failed', error: { detail: { stage: 'run' } },
  });
  expect(hooks).toBe(1);
  expect(second.requests.value).toBe(0);
  expect(second.native.finalizations).toBe(1);
});
