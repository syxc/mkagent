import { afterEach, describe, expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { CodemodeSandbox } from '@earendil-works/pi-durable/codemode/node';
import {
  createRegistry, defineTool, Harness, MemoryStorage, type CommitPublication, type TaskId, type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';
import {
  createCodemodeExtension, type CodemodeSandboxLease, type CodemodeStoreAdapter, type CodemodeToolOptions,
} from '@earendil-works/pi-durable/codemode';

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | void> = [];
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

async function fixture(options: Partial<CodemodeToolOptions> = {}, repeat = false, extraTools: ToolRegistration[] = []) {
  const registry = createRegistry();
  const extension = createCodemodeExtension({
    sandbox: options.sandbox ?? sandbox().value, models: false, ...options,
  });
  let result: ToolExecutionResult | undefined;
  const failures: unknown[] = [];
  registry.install({
    ...extension,
    tools: [...(extension.tools?.map((tool): ToolRegistration => tool.name !== 'codemode' ? tool : {
      ...tool,
      execute: async (args, api, ctx) => {
        try {
          result = await tool.execute(args, api, ctx);
          if (repeat) expect(await tool.execute(args, api, ctx)).toEqual(result);
          return result;
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
    }) ?? []), ...extraTools],
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
  const receipts: CommitPublication[] = [];
  const observation = harness.observeCommits({ advance: receipt => { receipts.push(receipt); }, end: () => {} });
  cleanups.push(() => observation.detach());
  const conversation = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  const run = async (code: string): Promise<ToolExecutionResult> => {
    result = undefined;
    failures.length = 0;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('codemode', { code }, { id: 'policy-script' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('done')]),
    ]);
    await (await conversation.submit({ type: 'input', content: 'Run local code' }, context)).wait(context);
    if (failures.length) throw failures[0];
    if (result === undefined) throw new Error('The model did not execute codemode');
    return result;
  };
  return { run, harness, receipts, advance: (ms: number) => { now += ms; } };
}

function text(result: ToolExecutionResult) {
  return result.output?.flatMap(item => item.type === 'text' ? [item.text] : []).join('') ?? '';
}

describe('public durable codemode host policies', () => {
  test('tool aliases retain discovery, namespaces and the real registered admission name', async () => {
    let effects = 0;
    const observed: string[] = [];
    const opened = await fixture({
      aliases: { private_registered: 'visible.tool' },
      namespaces: [{ name: 'visible', prefix: 'visible.' }],
      onCallStart: call => { observed.push(call.name); },
    }, false, [defineTool({
      name: 'private_registered', description: 'Unique aliased fixture', parameters: obj({}), callers: ['tools'],
      execute: async () => { effects++; return { output: [{ type: 'text', text: 'alias-result' }] }; },
    })]);
    const result = await opened.run(`
      const sample=await describeTool("visible.tool");
      if(typeof sample!=="string") throw new Error("Missing alias sample");
      const namespace=await describeNamespace("visible");
      if(namespace?.tools[0]!=="visible_tool") throw new Error("Wrong namespace binding");
      const found=await searchTools("Unique aliased fixture",{namespace:"visible"});
      if(found[0]?.name!=="visible_tool") throw new Error("Wrong search binding");
      return [await tools.visible_tool({}),sample,namespace,found];
    `);
    expect(result.isError).toBe(false);
    expect(text(result)).toContain('alias-result');
    expect(text(result)).toContain('visible_tool');
    expect(observed).toEqual(['private_registered']);
    expect(effects).toBe(1);
  }, 10_000);

  test.each([false, true])('preparation can reject before rows or admission (async: %s)', async asynchronous => {
    const observed: number[] = [];
    let effects = 0;
    const opened = await fixture({
      prepareCall: call => {
        const prepare = () => {
          if (call.name === 'prepared' && call.id === 1) throw new Error('Invalid helper context');
        };
        return asynchronous ? Promise.resolve().then(prepare) : prepare();
      },
      onCallStart: call => { observed.push(call.id); },
    }, false, [defineTool({
      name: 'prepared', description: 'Prepare before admission', parameters: obj({}), callers: ['tools'],
      execute: async () => { effects++; return { output: [{ type: 'text', text: 'accepted' }] }; },
    })]);
    const result = await opened.run(`
      try { await tools.prepared({}); } catch (e) { text(e.message); }
      return await tools.prepared({});
    `);
    expect(result.isError).toBe(false);
    expect(text(result)).toContain('Invalid helper context');
    expect(text(result)).toContain('accepted');
    expect(observed).toEqual([2]);
    expect(effects).toBe(1);
    expect(result.details).toMatchObject({ calls: [{ id: 2, name: 'prepared', status: 'ok' }] });
    const admitted = new Set(opened.receipts.flatMap(receipt => receipt.changes.flatMap(change =>
      change.type === 'task' && JSON.stringify(change.value.input).includes('"name":"prepared"')
        ? [change.value.id] : [])));
    expect(admitted.size).toBe(1);
  }, 10_000);

  test('the host projects the entire result once, after release and before durable result reuse', async () => {
    const vm = sandbox();
    let releases = 0;
    let projections = 0;
    const usage = {
      input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const opened = await fixture({
      sandbox: async () => ({ sandbox: vm.value, release: () => { releases++; } }),
      formatResult: (result, info) => {
        projections++;
        expect(releases).toBe(1);
        expect(result.ok).toBe(true);
        expect(info.calls).toEqual([]);
        expect(info.maxOutputTokens).toBe(12345);
        return { output: [{ type: 'text', text: 'host projection' }], details: { calls: ['native-id'] }, usage };
      },
    }, true);
    const result = await opened.run('// @options: {"max_output_tokens":12345}\nreturn "script value";');
    expect(text(result)).toBe('host projection');
    expect(result.details).toEqual({ calls: ['native-id'] });
    expect(result.usage).toEqual(usage);
    expect(projections).toBe(1);
    expect(vm.starts()).toBe(1);
  }, 10_000);

  test('each issued call is observed before its actual official ToolTask executes', async () => {
    const started = new Set<number>();
    const names: string[] = [];
    let effects = 0;
    const effect = defineTool({
      name: 'observed', description: 'Observe admission', parameters: obj({}), callers: ['tools'],
      execute: async () => {
        effects++;
        expect(started.size).toBeGreaterThan(0);
        return { output: [{ type: 'text', text: 'observed effect' }] };
      },
    });
    const opened = await fixture({
      onCallStart: call => {
        started.add(call.id);
        names.push(call.name);
        expect(call.args).toEqual({});
      },
    }, true, [effect]);
    const result = await opened.run('return await tools.observed({});');
    expect(text(result)).toContain('observed effect');
    expect(names).toEqual(['observed']);
    expect(started).toEqual(new Set([1]));
    expect(effects).toBe(1);
  }, 10_000);

  test.each([false, true])('an observer failure stops the VM after preparation (async: %s)', async asynchronous => {
    const vm = sandbox();
    const refused = new Error('host observer refused');
    let releases = 0;
    let effects = 0;
    const opened = await fixture({
      sandbox: async () => ({ sandbox: vm.value, release: () => { releases++; } }),
      prepareCall: asynchronous ? async () => {} : undefined,
      onCallStart: () => { throw refused; },
    }, false, [defineTool({
      name: 'observed', description: 'Refuse admission', parameters: obj({}), callers: ['tools'],
      execute: async () => { effects++; return { output: [] }; },
    })]);
    await expect(opened.run('await tools.observed({});')).rejects.toBe(refused);
    expect(releases).toBe(1);
    expect(effects).toBe(0);
  }, 10_000);

  test('preparation finishing after the VM returns admits no observer or effect', async () => {
    const vm = sandbox();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let preparations = 0, observed = 0, effects = 0;
    const opened = await fixture({
      sandbox: async () => ({ sandbox: vm.value, release }),
      prepareCall: async () => { preparations++; await gate; },
      onCallStart: () => { observed++; },
    }, false, [defineTool({
      name: 'prepared', description: 'Wait for preparation', parameters: obj({}), callers: ['tools'],
      execute: async () => { effects++; return { output: [] }; },
    })]);
    const result = await opened.run('tools.prepared({}); return "finished";');
    expect(text(result)).toContain('finished');
    expect(preparations).toBe(1);
    expect(observed).toBe(0);
    expect(effects).toBe(0);
    expect(opened.receipts.flatMap(receipt => receipt.changes).filter(change =>
      change.type === 'task' && JSON.stringify(change.value.input).includes('"name":"prepared"'))).toHaveLength(0);
  }, 10_000);

  test('model observers retain registered names for all issued calls, including queued helpers', async () => {
    const names: string[] = [];
    const opened = await fixture({ models: true, onCallStart: call => { names.push(call.name); } });
    const result = await opened.run(
      'return await Promise.allSettled(Array.from({length:6},()=>models.classify({provider:"faux",id:"faux-1"},{})));');
    expect(result.isError).toBe(false);
    expect(names).toEqual(Array(6).fill('pi.codemode.models.classify'));
  }, 10_000);

  test.each([undefined, null, 0])('an observer throwing %s still fails instead of publishing a cancellation result', async error => {
    const opened = await fixture({
      onCallStart: () => { throw error; },
    }, false, [defineTool({
      name: 'observed', description: 'Observe a thrown value', parameters: obj({}), callers: ['tools'],
      execute: async () => ({ output: [] }),
    })]);
    const outcome = await opened.run('await tools.observed({});').then(
      value => ({ value }), error => ({ error }));
    expect(outcome).toEqual({ error });
  }, 10_000);

  for (const releaseFails of [false, true]) {
    test(`caller cancellation ${releaseFails ? 'preserves a release failure' : 'returns partial output without a result or store publication'}`, async () => {
      const vm = sandbox();
      const cleanup = new Error('cleanup failed during cancellation');
      let task!: TaskId;
      let entered!: () => void;
      const ready = new Promise<void>(done => { entered = done; });
      let releases = 0;
      let writes = 0;
      let projected = 0;
      const opened = await fixture({
        sandbox: async api => {
          task = api.taskId;
          return {
            sandbox: vm.value,
            release: async () => {
              releases++;
              await vm.value.close();
              if (releaseFails) throw cleanup;
            },
          };
        },
        cancellation: 'result',
        store: { read: () => ({}), write: () => { writes++; } },
        formatResult: (result, info) => {
          projected++;
          expect(releases).toBe(1);
          expect(result.ok).toBe(false);
          expect(info.calls).toMatchObject([{ name: 'wait', status: 'cancelled' }]);
          return { output: result.output, isError: !result.ok, details: { cancelled: true } };
        },
      }, false, [defineTool({
        name: 'wait', description: 'Wait for cancellation', parameters: obj({}), callers: ['tools'],
        execute: async (_args, _api, ctx) => {
          entered();
          await new Promise<void>(done => {
            if (ctx.abortSignal?.aborted) done();
            else ctx.abortSignal?.addEventListener('abort', () => done(), { once: true });
          });
          return { output: [] };
        },
      })]);
      const running = opened.run('store("uncommitted", 1); text("partial before cancel"); await tools.wait({});');
      const settled = running.then(value => ({ value }), error => ({ error }));
      await ready;
      await opened.harness.abortTask(task, context);
      const outcome = await settled;
      if (releaseFails) {
        expect(outcome).toEqual({ error: cleanup });
        expect(projected).toBe(0);
      } else {
        expect('value' in outcome).toBe(true);
        if (!('value' in outcome)) throw outcome.error;
        expect(text(outcome.value)).toContain('partial before cancel');
        expect(outcome.value.isError).toBe(true);
        expect(projected).toBe(1);
      }
      expect(releases).toBe(1);
      expect(writes).toBe(0);
      expect(opened.receipts.some(receipt => receipt.changes.some(change =>
        change.type === 'document' && change.kind === 'change' && change.record.kind === 'pi.codemode.run'
          && change.value.result !== undefined))).toBe(false);
    }, 10_000);
  }

  for (const [cancellation, projectionFails] of [['result', false], ['result', true], ['throw', false]] as const) {
    test(`cancellation during projection (${cancellation}, failure: ${projectionFails}) retains output or the original error`, async () => {
      const vm = sandbox();
      const projectionError = new Error('projection failed during cancellation');
      let task!: TaskId;
      let entered!: () => void;
      const ready = new Promise<void>(done => { entered = done; });
      let cancelled!: Promise<void>;
      let reason: unknown;
      let releases = 0;
      let writes = 0;
      let projections = 0;
      const opened = await fixture({
        sandbox: async (api, ctx) => {
          task = api.taskId;
          cancelled = new Promise<void>(done => {
            ctx.abortSignal?.addEventListener('abort', () => { reason = ctx.abortSignal?.reason; done(); }, { once: true });
          });
          return { sandbox: vm.value, release: () => { releases++; } };
        },
        cancellation,
        store: { read: () => ({}), write: () => { writes++; } },
        formatResult: async result => {
          projections++;
          expect(result.ok).toBe(true);
          expect(releases).toBe(1);
          entered();
          await cancelled;
          if (projectionFails) throw projectionError;
          return { output: result.output, details: { projected: true } };
        },
      });
      const running = opened.run('store("uncommitted", 1); text("partial during projection");');
      const settled = running.then(value => ({ value }), error => ({ error }));
      await ready;
      await opened.harness.abortTask(task, context);
      const outcome = await settled;
      if (projectionFails) expect(outcome).toEqual({ error: projectionError });
      else if (cancellation === 'throw') expect(outcome).toEqual({ error: reason });
      else {
        expect('value' in outcome).toBe(true);
        if (!('value' in outcome)) throw outcome.error;
        expect(text(outcome.value)).toContain('partial during projection');
        expect(outcome.value.details).toEqual({ projected: true });
        expect(outcome.value.isError).toBe(true);
      }
      expect(projections).toBe(1);
      expect(writes).toBe(0);
      expect(opened.receipts.some(receipt => receipt.changes.some(change =>
        change.type === 'document' && change.kind === 'change' && change.record.kind === 'pi.codemode.run'
          && change.value.result !== undefined))).toBe(false);
    }, 10_000);
  }

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
