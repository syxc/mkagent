/** Deterministic production kernel process used only by crash-recovery tests. */
import { mock } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createAssistantMessageEventStream, createModels, createProvider, type Model,
} from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, Harness, type Storage } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { convertToLlm, type AgentSession } from '@mkagent/coding-runtime/native';
import type { DurableLoopBinding, NativeSessionJournal } from '@mkagent/coding-runtime/durable';
import { response } from '../../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { openDurableStorage } from '../../src/storage/durable-storage.ts';

const [mode, directory, backend, point, variant] = process.argv.slice(2);
if (!directory || !['seed', 'initial', 'resume', 'reopen'].includes(mode!)) throw new Error('Invalid crash worker');
globalThis.fetch = Object.assign(async () => { throw new Error('Production crash tests forbid network'); }, {
  preconnect: () => { throw new Error('Production crash tests forbid network'); },
});
const context = BACKGROUND_CONTEXT;
const sessionPath = join(directory, 'session');
const store = join(sessionPath, 'durable-store');
const agentDir = join(directory, 'agent');
mkdirSync(store, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const effect = (value: string) => appendFileSync(join(directory, 'effects.jsonl'), JSON.stringify(value) + '\n');
const terminate = () => {
  writeFileSync(join(directory, 'crash'), point!);
  process.kill(process.pid, 'SIGKILL');
};
let accepted = false;
let opening = true;
let finishing = false;
const actualOpen = openDurableStorage;
const interruptedAdoption = ['migration:running-without-child', 'migration:finalizing'].includes(point!);

function instrument(storage: Storage): Storage {
  return new Proxy(storage, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== 'commit') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: Parameters<Storage['commit']>) => {
        const writes = args[0].flat();
        const staged = writes.some(write => write.type === 'document.create' &&
          write.record.kind === 'mkagent.coding.legacy-work' && write.content.kind === 'base'
          && write.content.value.status === 'staged');
        const adopted = writes.some(write => write.type === 'document.change' && write.content.kind === 'base'
          && write.content.value.status === 'adopted');
        if (mode === 'initial' && ((point === 'migration:fence-before' && staged)
          || (point === 'migration:adopt-before' && adopted))) terminate();
        const receipt = await target.commit(...args);
        if (mode !== 'initial' || receipt.stored !== args[0].length) return receipt;
        if (point === 'handoff:committed' && writes.some(write => write.type === 'entry' && write.value.head !== undefined)
          && writes.some(write => write.type === 'entry' && write.value.model?.some(message =>
            message.role === 'user' && text(message.content) === 'handoff summary'))) terminate();
        if ((point === 'migration:fence-after' && staged) || (point === 'migration:adopt-after' && adopted)) terminate();
        for (const write of writes) {
          if (write.type === 'entry' && ['migration:placed', 'queue:placed'].includes(point!)
            && write.value.model?.some(message => message.role === 'user' && text(message.content) === 'duplicate')) terminate();
          if (write.type !== 'task') continue;
          const task = write.value;
          const state = task.state;
          if (point === 'migration:terminal' && task.kind === 'pi.coding.session' && state.status === 'terminal') terminate();
          if (task.kind === 'pi.coding.run' && point === 'queue:nextTurn-child'
            && JSON.stringify(task.input).includes('"customType":"next"') && finishing) terminate();
          if (state.status === 'terminal') continue;
          const checkpoint = state.checkpoint;
          if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) continue;
          if (point === 'migration:running-without-child' && task.kind === 'pi.coding.session'
            && checkpoint.phase === 'running' && checkpoint.child === undefined) terminate();
          if (point === 'migration:finalizing' && task.kind === 'pi.coding.session'
            && checkpoint.phase === 'finalizing') terminate();
          if (point === 'migration:child' && task.kind === 'pi.coding.session' && typeof checkpoint.child === 'number') terminate();
          if (point === 'queue:drained' && accepted && task.kind === 'pi.coding.run' && checkpoint.phase === 'prepare'
            && Array.isArray(checkpoint.pending) && checkpoint.pending.length) terminate();
        }
        return receipt;
      };
    },
  });
}
if (mode !== 'seed') mock.module(new URL('../../src/storage/durable-storage.ts', import.meta.url).pathname, () => ({
  openDurableStorage: async (...args: Parameters<typeof actualOpen>) => instrument(await actualOpen(...args)),
}));
const { DurableKernel } = await import('../../src/kernel.ts');
let kernel: InstanceType<typeof DurableKernel>;
const internals = () => kernel as unknown as {
  coding: { session: AgentSession; durable: DurableLoopBinding; journal: NativeSessionJournal; flush(): Promise<void> };
  harness: Harness; conversation: Awaited<ReturnType<Harness['root']>>;
};
const started = Promise.withResolvers<void>();
const model: Model<'faux'> = {
  id: 'local', name: 'local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const models = createModels();
models.setProvider(createProvider({
  id: 'faux', models: [model],
  auth: { apiKey: { name: 'Synthetic anonymous provider', resolve: async () => ({ auth: {} }) } },
  api: { faux: {
    stream: () => { throw new Error('Unexpected full stream'); },
    streamSimple: (_model, request, options) => {
      effect(`request:${request.messages.filter(message => message.role === 'user').length}`);
      const events = createAssistantMessageEventStream();
      if (mode === 'seed') {
        started.resolve();
        options?.signal?.addEventListener('abort', () =>
          events.push({ type: 'error', reason: 'aborted', error: response('aborted', 'aborted') }), { once: true });
      } else queueMicrotask(async () => {
        try {
          if (mode === 'initial' && point!.startsWith('queue:') && point !== 'queue:hook-accepted' && !accepted && !opening) {
            const { session, durable } = internals().coding;
            // This fixture reproduces the former adapter without reverting the shared worktree.
            if (variant === 'without-ledger') durable.persistQueuedInputs = async () => {};
            if (point === 'queue:receipt-before-enqueue') {
              const persist = durable.persistQueuedInputs.bind(durable);
              let receipts = 0;
              durable.persistQueuedInputs = async snapshot => {
                await persist(snapshot);
                if (++receipts === 8) terminate();
              };
            }
            for (let i = 0; i < 2; i++) await session.steer('duplicate');
            for (let i = 0; i < 2; i++) await session.followUp('duplicate');
            for (let i = 0; i < 2; i++) await session.sendCustomMessage({
              customType: 'next', content: 'duplicate', display: false,
            }, { deliverAs: 'nextTurn' });
            for (let i = 0; i < 2; i++) await session.sendCustomMessage({
              customType: 'context', content: 'duplicate', display: false,
            }, { triggerTurn: false });
            accepted = true;
            effect('accepted');
            if (point === 'queue:accepted') terminate();
            if (point === 'queue:cleared') {
              session.clearQueue();
              await internals().coding.flush();
              terminate();
            }
          }
          if (mode === 'initial' && point === 'queue:cleared-phase' && accepted
            && request.messages.filter(message => message.role === 'user').length > 1) {
            internals().coding.session.clearQueue();
            await internals().coding.flush();
            terminate();
          }
          if (point === 'handoff:committed' && !request.messages.some(message =>
            message.role === 'user' && text(message.content) === 'handoff summary')) {
            events.push({ type: 'done', reason: 'toolUse', message: {
              ...response('', 'toolUse'), content: [{ type: 'toolCall', id: 'handoff', name: 'handoff', arguments: {} }],
            } });
          } else events.push({ type: 'done', reason: 'stop', message: response('deterministic answer') });
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
          events.push({ type: 'error', reason: 'error', error: response(String(error), 'error') });
        }
      });
      return events;
    },
  } },
}));

if (mode === 'seed') {
  const storage = backend === 'jsonl' ? await openNodeJsonlStorage(store, context) : await actualOpen(store, context);
  const harness = await Harness.open(storage, {
    registry: createRegistry(), models, settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, context);
  const conversation = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'local' } } });
  if (interruptedAdoption) await conversation.commit(async tx => {
    await tx.appendEntry(conversation.id, { kind: 'pi.user', model: [{ role: 'user', content: 'previous', timestamp: 0 }] });
    await tx.appendEntry(conversation.id, { kind: 'pi.assistant', model: [response('previous answer')] });
  }, context);
  const submissions = [await conversation.submit({ type: 'input', content: 'original', requestId: 'original' }, context)];
  await started.promise;
  for (const whenBusy of interruptedAdoption ? [] : ['steer', 'steer', 'followUp', 'followUp'] as const) submissions.push(
    await conversation.submit({ type: 'input', content: 'duplicate', whenBusy, requestId: `queued-${submissions.length}` }, context),
  );
  await harness.close(context);
  if (interruptedAdoption) {
    const paused = await actualOpen(store, context);
    try {
      const generation = (await paused.scanTasks({ conversationId: conversation.id }, 20, undefined, context))
        .items.find(task => task.kind === 'pi.generation')!;
      const receipt = await paused.commit([[{ type: 'task', value: { ...generation,
        state: { status: 'pending', checkpoint: { phase: 'prepare', attempt: 1 } },
      } }]], () => {}, context);
      if (receipt.stored !== 1) throw new Error('Cannot prepare interrupted root fixture');
    } finally { await paused.close(context); }
  }
  writeFileSync(join(store, 'session-id.txt'), 'deterministic-legacy');
  writeFileSync(join(directory, 'submissions.json'), JSON.stringify(submissions.map(item => item.id)));
  process.stdout.write(JSON.stringify({ seeded: true }));
} else {
  if (backend === 'jsonl' && mode === 'initial' && point!.startsWith('queue:')) {
    const storage = await openNodeJsonlStorage(store, context);
    await storage.close(context);
  }
  const errors: string[] = [];
  kernel = new DurableKernel({
    sessionPath, cwd: directory, modelsSource: () => models,
    toolsExtension: defineExtension({ name: 'empty', tools: point === 'handoff:committed' ? [{
      name: 'handoff', description: 'handoff', parameters: { type: 'object', properties: {} },
      execute: async () => {
        effect('handoff-tool');
        await internals().coding.session.steer('handoff steering');
        return { output: [{ type: 'text', text: 'handoff' }], control: { handoff: 'handoff summary' } };
      },
    }] : [] }), wrapCodingTool: tool => tool,
    coding: {
      agentDir, globalSettings: { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' },
      disabledBuiltinExtensions: ['codemode', 'tool-search', 'mcp'],
      extensionFactories: [pi => {
        pi.on('input', () => { effect('input'); });
        pi.on('before_agent_start', () => { effect('prepare'); });
        pi.on('turn_end', async () => {
          if (mode !== 'initial' || point !== 'queue:hook-accepted') return;
          pi.appendEntry('uncommitted-hook', { mustRollBack: true });
          await internals().coding.session.sendCustomMessage({
            customType: 'next', content: 'accepted in hook', display: false,
          }, { deliverAs: 'nextTurn' });
          effect('hook-admission');
          terminate();
        });
      }],
    },
    hooks: {
      emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: error => errors.push(error),
    },
  });
  try {
    await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
    opening = false;
    if (mode === 'initial' && (point!.startsWith('queue:') || point === 'handoff:committed'))
      await kernel.submitPrompt('original');
    try { await kernel.waitForIdle(); }
    catch (error) {
      if (!['queue:hook-accepted', 'migration:running-without-child', 'migration:finalizing', 'queue:accepted',
        'queue:receipt-before-enqueue', 'queue:cleared', 'queue:cleared-phase'].includes(point!)
        || mode !== 'resume' || !/interrupted/.test(String(error))) throw error;
      errors.push(String(error));
    }
    if (mode !== 'reopen' && point!.startsWith('queue:')
      && !internals().coding.session.messages.some(message => message.role === 'user' && text(message.content) === 'after')) {
      finishing = true;
      await kernel.submitPrompt('after');
      await kernel.waitForIdle();
    }
    const { harness, conversation, coding } = internals();
    const admissions = await harness.commit(tx =>
      Promise.all(['original', 'queued-1', 'queued-2', 'queued-3', 'queued-4']
        .map(id => tx.submissionByRequest(conversation.id, id))), context);
    process.stdout.write(JSON.stringify({
      messages: (await conversation.context(context)).messages,
      nativeMessages: coding.session.messages,
      nativeAsModel: convertToLlm(coding.session.messages),
      entries: coding.journal.manager.getEntries(),
      pending: (await harness.inspect(context)).tasks.length,
      admissions: admissions.map(item => item && { id: item.id, status: item.status, reason: item.reason, answer: item.answer }),
      isIdle: coding.session.isIdle, errors,
      effects: readFileSync(join(directory, 'effects.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    }));
  } finally { await kernel.close(); }
}
function text(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : '';
}
