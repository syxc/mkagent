import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type AssistantMessage, type Usage } from '@earendil-works/pi-ai';
import {
  createRegistry, defineDoc, defineExtension, Harness, MemoryStorage,
  type CommitResult, type Seq, type Storage, type StorageWrite,
} from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import type { AgentEvent, AgentTool, AgentToolResult } from '../src/agent-runtime.ts';
import {
  createCodingToolTask, type CodingToolInvocation, type CodingToolTaskBindings,
  type CodingToolTaskCheckpoint, type CodingToolTaskInput, type CodingToolTaskResult,
} from '../src/durable-coding/tool-task.ts';

const context = BACKGROUND_CONTEXT;
const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close(context)));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function gate<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function untilAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) throw new Error('Expected runtime signal');
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

const usage: Usage = {
  input: 7, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 14,
  cost: { input: 0.07, output: 0.04, cacheRead: 0.02, cacheWrite: 0.01, total: 0.14 },
};

function input(id = 'call-1'): CodingToolTaskInput {
  const toolCall = { type: 'toolCall' as const, id, name: 'fixture', arguments: { raw: 'original' } };
  const assistantMessage: AssistantMessage = {
    role: 'assistant', content: [toolCall], api: 'faux', provider: 'local', model: 'fixture',
    stopReason: 'toolUse', timestamp: 1, usage,
  };
  return { assistantMessage, toolCall, args: { prepared: true } };
}

function tool(execute: AgentTool['execute'], other: Partial<AgentTool> = {}): AgentTool {
  return {
    name: 'fixture', label: 'Fixture', description: 'Local deterministic fixture',
    parameters: { type: 'object' }, execute, ...other,
  };
}

function textResult(text: string): AgentToolResult {
  return { content: [{ type: 'text', text }], details: {} };
}

const JournalDoc = defineDoc({
  kind: 'test.native-tool-journal', version: 1, scope: 'session',
  initial: () => ({ entries: [] as string[] }), checkpointWhen: () => true,
});

class RecordingStorage extends MemoryStorage {
  readonly batches: Array<readonly StorageWrite[]> = [];

  override commit(
    batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, context: Context,
  ): Promise<CommitResult> {
    return super.commit(batches, (index, seq) => {
      this.batches.push(batches[index]);
      receive(index, seq);
    }, context);
  }
}

async function open(
  target: AgentTool, options: Partial<CodingToolTaskBindings> = {}, storage: Storage = new MemoryStorage(),
  initial?: CodingToolTaskCheckpoint,
) {
  const events: AgentEvent[] = [];
  const bindings: CodingToolTaskBindings = {
    getTool: name => name === target.name ? target : undefined,
    context: () => ({ messages: [], tools: [target] }),
    emit: async event => { events.push(event); },
    ...options,
  };
  const defined = createCodingToolTask(() => bindings);
  const ToolTask = initial ? { definition: { ...defined.definition, initial: () => initial } } : defined;
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'native-tool-task-test', tasks: [ToolTask] }));
  const harness = await Harness.open(storage, {
    registry, models: createModels(), settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, context);
  harnesses.push(harness);
  const conversation = await harness.root(context);
  const start = (value = input()) => conversation.commit(
    tx => tx.createTask(ToolTask, value, { ownership: { kind: 'conversation' } }), context,
  );
  return { ToolTask, harness, conversation, start, events, bindings };
}

function completed(receipt: Awaited<ReturnType<Harness['waitForTask']>>): CodingToolTaskResult {
  expect(receipt.state.outcome.status).toBe('completed');
  if (receipt.state.outcome.status !== 'completed') throw new Error(JSON.stringify(receipt.state.outcome));
  return receipt.state.outcome.result as CodingToolTaskResult;
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'durable-coding-tool-'));
  directories.push(path);
  return path;
}

