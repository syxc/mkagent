/** Production startup transfers real admitted inputs from a stopped legacy scheduler. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, createProvider, type Model } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, Harness, type EntryId, type StorageWrite, type TaskId } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { response } from '../../../coding-runtime/test/fixtures/durable-harness.ts';
import { DurableKernel } from '../kernel.ts';
import { openDurableStorage } from './durable-storage.ts';

for (const backend of ['sqlite', 'jsonl'] as const)
for (const phase of ['request', 'prepare', 'unprepared', 'retry', 'tools', 'queue-only'] as const)
test(`adopts a legacy ${phase} and its queues through production ${backend} startup`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'production-coding-adoption-'));
  const sessionPath = join(directory, 'session');
  const store = join(sessionPath, 'durable-store');
  mkdirSync(store, { recursive: true });
  const storage = backend === 'jsonl' ? await openNodeJsonlStorage(store, BACKGROUND_CONTEXT)
    : await openDurableStorage(store, BACKGROUND_CONTEXT);
  const agentDir = join(directory, 'agent');
  mkdirSync(agentDir);
  const model: Model<'faux'> = {
    id: 'local', name: 'local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
    reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const started = Promise.withResolvers<void>();
  let stopped = false;
  let requests = 0;
  let inputHooks = 0;
  let preparationHooks = 0;
  const models = createModels();
  models.setProvider(createProvider({
    id: 'faux', models: [model], auth: { apiKey: { name: 'Local synthetic provider', resolve: async () => ({ auth: {} }) } },
    api: { faux: {
      stream: () => { throw new Error('Unexpected full stream'); },
      streamSimple: (_model, _transcript, options) => {
        requests++;
        const stream = createAssistantMessageEventStream();
        if (!stopped) {
          started.resolve();
          options?.signal?.addEventListener('abort', () =>
            stream.push({ type: 'error', reason: 'aborted', error: response('aborted', 'aborted') }), { once: true });
        } else queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: response(`answer-${requests}`) }));
        return stream;
      },
    } },
  }));
  const old = await Harness.open(storage, {
    registry: createRegistry(), models, settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, BACKGROUND_CONTEXT);
  let kernel: DurableKernel | undefined;
  try {
    const conversation = await old.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: 'local' } } });
    const first = await conversation.submit({ type: 'input', content: 'accepted original', requestId: 'original' }, BACKGROUND_CONTEXT);
    await started.promise;
    const steer = await conversation.submit({
      type: 'input', content: 'accepted steering', whenBusy: 'steer', requestId: 'steering',
    }, BACKGROUND_CONTEXT);
    const follow = await conversation.submit({
      type: 'input', content: 'accepted followup', whenBusy: 'followUp', requestId: 'followup',
    }, BACKGROUND_CONTEXT);
    await old.close(BACKGROUND_CONTEXT);
    if (phase !== 'request') {
      const paused = await openDurableStorage(store, BACKGROUND_CONTEXT);
      try {
        const generation = (await paused.scanTasks({ conversationId: conversation.id }, 20, undefined, BACKGROUND_CONTEXT))
          .items.find(task => task.kind === 'pi.generation')!;
        const liveRecord = await paused.findDocument({
          kind: 'pi.live', scope: { kind: 'conversation', conversationId: conversation.id },
        }, 'current', BACKGROUND_CONTEXT);
        const live = (await paused.document(liveRecord!.id, 'current', BACKGROUND_CONTEXT))!;
        const writes: StorageWrite[] = [];
        if (phase === 'prepare' || phase === 'unprepared' || phase === 'retry') writes.push({ type: 'task', value: { ...generation,
          state: { status: 'pending', checkpoint: phase !== 'retry'
            ? { phase: 'prepare', attempt: 1, ...(phase === 'prepare' ? { codingPrepared: true } : {}) }
            : { phase: 'retry', attempt: 1, until: Date.now() + 50 } },
        } });
        else {
          const answer = await paused.mintId<EntryId>();
          const toolId = await paused.mintId<TaskId>();
          const resultId = await paused.mintId<EntryId>();
          writes.push({ type: 'entry', value: { id: answer, conversationId: conversation.id, kind: 'pi.assistant',
            model: [phase === 'tools' ? { ...response('tool call', 'toolUse'), content: [
              { type: 'toolCall', id: 'legacy-call', name: 'completed_fixture', arguments: {} },
            ] } : response('already answered')] } });
          if (phase === 'tools') writes.push(
            { type: 'entry', value: { id: resultId, conversationId: conversation.id, kind: 'pi.tool-result', model: [{
              role: 'toolResult', toolCallId: 'legacy-call', toolName: 'completed_fixture',
              content: [{ type: 'text', text: 'committed old effect' }], timestamp: 2, isError: false,
            }] } },
            { type: 'task', value: { id: toolId, conversationId: conversation.id, owner: generation.id,
              kind: 'pi.tool', version: 3, background: false, abortRequested: false,
              input: { kind: 'model', assistant: answer, callId: 'legacy-call' },
              state: { status: 'terminal', outcome: { status: 'completed', result: { kind: 'model', entryId: resultId } } } } },
            { type: 'task', value: { ...generation, state: { status: 'waiting', on: [toolId], policy: 'allSettled',
              checkpoint: { phase: 'tools', assistant: answer, tools: [toolId], pending: [] } } } },
          );
          else {
            const submission = await paused.submission(first.id, BACKGROUND_CONTEXT);
            writes.push(
              { type: 'submission', value: { ...submission!, type: 'input', status: 'done', entry: submission!.entry!, answer } },
              { type: 'task', value: { ...generation,
                state: { status: 'terminal', outcome: { status: 'completed', result: { entryId: answer } } } } },
            );
            const { run: _run, generation: _generation, ...remaining } = live.value;
            writes.push({ type: 'document.change', id: live.record.id,
              content: { kind: 'base', version: 3, value: remaining } });
          }
        }
        const receipt = await paused.commit([writes], () => {}, BACKGROUND_CONTEXT);
        expect(receipt.stored).toBe(1);
      } finally { await paused.close(BACKGROUND_CONTEXT); }
    }
    stopped = true;
    writeFileSync(join(store, 'session-id.txt'), 'synthetic-legacy-session');
    const errors: string[] = [];
    const open = async () => {
      const next = new DurableKernel({
        sessionPath, cwd: directory, modelsSource: () => models, toolsExtension: defineExtension({ name: 'empty' }),
        coding: {
          agentDir, globalSettings: { retry: { enabled: false }, compaction: { enabled: false } },
          disabledBuiltinExtensions: ['codemode', 'tool-search', 'mcp'],
          extensionFactories: [pi => {
            pi.on('input', () => { inputHooks++; });
            pi.on('before_agent_start', () => { preparationHooks++; });
          }],
        },
        wrapCodingTool: tool => tool,
        hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
          isPrefetchableTool: () => false, debugLog: value => errors.push(value) },
      });
      await next.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
      return next;
    };
    kernel = await open();
    await kernel.waitForIdle();
    const live = kernel as unknown as { harness: Harness; conversation: typeof conversation };
    const admissions = await live.harness.commit(tx =>
      Promise.all(['original', 'steering', 'followup'].map(id => tx.submissionByRequest(conversation.id, id))),
    BACKGROUND_CONTEXT);
    expect(admissions.map(item => item?.id)).toEqual([first.id, steer.id, follow.id]);
    expect(admissions.map(item => item?.status)).toEqual(['done', 'done', 'done']);
    const expectedRequests = phase === 'request' ? 4 : 3;
    expect(requests).toBe(expectedRequests);
    expect(inputHooks).toBe(0);
    expect(preparationHooks).toBe(phase === 'queue-only' || phase === 'unprepared' ? 1 : 0);
    const messages = (await live.conversation.context(BACKGROUND_CONTEXT)).messages;
    expect(messages.filter(message => message.role === 'user').map(message =>
      typeof message.content === 'string' ? message.content :
        message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')))
      .toEqual(['accepted original', 'accepted steering', 'accepted followup']);
    expect(errors.filter(value => value.includes('[coding:action]'))).toEqual([]);
    await kernel.close();
    kernel = await open();
    await kernel.waitForIdle();
    expect(requests).toBe(expectedRequests);
  } finally {
    await kernel?.close();
    await old.close(BACKGROUND_CONTEXT);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
