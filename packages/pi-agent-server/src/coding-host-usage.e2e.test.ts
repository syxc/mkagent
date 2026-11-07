import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension, type Harness } from '@earendil-works/pi-durable';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { PiEventAdapter } from '../../shared/src/agent/backend/pi/event-adapter.ts';
import { durableFixture, response } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { DurableKernel, type DurableKernelOptions } from './kernel.ts';
import type { CodingHost } from './coding-host.ts';
import { readNativeSessionDescriptor } from './storage/native-session-projection.ts';

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
  const open = async (deferred = false) => {
    const kernel = new DurableKernel(options);
    cleanup.push(() => kernel.close());
    await kernel.open({ model, ...(deferred ? { codingReplacement: { reason: 'resume' as const } } : {}) });
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

test('committed assistant product IDs survive real kernel close and reopen', async () => {
  const state = await fixture([response('persisted response')]);
  const kernel = await state.open();
  await kernel.submitPrompt('hello');
  await kernel.waitForIdle();
  const host = coding(kernel);
  const ids = state.events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant')
    .map(event => event.sdkMessageId);
  expect(ids).toHaveLength(1);
  const descriptor = await readNativeSessionDescriptor(state.options.sessionPath);
  expect(host.session.sessionManager.getSessionFile()).toBe(descriptor.sessionFile);
  expect(descriptor.entryIds.filter(entry => entry.productMessageId !== undefined).map(entry => entry.productMessageId)).toEqual(ids);
  await kernel.close();
  const reopened = await state.open();
  const recovered = await readNativeSessionDescriptor(state.options.sessionPath);
  expect(recovered.nativeSessionId).toBe(descriptor.nativeSessionId);
  expect(coding(reopened).journal.committedSnapshot().entryIds).toEqual(host.journal.committedSnapshot().entryIds);
  expect(recovered.entryIds).toEqual(descriptor.entryIds);
  expect(state.calls).toHaveLength(1);
});

test('projection IO failure during shutdown still closes the journal, listener and durable store', async () => {
  const state = await fixture([response('done')]);
  const kernel = await state.open();
  await kernel.submitPrompt('hello');
  await kernel.waitForIdle();
  const host = coding(kernel);
  cleanup.pop();
  cleanup.push(async () => {
    const harness = (kernel as unknown as { harness: Harness | null }).harness;
    if (!harness) return;
    host.session.dispose();
    await host.projection.close();
    host.journal.close();
    await harness.close(BACKGROUND_CONTEXT);
  });
  unlinkSync(host.projection.paths.manifestFile);
  mkdirSync(host.projection.paths.manifestFile);
  host.session.sessionManager.appendCustomEntry('shutdown-metadata', {});
  await expect(kernel.close()).rejects.toThrow('journal commit remains authoritative');
  expect(() => host.journal.manager.appendCustomEntry('late-write', {})).toThrow('closed');
  await expect(host.projection.rebuild()).rejects.toThrow('closed');
  expect((kernel as unknown as { harness: Harness | null }).harness).toBeNull();
});

test('failed reload retires its closed host and the next native input can reload again', async () => {
  const state = await fixture([]);
  writeFileSync(state.path, `export default function(pi) {
    pi.registerCommand('refresh', { handler: async (_args, ctx) => { await ctx.reload(); } });
    pi.on('session_shutdown', () => { pi.appendEntry('shutdown-ran', {}); });
  }`);
  const kernel = await state.open();
  const previous = coding(kernel);
  unlinkSync(previous.projection.paths.manifestFile);
  mkdirSync(previous.projection.paths.manifestFile);
  try { await kernel.submitPrompt('/refresh'); } catch { /* The dispatcher may report the failed command. */ }
  expect(() => previous.journal.manager.appendCustomEntry('late-write', {})).toThrow('closed');
  expect(coding(kernel) === undefined).toBe(true);
  rmSync(previous.projection.paths.manifestFile, { recursive: true });
  await kernel.submitPrompt('/refresh');
  await kernel.waitForIdle();
  expect(coding(kernel) === previous).toBe(false);
  expect(coding(kernel).journal.committedSnapshot().entries.filter(entry => entry.type === 'custom' && entry.customType === 'shutdown-ran')).toHaveLength(2);
  expect(state.calls).toHaveLength(0);
});

test('a controlled recovery projection failure drains before the shutdown hook runs once', async () => {
  const state = await fixture([]);
  writeFileSync(state.path, `export default function(pi) {
    pi.on('session_shutdown', () => { pi.appendEntry('shutdown-after-recovery', {}); });
  }`);
  const kernel = await state.open(true);
  const host = coding(kernel);
  const release = Promise.withResolvers<void>();
  const draining = Promise.withResolvers<void>();
  const wait = host.session.waitForIdle.bind(host.session);
  const resume = spyOn(host.session, 'recoverDurable').mockImplementation(async onBound => {
    onBound?.();
    await release.promise;
    return false;
  });
  const idle = spyOn(host.session, 'waitForIdle').mockImplementation(async () => {
    await wait();
    draining.resolve();
  });
  try {
    await host.start('resume');
    unlinkSync(host.projection.paths.manifestFile);
    mkdirSync(host.projection.paths.manifestFile);
    host.session.sessionManager.appendCustomEntry('recovery-metadata', {});
    const closing = kernel.close();
    await draining.promise;
    release.resolve();
    await expect(closing).rejects.toThrow('journal commit remains authoritative');
    expect(host.journal.committedSnapshot().entries.filter(entry => entry.type === 'custom' && entry.customType === 'shutdown-after-recovery')).toHaveLength(1);
    expect((kernel as unknown as { harness: Harness | null }).harness).toBeNull();
  } finally {
    release.resolve();
    resume.mockRestore();
    idle.mockRestore();
  }
});