describe('durable native tool task', () => {
  test('persists complete native output and leaves all transcript delivery to its parent', async () => {
    const result: AgentToolResult = {
      content: [
        { type: 'text', text: 'display output' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
      details: { nested: { value: [1, 'two', false] } },
      structuredContent: { value: 42 }, isError: false, usage, terminate: true,
    };
    let receivedSignal: AbortSignal | undefined;
    const opened = await open(tool(async (id, args, signal) => {
      expect(id).toBe('call-1');
      expect(args).toEqual({ prepared: true });
      receivedSignal = signal;
      return result;
    }, { outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } }));
    expect(opened.ToolTask.definition.name).toBe('pi.coding.tool');
    expect(opened.ToolTask.definition.version).toBe(1);
    const before = await opened.conversation.entries({}, 100, undefined, context);
    const id = await opened.start();
    opened.harness.resume();
    const outcome = completed(await opened.harness.waitForTask(id, context));
    expect(outcome.result).toEqual(result);
    expect(outcome.isError).toBe(false);
    expect(outcome.durationMs).toBeNumber();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(opened.events).toEqual([{
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'fixture',
      result, isError: false, durationMs: outcome.durationMs,
    }]);
    expect(await opened.conversation.entries({}, 100, undefined, context)).toEqual(before);
  });

  test('serializes every progress delivery, joins slow listeners, and ignores late updates', async () => {
    const delivering = gate();
    const release = gate();
    const executed = gate();
    const order: string[] = [];
    let lateUpdate: Parameters<AgentTool['execute']>[3];
    const opened = await open(tool(async (_id, _args, _signal, update) => {
      lateUpdate = update;
      update?.(textResult('one'));
      update?.(textResult('two'));
      executed.resolve();
      return textResult('done');
    }), {
      emit: async event => {
        if (event.type === 'tool_execution_update') {
          const value = event.partialResult.content[0].text as string;
          order.push(`start:${value}`);
          if (value === 'one') { delivering.resolve(); await release.promise; }
          order.push(`end:${value}`);
        } else order.push(event.type);
      },
    });
    const id = await opened.start();
    opened.harness.resume();
    await Promise.all([delivering.promise, executed.promise]);
    expect(order).toEqual(['start:one']);
    lateUpdate?.(textResult('late'));
    release.resolve();
    expect(completed(await opened.harness.waitForTask(id, context)).isError).toBe(false);
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two', 'tool_execution_end']);
  });

  test('closes progress callbacks when execute settles even while invocation scope cleanup runs', async () => {
    let updateAfterExecute: Parameters<AgentTool['execute']>[3];
    const opened = await open(tool(async (_id, _args, _signal, update) => {
      updateAfterExecute = update;
      update?.(textResult('during execute'));
      return textResult('done');
    }), {
      withInvocation: async (_invocation, run) => {
        const result = await run();
        updateAfterExecute?.(textResult('during scope cleanup'));
        return result;
      },
    });
    const id = await opened.start();
    opened.harness.resume();
    completed(await opened.harness.waitForTask(id, context));
    expect(opened.events.map(event => event.type)).toEqual(['tool_execution_update', 'tool_execution_end']);
  });

  test('applies native after-hook replacement and drops structure when only content changes', async () => {
    const original: AgentToolResult = {
      ...textResult('original'), details: { preserve: true }, structuredContent: { value: 42 },
      usage, terminate: true, isError: true,
    };
    const opened = await open(tool(async () => original), {
      afterToolCall: async (call, signal) => {
        expect(call.result).toEqual(original);
        expect(call.args).toEqual({ prepared: true });
        expect(call.toolCall.arguments).toEqual({ raw: 'original' });
        expect(call.isError).toBe(true);
        expect(call.context.tools?.[0].name).toBe('fixture');
        expect(signal).toBeInstanceOf(AbortSignal);
        return { content: [{ type: 'text', text: 'replacement' }], isError: false, terminate: false };
      },
    });
    const id = await opened.start();
    opened.harness.resume();
    const outcome = completed(await opened.harness.waitForTask(id, context));
    expect(outcome.result).toEqual({
      content: [{ type: 'text', text: 'replacement' }], details: { preserve: true },
      usage, terminate: false, isError: true,
    });
    expect(outcome.isError).toBe(false);
    expect('structuredContent' in outcome.result).toBe(false);
  });

  test('replaces explicitly supplied fields in full and preserves structure with explicit content', async () => {
    const replacementUsage = { ...usage, output: 2 };
    const opened = await open(tool(async () => ({
      ...textResult('original'), details: { old: true }, structuredContent: { old: true }, usage,
    })), {
      afterToolCall: async () => ({
        content: [], details: { replacement: true }, structuredContent: { replacement: true },
        usage: replacementUsage, isError: true, terminate: true,
      }),
    });
    const id = await opened.start();
    opened.harness.resume();
    expect(completed(await opened.harness.waitForTask(id, context))).toMatchObject({
      isError: true,
      result: {
        content: [], details: { replacement: true }, structuredContent: { replacement: true },
        usage: replacementUsage, terminate: true,
      },
    });
  });

  test('turns tool and after-hook exceptions into error results with end events', async () => {
    for (const stage of ['execute', 'after'] as const) {
      const opened = await open(tool(async () => {
        if (stage === 'execute') throw new Error('execute failed');
        return textResult('ok');
      }), {
        ...(stage === 'after' ? { afterToolCall: async () => { throw new Error('after failed'); } } : {}),
      });
      const id = await opened.start();
      opened.harness.resume();
      const outcome = completed(await opened.harness.waitForTask(id, context));
      expect(outcome.isError).toBe(true);
      expect(outcome.result.content).toEqual([{ type: 'text', text: `${stage} failed` }]);
      expect(opened.events.at(-1)).toMatchObject({ type: 'tool_execution_end', isError: true });
    }
  });

  test('preserves explicit error output and all its metadata', async () => {
    const result: AgentToolResult = {
      ...textResult('native failure'), details: { exitCode: 2 },
      structuredContent: { diagnostic: 'failed' }, isError: true, usage, terminate: true,
    };
    const opened = await open(tool(async () => result));
    const id = await opened.start();
    opened.harness.resume();
    const outcome = completed(await opened.harness.waitForTask(id, context));
    expect(outcome.result).toEqual(result);
    expect(outcome.isError).toBe(true);
  });

  test('declared output schemas do not add validation policy to native tool execution', async () => {
    for (const structuredContent of [undefined, { date: 'not-a-date' }, { date: 7 }, null]) {
      const result: AgentToolResult = {
        ...textResult('display output'), details: { metadata: true }, usage,
        ...(structuredContent === undefined ? {} : { structuredContent }),
      };
      const opened = await open(tool(async () => result, {
        outputSchema: {
          type: 'object', properties: { date: { type: 'string', format: 'date' } }, required: ['date'],
        },
      }));
      const id = await opened.start();
      opened.harness.resume();
      const outcome = completed(await opened.harness.waitForTask(id, context));
      expect(outcome.isError).toBe(false);
      expect(outcome.result).toEqual(result);
    }
  });

  test('critical delivery failures fail the task after cleanup and retain the native output', async () => {
    for (const failedEvent of ['tool_execution_update', 'tool_execution_end']) {
      let cleaned = false;
      const opened = await open(tool(async (_id, _args, _signal, update) => {
        update?.(textResult('progress'));
        await Promise.resolve();
        cleaned = true;
        return textResult('done');
      }), {
        emit: async event => {
          if (event.type === failedEvent) throw new Error('event sink failed');
        },
      });
      const id = await opened.start();
      opened.harness.resume();
      expect((await opened.harness.waitForTask(id, context)).state.outcome).toMatchObject({
        status: 'failed', error: { message: 'event sink failed' }, result: { result: textResult('done') },
      });
      expect(cleaned).toBe(true);
    }
  });

  test('abort waits for tool cleanup and pending progress before committing its native error receipt', async () => {
    const entered = gate();
    const cleaning = gate();
    const releaseCleanup = gate();
    const delivering = gate();
    const releaseDelivery = gate();
    let cleaned = false;
    const events: string[] = [];
    const opened = await open(tool(async (_id, _args, signal, update) => {
      update?.(textResult('progress'));
      entered.resolve();
      try { await untilAbort(signal); }
      finally {
        cleaning.resolve();
        await releaseCleanup.promise;
        cleaned = true;
      }
      return textResult('unreachable');
    }), {
      emit: async event => {
        if (event.type === 'tool_execution_update') {
          delivering.resolve();
          await releaseDelivery.promise;
        }
        events.push(event.type);
      },
    });
    const id = await opened.start();
    opened.harness.resume();
    await Promise.all([entered.promise, delivering.promise]);
    let abortSettled = false;
    const aborting = opened.harness.abortTask(id, context).then(() => { abortSettled = true; });
    await cleaning.promise;
    expect(abortSettled).toBe(false);
    releaseCleanup.resolve();
    await Promise.resolve();
    expect(abortSettled).toBe(false);
    releaseDelivery.resolve();
    await aborting;
    expect(cleaned).toBe(true);
    const receipt = await opened.harness.waitForTask(id, context);
    expect(receipt.state.outcome).toMatchObject({
      status: 'aborted', result: { isError: true, result: { content: [{ type: 'text', text: expect.stringContaining('abort') }] } },
    });
    expect(events).toEqual(['tool_execution_update', 'tool_execution_end']);
  });

  test('runs cancellation finalization once and preserves the after-hook decision in its abort receipt', async () => {
    const entered = gate();
    let finalized = 0;
    const opened = await open(tool(async (_id, _args, signal) => {
      entered.resolve();
      await untilAbort(signal);
      return textResult('unreachable');
    }), {
      afterToolCall: async call => {
        finalized++;
        expect(call.isError).toBe(true);
        return { details: { cancelled: true }, terminate: true };
      },
    });
    const id = await opened.start();
    opened.harness.resume();
    await entered.promise;
    await opened.harness.abortTask(id, context);
    const receipt = await opened.harness.waitForTask(id, context);
    expect(receipt.state.outcome).toMatchObject({
      status: 'aborted', result: { isError: true, result: { details: { cancelled: true }, terminate: true } },
    });
    expect(finalized).toBe(1);
  });

  test('retains a native result returned during cancellation cleanup, including its usage', async () => {
    const entered = gate();
    const result: AgentToolResult = {
      ...textResult('cancelled with partial result'), details: { cleaned: true },
      structuredContent: { partial: true }, usage, isError: true, terminate: true,
    };
    const opened = await open(tool(async (_id, _args, signal) => {
      entered.resolve();
      try { await untilAbort(signal); } catch {}
      return result;
    }), {
      afterToolCall: async call => { expect(call.result).toEqual(result); return undefined; },
    });
    const id = await opened.start();
    opened.harness.resume();
    await entered.promise;
    await opened.harness.abortTask(id, context);
    expect((await opened.harness.waitForTask(id, context)).state.outcome).toMatchObject({
      status: 'aborted', result: { result, isError: true },
    });
  });

  test('parallel children emit end events in completion order', async () => {
    const first = gate();
    const firstStarted = gate();
    const opened = await open(tool(async id => {
      if (id === 'first') { firstStarted.resolve(); await first.promise; }
      return textResult(id);
    }));
    const firstId = await opened.start(input('first'));
    const secondId = await opened.start(input('second'));
    opened.harness.resume();
    await firstStarted.promise;
    await opened.harness.waitForTask(secondId, context);
    first.resolve();
    await opened.harness.waitForTask(firstId, context);
    expect(opened.events.filter(event => event.type === 'tool_execution_end').map(event => event.toolCallId)).toEqual(['second', 'first']);
  });

  test('restores an uncertain unsafe effect without executing the mutation again', async () => {
    const path = await directory();
    const entered = gate();
    let effects = 0;
    const target = tool(async (_id, _args, signal) => {
      effects++;
      entered.resolve();
      await untilAbort(signal);
      return textResult('unreachable');
    });
    const first = await open(target, {}, await openNodeJsonlStorage(path, context));
    const id = await first.start();
    first.harness.resume();
    await entered.promise;
    expect((await first.harness.getTask(id, context))?.state).toMatchObject({
      status: 'running', checkpoint: { phase: 'execute', replay: 'never' },
    });
    await first.harness.close(context);
    const second = await open(target, {}, await openNodeJsonlStorage(path, context));
    second.harness.resume();
    const outcome = completed(await second.harness.waitForTask(id, context));
    expect(effects).toBe(1);
    expect(outcome.isError).toBe(true);
    expect(outcome.result.content).toEqual([{
      type: 'text', text: 'Tool fixture was interrupted and may have partially run; it was not executed again',
    }]);
  });

  test('reruns only effects declared safe in both the stored intent and the current binding', async () => {
    for (const currentReplay of ['safe', 'never'] as const) {
      const path = await directory();
      const entered = gate();
      let calls = 0;
      const target = tool(async (_id, _args, signal) => {
        calls++;
        if (calls === 1) { entered.resolve(); await untilAbort(signal); }
        return { ...textResult('safe result'), structuredContent: { calls } };
      }, { replay: 'safe' });
      const first = await open(target, {}, await openNodeJsonlStorage(path, context));
      const id = await first.start();
      first.harness.resume();
      await entered.promise;
      await first.harness.close(context);
      target.replay = currentReplay;
      const second = await open(target, {}, await openNodeJsonlStorage(path, context));
      second.harness.resume();
      const outcome = completed(await second.harness.waitForTask(id, context));
      expect(calls).toBe(currentReplay === 'safe' ? 2 : 1);
      expect(outcome.isError).toBe(currentReplay !== 'safe');
    }
  });

  test('checkpoints raw results before an after-hook and never replays an interrupted hook', async () => {
    const path = await directory();
    const entered = gate();
    let calls = 0;
    let hooks = 0;
    const target = tool(async () => {
      calls++;
      return { ...textResult('actual effect result'), structuredContent: { effect: true }, usage };
    });
    const afterToolCall: CodingToolTaskBindings['afterToolCall'] = async (_call, signal) => {
      hooks++;
      entered.resolve();
      await untilAbort(signal);
      return { terminate: true };
    };
    const first = await open(target, { afterToolCall }, await openNodeJsonlStorage(path, context));
    const id = await first.start();
    first.harness.resume();
    await entered.promise;
    expect((await first.harness.getTask(id, context))?.state).toMatchObject({
      status: 'running', checkpoint: { phase: 'after', outcome: { result: { structuredContent: { effect: true }, usage } } },
    });
    await first.harness.close(context);
    const second = await open(target, { afterToolCall }, await openNodeJsonlStorage(path, context));
    second.harness.resume();
    const outcome = completed(await second.harness.waitForTask(id, context));
    expect(calls).toBe(1);
    expect(hooks).toBe(1);
    expect(outcome.isError).toBe(true);
    expect(outcome.result.content).toEqual([{
      type: 'text', text: 'afterToolCall for fixture was interrupted; the hook was not invoked again',
    }]);
  });

  test('restores complete finalized output and reports uncertain end delivery without repeating hooks or effects', async () => {
    const path = await directory();
    const delivering = gate();
    let effectCalls = 0;
    let hookCalls = 0;
    let deliveryCalls = 0;
    let signal: AbortSignal | undefined;
    const target = tool(async () => {
      effectCalls++;
      return { ...textResult('native text'), details: { effectCalls }, structuredContent: { value: 1 }, usage };
    });
    const afterToolCall: CodingToolTaskBindings['afterToolCall'] = async () => {
      hookCalls++;
      return { details: { finalized: true }, terminate: true };
    };
    const first = await open(target, {
      afterToolCall,
      withInvocation: async (invocation, run) => { signal = invocation.runtime.signal; return run(); },
      emit: async event => {
        if (event.type === 'tool_execution_end') {
          deliveryCalls++;
          delivering.resolve();
          await untilAbort(signal);
        }
      },
    }, await openNodeJsonlStorage(path, context));
    const id = await first.start();
    first.harness.resume();
    await delivering.promise;
    await first.harness.close(context);
    const second = await open(target, {
      afterToolCall, emit: async () => { deliveryCalls++; },
    }, await openNodeJsonlStorage(path, context));
    second.harness.resume();
    const receipt = await second.harness.waitForTask(id, context);
    expect(receipt.state.outcome).toMatchObject({
      status: 'failed',
      error: { message: 'tool_execution_end delivery for fixture was interrupted; delivery is uncertain' },
      result: {
        result: {
          content: [{ type: 'text', text: 'native text' }], details: { finalized: true },
          structuredContent: { value: 1 }, usage, terminate: true,
        },
      },
    });
    expect([effectCalls, hookCalls, deliveryCalls]).toEqual([1, 1, 1]);
  });

  test('supplies one nonnested scope per whole phase, including awaited listeners and commits', async () => {
    const phases: string[] = [];
    const deliveredScope = gate();
    let scoped = false;
    const opened = await open(tool(async () => {
      expect(scoped).toBe(true);
      return textResult('scoped');
    }), {
      afterToolCall: async () => { expect(scoped).toBe(true); return undefined; },
      emit: async () => { await Promise.resolve(); expect(scoped).toBe(true); },
      commit: async () => { expect(scoped).toBe(true); },
      withInvocation: async (invocation, run) => {
        expect(scoped).toBe(false);
        expect(invocation.runtime.signal).toBeInstanceOf(AbortSignal);
        expect(invocation.input.toolCall.id).toBe('call-1');
        const state = (await invocation.runtime.getTask(invocation.runtime.taskId, invocation.context))!.state;
        expect(state.status).toBe('running');
        const phase = state.status === 'running' ? (state.checkpoint as { phase: string }).phase : '';
        phases.push(phase);
        scoped = true;
        try { return await run(); } finally {
          scoped = false;
          if (phase === 'deliver') deliveredScope.resolve();
        }
      },
    });
    const id = await opened.start();
    opened.harness.resume();
    expect(completed(await opened.harness.waitForTask(id, context)).isError).toBe(false);
    await deliveredScope.promise;
    expect(phases).toEqual(['call', 'finalize', 'deliver']);
    expect(scoped).toBe(false);
  });

  test('commits listener metadata and native outcomes in the same durable transaction', async () => {
    const scope = new AsyncLocalStorage<{ invocation: CodingToolInvocation; staged: string[] }>();
    const storage = new RecordingStorage();
    let commitCalls = 0;
    const opened = await open(tool(async (_id, _args, _signal, update) => {
      expect(scope.getStore()).toBeDefined();
      update?.(textResult('progress'));
      return textResult('done');
    }), {
      withInvocation: async (invocation, run) => {
        expect(scope.getStore()).toBeUndefined();
        return scope.run({ invocation, staged: [] }, run);
      },
      afterToolCall: async () => {
        await Promise.resolve();
        scope.getStore()!.staged.push('after');
        return { terminate: true };
      },
      emit: async event => {
        await Promise.resolve();
        scope.getStore()!.staged.push(event.type);
      },
      commit: async tx => {
        commitCalls++;
        const staged = scope.getStore()!.staged;
        if (staged.length === 0) return;
        const journal = await tx.doc(JournalDoc);
        journal.entries.push(...staged);
        staged.length = 0;
      },
    }, storage);
    const id = await opened.start();
    opened.harness.resume();
    const outcome = completed(await opened.harness.waitForTask(id, context));
    expect(outcome.result.terminate).toBe(true);
    expect(commitCalls).toBe(6);
    expect(await opened.harness.snapshot(JournalDoc, context)).toEqual({
      entries: ['tool_execution_update', 'after', 'tool_execution_end'],
    });
    const journalBatches = storage.batches.filter(batch => batch.some(write =>
      write.type === 'document.create' && write.record.kind === JournalDoc.definition.kind
      || write.type === 'document.change' && write.content.kind === 'base'
        && 'entries' in write.content.value,
    ));
    expect(journalBatches).toHaveLength(3);
    const boundaries = journalBatches.map(batch => {
      const task = batch.find(write => write.type === 'task' && String(write.value.id) === String(id));
      if (!task || task.type !== 'task') throw new Error('Journal write has no atomic task update');
      const state = task.value.state;
      return state.status === 'running' ? (state.checkpoint as { phase: string }).phase : state.status;
    });
    expect(boundaries).toEqual(['finalize', 'deliver', 'terminal']);
    expect(scope.getStore()).toBeUndefined();
  });

  test('rejects failing commit ports before effects, after hooks, and after end listeners', async () => {
    for (const failAt of ['intent', 'after-hook', 'receipt']) {
      let hookCalls = 0;
      let endCalls = 0;
      let toolCalls = 0;
      const opened = await open(tool(async () => { toolCalls++; return textResult('done'); }), {
        afterToolCall: async () => { hookCalls++; return { terminate: true }; },
        emit: async event => { if (event.type === 'tool_execution_end') endCalls++; },
        commit: async tx => {
          if (failAt === 'intent' || failAt === 'after-hook' && hookCalls > 0 || failAt === 'receipt' && endCalls > 0) {
            const journal = await tx.doc(JournalDoc);
            journal.entries.push('must roll back');
            throw new Error(`commit failed at ${failAt}`);
          }
        },
      });
      const id = await opened.start();
      opened.harness.resume();
      expect((await opened.harness.waitForTask(id, context)).state.outcome).toEqual({
        status: 'faulted', error: { message: `commit failed at ${failAt}` },
      });
      expect(toolCalls).toBe(failAt === 'intent' ? 0 : 1);
      expect(hookCalls).toBe(failAt === 'intent' ? 0 : 1);
      expect(await opened.harness.snapshot(JournalDoc, context)).toBeUndefined();
    }
  });

  test('scopes every recovery phase and resolves asynchronous per-call bindings', async () => {
    const outcome: CodingToolTaskResult = { toolCall: input().toolCall, result: textResult('saved'), isError: false };
    const checkpoints: CodingToolTaskCheckpoint[] = [
      { phase: 'execute', replay: 'safe' },
      { phase: 'finalize', outcome }, { phase: 'after', outcome }, { phase: 'deliver', outcome }, { phase: 'emit', outcome },
    ];
    for (const initial of checkpoints) {
      const scope = new AsyncLocalStorage<CodingToolInvocation>();
      const phases: string[] = [];
      const target = tool(async () => {
        expect(scope.getStore()?.input.toolCall.id).toBe('call-1');
        return textResult('replayed safely');
      }, { replay: 'safe' });
      const opened = await open(target, {
        getTool: name => {
          expect(scope.getStore()).toBeDefined();
          return name === target.name ? target : undefined;
        },
        emit: async () => { await Promise.resolve(); expect(scope.getStore()).toBeDefined(); },
        commit: async () => { expect(scope.getStore()).toBeDefined(); },
        withInvocation: async (invocation, run) => {
          expect(scope.getStore()).toBeUndefined();
          const state = (await invocation.runtime.getTask(invocation.runtime.taskId, invocation.context))!.state;
          if (state.status === 'running') phases.push((state.checkpoint as { phase: string }).phase);
          return scope.run(invocation, run);
        },
      }, new MemoryStorage(), initial);
      const id = await opened.start();
      opened.harness.resume();
      const receipt = await opened.harness.waitForTask(id, context);
      expect(phases[0]).toBe(initial.phase);
      expect(receipt.state.outcome.status).toBe(initial.phase === 'emit' ? 'failed' : 'completed');
      expect(scope.getStore()).toBeUndefined();
    }

    const calls: string[] = [];
    const resolved = createCodingToolTask(async (_conversationId, value) => {
      await Promise.resolve();
      calls.push(value.toolCall.id);
      return {
        getTool: () => tool(async () => textResult(value.toolCall.id)),
        context: () => ({ messages: [] }), emit: async () => {},
      };
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'per-call-bindings', tasks: [resolved] }));
    const harness = await Harness.open(new MemoryStorage(), { registry, models: createModels() }, context);
    harnesses.push(harness);
    const root = await harness.root(context);
    const id = await root.commit(tx => tx.createTask(resolved, input('override'), { ownership: { kind: 'conversation' } }), context);
    harness.resume();
    expect(completed(await harness.waitForTask(id, context)).result.content).toEqual([{ type: 'text', text: 'override' }]);
    expect(calls).toEqual(['override', 'override', 'override']);
  });

  test('keeps abort cleanup and listeners scoped and releases the cancelled invocation', async () => {
    const scope = new AsyncLocalStorage<CodingToolInvocation>();
    const entered = gate();
    const abortedScope = gate();
    const phases: string[] = [];
    let activeScopes = 0;
    const opened = await open(tool(async (id, _args, signal, update) => {
      expect(scope.getStore()?.input.toolCall.id).toBe(id);
      if (id === 'first') {
        update?.(textResult('progress'));
        entered.resolve();
        try { await untilAbort(signal); } catch {}
        expect(scope.getStore()?.input.toolCall.id).toBe('first');
      }
      return textResult(id);
    }), {
      withInvocation: async (invocation, run) => {
        expect(scope.getStore()).toBeUndefined();
        const current = await invocation.runtime.getTask(invocation.runtime.taskId, invocation.context);
        phases.push(current?.abortRequested ? 'abort' : 'run');
        activeScopes++;
        try { return await scope.run(invocation, run); } finally {
          activeScopes--;
          if (current?.abortRequested) abortedScope.resolve();
        }
      },
      afterToolCall: async () => { expect(scope.getStore()).toBeDefined(); return undefined; },
      emit: async () => { await Promise.resolve(); expect(scope.getStore()).toBeDefined(); },
      commit: async () => { expect(scope.getStore()).toBeDefined(); },
    });
    const firstId = await opened.start(input('first'));
    opened.harness.resume();
    await entered.promise;
    await opened.harness.abortTask(firstId, context);
    expect((await opened.harness.waitForTask(firstId, context)).state.outcome.status).toBe('aborted');
    await abortedScope.promise;
    expect(activeScopes).toBe(0);
    expect(phases).toEqual(['run', 'abort']);
    const secondId = await opened.start(input('second'));
    expect(completed(await opened.harness.waitForTask(secondId, context)).result.content).toEqual([{ type: 'text', text: 'second' }]);
    await opened.harness.close(context);
    expect(activeScopes).toBe(0);
    expect(scope.getStore()).toBeUndefined();
  });
});
