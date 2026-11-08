// Verify the public SDK executor through real task ownership and crash/reopen boundaries.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, LiveDoc, MemoryStorage, ToolTask,
  type ConversationHandle, type Task, type TaskId, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable';
import type { AgentTool } from '../src/agent-runtime.ts';
import { DurableLoopBinding } from '../src/durable-coding/engine.ts';
import { hostToolToAgent } from '../src/host-tools.ts';
import { response } from './fixtures/durable-harness.ts';

const context = BACKGROUND_CONTEXT;
const opened: Array<{ harness: Harness; binding: DurableLoopBinding }> = [];
afterEach(async () => {
  for (const { harness, binding } of opened.splice(0)) {
    await binding.close();
    await harness.close(context);
  }
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function untilAbort(signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    if (!signal) throw new Error('Expected a tool signal');
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function registration(execute: ToolRegistration<any>['execute'], name = 'fixture'): ToolRegistration<any> {
  return { name, description: 'Local fixture', parameters: { type: 'object' }, replay: 'safe', execute };
}

async function open(tools: ToolRegistration<any>[] = [], tasks: Task<any, any, any, any>[] = []) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'host-sdk-test', tools, tasks }));
  const reports: unknown[] = [];
  const harness = await Harness.open(new MemoryStorage(), {
    registry, models: createModels(), onReport: report => { reports.push(report); },
  }, context);
  const conversation = await harness.root(context);
  const binding = new DurableLoopBinding({ kernel: { harness, conversation, registry } });
  opened.push({ harness, binding });
  await binding.backend();
  const execute = (tool: AgentTool, signal?: AbortSignal) => binding.runTool({
    type: 'toolCall', name: tool.name, id: 'call-1', arguments: {},
  }, { tools: [tool], assistantMessage: response('context'), context: { messages: [], tools: [tool] }, signal });
  return { harness, conversation, execute, reports };
}

test('delegates execution to the public ToolTask phase and rejects conflicting host calls', async () => {
  const phase = spyOn(ToolTask.definition.phases, 'call');
  try {
    let calls = 0;
    const first = hostToolToAgent(registration(async () => {
      calls++;
      return { output: [{ type: 'text', text: 'official result' }] };
    }));
    const second = hostToolToAgent(registration(async () => {
      throw new Error('Conflicting implementation must not run');
    }, 'other'));
    const target: AgentTool = {
      ...first, execute: async (id, args, signal) => {
        const result = await first.execute(id, args, signal);
        expect(await first.execute(id, args, signal)).toEqual(result);
        await expect(second.execute(id, args, signal)).rejects.toThrow('another tool or other arguments');
        await expect(first.execute(id, { changed: true }, signal)).rejects.toThrow('another tool or other arguments');
        return result;
      },
    };
    const fixture = await open();
    expect((await fixture.execute(target)).result.content).toEqual([{ type: 'text', text: 'official result' }]);
    expect(calls).toBe(1);
    expect(phase).toHaveBeenCalledTimes(1);
    expect(fixture.reports).toEqual([]);
  } finally { phase.mockRestore(); }
});

for (const conflicting of [false, true]) test(`rejects concurrent ${conflicting ? 'conflicting' : 'identical unsafe'} host executions`, async () => {
  const entered = gate();
  const release = gate();
  const effects: unknown[] = [];
  const bridge = hostToolToAgent({ ...registration(async args => {
    effects.push(args);
    entered.resolve();
    await release.promise;
    return { output: [{ type: 'text', text: 'once' }] };
  }), replay: 'unsafe' });
  const fixture = await open();
  const target: AgentTool = {
    ...bridge, execute: async (id, _args, signal) => {
      const first = bridge.execute(id, { value: 'one' }, signal);
      const second = bridge.execute(id, { value: conflicting ? 'two' : 'one' }, signal);
      const joined = Promise.allSettled([first, second]);
      await entered.promise;
      release.resolve();
      const results = await joined;
      expect(results[1].status).toBe('rejected');
      expect(results[1].status === 'rejected' && results[1].reason.message).toMatch(/already running|another tool or other arguments/);
      return first;
    },
  };
  expect((await fixture.execute(target)).isError).toBe(false);
  expect(effects).toEqual([{ value: 'one' }]);
  expect(fixture.reports).toEqual([]);
});

