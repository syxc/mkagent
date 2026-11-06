import { afterEach, describe, expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import {
  createRegistry, Harness, MemoryStorage, type TaskId, type ToolExecutionResult,
} from '@earendil-works/pi-durable';
import {
  createCodemodeExtension, type CodemodeSandboxLease, type CodemodeStoreAdapter, type CodemodeToolOptions,
} from '@earendil-works/pi-durable/codemode';

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function sandbox() {
  const value = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
  cleanups.push(() => value.close());
  const original = value.start.bind(value);
  let starts = 0;
  value.start = (...args) => { starts++; return original(...args); };
  return { value, starts: () => starts };
}

async function fixture(options: Partial<CodemodeToolOptions> = {}, repeat = false) {
  const registry = createRegistry();
  const extension = createCodemodeExtension({
    sandbox: options.sandbox ?? sandbox().value, models: false, ...options,
  });
  let result: ToolExecutionResult | undefined;
  let failure: unknown;
  registry.install({
    ...extension,
    tools: extension.tools?.map(tool => tool.name !== 'codemode' ? tool : {
      ...tool,
      execute: async (args, api, ctx) => {
        try {
          result = await tool.execute(args, api, ctx);
          if (repeat) expect(await tool.execute(args, api, ctx)).toEqual(result);
          return result;
        } catch (error) {
          failure = error;
          throw error;
        }
      },
    }),
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let now = Date.now();
  const harness = await Harness.open(new MemoryStorage(), {
    registry, models, now: () => now,
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, context);
  cleanups.push(() => harness.close(context));
  const conversation = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  const run = async (code: string): Promise<ToolExecutionResult> => {
    result = undefined;
    failure = undefined;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('codemode', { code }, { id: 'policy-script' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('done')]),
    ]);
    await (await conversation.submit({ type: 'input', content: 'Run local code' }, context)).wait(context);
    if (failure !== undefined) throw failure;
    if (result === undefined) throw new Error('The model did not execute codemode');
    return result;
  };
  return { run, harness, advance: (ms: number) => { now += ms; } };
}

function text(result: ToolExecutionResult) {
  return result.output?.flatMap(item => item.type === 'text' ? [item.text] : []).join('') ?? '';
}

describe('public durable codemode host policies', () => {
  test('a lease starts only once and is released before output formatting and result replay', async () => {
    const vm = sandbox();
    let acquisitions = 0;
    let releases = 0;
    const opened = await fixture({
      sandbox: async (): Promise<CodemodeSandboxLease> => {
        acquisitions++;
        return { sandbox: vm.value, release: async () => { releases++; await vm.value.close(); } };
      },
      output: { wallMs: () => { expect(releases).toBe(1); return 0; } },
    }, true);
    expect(text(await opened.run('return "leased";'))).toContain('leased');
    expect(acquisitions).toBe(1);
    expect(releases).toBe(1);
    expect(vm.starts()).toBe(1);
  }, 10_000);

  test('a failed script releases its lease and retains its partial output', async () => {
    const vm = sandbox();
    let releases = 0;
    const opened = await fixture({
      sandbox: async () => ({ sandbox: vm.value, release: async () => { releases++; await vm.value.close(); } }),
    });
    const result = await opened.run('text("partial"); throw new Error("failure");');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('partial');
    expect(releases).toBe(1);
  }, 10_000);

  test('acquisition and release failures propagate without starting or releasing twice', async () => {
    const vm = sandbox();
    const admission = new Error('admission failed');
    const rejected = await fixture({ sandbox: async () => { throw admission; } });
    await expect(rejected.run('return 1;')).rejects.toBe(admission);
    expect(vm.starts()).toBe(0);
    const cleanup = new Error('release failed');
    let releases = 0;
    const opened = await fixture({
      sandbox: async () => ({ sandbox: vm.value, release: async () => { releases++; throw cleanup; } }),
    });
    await expect(opened.run('return 1;')).rejects.toBe(cleanup);
    expect(releases).toBe(1);
    expect(vm.starts()).toBe(1);
  }, 10_000);

  test('worker admission counts against the saved absolute deadline', async () => {
    const vm = sandbox();
    let releases = 0;
    let deadline: number | undefined;
    const opened = await fixture({
      sandbox: async (api, _ctx, until) => {
        deadline = until;
        expect(until).toBe(api.now() + 10);
        opened.advance(11);
        return { sandbox: vm.value, release: () => { releases++; } };
      },
    });
    const result = await opened.run('// @options: {"timeout_ms":10}\nreturn "too late";');
    expect(deadline).toBeDefined();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('deadline passed while waiting for a sandbox');
    expect(releases).toBe(1);
    expect(vm.starts()).toBe(0);
  }, 10_000);

  test('a rejected store transaction propagates after the worker lease is released', async () => {
    const vm = sandbox();
    let releases = 0;
    const rejected = new Error('store refused');
    const store: CodemodeStoreAdapter = {
      read: () => ({ seed: 1 }),
      write: (_tx, writes) => {
        expect(writes).toEqual({ set: { seed: 2 }, delete: [] });
        expect(releases).toBe(1);
        throw rejected;
      },
    };
    const opened = await fixture({
      sandbox: async () => ({ sandbox: vm.value, release: () => { releases++; } }),
      store,
    });
    await expect(opened.run('store("seed", load("seed") + 1);')).rejects.toBe(rejected);
    expect(releases).toBe(1);
    expect(vm.starts()).toBe(1);
  }, 10_000);

  test('a lease returned after actual task cancellation is released without starting a VM', async () => {
    const vm = sandbox();
    let task!: TaskId;
    let entered!: () => void;
    const ready = new Promise<void>(done => { entered = done; });
    let releases = 0;
    const opened = await fixture({
      sandbox: async (api, ctx) => {
        task = api.taskId;
        entered();
        await new Promise<void>(done => {
          if (ctx.abortSignal?.aborted) done();
          else ctx.abortSignal?.addEventListener('abort', () => done(), { once: true });
        });
        return { sandbox: vm.value, release: () => { releases++; } };
      },
    });
    const running = opened.run('return "cancelled";');
    const failure = running.then(() => undefined, error => error);
    await ready;
    await opened.harness.abortTask(task, context);
    expect(await failure).toBeDefined();
    expect(releases).toBe(1);
    expect(vm.starts()).toBe(0);
  }, 10_000);

  test('a host output policy keeps a high script budget through the real ToolTask', async () => {
    const opened = await fixture({ output: { limits: false } });
    const result = await opened.run('// @options: {"max_output_tokens":400000}\nreturn "x".repeat(1100000);');
    expect(result.output?.[1]).toEqual({ type: 'text', text: 'x'.repeat(1_100_000) });
    expect(text(result)).not.toContain('Warning: truncated output');
  }, 10_000);

  test('the writer, image label and elapsed-time callback work without an environment', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOXsAAAAASUVORK5CYII=';
    const writes: Array<{ name: string; data: string | Uint8Array }> = [];
    const opened = await fixture({
      output: {
        limits: false,
        write: async (name, data) => { writes.push({ name, data }); return { path: `/test-output/${name}` }; },
        imageSize: () => 'native-size',
        wallMs: () => writes.length ? 2500 : 0,
      },
    });
    const result = await opened.run(`image("data:image/png;base64,${png}");`);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.data).toEqual(new Uint8Array(Buffer.from(png, 'base64')));
    expect(text(result)).toContain('native-size');
    expect(text(result)).toContain('/test-output/');
    expect(text(result)).toContain('Wall time 2.5 seconds');
    expect(result.output?.some(item => item.type === 'image' && item.data === png)).toBe(true);
  }, 10_000);

  test('custom discovery globals override the built-ins and retain journalled outcomes', async () => {
    let calls = 0;
    const opened = await fixture({
      globals: [{
        name: 'describeNamespace', spread: true,
        execute: async (args, api) => {
          expect(api.taskId).toBeGreaterThan(0);
          expect(args).toEqual(['manual']);
          calls++;
          return { name: 'docs', instructions: 'Read the manual', tools: ['echo'] };
        },
      }],
    }, true);
    const result = await opened.run('return await describeNamespace("manual");');
    expect(text(result)).toContain('"name":"docs"');
    expect(calls).toBe(1);
  }, 10_000);
});
