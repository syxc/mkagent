// Real host wrappers and real durable task ownership, without providers or credentials.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type AssistantMessage, type Usage } from '@earendil-works/pi-ai';
import {
  createRegistry, defineDoc, defineExtension, defineTask, Harness, LiveDoc, MemoryStorage,
  NestedCallDoc, ToolTask, UsageDoc, type Report, type ToolExecutionApi, type ToolRegistration,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import type { AgentTool, AgentToolResult, StreamFn } from '../src/agent-runtime.ts';
import { currentCodingToolInvocation, DurableLoopBinding } from '../src/durable-coding/engine.ts';
import { runToolCall } from '../src/durable-loop.ts';
import { agentToolToHost, hostToolToAgent, wrapAgentTool } from '../src/host-tools.ts';
import { wrapToolForKernel, type ToolWrapDeps } from '../../pi-agent-server/src/tools/wrap.ts';
import { BackgroundShells } from '../../pi-agent-server/src/background-shell.ts';
import { getDefaultStreamFn, setDefaultStreamFn } from '../src/stream-fn.ts';
import { createCodingToolTask, type CodingToolTaskCheckpoint } from '../src/durable-coding/tool-task.ts';

const context = BACKGROUND_CONTEXT;
const harnesses: Harness[] = [];
const bindings: DurableLoopBinding[] = [];
const directories: string[] = [];
let previousStream: StreamFn | undefined;
beforeEach(() => {
  try { previousStream = getDefaultStreamFn(); } catch { previousStream = undefined; }
  setDefaultStreamFn(() => { throw new Error('Unexpected provider request'); });
});
afterEach(async () => {
  await Promise.all(bindings.splice(0).map(binding => binding.close()));
  await Promise.all(harnesses.splice(0).map(harness => harness.close(context)));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  setDefaultStreamFn(previousStream);
});

const usage: Usage = {
  input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
  cost: { input: 0.03, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.05 },
};
const assistant: AssistantMessage = {
  role: 'assistant', content: [], api: 'faux', provider: 'local', model: 'fixture',
  stopReason: 'toolUse', timestamp: 1, usage,
};
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] };
const fullResult: AgentToolResult = {
  content: [{ type: 'text', text: 'original' }, { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
  details: { nested: [1, 'two', false] }, structuredContent: { value: 'structured' },
  usage, isError: true, terminate: true,
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function native(execute: AgentTool['execute'], extra: Partial<AgentTool> = {}): AgentTool {
  return { name: 'fixture', label: 'Fixture', description: 'Local fixture', parameters: schema, execute, ...extra };
}

function host(execute: ToolRegistration<any>['execute'], extra: Partial<ToolRegistration<any>> = {}): ToolRegistration<any> {
  return { name: 'fixture', description: 'Local fixture', parameters: schema, execute, ...extra };
}

async function open(registrations: ToolRegistration<any>[] = []) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'host-tools-test', tools: registrations }));
  const reports: Report[] = [];
  const env = new NodeExecutionEnv({ cwd: tmpdir(), shellEnv: {} });
  const models = createModels();
  const harness = await Harness.open(new MemoryStorage(), {
    registry, models, env: () => env,
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
    onReport: report => { reports.push(report); },
  }, context);
  harnesses.push(harness);
  const conversation = await harness.root(context);
  const binding = new DurableLoopBinding({ kernel: { harness, conversation, registry } });
  bindings.push(binding);
  await binding.backend();
  const execute = (
    tool: AgentTool, args = { value: 'original' },
    options: Partial<Parameters<DurableLoopBinding['runTool']>[1]> = {},
  ) => binding.runTool({ type: 'toolCall', name: tool.name, id: 'call-1', arguments: args }, {
    tools: [tool], assistantMessage: assistant, context: { messages: [], tools: [tool] }, ...options,
  });
  return { harness, conversation, binding, registry, execute, env, models, reports };
}

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'host-tools-'));
  directories.push(directory);
  return directory;
}