test('closes captured SDK APIs while the Native owner is still executing', async () => {
  const State = defineDoc({ kind: 'host-sdk-lifetime', version: 1, scope: 'task', initial: () => ({ value: 0 }) });
  let captured!: ToolExecutionApi;
  let handle!: ConversationHandle;
  let owner!: TaskId;
  const bridge = hostToolToAgent(registration(async (_args, api, ctx) => {
    captured = api;
    owner = api.taskId;
    handle = (await api.conversation(api.conversationId, ctx))!;
    return { output: [{ type: 'text', text: 'settled' }] };
  }));
  const fixture = await open();
  const target: AgentTool = {
    ...bridge, execute: async (...args) => {
      const result = await bridge.execute(...args);
      const lateMemo = captured.memo.bind(captured);
      for (const operation of [
        () => lateMemo('late', { changed: true }, context),
        () => captured.memo('late', context),
        () => captured.commit(() => { throw new Error('Late transaction ran'); }, context),
        () => captured.snapshot(State, context),
        () => captured.getTask(owner, context),
        () => captured.waitForTask(owner, context),
        () => captured.conversation(handle.id, context),
        () => captured.models,
        () => captured.env,
        () => handle.abort(context),
      ]) expect(operation).toThrow(/has settled|invocation has ended/);
      return result;
    },
  };
  expect((await fixture.execute(target)).result.content).toEqual([{ type: 'text', text: 'settled' }]);
  expect(fixture.reports).toEqual([]);
});

test('external cancellation closes API operations even with a live commit context', async () => {
  const entered = gate();
  const controller = new AbortController();
  const fixture = await open();
  const target = hostToolToAgent(registration(async (_args, api, ctx) => {
    entered.resolve();
    await untilAbort(ctx.abortSignal);
    expect(() => api.memo('after-abort', { changed: true }, context)).toThrow('fixture cancellation');
    return { output: [{ type: 'text', text: 'cleanup result' }] };
  }));
  const running = fixture.execute(target, controller.signal);
  await entered.promise;
  controller.abort(new Error('fixture cancellation'));
  expect((await running).result.content).toEqual([{ type: 'text', text: 'cleanup result' }]);
  expect(fixture.reports).toEqual([]);
});

for (const ownership of ['task', 'conversation'] as const) test(`SDK failure cancels and joins an owned ${ownership}`, async () => {
  const cleaning = gate();
  const release = gate();
  let cleaned = false;
  let child!: TaskId;
  let owner!: TaskId;
  const Child = defineTask<{}, { phase: 'sleep' }, null>({
    name: `host-sdk-${ownership}-child`, version: 1, initial: () => ({ phase: 'sleep' }),
    phases: { sleep: async (task, runtime, ctx) => {
      await runtime.commit(() => ({ status: 'sleeping', until: runtime.now() + 60_000, checkpoint: task.state.checkpoint }), ctx);
    } },
    abort: async (_task, runtime, ctx) => {
      cleaning.resolve();
      await release.promise;
      cleaned = true;
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx);
    },
  });
  const fixture = await open([], [Child]);
  const target = hostToolToAgent(registration(async (_args, api, ctx) => {
    owner = api.taskId;
    if (ownership === 'task') child = await api.createTask(Child, {}, {
      ownership: { kind: 'task', taskId: api.taskId },
    }, ctx);
    else child = await api.commit(async tx => {
      const conversation = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
      return tx.createTask(Child, {}, { conversationId: conversation.id, ownership: { kind: 'conversation' } });
    }, ctx);
    throw new Error('Host execution failed');
  }));
  let settled = false;
  const running = fixture.execute(target).then(result => { settled = true; return result; });
  try {
    const first = await Promise.race([cleaning.promise.then(() => undefined), running]);
    expect(first).toBeUndefined();
    expect(settled).toBe(false);
  } finally { release.resolve(); }
  expect((await running).isError).toBe(true);
  expect(cleaned).toBe(true);
  expect((await fixture.harness.getTask(child, context))?.state).toMatchObject({ status: 'terminal', outcome: { status: 'aborted' } });
  expect((await fixture.harness.getTask(owner, context))?.state).toMatchObject({ status: 'terminal', outcome: { status: 'failed' } });
  expect(fixture.reports).toEqual([]);
});

