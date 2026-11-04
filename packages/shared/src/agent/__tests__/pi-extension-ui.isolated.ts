/** Run real native startup UI before a chat generator exists. */
import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExtensionUIController, ExtensionUIDialog, ExtensionUIEvent, ExtensionUIHostPort } from '../../protocol/extension-ui.ts';

const cleanup: Array<() => Promise<void>> = [];
const directories: string[] = [];
const originalConfig = process.env.CONFIG_DIR;
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation();
  if (originalConfig === undefined) delete process.env.CONFIG_DIR;
  else process.env.CONFIG_DIR = originalConfig;
});
// The shared config module keeps the first fixture's directory for this process.
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

async function fixture(automaticStartup = true, hostSeeds = false) {
  const directory = mkdtempSync(join(tmpdir(), 'mkagent-parent-ui-'));
  directories.push(directory);
  process.env.CONFIG_DIR = join(directory, 'config');
  const { ensureConfigDir } = await import('../../config/storage.ts');
  ensureConfigDir();
  const { PiAgent } = await import('../pi-agent.ts');
  const agentDir = join(directory, 'agent');
  mkdirSync(agentDir);
  const plugin = join(agentDir, 'ui.ts');
  const resultPath = join(directory, 'startup.json');
  const inputPath = join(directory, 'inputs.json');
  writeFileSync(inputPath, '[]');
  const promptPath = join(directory, 'fixture-prompt.md');
  writeFileSync(promptPath, 'Native prompt body: $1');
  const skillPath = join(directory, 'fixture-skill');
  mkdirSync(skillPath);
  writeFileSync(join(skillPath, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Local native skill fixture\n---\nNative skill body.');
  writeFileSync(plugin, `
    import { writeFileSync } from 'node:fs';
    export default function(pi) {
      const inputs = [];
      pi.on('input', event => {
        inputs.push({ text: event.text, source: event.source });
        writeFileSync(${JSON.stringify(inputPath)}, JSON.stringify(inputs));
        if (event.text === 'transform-fixture') return { action: 'transform', text: 'Native transformed text' };
        if (event.text === 'handled-fixture') return { action: 'handled' };
        if (event.text === 'invalid-transform') return { action: 'transform', text: null };
      });
      pi.on('session_start', async (_, ctx) => {
        const answer = await ctx.ui.input('Startup', 'placeholder');
        const result = { kind: 'startup', answer, hasUI: ctx.hasUI,
          tools: pi.getAllTools().map(tool => tool.name),
          hostTool: pi.getAllTools().some(tool => tool.name === 'mcp__session__SubmitPlan') };
        writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
        ctx.ui.notify(JSON.stringify(result), 'info');
        ctx.ui.setStatus('fixture', 'ready');
      });
      pi.registerCommand('ui-editor', { handler: async (_, ctx) => {
        const answer = await ctx.ui.editor('Edit', 'line one\\nline two');
        ctx.ui.notify(JSON.stringify({ kind: 'editor', answer, hasUI: ctx.hasUI }), 'info');
        ctx.ui.setWidget('fixture', ['done', ''], { placement: 'belowEditor' });
      } });
      pi.registerCommand('ui-followup', { handler: args => { pi.sendUserMessage(args); } });
      pi.registerCommand('ui-trigger', { handler: args => {
        pi.sendMessage({ customType: 'fixture', content: args, display: true }, { triggerTurn: true });
      } });
      pi.registerCommand('side-effect', { handler: () => {
        writeFileSync(${JSON.stringify(join(directory, 'side-effect.txt'))}, 'executed');
      } });
    }
  `);
  let completions = 0;
  let lastUserMessage = '';
  let blockedModel: { text: string; entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'ui-model' }] });
      completions++;
      const body = await request.json();
      if (!body || typeof body !== 'object' || !('messages' in body) || !Array.isArray(body.messages)) {
        throw new Error('Expected local OpenAI-compatible messages');
      }
      const content: unknown = body.messages.findLast(message => message.role === 'user')?.content;
      lastUserMessage = typeof content === 'string' ? content
        : Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : '';
      if (blockedModel && lastUserMessage.includes(blockedModel.text)) {
        blockedModel.entered.resolve();
        await blockedModel.release.promise;
      }
      const chunks = [
        { id: 'mini', choices: [{ index: 0, delta: { role: 'assistant', content: 'mini ready' } }] },
        { id: 'mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  cleanup.push(async () => { server.stop(true); });
  const events: ExtensionUIEvent[] = [];
  const receipts: Array<Promise<boolean>> = [];
  const lifecycle = { resets: 0, closes: 0 };
  const startup = Promise.withResolvers<ExtensionUIDialog>();
  let controller: ExtensionUIController | undefined;
  const port: ExtensionUIHostPort = {
    connect(value) {
      controller = value;
      value.setAvailable(true);
      return {
        event(event) {
          events.push(event);
          if (event.type !== 'extension_ui_request') return;
          if (event.method === 'input') {
            startup.resolve(event);
            if (automaticStartup) receipts.push(value.respond(event.uiEpoch, { type: 'extension_ui_response', id: event.id, value: '' }));
          } else if (event.method === 'editor') {
            receipts.push(value.respond(event.uiEpoch, { type: 'extension_ui_response', id: event.id, value: 'edited\ntext' }));
          }
        },
        reset() { lifecycle.resets++; },
        close() { lifecycle.closes++; },
      };
    },
  };
  const sessionId = `ui-${crypto.randomUUID()}`;
  const contexts = { branch: 0, handoff: 0 };
  const agent = new PiAgent({
    provider: 'pi', providerType: 'pi_compat', authType: 'none', model: 'ui-model', miniModel: 'pi/ui-model', agentProfile: 'coding',
    workspace: { id: sessionId, name: 'UI fixture', slug: sessionId, rootPath: directory, createdAt: Date.now() },
    session: { id: sessionId, workspaceRootPath: directory, createdAt: Date.now(), lastUsedAt: Date.now(), permissionMode: 'allow-all' },
    isHeadless: true, skipConfigWatcher: true, extensionUI: port,
    getBranchSeedMessages: () => hostSeeds && !contexts.branch ? [{ type: 'user', content: 'Host branch sentinel' }] : [],
    markBranchSeedApplied: () => { contexts.branch++; },
    getTransferredSessionSummary: () => hostSeeds && !contexts.handoff ? 'Host handoff sentinel' : null,
    markTransferredSessionSummaryApplied: () => { contexts.handoff++; },
    codingResources: { agentDir, resourcePolicy: 'host-only', extensionPaths: [plugin], promptPaths: [promptPath], skillPaths: [skillPath] },
    runtime: {
      paths: { node: process.execPath, piServer: resolve(import.meta.dir, '../../../../pi-agent-server/src/index.ts') },
      baseUrl: `http://127.0.0.1:${server.port}/v1`, customEndpoint: { api: 'openai-completions' },
      customModels: [{ id: 'ui-model', contextWindow: 16_384 }],
    },
  });
  cleanup.push(async () => { await agent.disposeForRestart(); agent.destroy(); });
  return {
    agent, events, receipts, lifecycle, contexts, startup: startup.promise,
    completions: () => completions,
    lastUserMessage: () => lastUserMessage,
    inputs: () => JSON.parse(readFileSync(inputPath, 'utf8')),
    holdModel(text: string) {
      const block = { text, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      blockedModel = block;
      return { entered: block.entered.promise, release: () => block.release.resolve() };
    },
    startupResult: () => JSON.parse(readFileSync(resultPath, 'utf8')),
    sideEffect: () => { try { return readFileSync(join(directory, 'side-effect.txt'), 'utf8'); } catch { return null; } },
    get controller(): ExtensionUIController {
      if (!controller) throw new Error('UI port was not connected');
      return controller;
    },
    notifications: () => events.flatMap(event =>
      event.type === 'extension_ui_request' && event.method === 'notify' ? [JSON.parse(event.message)] : []),
  };
}

test.each(['side-effect', 'model'])('stop during startup UI prevents a late %s prompt', async kind => {
  const f = await fixture(false);
  const events: Array<{ type: string }> = [];
  const running = (async () => {
    for await (const event of f.agent.chat(kind === 'side-effect' ? '/side-effect' : 'Call the model')) events.push(event);
  })();
  await f.startup;
  expect(f.agent.stopTurn()).toBe(true);
  await running;
  expect(f.completions()).toBe(0);
  // This real round trip orders the assertion after any wrongly admitted prompt.
  const request = await f.startup;
  expect(await f.controller.respond(request.uiEpoch, { type: 'extension_ui_response', id: 'barrier', cancelled: true })).toBe(false);
  expect(await f.agent.runMiniCompletion('Cancellation barrier')).toBe('mini ready');
  expect(f.completions()).toBe(1);
  expect(f.sideEffect()).toBeNull();
  expect(events.some(event => event.type === 'error')).toBe(false);
}, 30_000);

test('answers native startup UI before any chat with host tools already registered', async () => {
  const f = await fixture();
  expect(await f.agent.runMiniCompletion('Local fixture')).toBe('mini ready');
  const request = await f.startup;
  expect(f.startupResult()).toMatchObject({ kind: 'startup', answer: '', hasUI: true, hostTool: true });
  expect(f.notifications()).toContainEqual(f.startupResult());
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'extension_ui_request', method: 'setStatus', statusText: 'ready' }));
  expect(await f.controller.respond('old-epoch', { type: 'extension_ui_response', id: request.id, value: 'late' })).toBe(false);
  expect(await f.controller.respond(request.uiEpoch, { type: 'extension_ui_response', id: request.id, value: 'duplicate' })).toBe(false);
  const chatEvents = [];
  for await (const event of f.agent.chat('/ui-editor')) chatEvents.push(event);
  expect(chatEvents.filter(event => event.type === 'error')).toEqual([]);
  expect(chatEvents.at(-1)).toMatchObject({ type: 'complete' });
  expect(f.completions()).toBe(1);
  expect(f.notifications()).toContainEqual({ kind: 'editor', answer: 'edited\ntext', hasUI: true });
  expect(f.events).toContainEqual(expect.objectContaining({
    type: 'extension_ui_request', method: 'setWidget', widgetKey: 'fixture', widgetLines: ['done', ''], widgetPlacement: 'belowEditor',
  }));
  expect(await Promise.all(f.receipts)).toEqual([true, true]);
  expect(f.completions()).toBe(1);
  await f.agent.disposeForRestart();
  expect(f.lifecycle.closes).toBe(1);
  expect(f.lifecycle.resets).toBeGreaterThan(0);
}, 30_000);

