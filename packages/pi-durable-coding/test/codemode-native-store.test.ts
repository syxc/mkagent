// Real durable codemode and host APIs, with the native branch as the store owner.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyJson } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import {
  createRegistry, Harness, MemoryStorage, type CommitPublication, type ToolExecutionApi,
} from '@earendil-works/pi-durable';
import {
  createCodemodeTool, type CodemodeStoreAdapter,
} from '@earendil-works/pi-durable/codemode';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { AgentToolResult, StreamFn } from '../src/agent-runtime.ts';
import { currentCodingHostToolApi, DurableLoopBinding } from '../src/durable-coding/engine.ts';
import { executeNativeCodemode } from '../src/compat/codemode-native.ts';
import type { ExtensionToolContext } from '../src/pi/core/extensions/types.ts';
import { NativeSessionJournal } from '../src/durable-coding/session-journal.ts';
import { hostToolToAgent } from '../src/host-tools.ts';
import { readCodemodeStore } from '../src/pi/extensions/codemode/execute.ts';
import { convertToLlm } from '../src/pi/core/messages.ts';
import { getDefaultStreamFn, setDefaultStreamFn } from '../src/stream-fn.ts';

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | void> = [];
let previousStream: StreamFn | undefined;
beforeEach(() => {
  try { previousStream = getDefaultStreamFn(); } catch { previousStream = undefined; }
  setDefaultStreamFn(() => { throw new Error('Unexpected provider request'); });
});
afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const close of cleanups.splice(0).reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
  } finally {
    setDefaultStreamFn(previousStream);
  }
  if (failures.length) throw new AggregateError(failures, 'Store fixture cleanup failed');
});

class ResultRefusingStorage extends MemoryStorage {
  armed = false;
  refusals = 0;
  private readonly runs = new Set<string>();
  override commit(...[batches, receive, ctx]: Parameters<MemoryStorage['commit']>) {
    for (const write of batches.flat()) {
      if (write.type === 'document.create' && write.record.kind === 'pi.codemode.run') this.runs.add(write.record.id);
    }
    if (this.armed && batches.some(batch => batch.some(write =>
      write.type === 'document.change' && this.runs.has(write.id) &&
      JSON.stringify(write.content).includes('"result"')))) {
      this.armed = false;
      this.refusals++;
      return Promise.reject(new Error('refuse stored codemode outcome'));
    }
    return super.commit(batches, receive, ctx);
  }
}

