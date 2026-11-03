import { describe, expect, it } from 'bun:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  createRegistry, Harness, LiveDoc, MemoryStorage, type CommitObserver,
  type CommitPublication, type ConversationView, type Observer, type TaskId,
} from '@earendil-works/pi-durable';
import { watchEvents, type AgentEvent } from './watch.ts';
import { EventTranslator } from './translate.ts';

const message = (text: string): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'faux', provider: 'faux', model: 'fixture', timestamp: 1,
  stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const empty = (): ConversationView => ({ conversation: { id: 1 as ConversationView['conversation']['id'] }, entries: [], docs: {} });

describe('durable observer event bridge', () => {
  it('replays callbacks received before attachment resolves from the attachment value', async () => {
    let commits: CommitObserver;
    const initial = empty();
    const next = { ...initial, docs: { 'pi.live': { generation: { attempt: 1, message: message('early') } } } };
    const harness = {
      observeCommits(observer: CommitObserver) { commits = observer; return { detach() {} }; },
      async observeConversation(_id: number, observer: Observer<ConversationView>) {
        observer.advance({ kind: 'value', value: next, ops: [['s', ['docs', 'pi.live'], next.docs['pi.live']]], retired: false }, context);
        return { value: initial, detach() {} };
      },
    } as unknown as Harness;
    const watch = await watchEvents(harness, initial.conversation.id, context);
    const events: AgentEvent[] = [];
    watch.start(batch => events.push(...batch));
    await Promise.resolve();
    expect(events).toMatchObject([{ type: 'message_start', message: { content: [{ text: 'early' }] } }]);
    watch.stop();
    expect(commits!).toBeDefined();
  });

  it('delivers all appended entries even when the same revision trims its transcript window', async () => {
    const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: () => { throw new Error('No models'); } }, context);
    try {
      const root = await harness.root(context);
      const watch = await watchEvents(harness, root.id, context);
      const events: AgentEvent[] = [];
      watch.start(batch => events.push(...batch));
      await root.commit(async tx => {
        for (let index = 0; index < 150; index++) await tx.appendEntry(root.id, { kind: 'fixture', data: { index } });
      }, context);
      expect(events.filter(event => event.type === 'entry_appended').map(event => event.entry.data)).toEqual(
        Array.from({ length: 150 }, (_, index) => ({ index })),
      );
      watch.stop();
    } finally { await harness.close(context); }
  });

  it('delivers each deferred partial once before their combined persistence', async () => {
    const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: () => { throw new Error('No models'); } }, context);
    try {
      const root = await harness.root(context);
      const watch = await watchEvents(harness, root.id, context);
      const events: AgentEvent[] = [];
      watch.start(batch => events.push(...batch));
      for (const text of ['a', 'ab', 'abc']) {
        await root.commit(async tx => {
          (await tx.doc(LiveDoc, root.id)).generation = { attempt: 1, message: message(text) };
        }, context, { persistence: { kind: 'deferred' } });
      }
      expect(events.map(event => event.type)).toEqual(['message_start', 'message_update', 'message_update']);
      expect(events.filter(event => event.type === 'message_update').flatMap(event => event.changes.map(change => change.delta))).toEqual(['b', 'c']);
      await root.commit(async tx => {
        delete (await tx.doc(LiveDoc, root.id)).generation;
        await tx.appendEntry(root.id, { kind: 'pi.assistant', model: [message('abc')] });
      }, context);
      expect(events.map(event => event.type)).toEqual(['message_start', 'message_update', 'message_update', 'message_end']);
      watch.stop();
    } finally { await harness.close(context); }
  });

  it('keeps an answered run busy until its afterRun tasks end', () => {
    const translator = new EventTranslator();
    const before = { ...empty(), docs: { 'pi.live': { run: { taskId: 10, inputs: [11], turns: 1 } } } } as ConversationView;
    const after = { ...empty(), docs: { 'pi.live': { run: { taskId: 10, inputs: [], turns: 1, afterRun: { tasks: [12] } } } } } as ConversationView;
    expect(translator.translate(before, after, [])).toEqual([]);
    expect(translator.translate(after, empty(), [])).toEqual([{ type: 'run_end', inputs: [] }]);
  });

  it('accepts replaced partial text and resumes deltas from the new message', () => {
    const translator = new EventTranslator();
    const view = (text: string) => ({
      ...empty(), docs: { 'pi.live': { generation: { attempt: 1, message: message(text) } } },
    }) as ConversationView;
    const replaced = view('replacement');
    expect(translator.translate(view('old text'), replaced, [])).toEqual([{
      type: 'message_update', message: message('replacement'), usage: message('').usage, changes: [],
    }]);
    expect(translator.translate(replaced, view('replacement!'), [])).toMatchObject([{
      type: 'message_update', changes: [{ type: 'text_delta', delta: '!' }],
    }]);
  });

  it('does not replay a held partial when a read flushes it without changing the view', async () => {
    const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: () => { throw new Error('No models'); } }, context);
    try {
      const root = await harness.root(context);
      const watch = await watchEvents(harness, root.id, context);
      const events: AgentEvent[] = [];
      watch.start(batch => events.push(...batch));
      await root.commit(async tx => {
        (await tx.doc(LiveDoc, root.id)).generation = { attempt: 1, message: message('held') };
      }, context, { persistence: { kind: 'deferred' } });
      await root.commit(async tx => { await tx.doc(LiveDoc, root.id); }, context);
      expect(events.map(event => event.type)).toEqual(['message_start']);
      await root.commit(async tx => {
        (await tx.doc(LiveDoc, root.id)).generation = { attempt: 1, message: message('held!') };
      }, context);
      expect(events.map(event => event.type)).toEqual(['message_start', 'message_update']);
      expect(events.at(-1)).toMatchObject({ changes: [{ delta: '!' }] });
      watch.stop();
    } finally { await harness.close(context); }
  });

  it('captures a nested result before the caller document retires', () => {
    const translator = new EventTranslator();
    const slot = { taskId: 12, parentTaskId: 10, parentCallId: 'parent', callId: 'parent/child', name: 'child', arguments: {}, status: 'running' };
    const before = { ...empty(), docs: { 'pi.live': { nestedTools: [slot] } } } as ConversationView;
    const publication = {
      seq: 1, changes: [{
        type: 'document', kind: 'change', record: { kind: 'pi.tool.nested-call' },
        conversationId: 1, version: 1,
        value: { taskId: 12, result: { taskId: 12, structuredOutput: { retained: true }, isError: false, diagnostics: [] } }, ops: [],
      }],
    } as unknown as CommitPublication;
    expect(translator.translate(before, empty(), [], publication)).toMatchObject([{
      type: 'tool_execution_end', taskId: 12 as TaskId, parentToolCallId: 'parent',
      result: { structuredOutput: { retained: true }, isError: false },
    }]);
  });
});