test('disconnect releases startup and reconnect supports new commands without repeating startup', async () => {
  const f = await fixture(false);
  const opening = f.agent.runMiniCompletion('Local fixture');
  const request = await f.startup;
  f.controller.setAvailable(false);
  expect(await opening).toBe('mini ready');
  expect(f.startupResult()).toMatchObject({ kind: 'startup', hasUI: false, hostTool: true });
  expect(f.notifications()).toEqual([]);
  f.controller.setAvailable(true);
  expect(await f.controller.respond(request.uiEpoch, { type: 'extension_ui_response', id: request.id, value: 'late' })).toBe(false);
  const chatEvents = [];
  for await (const event of f.agent.chat('/ui-editor')) chatEvents.push(event);
  expect(chatEvents.filter(event => event.type === 'error')).toEqual([]);
  expect(chatEvents.at(-1)).toMatchObject({ type: 'complete' });
  expect(f.completions()).toBe(1);
  expect(f.notifications()).toContainEqual({ kind: 'editor', answer: 'edited\ntext', hasUI: true });
  expect(f.events.filter(event => event.type === 'extension_ui_request' && event.method === 'input')).toHaveLength(1);
  expect(await Promise.all(f.receipts)).toEqual([true]);
  expect(f.completions()).toBe(1);
}, 30_000);

