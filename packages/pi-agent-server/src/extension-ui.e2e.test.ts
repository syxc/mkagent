/** Exercise UI through real native extensions and a local durable kernel. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension } from '@earendil-works/pi-durable';
import { durableFixture } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { ExtensionUIHost, type ExtensionUIEvent } from './extension-ui.ts';
import { DurableKernel } from './kernel.ts';

type Request = Extract<ExtensionUIEvent, { type: 'extension_ui_request' }>;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

async function fixture(source: string, onEvent?: (event: ExtensionUIEvent, host: ExtensionUIHost) => void) {
  const root = await durableFixture([]);
  await root.harness.close(BACKGROUND_CONTEXT);
  cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const resultPath = join(root.directory, 'result.json');
  const plugin = join(agentDir, 'ui.ts');
  writeFileSync(plugin, `
    import { writeFileSync } from 'node:fs';
    const save = value => writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(value));
    export default function(pi) { ${source} }
  `);
  const events: ExtensionUIEvent[] = [];
  const ui = new ExtensionUIHost(event => { events.push(event); onEvent?.(event, ui); });
  ui.setAvailable(true);
  const errors: string[] = [];
  const kernel = new DurableKernel({
    sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'host', tools: [] }),
    coding: { agentDir, resourcePolicy: 'host-only', extensionPaths: [plugin],
      globalSettings: { compaction: { enabled: false }, cacheWarming: 'off' }, projectSettings: {} },
    codingUI: ui, wrapCodingTool: tool => tool,
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: value => errors.push(value) },
  });
  cleanup.push(() => kernel.close());
  return {
    kernel, ui, events, errors, root,
    open: () => kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } }),
    result: (): unknown => JSON.parse(readFileSync(resultPath, 'utf8')),
  };
}

test('answers a startup hook before kernel.open completes and rejects invalid or repeated responses', async () => {
  const f = await fixture(`
    pi.on('session_start', async (_, ctx) => {
      const choice = await ctx.ui.select('Startup', ['one', 'two']);
      save({ choice, hasUI: ctx.hasUI, mode: ctx.mode });
    });
  `, (event, ui) => {
    if (event.type !== 'extension_ui_request' || event.method !== 'select') return;
    const response = { type: 'extension_ui_response', id: event.id, value: 'two' } as const;
    expect(ui.respond('old-epoch', response)).toBe(false);
    expect(ui.respond(event.uiEpoch, { ...response, value: 'invented' })).toBe(false);
    expect(ui.respond(event.uiEpoch, { type: 'extension_ui_response', id: event.id, confirmed: true })).toBe(false);
    expect(ui.respond(event.uiEpoch, response)).toBe(true);
    expect(ui.respond(event.uiEpoch, response)).toBe(false);
  });
  await f.open();
  expect(f.result()).toEqual({ choice: 'two', hasUI: true, mode: 'rpc' });
  expect(f.errors).toEqual([]);
  expect(f.root.calls).toHaveLength(0);
});

test('preserves false, empty input, multiline editors and keyed display updates through native RPC methods', async () => {
  const f = await fixture(`
    pi.registerCommand('dialogs', { handler: async (_, ctx) => {
      const confirmed = await ctx.ui.confirm('Confirm', 'Separate from tool permission');
      const input = await ctx.ui.input('Input', 'placeholder');
      const edited = await ctx.ui.editor('Editor', 'line one\\nline two');
      ctx.ui.notify('notice', 'warning');
      ctx.ui.setStatus('status', '');
      ctx.ui.setStatus('status', undefined);
      ctx.ui.setWidget('widget', [], { placement: 'belowEditor' });
      ctx.ui.setWidget('widget', undefined);
      ctx.ui.setWidget('ignored-factory', () => { throw new Error('TUI factory must not execute'); });
      ctx.ui.setTitle('Plugin title');
      ctx.ui.setEditorText('');
      ctx.ui.pasteToEditor('pasted');
      const unsupported = await ctx.ui.custom(() => { throw new Error('TUI custom must not execute'); });
      save({ confirmed, input, edited, unsupported: unsupported ?? null,
        editorText: ctx.ui.getEditorText(), styled: ctx.ui.theme.fg('accent', 'styled').includes('styled') });
    } });
  `, (event, ui) => {
    if (event.type !== 'extension_ui_request') return;
    if (event.method === 'confirm') ui.respond(event.uiEpoch, { type: 'extension_ui_response', id: event.id, confirmed: false });
    if (event.method === 'input') ui.respond(event.uiEpoch, { type: 'extension_ui_response', id: event.id, value: '' });
    if (event.method === 'editor') {
      expect(event.prefill).toBe('line one\nline two');
      ui.respond(event.uiEpoch, { type: 'extension_ui_response', id: event.id, value: 'edited\ntext' });
    }
  });
  await f.open();
  await f.kernel.submitPrompt('/dialogs');
  await f.kernel.waitForIdle();
  expect(f.result()).toEqual({
    confirmed: false, input: '', edited: 'edited\ntext', unsupported: null, editorText: '', styled: true,
  });
  const requests = f.events.filter(event => event.type === 'extension_ui_request');
  expect(requests.filter(event => event.method === 'setStatus').map(event => event.statusText)).toEqual(['', undefined]);
  expect(requests.filter(event => event.method === 'setWidget').map(event => event.widgetLines)).toEqual([[], undefined]);
  expect(requests.filter(event => event.method === 'set_editor_text').map(event => event.text)).toEqual(['', 'pasted']);
  expect(requests.find(event => event.method === 'notify')).toMatchObject({ notifyType: 'warning', message: 'notice' });
  expect(requests.find(event => event.method === 'setTitle')).toMatchObject({ title: 'Plugin title' });
  expect(f.errors).toEqual([]);
  expect(f.root.calls).toHaveLength(0);
});

test('honors native timeout and AbortSignal defaults and rejects late replies', async () => {
  const f = await fixture(`
    pi.on('session_start', async (_, ctx) => {
      const timed = await ctx.ui.confirm('Timed', 'message', { timeout: 5 });
      const controller = new AbortController();
      const pending = ctx.ui.input('Aborted', undefined, { signal: controller.signal });
      controller.abort();
      const aborted = await pending;
      const alreadyAborted = await ctx.ui.select('Never emitted', ['one'], { signal: controller.signal });
      save({ timed, aborted: aborted ?? null, alreadyAborted: alreadyAborted ?? null });
    });
  `);
  await f.open();
  expect(f.result()).toEqual({ timed: false, aborted: null, alreadyAborted: null });
  const requests = f.events.filter(event => event.type === 'extension_ui_request');
  expect(requests.map(event => event.method)).toEqual(['confirm', 'input']);
  for (const request of requests) {
    expect(f.ui.respond(request.uiEpoch, { type: 'extension_ui_response', id: request.id, cancelled: true })).toBe(false);
    expect(f.events.filter(event => event.type === 'extension_ui_closed' && event.id === request.id)).toHaveLength(1);
  }
  expect(f.errors).toEqual([]);
});

test('abort releases a waiting command and suppresses follow-up dialogs until its action drains', async () => {
  const requested = Promise.withResolvers<Request>();
  const f = await fixture(`
    pi.registerCommand('wait', { handler: async (_, ctx) => {
      const value = await ctx.ui.input('Waiting');
      const followup = await ctx.ui.confirm('After cancellation', 'must use native false fallback');
      save({ value: value ?? null, followup, hasUI: ctx.hasUI });
    } });
  `, event => {
    if (event.type === 'extension_ui_request' && event.method === 'input') requested.resolve(event);
  });
  await f.open();
  const command = f.kernel.submitPrompt('/wait');
  const request = await requested.promise;
  await f.kernel.abort();
  await command;
  expect(f.result()).toEqual({ value: null, followup: false, hasUI: false });
  expect(f.events.filter(event => event.type === 'extension_ui_request')).toHaveLength(1);
  expect(f.ui.respond(request.uiEpoch, { type: 'extension_ui_response', id: request.id, value: 'late' })).toBe(false);
  expect(f.events.at(-1)).toMatchObject({ type: 'extension_ui_state', available: true, reset: false });
  expect(f.errors).toEqual([]);
});

test('abort preserves persistent display cleanup from a cancelled native command', async () => {
  const requested = Promise.withResolvers<Request>();
  const f = await fixture(`
    pi.registerCommand('wait', { handler: async (_, ctx) => {
      ctx.ui.setStatus('job', 'Waiting');
      ctx.ui.setWidget('job', ['Waiting']);
      try { await ctx.ui.input('Waiting'); }
      finally {
        ctx.ui.setStatus('job', undefined);
        ctx.ui.setWidget('job', undefined);
        save({ hasUI: ctx.hasUI });
      }
    } });
  `, event => {
    if (event.type === 'extension_ui_request' && event.method === 'input') requested.resolve(event);
  });
  await f.open();
  const command = f.kernel.submitPrompt('/wait');
  await requested.promise;
  await f.kernel.abort();
  await command;
  expect(f.result()).toEqual({ hasUI: false });
  expect(f.events.filter(event => event.type === 'extension_ui_request' && event.method === 'setStatus'))
    .toMatchObject([{ statusKey: 'job', statusText: 'Waiting' }, { statusKey: 'job', statusText: undefined }]);
  expect(f.events.filter(event => event.type === 'extension_ui_request' && event.method === 'setWidget'))
    .toMatchObject([{ widgetKey: 'job', widgetLines: ['Waiting'] }, { widgetKey: 'job', widgetLines: undefined }]);
  expect(f.errors).toEqual([]);
});

test('disconnect cancels pending UI and reconnect changes hasUI without rerunning startup hooks', async () => {
  const requested = Promise.withResolvers<Request>();
  const f = await fixture(`
    let starts = 0;
    pi.on('session_start', () => { starts++; });
    pi.registerCommand('wait', { handler: async (_, ctx) => {
      const value = await ctx.ui.input('Waiting');
      save({ value: value ?? null, hasUI: ctx.hasUI, starts });
    } });
    pi.registerCommand('state', { handler: async (_, ctx) => {
      save({ hasUI: ctx.hasUI, mode: ctx.mode, starts });
    } });
  `, event => {
    if (event.type === 'extension_ui_request' && event.method === 'input') requested.resolve(event);
  });
  await f.open();
  const command = f.kernel.submitPrompt('/wait');
  const request = await requested.promise;
  f.ui.setAvailable(false);
  await command;
  expect(f.result()).toEqual({ value: null, hasUI: false, starts: 1 });
  expect(f.ui.respond(request.uiEpoch, { type: 'extension_ui_response', id: request.id, value: 'late' })).toBe(false);
  f.ui.setAvailable(true);
  await f.kernel.submitPrompt('/state');
  expect(f.result()).toEqual({ hasUI: true, mode: 'rpc', starts: 1 });
  expect(f.errors).toEqual([]);
});

test('close releases pending dialogs before draining actions and prevents shutdown hook deadlock', async () => {
  const requested = Promise.withResolvers<Request>();
  const f = await fixture(`
    pi.registerCommand('wait', { handler: async (_, ctx) => { await ctx.ui.input('Waiting'); } });
    pi.on('session_shutdown', async (_, ctx) => {
      save({ confirmed: await ctx.ui.confirm('Shutdown', 'no interactive client during close'), hasUI: ctx.hasUI });
    });
  `, event => {
    if (event.type === 'extension_ui_request' && event.method === 'input') requested.resolve(event);
  });
  await f.open();
  const command = f.kernel.submitPrompt('/wait');
  await requested.promise;
  await f.kernel.close();
  await command;
  expect(f.result()).toEqual({ confirmed: false, hasUI: false });
  expect(f.events.filter(event => event.type === 'extension_ui_request')).toHaveLength(1);
  expect(f.events.at(-1)).toMatchObject({ type: 'extension_ui_state', available: false, reset: true });
  expect(f.errors).toEqual([]);
});

test('reload cancels a pending dialog and enables startup UI in a fresh epoch', async () => {
  const waiting = Promise.withResolvers<Request>();
  const f = await fixture(`
    pi.on('session_start', async (_, ctx) => {
      save({ choice: await ctx.ui.select('Startup', ['one']), hasUI: ctx.hasUI, mode: ctx.mode });
    });
    pi.registerCommand('reload-ui', { handler: async (_, ctx) => {
      const pending = ctx.ui.input('Old input');
      await ctx.reload();
      if (await pending !== undefined) throw new Error('Retired input must be cancelled');
    } });
  `, (event, ui) => {
    if (event.type !== 'extension_ui_request') return;
    if (event.method === 'input') waiting.resolve(event);
    if (event.method === 'select') ui.respond(event.uiEpoch, { type: 'extension_ui_response', id: event.id, value: 'one' });
  });
  await f.open();
  const command = f.kernel.submitPrompt('/reload-ui');
  const oldRequest = await waiting.promise;
  await command;
  expect(f.result()).toEqual({ choice: 'one', hasUI: true, mode: 'rpc' });
  const startups = f.events.filter(event => event.type === 'extension_ui_request' && event.method === 'select');
  expect(startups).toHaveLength(2);
  expect(startups[1]!.uiEpoch).not.toBe(startups[0]!.uiEpoch);
  expect(f.ui.respond(oldRequest.uiEpoch, { type: 'extension_ui_response', id: oldRequest.id, value: 'late' })).toBe(false);
  expect(f.errors).toEqual([]);
});

test('retiring the UI host while native resources open prevents future interaction in that initialization', async () => {
  const f = await fixture(`
    pi.on('session_start', async (_, ctx) => {
      save({ value: await ctx.ui.input('Retired') ?? null, hasUI: ctx.hasUI, mode: ctx.mode });
    });
  `);
  f.ui.close();
  f.ui.setAvailable(true);
  await f.open();
  expect(f.result()).toEqual({ value: null, hasUI: false, mode: 'print' });
  expect(f.events.filter(event => event.type === 'extension_ui_request')).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

test('mixed cancelled replies always use native false and undefined defaults', async () => {
  const f = await fixture(`
    pi.on('session_start', async (_, ctx) => {
      save({
        confirmed: await ctx.ui.confirm('Confirm', 'Cancelled wins'),
        selected: await ctx.ui.select('Select', ['two']) ?? null,
        input: await ctx.ui.input('Input') ?? null,
        editor: await ctx.ui.editor('Editor') ?? null,
      });
    });
  `, (event, ui) => {
    if (event.type !== 'extension_ui_request') return;
    expect(ui.respond(event.uiEpoch, {
      type: 'extension_ui_response', id: event.id, cancelled: true, confirmed: true, value: 'two',
    })).toBe(true);
  });
  await f.open();
  expect(f.result()).toEqual({ confirmed: false, selected: null, input: null, editor: null });
});

test('abort waits for reload startup asynchronous work and suppresses its next dialog', async () => {
  const key = `native-ui-reload-${crypto.randomUUID()}`;
  const gate = { entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
  Reflect.set(globalThis, key, gate);
  const requested = Promise.withResolvers<Request>();
  const f = await fixture(`
    pi.on('session_start', async (event, ctx) => {
      if (event.reason !== 'reload') return;
      const initial = await ctx.ui.input('Reload input');
      const gate = globalThis[${JSON.stringify(key)}];
      gate.entered.resolve();
      await gate.resume.promise;
      const followup = await ctx.ui.confirm('Followup', 'After asynchronous startup work');
      save({ initial: initial ?? null, followup, hasUI: ctx.hasUI });
    });
    pi.registerCommand('reload-ui', { handler: async (_, ctx) => { await ctx.reload(); } });
  `, (event, ui) => {
    if (event.type !== 'extension_ui_request') return;
    if (event.method === 'input') requested.resolve(event);
    // Let the red run finish even if it incorrectly opens a second question.
    if (event.method === 'confirm') ui.respond(event.uiEpoch, { type: 'extension_ui_response', id: event.id, cancelled: true });
  });
  cleanup.push(() => { gate.resume.resolve(); Reflect.deleteProperty(globalThis, key); });
  await f.open();
  const reloading = f.kernel.submitPrompt('/reload-ui');
  await requested.promise;
  let stopped = false;
  const aborting = f.kernel.abort().then(() => { stopped = true; });
  await gate.entered.promise;
  // Startup is held by the fixture while the local abort drains all runnable work.
  await new Promise(resolve => setTimeout(resolve, 100));
  const stoppedBeforeStartupFinished = stopped;
  gate.resume.resolve();
  await aborting;
  await reloading;
  expect(stoppedBeforeStartupFinished).toBe(false);
  expect(f.result()).toEqual({ initial: null, followup: false, hasUI: false });
  expect(f.events.filter(event => event.type === 'extension_ui_request' && event.method === 'confirm')).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

test('abort spans the reload interval while extension factories are still loading', async () => {
  const key = `native-ui-loading-${crypto.randomUUID()}`;
  const gate = { loads: 0, entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
  Reflect.set(globalThis, key, gate);
  const f = await fixture(`
    const gate = globalThis[${JSON.stringify(key)}];
    gate.loads++;
    const install = () => {
      pi.on('session_start', async (event, ctx) => {
        if (event.reason === 'reload') save({
          followup: await ctx.ui.confirm('After load', 'Still part of the stopped reload'),
          hasUI: ctx.hasUI,
        });
      });
      pi.registerCommand('reload-ui', { handler: async (_, ctx) => { await ctx.reload(); } });
    };
    if (gate.loads === 2) {
      gate.entered.resolve();
      return gate.resume.promise.then(install);
    }
    install();
  `, (event, ui) => {
    if (event.type === 'extension_ui_request' && event.method === 'confirm') {
      ui.respond(event.uiEpoch, { type: 'extension_ui_response', id: event.id, cancelled: true });
    }
  });
  cleanup.push(() => { gate.resume.resolve(); Reflect.deleteProperty(globalThis, key); });
  await f.open();
  const reloading = f.kernel.submitPrompt('/reload-ui');
  await gate.entered.promise;
  let stopped = false;
  const aborting = f.kernel.abort().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  const stoppedBeforeLoadFinished = stopped;
  gate.resume.resolve();
  await aborting;
  await reloading;
  expect(stoppedBeforeLoadFinished).toBe(false);
  expect(f.result()).toEqual({ followup: false, hasUI: false });
  expect(f.events.filter(event => event.type === 'extension_ui_request')).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

test('abort racing source shutdown does not flush a closed journal after reload', async () => {
  const key = `native-ui-shutdown-${crypto.randomUUID()}`;
  const gate = { loads: 0, entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
  Reflect.set(globalThis, key, gate);
  const f = await fixture(`
    const gate = globalThis[${JSON.stringify(key)}];
    gate.loads++;
    const load = gate.loads;
    pi.on('session_shutdown', async () => {
      if (load !== 1) return;
      gate.entered.resolve();
      await gate.resume.promise;
    });
    pi.on('session_start', (event, ctx) => {
      if (event.reason === 'reload') save({ hasUI: ctx.hasUI });
    });
    pi.registerCommand('reload-ui', { handler: async (_, ctx) => { await ctx.reload(); } });
  `);
  cleanup.push(() => { gate.resume.resolve(); Reflect.deleteProperty(globalThis, key); });
  await f.open();
  const reloading = f.kernel.submitPrompt('/reload-ui');
  await gate.entered.promise;
  const aborting = f.kernel.abort();
  gate.resume.resolve();
  await aborting;
  await reloading;
  expect(f.result()).toEqual({ hasUI: false });
  expect(f.errors).toEqual([]);
});

test('close waits for a reload already inside source shutdown and disposes its replacement', async () => {
  const key = `native-ui-close-${crypto.randomUUID()}`;
  const gate = { loads: 0, entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
  Reflect.set(globalThis, key, gate);
  const f = await fixture(`
    const gate = globalThis[${JSON.stringify(key)}];
    const load = ++gate.loads;
    pi.on('session_shutdown', async () => {
      if (load !== 1) return;
      gate.entered.resolve();
      await gate.resume.promise;
    });
    pi.registerCommand('reload-ui', { handler: async (_, ctx) => { await ctx.reload(); } });
  `);
  cleanup.push(() => { gate.resume.resolve(); Reflect.deleteProperty(globalThis, key); });
  await f.open();
  const reloading = f.kernel.submitPrompt('/reload-ui');
  await gate.entered.promise;
  const closing = f.kernel.close();
  gate.resume.resolve();
  const results = await Promise.allSettled([closing, reloading]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(f.events.at(-1)).toMatchObject({ type: 'extension_ui_state', available: false, reset: true });
  expect(f.errors).toEqual([]);
});

test('concurrent reload calls share one replacement host and startup', async () => {
  const key = `native-ui-double-reload-${crypto.randomUUID()}`;
  const gate = { loads: 0 };
  Reflect.set(globalThis, key, gate);
  const f = await fixture(`
    const gate = globalThis[${JSON.stringify(key)}];
    ++gate.loads;
    pi.registerCommand('double-reload', { handler: async (_, ctx) => {
      await Promise.all([ctx.reload(), ctx.reload()]);
      save({ loads: gate.loads });
    } });
  `);
  cleanup.push(() => Reflect.deleteProperty(globalThis, key));
  await f.open();
  await f.kernel.submitPrompt('/double-reload');
  expect(gate.loads).toBe(2);
  expect(f.result()).toEqual({ loads: 2 });
  expect(f.errors).toEqual([]);
});

for (const operation of ['reload', 'newSession', 'fork']) {
  test(`close rejects a late ${operation} from a command draining cancelled UI`, async () => {
    const key = `native-ui-late-${crypto.randomUUID()}`;
    const gate = {
      entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>(),
      escape: Promise.withResolvers<void>(), result: Promise.withResolvers<string>(),
    };
    Reflect.set(globalThis, key, gate);
    const sourceClosing = Promise.withResolvers<void>();
    const f = await fixture(`
      const gate = globalThis[${JSON.stringify(key)}];
      pi.registerCommand('late-transition', { handler: async (_, ctx) => {
        const selected = ctx.sessionManager.getEntries().find(e => e.type === 'message' && e.message.role === 'user');
        gate.entered.resolve();
        await ctx.ui.input('Hold command');
        await gate.resume.promise;
        try {
          await Promise.race([ctx[${JSON.stringify(operation)}](${operation === 'fork' ? 'selected.id' : ''}), gate.escape.promise]);
          gate.result.resolve('allowed');
        } catch (error) { gate.result.resolve(error.message); }
      } });
    `, event => {
      if (event.type === 'extension_ui_state' && event.reset && !event.available) sourceClosing.resolve();
    });
    cleanup.push(() => { gate.resume.resolve(); gate.escape.resolve(); Reflect.deleteProperty(globalThis, key); });
    await f.open();
    if (operation === 'fork') {
      await f.kernel.submitPrompt('Fork seed');
      await f.kernel.waitForIdle();
    }
    const command = f.kernel.submitPrompt('/late-transition');
    await gate.entered.promise;
    const closing = f.kernel.close();
    await sourceClosing.promise;
    gate.resume.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      closing.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 150); }),
    ]);
    clearTimeout(timer);
    // Release the old implementation's cycle so the red run can finish teardown.
    gate.escape.resolve();
    await Promise.allSettled([closing, command]);
    expect(finished).toBe(true);
    expect(await gate.result.promise).toContain('closing');
    expect(f.errors).toEqual([]);
  });
}
