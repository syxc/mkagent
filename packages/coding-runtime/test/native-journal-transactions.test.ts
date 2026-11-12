import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type AssistantMessage } from '@earendil-works/pi-ai';
import {
  createRegistry, defineDoc, Harness, MemoryStorage, ToolTask,
  type CommitResult, type Seq, type Storage, type StorageWrite, type Tx,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { AgentTool, StreamFn } from '../src/agent-runtime.ts';
import { currentCodingHostToolApi, currentCodingToolInvocation, DurableLoopBinding } from '../src/durable-coding/engine.ts';
import { NativeSessionJournal } from '../src/durable-coding/session-journal.ts';
import { agentToolToHost, hostToolToAgent } from '../src/host-tools.ts';
import { getDefaultStreamFn, setDefaultStreamFn } from '../src/stream-fn.ts';

const context = BACKGROUND_CONTEXT;
const harnesses: Harness[] = [];
const journals: NativeSessionJournal[] = [];
const bindings: DurableLoopBinding[] = [];
let previousStream: StreamFn | undefined;
beforeEach(() => {
  try { previousStream = getDefaultStreamFn(); } catch { previousStream = undefined; }
  setDefaultStreamFn(() => { throw new Error('Unexpected provider request'); });
});
afterEach(async () => {
  for (const binding of bindings.splice(0)) await binding.close();
  for (const journal of journals.splice(0)) journal.close();
  for (const harness of harnesses.splice(0)) await harness.close(context);
  setDefaultStreamFn(previousStream);
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const user = (content: string) => ({ role: 'user' as const, content, timestamp: 1 });

async function setup(storage: Storage = new MemoryStorage()) {
  const registry = createRegistry();
  const env = new NodeExecutionEnv({ cwd: '/tmp/native-journal-transactions', shellEnv: {} });
  const harness = await Harness.open(storage, {
    registry, models: createModels(), env: () => env,
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, context);
  harnesses.push(harness);
  const conversation = await harness.root(context);
  const openJournal = async () => {
    const journal = await NativeSessionJournal.open({
      harness, conversation, context, cwd: '/tmp/native-journal-transactions',
    });
    journals.push(journal);
    return journal;
  };
  const journal = await openJournal();
  return { harness, conversation, journal, manager: journal.manager, openJournal, registry };
}

async function toolFixture() {
  const opened = await setup();
  const binding = new DurableLoopBinding({
    kernel: { harness: opened.harness, conversation: opened.conversation, registry: opened.registry },
    journal: opened.journal,
  });
  bindings.push(binding);
  const assistant: AssistantMessage = {
    role: 'assistant', content: [], api: 'faux', provider: 'local', model: 'fixture',
    stopReason: 'toolUse', timestamp: 1,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const execute = (tool: AgentTool) => binding.runTool({
    type: 'toolCall', name: tool.name, id: 'transaction-call', arguments: {},
  }, { tools: [tool], assistantMessage: assistant, context: { messages: [], tools: [tool] } });
  return { ...opened, execute, binding };
}

describe('native journal preparation within one transaction', () => {
  test('a second flush without new operations preserves revision and navigation identity', async () => {
    const { journal, manager, conversation } = await setup();
    const before = journal.committedSnapshot();
    let id = '';
    await journal.phase(async () => {
      id = manager.appendMessage(user('once'));
      journal.markTreeNavigation();
      await conversation.commit(async tx => {
        await journal.commit(tx);
        await journal.commit(tx);
        await journal.commit(tx);
        expect(journal.committedSnapshot()).toEqual(before);
        expect(journal.durableId(id)).toBeUndefined();
      }, context);
    });
    expect(journal.committedSnapshot()).toMatchObject({
      revision: before.revision + 1, treeRevision: before.revision + 1,
      entries: [{ id }], leaf: id,
    });
    expect((await conversation.entries({}, 20, undefined, context)).items).toHaveLength(1);
    expect((await conversation.context(context)).messages).toEqual([user('once')]);
  });

  test('prepares only the new suffix and retains writes made after the last flush', async () => {
    const { journal, manager, conversation, openJournal } = await setup();
    const revision = journal.committedSnapshot().revision;
    let a = '';
    let metadata = '';
    let b = '';
    let c = '';
    await journal.phase(async () => {
      a = manager.appendMessage(user('first branch'));
      journal.markTreeNavigation();
      await conversation.commit(async tx => {
        await journal.commit(tx);
        metadata = manager.appendCustomEntry('metadata', { retained: true });
        manager.resetLeaf();
        b = manager.appendMessage(user('second branch'));
        await journal.commit(tx);
        c = manager.appendMessage(user('after preparation'));
      }, context);
      const committed = journal.committedSnapshot();
      expect(committed.entries.map(entry => entry.id)).toEqual([a, metadata, b]);
      expect(committed).toMatchObject({
        revision: revision + 2, treeRevision: revision + 1, leaf: b,
      });
      expect(journal.durableId(c)).toBeUndefined();
      expect(manager.getEntries().map(entry => entry.id)).toEqual([a, metadata, b, c]);
      await conversation.commit(tx => journal.commit(tx), context);
    });
    expect(manager.getEntries().map(entry => [entry.id, entry.parentId]))
      .toEqual([[a, null], [metadata, a], [b, null], [c, b]]);
    expect(journal.committedSnapshot()).toMatchObject({
      revision: revision + 3, treeRevision: revision + 1, leaf: c,
    });
    expect((await conversation.context(context)).messages)
      .toEqual([user('second branch'), user('after preparation')]);
    expect((await openJournal()).committedSnapshot()).toEqual(journal.committedSnapshot());
  });

  test('can prepare successive replacements without conflicting with its own revision', async () => {
    const { journal, manager, conversation, openJournal } = await setup();
    manager.appendMessage(user('previous session'));
    await journal.flush();
    const revision = journal.committedSnapshot().revision;
    await journal.phase(async () => {
      manager.newSession({ id: 'replacement-one' });
      manager.appendMessage(user('intermediate replacement'));
      await conversation.commit(async tx => {
        await journal.commit(tx);
        await journal.commit(tx);
        manager.newSession({ id: 'replacement-two' });
        manager.appendMessage(user('final replacement'));
        await journal.commit(tx);
        await journal.commit(tx);
      }, context);
    });
    expect(manager.getSessionId()).toBe('replacement-two');
    expect(manager.getEntries()).toHaveLength(1);
    expect(journal.committedSnapshot().revision).toBe(revision + 2);
    expect((await conversation.context(context)).messages).toEqual([user('final replacement')]);
    expect((await openJournal()).committedSnapshot()).toEqual(journal.committedSnapshot());
  });

  test('a real concurrent replacement still requires a fresh phase', async () => {
    const { journal, manager, conversation, openJournal } = await setup();
    const other = await openJournal();
    await expect(journal.phase(async () => {
      manager.newSession({ id: 'stale-replacement' });
      manager.appendMessage(user('must not replace a later receipt'));
      other.manager.appendMessage(user('concurrent commit'));
      await other.flush();
      await conversation.commit(tx => journal.commit(tx), context);
    })).rejects.toThrow('Concurrent native session replacement requires a fresh phase');
    expect(journal.committedSnapshot()).toEqual(other.committedSnapshot());
    expect(manager.buildSessionContext().messages).toEqual([user('concurrent commit')]);
  });

  test('a refused callback retries the whole pending stage in a fresh transaction', async () => {
    const { journal, manager, conversation, openJournal } = await setup();
    const before = journal.committedSnapshot();
    let a = '';
    let b = '';
    await journal.phase(async () => {
      manager.newSession({ id: 'retry-session' });
      a = manager.appendMessage(user('first pending write'));
      await expect(conversation.commit(async tx => {
        await journal.commit(tx);
        b = manager.appendMessage(user('second pending write'));
        journal.markTreeNavigation();
        await journal.commit(tx);
        throw new Error('refuse prepared transaction');
      }, context)).rejects.toThrow('refuse prepared transaction');
      expect(journal.committedSnapshot()).toEqual(before);
      expect(journal.durableId(a)).toBeUndefined();
      expect(journal.durableId(b)).toBeUndefined();
      await conversation.commit(async tx => {
        await journal.commit(tx);
        await journal.commit(tx);
      }, context);
    });
    expect(manager.getEntries().map(entry => [entry.id, entry.parentId])).toEqual([[a, null], [b, a]]);
    expect(journal.committedSnapshot()).toMatchObject({
      revision: before.revision + 1, treeRevision: before.revision + 1,
    });
    expect((await conversation.entries({}, 20, undefined, context)).items
      .filter(entry => entry.kind === 'mkagent.coding.entry.v1')).toHaveLength(2);
    expect((await openJournal()).committedSnapshot()).toEqual(journal.committedSnapshot());
  });

  test('preserves edit and compaction references when one operation adds several projections', async () => {
    const { journal, manager, conversation } = await setup();
    const root = manager.appendMessage(user('root'));
    const kept = manager.appendMessage(user('kept'));
    await journal.flush();
    const revision = journal.committedSnapshot().revision;
    let edit = '';
    let compaction = '';
    await journal.phase(async () => {
      edit = manager.appendContextEdit(root, { content: 'edited root' });
      journal.markTreeNavigation();
      await conversation.commit(async tx => {
        await journal.commit(tx);
        compaction = manager.appendCompaction('summary', kept, 30);
        manager.appendLabelChange(edit, 'retained label');
        await journal.commit(tx);
        await journal.commit(tx);
      }, context);
    });
    const view = await conversation.context(context);
    expect(view.head?.id).toBe(journal.durableId(compaction));
    expect(view.head?.head).toBe(journal.durableId(kept));
    const records = (await conversation.entries({}, 30, undefined, context)).items;
    expect(records.find(entry => entry.id === journal.durableId(edit))?.edits)
      .toEqual([{ target: journal.durableId(root), action: 'replace', messages: [user('edited root')] }]);
    const ids = journal.committedSnapshot().entryIds.map(entry => entry.durableId);
    expect(new Set(ids).size).toBe(5);
    expect(manager.getLabel(edit)).toBe('retained label');
    expect(journal.committedSnapshot()).toMatchObject({
      revision: revision + 2, treeRevision: revision + 1,
    });
  });

  test('does not publish either preparation until storage acknowledges the transaction', async () => {
    const entered = gate();
    const release = gate();
    class PausedStorage extends MemoryStorage {
      pause = false;
      override async commit(
        batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, ctx: Context,
      ): Promise<CommitResult> {
        if (this.pause) {
          this.pause = false;
          entered.resolve();
          await release.promise;
        }
        return super.commit(batches, receive, ctx);
      }
    }
    const storage = new PausedStorage();
    const { journal, manager, conversation } = await setup(storage);
    const before = journal.committedSnapshot();
    const notifications: number[] = [];
    journal.observeCommitted(state => { notifications.push(state.revision); });
    storage.pause = true;
    let a = '';
    let b = '';
    let c = '';
    let appendWhilePending!: () => string;
    const running = journal.phase(async () => {
      const resume = AsyncLocalStorage.snapshot();
      appendWhilePending = () => resume(() => manager.appendCustomEntry('during pending receipt'));
      a = manager.appendCustomEntry('first');
      await conversation.commit(async tx => {
        await journal.commit(tx);
        b = manager.appendCustomEntry('second');
        await journal.commit(tx);
      }, context);
      expect(journal.committedSnapshot().entries.map(entry => entry.id)).toEqual([a, b]);
      expect(journal.durableId(c)).toBeUndefined();
      expect(manager.getEntries().map(entry => entry.id)).toEqual([a, b, c]);
      await conversation.commit(tx => journal.commit(tx), context);
    });
    try {
      await entered.promise;
      c = appendWhilePending();
      expect(journal.committedSnapshot()).toEqual(before);
      expect(journal.durableId(a)).toBeUndefined();
      expect(journal.durableId(b)).toBeUndefined();
      expect(notifications).toEqual([]);
    } finally {
      release.resolve();
      await running;
    }
    expect(journal.committedSnapshot().entries.map(entry => entry.id)).toEqual([a, b, c]);
    expect(notifications).toEqual([before.revision + 2, before.revision + 3]);
    expect(journal.durableId(a)).toBeDefined();
    expect(journal.durableId(b)).toBeDefined();
    expect(journal.durableId(c)).toBeDefined();
  });
});

describe('native journal scope in a real host tool invocation', () => {
  test('the same-owner path binds a wrapper API while retaining its CodingToolTask', async () => {
    const { execute, binding } = await toolFixture();
    let observed = false;
    const tool = hostToolToAgent({
      name: 'wrapped-scope', description: 'Bind the real wrapped API', parameters: { type: 'object' },
      execute: async (_args, api, ctx) => {
        const task = currentCodingToolInvocation().runtime.taskId;
        const wrapped = { ...api, now: () => 12345 };
        await binding.withHostToolScope(wrapped, ctx, async () => {
          expect(currentCodingHostToolApi()?.api).toBe(wrapped);
          expect(currentCodingHostToolApi()?.api.now()).toBe(12345);
          expect(currentCodingToolInvocation().runtime.taskId).toBe(task);
          observed = true;
        });
        expect(currentCodingHostToolApi()?.api).toBe(api);
        return { output: [] };
      },
    });
    expect((await execute(tool)).isError).toBe(false);
    expect(observed).toBe(true);
  });

  test.each(['models', 'append'])('an official ToolTask retains native %s behavior', async behavior => {
    const { execute, binding, registry, journal, manager } = await toolFixture();
    const first = createModels();
    const second = createModels();
    let models = first;
    let entry = '';
    let observed = false;
    const native: AgentTool = {
      name: 'native-wrapper', label: 'Native wrapper', description: 'Real official scope fixture',
      parameters: { type: 'object' },
      execute: async () => {
        if (behavior === 'models') {
          expect(currentCodingHostToolApi()?.api.models).toBe(first);
          models = second;
          expect(currentCodingHostToolApi()?.api.models).toBe(second);
        } else {
          entry = manager.appendCustomEntry('unflushed official append');
        }
        observed = true;
        return { content: [{ type: 'text', text: 'native behavior retained' }], details: {} };
      },
    };
    registry.install({
      name: 'test-native-wrapper',
      tools: [agentToolToHost(native, (api, ctx, work) =>
        binding.withHostToolScope({ ...api, get models() { return models; } }, ctx, work))],
    });
    const parent = hostToolToAgent({
      name: 'native-wrapper-parent', description: 'Own the official task', parameters: { type: 'object' },
      execute: async (_args, api, ctx) => {
        const result = await api.executeTool(native.name, {}, ctx);
        return { output: [], isError: result.isError };
      },
    });
    expect((await execute(parent)).isError).toBe(false);
    expect(observed).toBe(true);
    if (behavior === 'append') {
      expect(journal.durableId(entry)).toBeDefined();
      expect(journal.committedSnapshot().entries).toMatchObject([{ id: entry }]);
    }
  });

  test('a detached commit prepares callback appends with the host document in one receipt', async () => {
    const detached = new AsyncResource('test.native-journal-detached');
    const { execute, journal, manager, harness, conversation } = await toolFixture();
    const HostState = defineDoc({
      kind: 'test.native-journal-host-state', version: 1, scope: 'conversation',
      initial: () => ({ id: '' }), checkpointWhen: () => false,
    });
    let before = '';
    let after = '';
    const tool = hostToolToAgent({
      name: 'transaction', description: 'Local transaction fixture', parameters: { type: 'object' },
      execute: async (_args, api, ctx) => {
        const scope = currentCodingToolInvocation();
        expect(currentCodingHostToolApi()?.api).toBe(api);
        before = manager.appendCustomEntry('before callback');
        const result = await detached.runInAsyncScope(() => api.commit(async tx => {
          expect(currentCodingToolInvocation().runtime.taskId).toBe(scope.runtime.taskId);
          expect(currentCodingHostToolApi()?.api).toBe(api);
          after = manager.appendCustomEntry('inside callback');
          (await tx.doc(HostState, conversation.id)).id = after;
          expect(journal.durableId(before)).toBeUndefined();
          expect(journal.durableId(after)).toBeUndefined();
          return 'committed';
        }, ctx));
        expect(result).toBe('committed');
        expect(journal.durableId(before)).toBeDefined();
        expect(journal.durableId(after)).toBeDefined();
        expect((await api.snapshot(HostState, conversation.id, ctx))?.id).toBe(after);
        return { output: [{ type: 'text', text: result }] };
      },
    });
    try {
      const result = await execute(tool);
      expect(result.result.content).toEqual([{ type: 'text', text: 'committed' }]);
      expect(result.isError).toBe(false);
      expect(journal.committedSnapshot().entries.map(entry => entry.id)).toEqual([before, after]);
      expect((await harness.snapshot(HostState, conversation.id, context))?.id).toBe(after);
    } finally {
      detached.emitDestroy();
    }
  });

  test.each([false, true])('an official ToolTask commits detached native appends (retry: %s)', async retry => {
    const detached = new AsyncResource('test.native-official-api');
    const opened = await toolFixture();
    const { execute, binding, registry, journal, manager, conversation, harness } = opened;
    const HostState = defineDoc({
      kind: 'test.native-official-host-state', version: 1, scope: 'conversation',
      initial: () => ({ id: '' }), checkpointWhen: () => false,
    });
    let before = '';
    let after = '';
    let enteredCommit = false;
    const native: AgentTool = {
      name: 'native-scope', label: 'Native scope', description: 'Local official scope fixture',
      parameters: { type: 'object' },
      execute: async callId => {
        expect(() => currentCodingToolInvocation()).toThrow('requires a durable coding tool invocation');
        const scope = currentCodingHostToolApi();
        if (!scope) throw new Error('Official ToolTask has no host API');
        expect(scope.api.callId).toBe(callId);
        expect((await scope.api.getTask(scope.api.taskId, scope.context))?.kind).toBe(ToolTask.definition.name);
        before = manager.appendCustomEntry('before official callback');
        const change = async (tx: Tx) => {
          enteredCommit = true;
          if (currentCodingHostToolApi()?.api.taskId !== scope.api.taskId) {
            throw new Error('Official commit lost the native API scope');
          }
          after = manager.appendCustomEntry('inside official callback');
          (await tx.doc(HostState, conversation.id)).id = after;
          expect(journal.durableId(after)).toBeUndefined();
        };
        if (retry) {
          const refused = new Error('Refuse official transaction');
          await expect(detached.runInAsyncScope(() => scope.api.commit(async tx => {
            await change(tx);
            throw refused;
          }, scope.context))).rejects.toBe(refused);
          expect(journal.durableId(before)).toBeUndefined();
          expect(journal.durableId(after)).toBeUndefined();
          expect(await harness.snapshot(HostState, conversation.id, context)).toBeUndefined();
          await detached.runInAsyncScope(() => scope.api.commit(async tx => {
            (await tx.doc(HostState, conversation.id)).id = after;
          }, scope.context));
        } else {
          await detached.runInAsyncScope(() => scope.api.commit(change, scope.context));
        }
        expect(journal.durableId(before)).toBeDefined();
        expect(journal.durableId(after)).toBeDefined();
        return { content: [{ type: 'text', text: 'official committed' }], details: {} };
      },
    };
    registry.install({
      name: 'test-native-official-scope',
      tools: [agentToolToHost(native, (api, ctx, work) => binding.withHostToolScope(api, ctx, work))],
    });
    const parent = hostToolToAgent({
      name: 'official-parent', description: 'Local official parent', parameters: { type: 'object' },
      execute: async (_args, api, ctx) => {
        const result = await api.executeTool(native.name, {}, ctx, { key: 'official-scope' });
        expect(currentCodingHostToolApi()?.api).toBe(api);
        return { output: [{ type: 'text', text: String(result.isError) }], isError: result.isError };
      },
    });
    try {
      const result = await execute(parent);
      expect(enteredCommit).toBe(true);
      expect(result.isError).toBe(false);
      expect(journal.committedSnapshot().entries.map(entry => entry.id)).toEqual([before, after]);
      expect((await harness.snapshot(HostState, conversation.id, context))?.id).toBe(after);
    } finally {
      detached.emitDestroy();
    }
  });

  test('captured scope restores synchronous and asynchronous appends outside ALS', async () => {
    const detached = new AsyncResource('test.native-journal-resume');
    const { execute, journal, manager, conversation, openJournal } = await toolFixture();
    let first = '';
    let second = '';
    const tool: AgentTool = {
      name: 'resume', label: 'Resume', description: 'Local scope fixture', parameters: { type: 'object' },
      execute: async () => {
        const scope = currentCodingToolInvocation();
        await detached.runInAsyncScope(async () => {
          expect(() => currentCodingToolInvocation()).toThrow('requires a durable coding tool invocation');
          first = scope.runInScope(() => manager.appendCustomEntry('synchronous append'));
          second = await scope.runInScope(async () => {
            await Promise.resolve();
            return manager.appendCustomEntry('asynchronous append');
          });
          await scope.runtime.commit(async tx => {
            await scope.flush(tx);
            return undefined;
          }, scope.context);
        });
        expect(journal.durableId(first)).toBeDefined();
        expect(journal.durableId(second)).toBeDefined();
        return { content: [{ type: 'text', text: 'resumed' }], details: {} };
      },
    };
    try {
      const result = await execute(tool);
      expect(result.result.content).toEqual([{ type: 'text', text: 'resumed' }]);
      expect(result.isError).toBe(false);
      expect(manager.getEntries().map(entry => [entry.id, entry.parentId]))
        .toEqual([[first, null], [second, first]]);
      expect((await conversation.entries({}, 20, undefined, context)).items
        .filter(entry => entry.kind === 'mkagent.coding.entry.v1')).toHaveLength(2);
      expect((await openJournal()).committedSnapshot()).toEqual(journal.committedSnapshot());
    } finally {
      detached.emitDestroy();
    }
  });
});