async function fixture(options: {
  append?: boolean; repeat?: boolean; refuse?: boolean; native?: boolean; failResultCommit?: boolean;
} = {}) {
  const registry = createRegistry();
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
  cleanups.push(() => sandbox.close());
  const env = new NodeExecutionEnv({ cwd: '/tmp/codemode-native-store', shellEnv: {} });
  const storage = new ResultRefusingStorage();
  const harness = await Harness.open(storage, {
    registry, models: createModels(), env: () => env,
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, context);
  cleanups.push(() => harness.close(context));
  const conversation = await harness.root(context);
  const journal = await NativeSessionJournal.open({
    harness, conversation, context, cwd: '/tmp/codemode-native-store',
  });
  cleanups.push(() => journal.close());
  const binding = new DurableLoopBinding({ kernel: { harness, conversation, registry }, journal });
  cleanups.push(() => binding.close());
  const receipts: CommitPublication[] = [];
  const observation = harness.observeCommits({ advance: publication => { receipts.push(publication); } });
  cleanups.push(() => observation.detach());
  let reads = 0;
  let writes = 0;
  let call = 0;
  const apiIdentities = new Set<ToolExecutionApi>();
  const store: CodemodeStoreAdapter = {
    read: () => {
      reads++;
      return copyJson(readCodemodeStore(journal.manager.getBranch()));
    },
    write: (_tx, data, api) => {
      writes++;
      apiIdentities.add(api);
      if (options.refuse) throw new Error('refuse native store transaction');
      if (options.append !== false) journal.manager.appendCustomEntry('codemode-store', data);
      if (options.failResultCommit) storage.armed = true;
    },
  };
  const registered = createCodemodeTool({ sandbox, models: false, store });
  const tool = options.native ? {
    name: 'codemode', label: 'Code', description: 'Native codemode through the real journal',
    parameters: registered.parameters,
    execute: async (id: string, args: { code: string }, signal?: AbortSignal) => {
      const run = () => executeNativeCodemode(id, args, signal, undefined, {
        tools: [], sessionManager: { getBranch: () => { reads++; return journal.manager.getBranch(); } },
      } as unknown as ExtensionToolContext, options.append === false ? {} : {
        appendEntry: (kind, data) => {
          writes++;
          apiIdentities.add(currentCodingHostToolApi()!.api);
          if (options.refuse) throw new Error('refuse native store transaction');
          journal.manager.appendCustomEntry(kind, data);
          if (options.failResultCommit) storage.armed = true;
        },
      });
      const result = await run();
      if (options.repeat) expect(await run()).toEqual(result);
      return result;
    },
  } : hostToolToAgent({
    ...registered,
    execute: async (args, api, ctx) => {
      const result = await registered.execute(args, api, ctx);
      if (!options.repeat) return result;
      expect(await registered.execute(args, api, ctx)).toEqual(result);
      return result;
    },
  });
  const assistant: AssistantMessage = {
    role: 'assistant', content: [], api: 'faux', provider: 'local', model: 'fixture',
    stopReason: 'toolUse', timestamp: 1,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const model: Model<'faux'> = {
    id: 'fixture', name: 'Fixture', api: 'faux', provider: 'local', baseUrl: '',
    reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const run = async (code: string) => {
    const toolCall = { type: 'toolCall' as const, id: `store-${++call}`, name: tool.name, arguments: { code } };
    let requests = 0;
    let outcome: { result: AgentToolResult<unknown>; isError: boolean } | undefined;
    await binding.run([{ role: 'user', content: 'Run the local script', timestamp: 1 }],
      { messages: [], tools: [tool] }, { model, convertToLlm }, async event => {
        if (event.type === 'tool_execution_end' && event.toolName === tool.name)
          outcome = { result: event.result, isError: event.isError };
      }, undefined, () => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = ++requests === 1
          ? { ...assistant, content: [toolCall] }
          : { ...assistant, content: [{ type: 'text', text: 'done' }], stopReason: 'stop' };
        queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason, message }));
        return stream;
      });
    if (!outcome) throw new Error('The model run did not execute codemode');
    return outcome;
  };
  const values = () => readCodemodeStore(journal.manager.getBranch());
  const select = (leaf: string) => journal.phase(async () => {
    journal.manager.branch(leaf);
    await conversation.commit(tx => journal.commit(tx), context);
  });
  const counters = () => ({ reads, writes, apis: apiIdentities.size });
  return { run, journal, conversation, receipts, counters, values, select, storage };
}

function text(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['run']>>) {
  return result.result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
}

function resultReceipt(receipt: CommitPublication) {
  return receipt.changes.some(change => change.type === 'document' && change.kind === 'change'
    && change.record.kind === 'pi.codemode.run' && change.value.result !== undefined);
}