test('SDK settlement joins owned nested cleanup before delivering the parent result', async () => {
  const entered = gate();
  const cleaning = gate();
  const release = gate();
  let cleaned = false;
  const leaf = registration(async (_args, _api, ctx) => {
    entered.resolve();
    await untilAbort(ctx.abortSignal);
    cleaning.resolve();
    await release.promise;
    cleaned = true;
    return { output: [{ type: 'text', text: 'joined child' }] };
  }, 'leaf');
  const fixture = await open([leaf]);
  const target = hostToolToAgent(registration(async (_args, api, ctx) => {
    void api.executeTool('leaf', {}, ctx).catch(() => {});
    await entered.promise;
    return { output: [{ type: 'text', text: 'parent' }] };
  }));
  let settled = false;
  const running = fixture.execute(target).then(result => { settled = true; return result; });
  try {
    await cleaning.promise;
    expect(settled).toBe(false);
    expect(cleaned).toBe(false);
  } finally { release.resolve(); }
  expect((await running).isError).toBe(false);
  expect(cleaned).toBe(true);
  expect((await fixture.harness.snapshot(LiveDoc, fixture.conversation.id, context))?.nestedTools).toBeUndefined();
  expect(fixture.reports).toEqual([]);
});

for (const mode of ['signal', 'scheduler']) test(`${mode} cancellation joins nested cleanup and clears SDK progress slots`, async () => {
  const entered = gate();
  const cleaning = gate();
  const release = gate();
  let cleaned = false;
  const leaf = registration(async (_args, _api, ctx) => {
    entered.resolve();
    await untilAbort(ctx.abortSignal);
    cleaning.resolve();
    await release.promise;
    cleaned = true;
    return { output: [{ type: 'text', text: 'joined child' }] };
  }, 'leaf');
  const fixture = await open([leaf]);
  let owner: TaskId | undefined;
  const target = hostToolToAgent(registration(async (_args, api, ctx) => {
    owner = api.taskId;
    void api.executeTool('leaf', {}, ctx).catch(() => {});
    await entered.promise;
    await untilAbort(ctx.abortSignal);
    return { output: [{ type: 'text', text: 'parent cleanup result' }] };
  }));
  const controller = new AbortController();
  let settled = false;
  const running = fixture.execute(target, controller.signal).then(result => { settled = true; return result; });
  await entered.promise;
  const aborting = mode === 'scheduler' ? fixture.harness.abortTask(owner!, context) : undefined;
  if (mode === 'signal') controller.abort(new Error('fixture cancellation'));
  try {
    await cleaning.promise;
    expect(settled).toBe(false);
  } finally { release.resolve(); }
  expect((await running).result.content).toEqual([{ type: 'text', text: 'parent cleanup result' }]);
  await aborting;
  expect(cleaned).toBe(true);
  expect((await fixture.harness.snapshot(LiveDoc, fixture.conversation.id, context))?.nestedTools).toBeUndefined();
  expect(fixture.reports).toEqual([]);
});

const processFixture = fileURLToPath(new URL('./fixtures/host-tool-recovery-process.ts', import.meta.url));
async function run(directory: string, phase: 'begin' | 'resume', replay: 'safe' | 'never', boundary: string, nativeReplay = replay) {
  return new Promise<string>((resolve, reject) => {
    const options = typeof Bun === 'undefined' ? ['--experimental-transform-types'] : ['--no-env-file'];
    const child = spawn(process.execPath, [...options, processFixture, directory, phase, replay, boundary, nativeReplay], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    let killed = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 8_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (phase === 'begin' && !killed && output.includes('CRASH_BOUNDARY\n')) killed = child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (phase === 'begin' ? killed && signal === 'SIGKILL' : code === 0) resolve(output);
      else reject(new Error(`Host recovery failed: ${phase}, ${code}, ${signal}\n${output}\n${errors}`));
    });
  });
}

