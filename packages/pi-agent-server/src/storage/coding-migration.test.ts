/** Synthetic v4/v3 crash checkpoints exercised through the real memory and JSONL storage boundaries. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyJson, type JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createAssistantMessageEventStream, createModels, createProvider,
  type AssistantMessage, type Model, type Usage,
} from '@earendil-works/pi-ai';
import {
  createRegistry, defineTask, GenerationTask, Harness, MemoryStorage, ROOT_CONVERSATION_ID, ToolTask,
  type ConversationId, type DocumentId, type EntryId, type EntryRecord, type JsonObject,
  type Storage, type StorageWrite, type SubmissionId, type TaskId, type TaskRecord,
} from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { NativeSessionJournal } from '../../../coding-runtime/src/durable-coding/session-journal.ts';
import {
  adoptLegacyCodingWork, CodingMigrationDoc, CodingMigrationError, migrateLegacyCodingWork,
} from './coding-migration.ts';

const context = BACKGROUND_CONTEXT;
const root = ROOT_CONVERSATION_ID;
const directories: string[] = [];
afterAll(() => { for (const path of directories) rmSync(path, { recursive: true, force: true }); });

const usage: Usage = {
  input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7,
  cost: { input: 0.04, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.07 },
};
const user = (content: string) => ({ role: 'user' as const, content, timestamp: 1 });
const assistant = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', content, api: 'faux', provider: 'local', model: 'fixture', stopReason, timestamp: 2, usage,
});
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

async function commit(storage: Storage, writes: StorageWrite[]) {
  const result = await storage.commit([writes], () => {}, context);
  if (result.stored !== 1) throw result.refused ?? new Error('fixture commit refused');
}

async function document(storage: Storage, kind: string, value: JsonObject, version = 1) {
  const id = await storage.mintId<DocumentId>();
  await commit(storage, [{
    type: 'document.create',
    record: { id, kind, scope: { kind: 'conversation', conversationId: root }, history: 'latest', fork: 'initial' },
    content: { kind: 'base', version, value },
  }]);
  return id;
}

async function readDocument(storage: Storage, kind: string) {
  const record = await storage.findDocument({ kind, scope: { kind: 'conversation', conversationId: root } }, 'current', context);
  return record ? storage.document(record.id, 'current', context) : undefined;
}

async function entry(storage: Storage, model: EntryRecord['model'], kind = 'pi.user') {
  const id = await storage.mintId<EntryId>();
  await commit(storage, [{ type: 'entry', value: { id, conversationId: root, kind, model } }]);
  return id;
}

async function fixture(storage: Storage, phase: 'request' | 'tools' | 'unsafe' = 'request') {
  await commit(storage, [{ type: 'conversation', value: { id: root } }]);
  const previousUser = await entry(storage, [user('prior accepted input')]);
  const previousAnswer = await entry(storage, [assistant([{ type: 'text', text: 'prior committed answer' }])], 'pi.assistant');
  const currentUser = await entry(storage, [user('current accepted input')]);
  const input = await storage.mintId<SubmissionId>();
  const generationId = await storage.mintId<TaskId>();
  const base = {
    conversationId: root, background: false, abortRequested: false,
  };
  const toolAssistant = phase !== 'request' ? await entry(storage, [
    assistant([{ type: 'toolCall', id: 'call-1', name: 'fixture', arguments: { path: 'synthetic.txt' } }], 'toolUse'),
  ], 'pi.assistant') : undefined;
  const toolId = phase !== 'request' ? await storage.mintId<TaskId>() : undefined;
  const toolResult = phase === 'tools' ? await entry(storage, [{
    role: 'toolResult', toolCallId: 'call-1', toolName: 'fixture',
    content: [{ type: 'text', text: 'committed tool output' }], timestamp: 3, isError: false,
  }], 'pi.tool-result') : undefined;
  const generation: StoredTask = {
    ...base, id: generationId, kind: 'pi.generation', version: 4, input: { codingRequest: true },
    state: phase === 'request' ? {
      status: 'running', checkpoint: {
        phase: 'request', attempt: 1, model: { provider: 'local', modelId: 'fixture' },
        thinkingLevel: 'off', streamOptions: { temperature: 0 }, cutoff: currentUser,
      },
    } : {
      status: 'waiting', checkpoint: { phase: 'tools', assistant: toolAssistant!, tools: [toolId!], pending: [] },
      on: [toolId!], policy: 'allSettled',
    },
    restarts: 1, startedAt: 10,
    memos: { [['mkagent', 'coding', 'prepare', 'v1:1'].join('.')]: { batches: [], latest: currentUser } },
  };
  const writes: StorageWrite[] = [
    { type: 'task', value: generation },
    { type: 'submission', value: {
      id: input, conversationId: root, type: 'input', status: 'placed', entry: currentUser, requestId: 'accepted-request',
    } },
  ];
  if (toolId) writes.push({ type: 'task', value: {
    ...base, id: toolId, owner: generationId, kind: 'pi.tool', version: 3,
    input: { kind: 'model', assistant: toolAssistant!, callId: 'call-1' },
    state: phase === 'unsafe'
      ? { status: 'running', checkpoint: { phase: 'execute', arguments: { path: 'synthetic.txt' }, replay: 'unsafe' } }
      : { status: 'terminal', outcome: { status: 'completed', result: { kind: 'model', entryId: toolResult! } } },
  } });
  await commit(storage, writes);
  const live = await document(storage, 'pi.live', {
    run: {
      taskId: generationId, inputs: [input], turns: phase === 'tools' ? 1 : 0, first: currentUser,
      codingStarted: true, codingPreparation: { taskId: generationId, attempt: 1 },
    },
    ...(phase === 'request' ? { generation: { attempt: 1 } } : {
      tools: [{
        taskId: toolId!, callId: 'call-1', name: 'fixture',
        ...(phase === 'unsafe' ? { status: 'running', output: 'committed partial tool output' } : { status: 'done', entry: toolResult! }),
      }],
    }),
    compactionFailure: { taskId: generationId, trigger: 'manual', error: 'historical diagnostic' },
  }, 3);
  const inbox = await document(storage, 'pi.inbox', { items: [] });
  const usageId = await document(storage, 'pi.usage', {
    models: { 'local/fixture': copyJson(usage) }, tools: { fixture: copyJson(usage) },
  });
  const taskDocument = await storage.mintId<DocumentId>();
  await commit(storage, [{
    type: 'document.create', record: { id: taskDocument, kind: 'fixture.task-evidence', scope: { kind: 'task', taskId: generationId } },
    content: { kind: 'base', version: 1, value: { retained: 'task-local evidence' } },
  }]);
  return { generation, input, currentUser, previousUser, previousAnswer, live, inbox, usageId, taskDocument, toolId, toolResult, toolAssistant };
}

async function replaceTask(storage: Storage, id: TaskId, transform: (task: StoredTask) => StoredTask) {
  const task = await storage.task(id, context);
  if (!task) throw new Error('fixture task missing');
  await commit(storage, [{ type: 'task', value: transform(task) }]);
}

async function snapshot(storage: Storage) {
  return {
    tasks: (await storage.scanTasks({}, 1000, undefined, context)).items,
    submissions: (await storage.scanSubmissions({}, 1000, undefined, context)).items,
    entries: (await storage.scanEntries({ conversationId: root, order: 'ascending' }, 1000, undefined, context)).items,
    documents: await Promise.all((await storage.scanDocuments({
      scope: { kind: 'conversation', conversationId: root }, at: 'current',
    }, 1000, undefined, context)).items.map(record => storage.document(record.id, 'current', context))),
  };
}

async function blocked(storage: Storage, code: string) {
  const before = await snapshot(storage);
  const failure = await migrateLegacyCodingWork(storage, root).then(() => undefined, error => error);
  expect(failure).toBeInstanceOf(CodingMigrationError);
  expect(failure.code).toBe(code);
  expect(failure.message).toContain('The store was not migrated');
  expect(await snapshot(storage)).toEqual(before);
  expect(await readDocument(storage, CodingMigrationDoc.definition.kind)).toBeUndefined();
}

for (const backend of ['memory', 'jsonl'] as const) describe(`paused legacy coding migration (${backend})`, () => {
  async function open() {
    if (backend === 'memory') return { storage: new MemoryStorage() as Storage, path: undefined };
    const path = mkdtempSync(join(tmpdir(), 'coding-migration-'));
    directories.push(path);
    return { storage: await openNodeJsonlStorage(path, context), path };
  }

  test('uses the actual installed v4 generation and v3 tool schemas', () => {
    expect(GenerationTask.definition.version).toBe(4);
    expect(ToolTask.definition.version).toBe(3);
  });

  test('migrates a real admitted request stopped inside a deterministic local provider', async () => {
    const { storage } = await open();
    const started = Promise.withResolvers<void>();
    const model: Model<'faux'> = {
      id: 'fixture', name: 'fixture', api: 'faux', provider: 'local', baseUrl: 'http://unused.invalid',
      reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const models = createModels();
    let requests = 0;
    models.setProvider(createProvider({
      id: 'local', models: [model], auth: { apiKey: { name: 'Anonymous local fixture', resolve: async () => ({ auth: {} }) } },
      api: { faux: {
        stream: () => { throw new Error('unexpected full stream'); },
        streamSimple: (_model, _transcript, options) => {
          requests++;
          const stream = createAssistantMessageEventStream();
          options?.signal?.addEventListener('abort', () => stream.push({
            type: 'error', reason: 'aborted', error: assistant([], 'aborted'),
          }), { once: true });
          started.resolve();
          return stream;
        },
      } },
    }));
    // Closing the Harness stops its invocations; retain the real backend for the paused migration.
    const borrowed = new Proxy(storage, {
      get(target, key) {
        if (key === 'close') return async () => {};
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const harness = await Harness.open(borrowed, {
      registry: createRegistry(), models, settings: { retry: { enabled: false }, compaction: { enabled: false } },
    }, context);
    try {
      const conversation = await harness.root(context, { agent: { model: { provider: 'local', modelId: 'fixture' } } });
      const submission = await conversation.submit({ type: 'input', content: 'real accepted local request' }, context);
      await started.promise;
      await harness.close(context);
      const recovery = await migrateLegacyCodingWork(storage, root);
      expect(recovery?.continuation?.checkpoint.phase).toBe('request');
      expect(recovery?.continuation?.inputs).toEqual([submission.id]);
      expect(recovery?.submissions[0]).toMatchObject({ id: submission.id, status: 'placed', type: 'input' });
      expect(requests).toBe(1);
      expect(await migrateLegacyCodingWork(storage, root)).toEqual(recovery);
    } finally { await harness.close(context); await storage.close(context); }
  });

  test('fences an active request atomically and keeps history, usage, admissions and unrelated work', async () => {
    const { storage } = await open();
    try {
      const f = await fixture(storage);
      const otherConversation = await storage.mintId<ConversationId>();
      const unrelated = await storage.mintId<TaskId>();
      const otherGeneration = await storage.mintId<TaskId>();
      const programmaticGeneration = await storage.mintId<TaskId>();
      const custom: StoredTask = {
        id: unrelated, conversationId: root, kind: 'fixture.programmatic', version: 1, input: null,
        background: false, abortRequested: false, state: { status: 'pending', checkpoint: { phase: 'work' } },
      };
      await commit(storage, [
        { type: 'conversation', value: { id: otherConversation } },
        { type: 'task', value: custom },
        { type: 'task', value: { ...f.generation, id: otherGeneration, conversationId: otherConversation } },
        { type: 'task', value: { ...f.generation, id: programmaticGeneration, owner: unrelated } },
      ]);
      const history = (await snapshot(storage)).entries;
      const ledger = await storage.document(f.usageId, 'current', context);
      const recovery = await migrateLegacyCodingWork(storage, root);
      expect(recovery?.continuation).toEqual({
        taskId: f.generation.id, inputs: [f.input], checkpoint: f.generation.state.checkpoint,
      });
      expect(recovery?.tasks).toEqual([f.generation]);
      expect((await storage.task(f.generation.id, context))?.state).toEqual({
        status: 'terminal', outcome: { status: 'aborted', reason: 'native-coding-migration' },
      });
      expect((await storage.task(f.generation.id, context))?.restarts).toBeUndefined();
      expect((await storage.task(f.generation.id, context))?.memos).toBeUndefined();
      expect(await storage.task(unrelated, context)).toEqual(custom);
      expect((await storage.task(otherGeneration, context))?.state.status).toBe('running');
      expect((await storage.task(programmaticGeneration, context))?.state.status).toBe('running');
      expect((await snapshot(storage)).entries).toEqual(history);
      expect(await storage.document(f.usageId, 'current', context)).toEqual(ledger);
      expect((await storage.submissionByRequest(root, 'accepted-request', context))?.status).toBe('placed');
      expect((await readDocument(storage, 'pi.live'))?.value).toEqual({
        compactionFailure: { taskId: f.generation.id, trigger: 'manual', error: 'historical diagnostic' },
      });
      expect(await storage.document(f.taskDocument, 'current', context)).toBeUndefined();
      expect(recovery?.taskDocuments).toMatchObject([{
        record: { id: f.taskDocument }, value: { retained: 'task-local evidence' },
      }]);
      const after = await snapshot(storage);
      expect(await migrateLegacyCodingWork(storage, root)).toEqual(recovery);
      expect(await snapshot(storage)).toEqual(after);
    } finally { await storage.close(context); }
  });

  test('imports committed tool output once and preserves completing/failed result receipts', async () => {
    for (const status of ['terminal', 'completing'] as const) {
      const { storage } = await open();
      const f = await fixture(storage, 'tools');
      await replaceTask(storage, f.toolId!, task => ({
        ...task, state: {
          status, outcome: { status: 'failed', error: { message: 'reported failure' }, result: { kind: 'model', entryId: f.toolResult! } },
        },
      }));
      const before = await snapshot(storage);
      const recovery = await migrateLegacyCodingWork(storage, root);
      expect(recovery?.continuation?.checkpoint.phase).toBe('tools');
      expect((await storage.task(f.toolId!, context))?.state).toEqual({
        status: 'terminal',
        outcome: { status: 'failed', error: { message: 'reported failure' }, result: { kind: 'model', entryId: f.toolResult! } },
      });
      expect((await snapshot(storage)).entries).toEqual(before.entries);
      const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
      const journal = await NativeSessionJournal.open({
        harness, conversation: await harness.root(context), context, cwd: '/tmp/coding-migration-fixture',
      });
      try {
        expect(journal.manager.buildSessionContext().messages.filter(message => message.role === 'toolResult')).toHaveLength(1);
        expect((await harness.getTask(f.generation.id, context))?.state.status).toBe('terminal');
      } finally { journal.close(); await harness.close(context); }
    }
  });

  test('retains ordered steer/follow-up input and atomically adopts it once, also after JSONL reopen', async () => {
    let { storage, path } = await open();
    const f = await fixture(storage);
    const steer = await storage.mintId<SubmissionId>();
    const followUp = await storage.mintId<SubmissionId>();
    const queued = [
      { id: steer, mode: 'steer', content: [{ type: 'text', text: 'accepted steer' }] },
      { id: followUp, mode: 'followUp', content: 'accepted follow-up' },
    ];
    await commit(storage, [
      ...[steer, followUp].map((id): StorageWrite => ({
        type: 'submission', value: { id, conversationId: root, type: 'input', status: 'queued', requestId: `request-${id}` },
      })),
      { type: 'document.change', id: f.inbox, content: { kind: 'base', version: 1, value: { items: queued } } },
    ]);
    expect((await migrateLegacyCodingWork(storage, root))?.queued).toEqual(queued);
    expect((await readDocument(storage, 'pi.inbox'))?.value.items).toEqual([]);
    if (path) {
      await storage.close(context);
      storage = await openNodeJsonlStorage(path, context);
      expect((await migrateLegacyCodingWork(storage, root))?.queued).toEqual(queued);
    }
    const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
    let adopts = 0;
    // A successor queue is a durable task input; its execution belongs to the parent's native integration.
    const successor = defineTask<JsonValue, { phase: 'adopted' }, null>({
      name: 'fixture.native-successor', version: 1, initial: () => ({ phase: 'adopted' }),
      phases: { adopted: async (_task, runtime, ctx) => runtime.commit(() => ({
        status: 'terminal', outcome: { status: 'completed', result: null },
      }), ctx) },
    });
    try {
      await expect(harness.commit(tx => adoptLegacyCodingWork(tx, root, async (_recovery, nested) => {
        await nested.createTask(successor, { wouldHaveBeenAdopted: true }, { conversationId: root, ownership: { kind: 'conversation' } });
        throw new Error('injected adoption failure');
      }), context)).rejects.toThrow('injected adoption failure');
      expect((await harness.snapshot(CodingMigrationDoc, root, context))?.status).toBe('staged');
      const adopt = () => harness.commit(tx => adoptLegacyCodingWork(tx, root, async (recovery, nested) => {
        adopts++;
        return await nested.createTask(successor, copyJson(recovery), { conversationId: root, ownership: { kind: 'conversation' } });
      }), context);
      const receipt = await adopt();
      expect(await adopt()).toBe(receipt);
      expect(adopts).toBe(1);
      expect((await harness.snapshot(CodingMigrationDoc, root, context))?.status).toBe('adopted');
      expect((await harness.getTask(receipt as TaskId, context))?.input).toMatchObject({ queued });
    } finally { await harness.close(context); }
    if (path) {
      storage = await openNodeJsonlStorage(path, context);
      try {
        expect(await migrateLegacyCodingWork(storage, root)).toBeUndefined();
        expect((await storage.scanTasks({ kind: 'fixture.native-successor' }, 10, undefined, context)).items).toHaveLength(1);
      } finally { await storage.close(context); }
    }
  });

  test('leaves interrupted unsafe tool effects fenced by a diagnostic before any mutation', async () => {
    const { storage, path } = await open();
    try {
      await fixture(storage, 'unsafe');
      const bytes = path ? readFileSync(join(path, 'main.jsonl')) : undefined;
      await blocked(storage, 'uncertain-tool-effect');
      if (path) expect(readFileSync(join(path, 'main.jsonl'))).toEqual(bytes!);
    } finally { await storage.close(context); }
  });

  test('does not lose pending sequential calls, tool control, or mismatched receipts', async () => {
    for (const failure of ['unstarted-tool', 'tool-control', 'tool-receipt']) {
      const { storage } = await open();
      try {
        const f = await fixture(storage, 'tools');
        if (failure === 'unstarted-tool') await replaceTask(storage, f.generation.id, task => ({
          ...task, state: { status: 'pending', checkpoint: { phase: 'tools', assistant: f.toolAssistant!, tools: [f.toolId!], pending: ['call-never-started'] } },
        }));
        else await replaceTask(storage, f.toolId!, task => ({
          ...task, state: { status: 'terminal', outcome: { status: 'completed', result: {
            kind: 'model', entryId: failure === 'tool-receipt' ? f.previousAnswer : f.toolResult!,
            ...(failure === 'tool-control' ? { control: { terminate: true } } : {}),
          } } },
        }));
        await blocked(storage, failure);
      } finally { await storage.close(context); }
    }
  });

  test('preserves native compaction envelopes and their head/edits through journal import', async () => {
    const { storage } = await open();
    const f = await fixture(storage);
    const id = await storage.mintId<EntryId>();
    await commit(storage, [{ type: 'entry', value: {
      id, conversationId: root, kind: 'mkagent.coding.entry.v1', head: f.currentUser,
      data: {
        type: 'compaction', id: 'native-compaction', parentId: `d-${f.currentUser}-0`,
        timestamp: '2026-11-04T00:00:00.000Z', summary: 'committed compacted context',
        firstKeptEntryId: `d-${f.currentUser}-0`, tokensBefore: 1000,
      },
      edits: [{ target: f.previousAnswer, action: 'omit' }],
    } }]);
    const before = (await snapshot(storage)).entries;
    await migrateLegacyCodingWork(storage, root);
    const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
    const journal = await NativeSessionJournal.open({
      harness, conversation: await harness.root(context), context, cwd: '/tmp/coding-migration-fixture',
    });
    try {
      expect(journal.manager.getEntry('native-compaction')).toMatchObject({ type: 'compaction', summary: 'committed compacted context' });
      expect((await harness.commit(tx => tx.scanEntries({ conversationId: root, order: 'ascending' }, 100), context)).items).toEqual(before);
    } finally { journal.close(); await harness.close(context); }
  });

  test('fences ordinary head/edit history now supported by the native journal import', async () => {
    for (const modification of ['head', 'edits'] as const) {
      const { storage } = await open();
      try {
        const f = await fixture(storage);
        await commit(storage, [{ type: 'entry', value: {
          id: await storage.mintId<EntryId>(), conversationId: root, kind: 'pi.compaction',
          ...(modification === 'head' ? { head: f.currentUser } : { edits: [{ target: f.previousAnswer, action: 'omit' as const }] }),
          data: { summary: 'ordinary summary without native provenance' },
        } }]);
        const before = (await snapshot(storage)).entries;
        expect((await migrateLegacyCodingWork(storage, root))?.continuation?.taskId).toBe(f.generation.id);
        expect((await snapshot(storage)).entries).toEqual(before);
      } finally { await storage.close(context); }
    }
  });

  test('fails closed on lost admissions, callback decisions and owned programmatic children', async () => {
    for (const failure of ['submission-ownership', 'callback-memo', 'owned-work', 'checkpoint-phase']) {
      const { storage } = await open();
      try {
        const f = await fixture(storage);
        if (failure === 'submission-ownership') await commit(storage, [{ type: 'submission', value: {
          id: await storage.mintId<SubmissionId>(), conversationId: root, type: 'input', status: 'queued',
        } }]);
        if (failure === 'callback-memo') await replaceTask(storage, f.generation.id, task => ({
          ...task, memos: { 'mkagent.coding.turn_end.v1:0': { entries: [{ kind: 'pending-write', data: 'must not disappear' }] } },
        }));
        if (failure === 'owned-work') await commit(storage, [{ type: 'task', value: {
          id: await storage.mintId<TaskId>(), owner: f.generation.id, conversationId: root,
          kind: 'fixture.after-run', version: 1, input: null, background: false, abortRequested: false,
          state: { status: 'pending', checkpoint: { phase: 'work' } },
        } }]);
        if (failure === 'checkpoint-phase') await replaceTask(storage, f.generation.id, task => ({
          ...task, state: { status: 'running', checkpoint: {
            phase: 'codingBoundary', assistant: f.previousAnswer, results: [], turnIndex: 0,
            outcome: 'completed', plan: { kind: 'answer' },
          } },
        }));
        await blocked(storage, failure);
      } finally { await storage.close(context); }
    }
  });

  test('leaves the entire store unchanged when the single migration batch is refused', async () => {
    const { storage } = await open();
    try {
      await fixture(storage);
      const before = await snapshot(storage);
      let commits = 0;
      const refusing = new Proxy(storage, {
        get(target, key) {
          if (key === 'commit') return async (batches: StorageWrite[][]) => {
            commits++;
            expect(batches).toHaveLength(1);
            expect(batches[0].some(write => write.type === 'task')).toBe(true);
            expect(batches[0].some(write => write.type === 'document.create')).toBe(true);
            return { stored: 0, refused: new Error('injected atomic refusal') };
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(migrateLegacyCodingWork(refusing, root)).rejects.toThrow('injected atomic refusal');
      expect(commits).toBe(1);
      expect(await snapshot(storage)).toEqual(before);
    } finally { await storage.close(context); }
  });

  test('handles fresh/initial fork markers without treating them as a prior migration', async () => {
    const { storage } = await open();
    try {
      expect(await migrateLegacyCodingWork(storage, root)).toBeUndefined();
      await commit(storage, [{ type: 'conversation', value: { id: root } }]);
      await document(storage, CodingMigrationDoc.definition.kind, { status: 'empty', recovery: null, receipt: null });
      expect(await migrateLegacyCodingWork(storage, root)).toBeUndefined();
      const inbox = await document(storage, 'pi.inbox', { items: [] });
      const id = await storage.mintId<SubmissionId>();
      await commit(storage, [
        { type: 'submission', value: { id, conversationId: root, type: 'input', status: 'queued' } },
        { type: 'document.change', id: inbox, content: { kind: 'base', version: 1, value: {
          items: [{ id, mode: 'followUp', content: 'accepted while idle' }],
        } } },
      ]);
      expect((await migrateLegacyCodingWork(storage, root))?.queued).toEqual([
        { id, mode: 'followUp', content: 'accepted while idle' },
      ]);
    } finally { await storage.close(context); }
  });
});