describe.each([false, true])('native journal with the Native SDK executor: %s', native => {
  const open = (options: Parameters<typeof fixture>[0] = {}) => fixture({ ...options, native });
  test('keeps raw no-op writes and commits the native entry with run.result', async () => {
    const opened = await open();
    opened.journal.manager.appendCustomEntry('codemode-store', { set: { kept: 1 }, delete: [] });
    await opened.journal.flush();
    const outcome = await opened.run('store("kept", 1); store("missing", undefined); return load("kept");');
    expect(outcome.isError).toBe(false);
    expect(text(outcome)).toContain('1');
    const entries = opened.journal.committedSnapshot().entries;
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      type: 'custom', customType: 'codemode-store', data: { set: { kept: 1 }, delete: ['missing'] },
    });
    expect(opened.counters()).toEqual({ reads: 1, writes: 1, apis: 1 });
    const receipts = opened.receipts.filter(resultReceipt);
    expect(receipts).toHaveLength(1);
    const id = opened.journal.durableId(entries[1]!.id);
    expect(receipts[0]!.changes.some(change => change.type === 'entry' && change.value.id === id)).toBe(true);
    expect(opened.receipts.some(receipt => receipt.changes.some(change =>
      change.type === 'document' && change.record.kind === 'pi.codemode.store'))).toBe(false);
  }, 10_000);

  test('reads each invocation from the selected native branch', async () => {
    const opened = await open();
    const root = opened.journal.manager.appendCustomEntry('codemode-store', { set: { shared: 'root' }, delete: [] });
    await opened.journal.flush();
    expect((await opened.run('store("path", "left");')).isError).toBe(false);
    const left = opened.journal.manager.getLeafId()!;
    await opened.select(root);
    expect(text(await opened.run('return [load("shared"), load("path")];'))).toContain('["root",null]');
    expect((await opened.run('store("path", "right");')).isError).toBe(false);
    expect(opened.values()).toEqual({ shared: 'root', path: 'right' });
    await opened.select(left);
    expect(text(await opened.run('return load("path");'))).toContain('left');
    expect(opened.values()).toEqual({ shared: 'root', path: 'left' });
  }, 10_000);

  test('without append support writes do not survive into the next call', async () => {
    const opened = await open({ append: false });
    expect((await opened.run('store("ephemeral", 7); return load("ephemeral");')).isError).toBe(false);
    const next = await opened.run('return load("ephemeral");');
    expect(next.isError).toBe(false);
    expect(next.result.content).toHaveLength(1);
    expect(opened.values()).toEqual({});
    expect(opened.journal.committedSnapshot().entries).toEqual([]);
    expect(opened.counters()).toEqual({ reads: 2, writes: native ? 0 : 1, apis: native ? 0 : 1 });
  }, 10_000);

  test('a repeated completed invocation returns the stored result without another read or write', async () => {
    const opened = await open({ repeat: true });
    const outcome = await opened.run('store("once", 1); return "done";');
    expect(outcome.isError).toBe(false);
    expect(text(outcome)).toContain('done');
    expect(opened.counters()).toEqual({ reads: 1, writes: 1, apis: 1 });
    expect(opened.journal.committedSnapshot().entries).toHaveLength(1);
    expect(opened.receipts.filter(resultReceipt)).toHaveLength(1);
  }, 10_000);

  test('a failed script retains partial output and does not write the store', async () => {
    const opened = await open();
    const outcome = await opened.run('store("discarded", 1); text("partial"); throw new Error("script failed");');
    expect(outcome.isError).toBe(true);
    expect(text(outcome)).toContain('partial');
    expect(text(outcome)).toContain('script failed');
    expect(opened.counters()).toEqual({ reads: 1, writes: 0, apis: 0 });
    expect(opened.journal.committedSnapshot().entries).toEqual([]);
    expect(opened.receipts.filter(resultReceipt)).toHaveLength(1);
  }, 10_000);

  test('a refused store transaction does not publish run.result', async () => {
    const opened = await open({ refuse: true });
    const outcome = await opened.run('store("refused", 1); return "must not commit";');
    expect(outcome.isError).toBe(true);
    expect(opened.counters()).toEqual({ reads: 1, writes: 1, apis: 1 });
    expect(opened.journal.committedSnapshot().entries).toEqual([]);
    expect(opened.receipts.filter(resultReceipt)).toEqual([]);
  }, 10_000);

  test('a storage refusal after append publishes neither Native state nor run.result', async () => {
    const opened = await open({ failResultCommit: true });
    await expect(opened.run('store("uncommitted",1); return "must not publish";'))
      .rejects.toThrow('Session failed after a storage error');
    expect(opened.storage.refusals).toBe(1);
    expect(opened.values()).toEqual({});
    expect(opened.journal.committedSnapshot().entries).toEqual([]);
    expect(opened.receipts.filter(resultReceipt)).toEqual([]);
  }, 10_000);
});