test('native input hooks and resources receive raw input while model messages retain host context', async () => {
  const f = await fixture();
  await f.agent.runMiniCompletion('Local fixture');
  const cases = [
    { input: 'transform-fixture', expanded: 'Native transformed text' },
    { input: '/fixture-prompt value', expanded: 'Native prompt body: value' },
    { input: '/skill:fixture-skill value', expanded: 'Native skill body.' },
    { input: '/unknown-command value', expanded: '/unknown-command value' },
  ];
  for (const row of cases) {
    const events = [];
    for await (const event of f.agent.chat(row.input)) events.push(event);
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
    expect(f.inputs().at(-1)).toEqual({ text: row.input, source: 'rpc' });
    expect(f.lastUserMessage()).toContain(row.expanded);
    expect(f.lastUserMessage()).toContain('<session_state permission_mode="ask" />');
  }
  expect(f.completions()).toBe(5);
}, 30_000);

test('a handled native input hook completes product chat without asking the model', async () => {
  const f = await fixture();
  await f.agent.runMiniCompletion('Local fixture');
  const events = [];
  for await (const event of f.agent.chat('handled-fixture')) events.push(event);
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: 'complete' });
  expect(f.inputs().at(-1)).toEqual({ text: 'handled-fixture', source: 'rpc' });
  expect(f.completions()).toBe(1);
}, 30_000);