async function deps(approval: ToolWrapDeps['requestApproval']): Promise<ToolWrapDeps> {
  const directory = await tempDirectory();
  return {
    requestApproval: approval, backgroundShells: new BackgroundShells(() => {}),
    tasksDirectory: join(directory, 'tasks'),
    shellEnv: new NodeExecutionEnv({ cwd: directory, shellEnv: {} }),
    getContextWindow: () => 100_000, summarize: async () => null,
    getUserRequest: () => 'fixture', getSessionPath: () => null, debugLog: () => {},
  };
}

describe('host tool bridge', () => {
  test('preserves caller restrictions when a native call reaches a host tool', async () => {
    const opened = await open();
    let effects = 0;
    const implementation: ToolRegistration<any>['execute'] = async () => {
      effects++;
      return { output: [{ type: 'text', text: 'allowed' }] };
    };
    const denied = await opened.execute(hostToolToAgent(host(implementation, { callers: ['model'] })));
    expect(denied.isError).toBe(true);
    expect(denied.result.content).toEqual([{ type: 'text', text: 'Tool fixture does not allow tools calls' }]);
    expect(effects).toBe(0);
    const allowed = await opened.execute(hostToolToAgent(host(implementation, { callers: ['tools'] })));
    expect(allowed.isError).toBe(false);
    expect(allowed.result.content).toEqual([{ type: 'text', text: 'allowed' }]);
    expect(effects).toBe(1);
    expect(hostToolToAgent(host(implementation, { callers: [] })).exposure).toBe('hidden');
    const nativeOnly = agentToolToHost({ ...native(async () => fullResult), exposure: 'model-only' });
    expect(nativeOnly.callers).toEqual(['model']);
    expect(opened.reports).toEqual([]);
  });

  test('uses production approval, augmented schema, cleaned transformed arguments, and durable memo', async () => {
    const approved = { value: 'approved' };
    const dependencies = await deps(async (name, args, callId) => {
      expect(name).toBe('fixture');
      expect(callId).toBe('call-1');
      expect(args._intent).toBe('explain');
      return { ...approved, _intent: 'ui-only' };
    });
    let received: unknown;
    let recorded: unknown;
    const wrapped = wrapAgentTool(native(async (_id, args) => {
      received = args;
      const scope = currentCodingToolInvocation();
      recorded = await scope.runtime.memo('mkagent.tool.approved-arguments', scope.context);
      return fullResult;
    }, { outputSchema: schema, replay: 'safe', executionMode: 'sequential' }),
    tool => wrapToolForKernel(tool, dependencies));
    expect(wrapped.registration.parameters.properties._intent).toBeDefined();
    expect(wrapped.tool.parameters).toBe(wrapped.registration.parameters);
    expect(wrapped.tool.outputSchema).toEqual(schema);
    expect(wrapped.tool.replay).toBe('safe');
    expect(wrapped.registration.replay).toBe('safe');
    expect(wrapped.tool.executionMode).toBe('sequential');
    const opened = await open([wrapped.registration]);
    const outcome = await opened.execute(wrapped.tool, { value: 'original', _intent: 'explain' } as { value: string });
    expect(received).toEqual(approved);
    expect(recorded).toEqual(approved);
    expect(outcome.result).toEqual(fullResult);
    expect(outcome.isError).toBe(true);
    expect(opened.reports).toEqual([]);
  });

  test('wrapper output and details replacement preserve native structure, usage, error, and termination', async () => {
    const wrapped = wrapAgentTool(native(async () => fullResult, { outputSchema: schema }), original => ({
      ...original,
      execute: async (...args) => ({
        ...await original.execute(...args),
        output: [{ type: 'text', text: 'summary' }], details: { transformed: true },
      }),
    }));
    const opened = await open([wrapped.registration]);
    const outcome = await opened.execute(wrapped.tool);
    expect(outcome.result).toEqual({
      ...fullResult, content: [{ type: 'text', text: 'summary' }], details: { transformed: true },
    });
    expect(wrapped.tool.replay).toBe('never');
    expect(wrapped.registration.replay).toBe('unsafe');
    expect(opened.reports).toEqual([]);
  });

  test('full native progress is serialized, joined, persisted, and closed before wrapper cleanup', async () => {
    const entered = gate();
    const release = gate();
    const settled = gate();
    const updates: AgentToolResult[] = [];
    let late: Parameters<AgentTool['execute']>[3];
    const wrapped = wrapAgentTool(native(async (_id, _args, _signal, onUpdate) => {
      late = onUpdate;
      onUpdate?.(fullResult);
      onUpdate?.({ ...fullResult, content: [{ type: 'text', text: 'second' }] });
      settled.resolve();
      return fullResult;
    }), original => ({
      ...original,
      execute: async (...args) => {
        const result = await original.execute(...args);
        late?.({ content: [{ type: 'text', text: 'late' }], details: {} });
        return result;
      },
    }));
    const opened = await open([wrapped.registration]);
    const running = opened.execute(wrapped.tool, undefined, {
      onUpdate: async update => {
        updates.push(update);
        if (updates.length === 1) { entered.resolve(); await release.promise; }
      },
    });
    await Promise.all([entered.promise, settled.promise]);
    expect(updates).toEqual([fullResult]);
    release.resolve();
    expect((await running).result).toEqual(fullResult);
    expect(updates).toEqual([fullResult, { ...fullResult, content: [{ type: 'text', text: 'second' }] }]);
    late?.(fullResult);
    expect(updates).toHaveLength(2);
    expect(opened.reports).toEqual([]);
  });

  test('joins callback failure and observes detached persistence failure without late work', async () => {
    const wrapped = wrapAgentTool(native(async (_id, _args, _signal, update) => {
      update?.(fullResult);
      return fullResult;
    }), tool => tool);
    const opened = await open();
    await expect(opened.execute(wrapped.tool, undefined, {
      onUpdate: async () => { throw new Error('progress listener failed'); },
    })).rejects.toThrow('progress listener failed');

    let captured!: ToolExecutionApi;
    const broken = hostToolToAgent(host(async (_args, api, ctx) => {
      captured = api;
      void api.commit(() => { throw new Error('detached commit failed'); }, ctx);
      return { output: [{ type: 'text', text: 'done' }] };
    }));
    const outcome = await opened.execute(broken);
    expect(outcome.isError).toBe(true);
    expect(outcome.result.content[0]).toEqual({ type: 'text', text: 'detached commit failed' });
    expect(() => captured.output('late')).toThrow('has settled');
    expect(() => captured.memo('late', context)).toThrow('has settled');
    expect(() => captured.executeTool('fixture', {}, context)).toThrow('has settled');
  });

  test('provides real env, commit, memo, documents, watches, child tasks, and progress fallback', async () => {
    const State = defineDoc({
      kind: 'test.host-tools-state', version: 1, scope: 'session', initial: () => ({ value: 0 }),
      checkpointWhen: () => true,
    });
    const Child = defineTask<{ value: number }, { phase: 'run' }, number>({
      name: 'test.host-tools-child', version: 1, initial: () => ({ phase: 'run' }),
      phases: { run: async (task, runtime, ctx) => {
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: task.input.value } }), ctx);
      } },
      abort: async (_task, runtime, ctx) => {
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx);
      },
    });
    const opened = await open();
    opened.registry.install(defineExtension({ name: 'child-task-test', tasks: [Child] }));
    let apiAfter!: ToolExecutionApi;
    const updates: AgentToolResult[] = [];
    const target = hostToolToAgent(host(async (_args, api, ctx) => {
      apiAfter = api;
      expect(api.env).toBe(opened.env);
      expect(api.models.getProviders()).toEqual(opened.models.getProviders());
      expect(api.now()).toBeNumber();
      expect((await api.agent(ctx)).tools).toBeArray();
      expect(await api.memo('once', { value: 1 }, ctx)).toEqual({ value: 1 });
      expect(await api.memo('once', { value: 2 }, ctx)).toEqual({ value: 1 });
      expect(await api.memo('once', ctx)).toEqual({ value: 1 });
      expect(await api.commit(async tx => { (await tx.doc(State)).value = 42; return 'committed'; }, ctx)).toBe('committed');
      expect(await api.snapshot(State, ctx)).toEqual({ value: 42 });
      const watch = await api.watchDoc(State, () => {}, ctx);
      await watch.stop();
      expect((await api.getTask(api.taskId, ctx))?.kind).toBe('pi.coding.tool');
      expect((await api.conversation(api.conversationId, ctx))?.id).toBe(opened.conversation.id);
      const child = await api.createTask(Child, { value: 7 }, { ownership: { kind: 'task', taskId: api.taskId } }, ctx);
      expect((await api.getTask(child, ctx))?.abandonOnRestart).toBe(true);
      expect((await api.waitForTask(child, ctx)).state.outcome).toEqual({ status: 'completed', result: 7 });
      api.output('hello');
      await api.details({ progress: 'stored' }, ctx);
      api.diagnostic({ severity: 'info', code: 'fixture', message: 'remark' });
      return { usage, control: { terminate: true }, structuredOutput: { value: 'structured' } };
    }));
    const outcome = await opened.execute(target, undefined, { onUpdate: update => { updates.push(update); } });
    expect(outcome.result).toEqual({
      content: [{ type: 'text', text: 'hello' }, { type: 'text', text: '<harness>\n[info] remark\n</harness>' }],
      details: { progress: 'stored' }, usage, terminate: true, structuredContent: { value: 'structured' },
    });
    expect(updates.some(update => update.content[0]?.text === 'hello')).toBe(true);
    expect(updates.at(-1)?.details).toEqual({ progress: 'stored' });
    expect(() => apiAfter.snapshot(State, context)).toThrow('has settled');
    expect(opened.reports).toEqual([]);
  });

  test('retains a bounded UTF-8 tail, preserves images, and reports truncation', async () => {
    const target = hostToolToAgent(host(async (_args, api) => {
      expect(api.outputWindow?.maxBytes).toBe(8);
      api.output('0123456789');
      expect(api.retainedOutput()).toEqual({ text: '23456789', truncated: true });
      return {};
    }, { outputLimits: { maxBytes: 8, maxLines: 2, retain: 'tail' } }));
    const opened = await open();
    const outcome = await opened.execute(target);
    expect(outcome.result.content[0]).toEqual({ type: 'text', text: '23456789' });
    expect(outcome.result.content[1].text).toContain('2 bytes dropped');
    const explicit = hostToolToAgent(host(async () => ({
      output: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }, { type: 'text', text: '你好吗你好' }],
    }), { outputLimits: { maxBytes: 7, retain: 'tail' } }));
    const second = await opened.execute(explicit);
    expect(second.result.content[0].type).toBe('image');
    expect(second.result.content[1]).toEqual({ type: 'text', text: '你好' });
  });

  test('coalesces a burst of host chunks while retaining the final bounded window', async () => {
    const updates: AgentToolResult[] = [];
    const target = hostToolToAgent(host(async (_args, api) => {
      for (let index = 0; index < 10_000; index++) api.output(String(index % 10));
      return {};
    }, { outputLimits: { maxBytes: 10, retain: 'tail' } }));
    const opened = await open();
    const outcome = await opened.execute(target, undefined, { onUpdate: update => { updates.push(update); } });
    expect(updates.length).toBeLessThanOrEqual(2);
    expect(updates.at(-1)?.content[0]).toEqual({ type: 'text', text: '0123456789' });
    expect(outcome.result.content[0]).toEqual({ type: 'text', text: '0123456789' });
    expect(outcome.result.content[1].text).toContain('9990 bytes dropped');
  });

  test('recovers a persisted unsafe execution intent without invoking the host effect', async () => {
    let effects = 0;
    const target = hostToolToAgent(agentToolToHost(native(async () => {
      effects++;
      return fullResult;
    })));
    const definition = createCodingToolTask(() => ({
      getTool: () => target, context: () => ({ messages: [], tools: [target] }), emit: async () => {},
    }));
    // Seed the checkpoint a crash leaves after intent, before a durable outcome.
    const seeded = { definition: {
      ...definition.definition,
      initial: (): CodingToolTaskCheckpoint => ({ phase: 'execute', replay: target.replay ?? 'never' }),
    } };
    const directory = await tempDirectory();
    const firstRegistry = createRegistry();
    firstRegistry.install(defineExtension({ name: 'recovery-test', tasks: [seeded] }));
    const first = await Harness.open(await openNodeJsonlStorage(directory, context), {
      registry: firstRegistry, models: createModels(),
    }, context);
    const conversation = await first.root(context);
    const call = { type: 'toolCall' as const, id: 'unsafe-call', name: 'fixture', arguments: { value: 'original' } };
    const id = await conversation.commit(tx => tx.createTask(seeded, {
      assistantMessage: assistant, toolCall: call, args: call.arguments,
    }, { ownership: { kind: 'conversation' } }), context);
    await first.close(context);
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'recovery-test', tasks: [definition] }));
    const recovered = await Harness.open(await openNodeJsonlStorage(directory, context), {
      registry, models: createModels(),
    }, context);
    harnesses.push(recovered);
    recovered.resume();
    const receipt = await recovered.waitForTask(id, context);
    expect(receipt.state.outcome).toMatchObject({
      status: 'completed', result: { isError: true, result: {
        content: [{ type: 'text', text: 'Tool fixture was interrupted and may have partially run; it was not executed again' }],
      } },
    });
    expect(effects).toBe(0);
  });

  test('runs official nested ToolTasks with key replay, validation, policy, and usage exactly once', async () => {
    let calls = 0;
    const leaf = host(async () => {
      calls++;
      return { output: [{ type: 'text', text: 'nested' }], details: { leaf: true }, usage };
    }, { name: 'leaf', replay: 'safe' });
    const blocked = host(async () => { throw new Error('Must not execute'); }, { name: 'model_only', callers: ['model'] });
    const opened = await open([leaf, blocked]);
    const target = hostToolToAgent(host(async (_args, api, ctx) => {
      const first = await api.executeTool('leaf', { value: 'same', object: { a: 1, b: 2 } }, ctx, { key: 'named' });
      const second = await api.executeTool('leaf', { object: { b: 2, a: 1 }, value: 'same' }, ctx, { key: 'named' });
      expect(second).toEqual(first);
      expect(first.structuredOutput).toBe('nested');
      expect(first.details).toEqual({ leaf: true });
      expect(first.usage).toEqual(usage);
      const record = await api.getTask(first.taskId, ctx);
      expect(record?.kind).toBe(ToolTask.definition.name);
      expect(record?.owner).toBe(api.taskId);
      expect(record?.abandonOnRestart).toBeUndefined();
      expect((await api.snapshot(NestedCallDoc, api.taskId, 'named', ctx))?.taskId).toBe(first.taskId);
      await expect(api.executeTool('leaf', { value: 'changed' }, ctx, { key: 'named' })).rejects.toThrow('another tool or other arguments');
      for (const key of ['', '/', '__proto__', '1']) {
        await expect(api.executeTool('leaf', { value: 'same' }, ctx, { key })).rejects.toThrow('Nested call key');
      }
      const invalid = await api.executeTool('leaf', {}, ctx);
      expect(invalid.isError).toBe(true);
      expect(invalid.diagnostics.some(item => item.code === 'invalid_arguments')).toBe(true);
      const denied = await api.executeTool('model_only', { value: 'same' }, ctx);
      expect(denied.isError).toBe(true);
      return { output: [{ type: 'text', text: 'parent' }] };
    }, { replay: 'safe' }));
    const outcome = await opened.execute(target);
    expect(outcome.isError).toBe(false);
    expect(calls).toBe(1);
    expect((await opened.harness.snapshot(UsageDoc, opened.conversation.id, context))?.tools).toEqual({ leaf: usage });
    expect((await opened.harness.snapshot(LiveDoc, opened.conversation.id, context))?.nestedTools).toBeUndefined();
    expect(opened.reports).toEqual([]);
  });

  test('nested official calls can discover wrapped native registrations and unsafe callers abandon children', async () => {
    const leaf = wrapAgentTool(native(async () => fullResult, { name: 'native_leaf', outputSchema: schema }), tool => tool);
    const opened = await open([leaf.registration]);
    const target = hostToolToAgent(host(async (_args, api, ctx) => {
      const result = await api.executeTool('native_leaf', { value: 'nested' }, ctx);
      expect(result.structuredOutput).toEqual(fullResult.structuredContent);
      expect(result.usage).toEqual(usage);
      expect(result.details).toEqual(fullResult.details);
      expect((await api.getTask(result.taskId, ctx))?.abandonOnRestart).toBe(true);
      return { output: [{ type: 'text', text: 'done' }] };
    }));
    expect((await opened.execute(target)).isError).toBe(false);
    expect((await opened.harness.snapshot(UsageDoc, opened.conversation.id, context))?.tools).toEqual({ native_leaf: usage });
    expect(opened.reports).toEqual([]);
  });

  test('native executeTool reentry remains in the current owned coding graph', async () => {
    const leaf = native(async () => ({ content: [{ type: 'text', text: 'inner' }], details: {} }), { name: 'inner' });
    const wrapped = wrapAgentTool(native(async (_id, _args, signal) => {
      const result = await runToolCall({ type: 'toolCall', id: 'inner-call', name: 'inner', arguments: { value: 'inner' } }, {
        tools: [leaf], assistantMessage: assistant, context: { messages: [], tools: [leaf] }, signal,
      });
      return result.result;
    }), tool => tool);
    const opened = await open([wrapped.registration]);
    expect((await opened.execute(wrapped.tool)).result.content).toEqual([{ type: 'text', text: 'inner' }]);
    expect(opened.reports).toEqual([]);
  });

  test('host to official to native reentry owns its child under the official task', async () => {
    const opened = await open();
    let childOwner: Parameters<typeof opened.harness.getTask>[0] | undefined;
    const leaf = native(async () => {
      childOwner = currentCodingToolInvocation().input.parentTaskId;
      return { content: [{ type: 'text', text: 'deep result' }], details: {} };
    }, { name: 'inner' });
    const middle = wrapAgentTool(native(async (_id, _args, signal) => {
      return (await runToolCall({ type: 'toolCall', id: 'inner-call', name: 'inner', arguments: { value: 'inner' } }, {
        tools: [leaf], assistantMessage: assistant, context: { messages: [], tools: [leaf] }, signal,
      })).result;
    }, { name: 'middle' }), tool => tool,
    (api, ctx, work) => opened.binding.withHostToolScope(api, ctx, work));
    opened.registry.install(defineExtension({ name: 'middle', tools: [middle.registration] }));
    let officialId: Parameters<typeof opened.harness.getTask>[0] | undefined;
    const outer = hostToolToAgent(host(async (_args, api, ctx) => {
      const result = await api.executeTool('middle', { value: 'middle' }, ctx);
      officialId = result.taskId;
      expect(result.isError).toBe(false);
      expect(result.structuredOutput).toBe('deep result');
      return { output: [{ type: 'text', text: String(result.structuredOutput) }] };
    }));
    expect((await opened.execute(outer)).result.content).toEqual([{ type: 'text', text: 'deep result' }]);
    expect(childOwner).toBeDefined();
    expect((await opened.harness.getTask(childOwner!, context))?.owner).toBe(officialId);
    expect(opened.reports).toEqual([]);
  });

  test('production background bash outlives the call using its separate shell context', async () => {
    const started = gate();
    const release = gate();
    const finished = gate();
    const events: Array<{ type: string; outputFile?: string }> = [];
    let nativeExecuted = false;
    const dependencies = await deps(async (_name, args) => args);
    dependencies.backgroundShells = new BackgroundShells(event => {
      events.push(event);
      if (event.type === 'task_completed') finished.resolve();
    });
    dependencies.shellEnv.exec = async (_command, options, ctx) => {
      started.resolve();
      await release.promise;
      expect(ctx.abortSignal?.aborted).toBe(false);
      await options?.onOutput?.('background output', ctx);
      return { ok: true, value: { exitCode: 0 } };
    };
    const wrapped = wrapAgentTool(native(async () => {
      nativeExecuted = true;
      return fullResult;
    }, {
      name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }), tool => wrapToolForKernel(tool, dependencies));
    const opened = await open([wrapped.registration]);
    const outcome = await opened.execute(wrapped.tool, { command: 'synthetic', run_in_background: true } as unknown as { value: string });
    await started.promise;
    expect(outcome.isError).toBe(false);
    expect(outcome.result.content[0].text).toContain('Command running in background');
    expect(nativeExecuted).toBe(false);
    release.resolve();
    await finished.promise;
    const outputFile = events.find(event => event.type === 'task_completed')!.outputFile!;
    expect(await readFile(outputFile, 'utf8')).toBe('background output');
    await dependencies.backgroundShells.dispose();
    expect(opened.reports).toEqual([]);
  });
});