for (const replay of ['safe', 'never'] as const) for (const current of ['safe', 'never'] as const) {
  test(`SDK cold recovery keeps ${replay} intent and ${current} current policy`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-sdk-crash-'));
    try {
      await run(directory, 'begin', replay, 'intent');
      const restored = JSON.parse(await run(directory, 'resume', current, 'intent'));
      const safe = replay === 'safe' && current === 'safe';
      expect(restored.resumed).toBe(true);
      expect(restored.checkpoint).toMatchObject({ status: 'pending', checkpoint: { phase: 'execute' } });
      expect(restored.execution.execution).toMatchObject({ version: ToolTask.definition.version,
        checkpoint: { phase: 'execute', replay: replay === 'safe' ? 'safe' : 'unsafe' } });
      expect(await readFile(join(directory, 'effects.txt'), 'utf8')).toBe(safe ? 'begin\nresume\n' : 'begin\n');
      const result = restored.messages.find((message: { role: string }) => message.role === 'toolResult');
      expect(result.isError).toBe(!safe);
      if (safe) {
        expect(result.content[0].text).toBe('native result '.repeat(5_000));
        expect(result.content[1]).toEqual({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' });
      } else expect(result.content.at(-1).text).toContain('interrupted and may have partially run');
      expect(restored.reports).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
}

for (const [stored, current, boundary] of [
  ['safe', 'never', 'intent'],
  ['never', 'safe', 'intent'],
  ['never', 'never', 'intent'],
  ['never', 'safe', 'legacy-policy'],
] as const) test(`Native ${stored}/${current} limits SDK safe replay at ${boundary}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-sdk-native-policy-'));
  try {
    await run(directory, 'begin', 'safe', boundary, stored);
    const restored = JSON.parse(await run(directory, 'resume', 'safe', boundary, current));
    expect(restored.checkpoint).toMatchObject({ status: 'pending', checkpoint: { phase: 'execute', replay: stored } });
    if (boundary === 'legacy-policy') expect(restored.execution.execution.checkpoint.replay).toBe('safe');
    expect(await readFile(join(directory, 'effects.txt'), 'utf8')).toBe('begin\n');
    const result = restored.messages.find((message: { role: string }) => message.role === 'toolResult');
    expect(result.isError).toBe(true);
    expect(result.content.at(-1).text).toContain('interrupted and may have partially run');
    expect(restored.reports).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20_000);

for (const boundary of ['failed', 'failed-removed']) {
  test(`cold recovery preserves SDK failure cleanup with tool ${boundary}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-sdk-failure-'));
    try {
      await run(directory, 'begin', 'never', boundary);
      const restored = JSON.parse(await run(directory, 'resume', 'never', boundary));
      expect(restored.execution.execution.failure).toEqual({ message: 'Tool fixture threw' });
      expect(await readFile(join(directory, 'effects.txt'), 'utf8')).toBe('begin\n');
      expect((await readFile(join(directory, 'cleanup.txt'), 'utf8')).trim().split('\n')).toHaveLength(2);
      expect(restored.children).toHaveLength(2);
      for (const child of restored.children) expect(child.state).toMatchObject({ status: 'terminal', outcome: { status: 'aborted' } });
      expect(restored.owner.state).toMatchObject({ status: 'terminal', outcome: { status: 'failed' } });
      const result = restored.messages.find((message: { role: string }) => message.role === 'toolResult');
      expect(result.isError).toBe(true);
      expect(result.content.at(-1).text).toContain('Host execution failed');
      expect(restored.reports).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
}

for (const boundary of ['completed', 'removed']) {
  test(`cold recovery delivers the full completed SDK receipt with tool ${boundary}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-sdk-receipt-'));
    try {
      await run(directory, 'begin', 'never', boundary);
      const restored = JSON.parse(await run(directory, 'resume', 'never', boundary));
      expect(restored.resumed).toBe(true);
      expect(restored.checkpoint).toMatchObject({ status: 'pending', checkpoint: { phase: 'execute', replay: 'never' } });
      expect(restored.execution.execution.result.result.structuredContent).toEqual({ complete: true });
      expect(await readFile(join(directory, 'effects.txt'), 'utf8')).toBe('begin\n');
      const result = restored.messages.find((message: { role: string }) => message.role === 'toolResult');
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([
        { type: 'text', text: 'native result '.repeat(5_000) },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ]);
      expect(result.details).toEqual({ source: 'native' });
      expect(restored.reports).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
}