test.each(['ui-followup', 'ui-trigger'])('native %s keeps product chat open while its follow-up model response is pending', async command => {
  const f = await fixture();
  await f.agent.runMiniCompletion('Local fixture');
  const held = f.holdModel('Native followup gate');
  const events: Array<{ type: string }> = [];
  let completed = false;
  const chat = (async () => {
    for await (const event of f.agent.chat(`/${command} Native followup gate`)) events.push(event);
  })().finally(() => { completed = true; });
  const deadline = Promise.withResolvers<void>();
  const timer = setTimeout(() => deadline.reject(new Error('Follow-up model did not start')), 5_000);
  try {
    await Promise.race([held.entered, deadline.promise]);
    const startup = await f.startup;
    expect(await f.controller.respond(startup.uiEpoch, {
      type: 'extension_ui_response', id: 'followup-barrier', cancelled: true,
    })).toBe(false);
    expect(completed).toBe(false);
  } finally {
    clearTimeout(timer);
    held.release();
    await chat;
  }
  expect(f.completions()).toBe(2);
  expect(events.some(event => event.type === 'text_delta')).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: 'complete' });
}, 30_000);

test('native handled commands preserve branch and handoff context for the next model input', async () => {
  const f = await fixture(true, true);
  await f.agent.runMiniCompletion('Local fixture');
  for await (const _ of f.agent.chat('/ui-editor')) {}
  expect(f.contexts).toEqual({ branch: 0, handoff: 0 });
  for await (const _ of f.agent.chat('Use host context now')) {}
  expect(f.contexts).toEqual({ branch: 1, handoff: 1 });
  expect(f.lastUserMessage()).toContain('Host branch sentinel');
  expect(f.lastUserMessage()).toContain('Host handoff sentinel');
  for await (const _ of f.agent.chat('Continue without repeating host context')) {}
  expect(f.contexts).toEqual({ branch: 1, handoff: 1 });
  expect(f.lastUserMessage()).not.toContain('Host branch sentinel');
  expect(f.lastUserMessage()).not.toContain('Host handoff sentinel');
}, 30_000);

test('a native prompt error releases context confirmation and preserves it for recovery', async () => {
  const f = await fixture(true, true);
  await f.agent.runMiniCompletion('Local fixture');
  const events: Array<{ type: string }> = [];
  let finished = false;
  const chat = (async () => {
    for await (const event of f.agent.chat('invalid-transform')) events.push(event);
  })().finally(() => { finished = true; });
  const deadline = Promise.withResolvers<void>();
  const timer = setTimeout(() => deadline.reject(new Error('Prompt error did not finish product chat')), 3_000);
  try {
    await Promise.race([chat, deadline.promise]);
  } finally {
    clearTimeout(timer);
    if (!finished) await f.agent.abort();
    await chat;
  }
  expect(events.some(event => event.type === 'error' || event.type === 'typed_error')).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: 'complete' });
  expect(f.contexts).toEqual({ branch: 0, handoff: 0 });
  for await (const _ of f.agent.chat('Recover using the host context')) {}
  expect(f.contexts).toEqual({ branch: 1, handoff: 1 });
  expect(f.lastUserMessage()).toContain('Host branch sentinel');
  expect(f.lastUserMessage()).toContain('Host handoff sentinel');
}, 30_000);
