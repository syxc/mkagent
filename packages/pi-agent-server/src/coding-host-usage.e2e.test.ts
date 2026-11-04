import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension } from '@earendil-works/pi-durable';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { PiEventAdapter } from '../../shared/src/agent/backend/pi/event-adapter.ts';
import { durableFixture, response } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { DurableKernel, type DurableKernelOptions } from './kernel.ts';
import type { CodingHost } from './coding-host.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });
const model = { provider: 'faux', modelId: 'local', contextWindow: 100_000 };
const coding = (kernel: DurableKernel) => (kernel as unknown as { coding: CodingHost }).coding;

async function fixture(answers: AssistantMessage[]) {
  const root = await durableFixture(answers);
  await root.harness.close(BACKGROUND_CONTEXT);
  cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const path = join(agentDir, 'extension.ts');
  writeFileSync(path, 'export default function() {}');
  const events: Array<Record<string, any>> = [];
  const options: DurableKernelOptions = {
    sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'host' }), coding: { agentDir, extensionPaths: [path] },
    wrapCodingTool: tool => tool,
    hooks: { emitEvent: event => events.push(event), sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: () => {} },
  };
  const open = async () => {
    const kernel = new DurableKernel(options);
    cleanup.push(() => kernel.close());
    await kernel.open({ model });
    return kernel;
  };
  return { ...root, open, options, path, events };
}

test('native events transport canonical usage through the production UI adapter before completion', async () => {
  const state = await fixture([
    { ...response(''), stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'local-call', name: 'local_tool', arguments: {} }],
      usage: { ...response('').usage, input: 7_000, output: 0, totalTokens: 7_000 } },
    response('done'),
  ]);
  state.options.coding!.globalSettings = { compaction: { enabled: false, reserveTokens: 123 } };
  state.options.toolsExtension = defineExtension({ name: 'host', tools: [{
    name: 'local_tool', description: 'Local fixture', parameters: { type: 'object', properties: {} },
    execute: async () => ({ output: [{ type: 'text', text: 'local result' }] }),
  }] });
  const kernel = await state.open();
  await kernel.submitPrompt('hello');
  await kernel.waitForIdle();
  const terminal = state.events.find(event => event.type === 'agent_end')!;
  expect(terminal.contextUsage).toEqual(coding(kernel).session.getContextUsage());
  expect(terminal.compactionSettings).toEqual({ enabled: false, reserveTokens: 123 });
  const turns = state.events.filter(event => event.type === 'turn_end');
  expect(turns).toHaveLength(2);
  expect(turns[0].contextUsage.tokens).toBeGreaterThan(7_000);
  expect(turns[1].contextUsage.tokens).toBe(3);
  const adapter = new PiEventAdapter();
  const adapted = state.events.flatMap(event =>
    [...adapter.adaptEvent(event as Parameters<PiEventAdapter['adaptEvent']>[0])]);
  const completion = adapted.findIndex(event => event.type === 'complete');
  const occupancy = adapted.slice(0, completion).findLast(event => event.type === 'context_usage');
  expect(completion).toBeGreaterThan(0);
  expect(occupancy).toMatchObject({ contextUsage: {
    usedTokens: 3, limitTokens: 100_000, limitKind: 'context', canCompact: true,
  } });
  const ended = state.events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant');
  expect(ended).toHaveLength(2);
  expect(state.events.filter(event => event.type === 'pi_turn_anchor').map(event => event.sdkMessageId))
    .toEqual(ended.map(event => event.sdkMessageId));
});

test('native compaction, payloads and toggles use the same profile and window policy across model changes', async () => {
  const state = await fixture([]);
  state.options.autoCompactWindow = 100_000;
  state.options.coding!.projectTrusted = true;
  state.options.coding!.globalSettings = {
    compaction: { enabled: true, reserveTokens: 31_000,
      modelOverrides: { 'faux/local': { reserveTokens: 123 } } },
  };
  state.options.coding!.projectSettings = { compaction: { enabled: false } };
  const wide = { ...state.models.getModel('faux', 'local')!, id: 'wide', contextWindow: 1_000_000 };
  writeFileSync(state.path, `export default function(pi) {
    pi.registerProvider('faux', { models: [${JSON.stringify(state.models.getModel('faux', 'local'))}, ${JSON.stringify(wide)}] });
    pi.registerCommand('refresh', { handler: async (_args, ctx) => { await ctx.reload(); } });
  }`);
  const kernel = await state.open();
  expect(kernel.getAutoCompactionEnabled()).toBe(false);
  expect((await kernel.contextUsagePayload()).compactionSettings).toEqual({ enabled: false, reserveTokens: 123 });
  await kernel.setModel({ provider: 'faux', modelId: 'wide', contextWindow: 1_000_000 });
  expect(coding(kernel).session.settingsManager.getCompactionSettings(coding(kernel).session.model))
    .toMatchObject({ enabled: false, reserveTokens: 900_000 });
  expect((await kernel.contextUsagePayload()).compactionSettings).toEqual({ enabled: false, reserveTokens: 900_000 });
  kernel.setAutoCompaction(true);
  expect(kernel.getAutoCompactionEnabled()).toBe(false);
  coding(kernel).session.settingsManager.setTheme('changed');
  await coding(kernel).session.settingsManager.flush();
  await coding(kernel).session.settingsManager.reload();
  expect((await kernel.contextUsagePayload()).compactionSettings.reserveTokens).toBe(900_000);
  expect(coding(kernel).session.settingsManager.getGlobalSettings().compaction?.reserveTokens).toBe(31_000);
  await kernel.submitPrompt('/refresh');
  expect((await kernel.contextUsagePayload()).compactionSettings).toEqual({ enabled: false, reserveTokens: 900_000 });
  await kernel.setModel(model);
  expect((await kernel.contextUsagePayload()).compactionSettings.reserveTokens).toBe(123);
});

test('autoCompactWindow drives actual native threshold compaction and reports unknown post-compaction occupancy', async () => {
  const answers = [200, 201].map((tokens, index) => ({
    ...response(`answer ${index}`), timestamp: Date.now() + (index + 1) * 60_000,
    usage: { ...response('').usage, input: tokens, output: 0, totalTokens: tokens },
  }));
  const state = await fixture(answers);
  state.options.autoCompactWindow = 200;
  state.options.coding!.globalSettings = {
    compaction: { enabled: true, reserveTokens: 33, keepRecentTokens: 1 },
  };
  writeFileSync(state.path, `export default function(pi) {
    pi.on('session_before_compact', event => ({ compaction: {
      summary: 'local summary', firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    } }));
  }`);
  const kernel = await state.open();
  await kernel.submitPrompt('first');
  await kernel.waitForIdle();
  expect(state.events.filter(event => event.type === 'compaction_start')).toHaveLength(0);
  await kernel.submitPrompt('second');
  await kernel.waitForIdle();
  const ends = state.events.filter(event => event.type === 'compaction_end');
  expect(ends.length).toBeGreaterThan(0);
  expect(ends.at(-1)).toMatchObject({
    reason: 'threshold', aborted: false, result: { summary: 'local summary' },
    contextUsage: { tokens: null }, compactionSettings: { enabled: true, reserveTokens: 99_800 },
  });
  expect((await kernel.contextUsagePayload()).contextUsage?.tokens).toBeNull();
  expect(state.calls).toHaveLength(2);
});
