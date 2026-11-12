import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, awaitWithContext } from '@earendil-works/chord/context';
import { defineExtension, type ToolRegistration } from '@earendil-works/pi-durable';
import { durableFixture, response } from '../../coding-runtime/test/fixtures/durable-harness.ts';
import { DurableKernel } from './kernel.ts';
import type { CodingHost } from './coding-host.ts';
import { readNativeSessionDescriptor } from './storage/native-session-projection.ts';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const coding = (kernel: DurableKernel) => (kernel as unknown as { coding: CodingHost }).coding;

async function fixture(answers: ReturnType<typeof response>[], tools: ToolRegistration[] = [], replaceMessages = false) {
  const state = await durableFixture(answers);
  await state.harness.close(BACKGROUND_CONTEXT);
  cleanup.push(() => rmSync(state.directory, { recursive: true, force: true }));
  const agentDir = join(state.directory, 'agent');
  mkdirSync(agentDir);
  const plugin = join(agentDir, 'input.ts');
  writeFileSync(plugin, `export default function(pi) {
    pi.on('input', event => ({ action: 'transform', text: event.text.replace('same', 'normalized') }));
    if (${replaceMessages}) pi.on('message_end', event => {
      if (event.message.role === 'user') return { message: {
        role: 'user', content: event.message.content, timestamp: event.message.timestamp,
      } };
    });
    pi.registerCommand('local', { handler: async () => {} });
  }`);
  const sessionPath = join(state.directory, 'product-session');
  const kernel = new DurableKernel({
    sessionPath, cwd: state.directory, modelsSource: () => state.models,
    coding: { resourcePolicy: 'host-only', agentDir, extensionPaths: [plugin] },
    toolsExtension: defineExtension({ name: 'host-fixture', tools }), wrapCodingTool: tool => tool,
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: () => {} },
  });
  cleanup.push(() => kernel.close());
  await kernel.open({ model: { provider: 'faux', modelId: 'local' } });
  return { ...state, kernel, host: coding(kernel), sessionPath };
}

test('transformed repeated host inputs retain their own IDs without fabricating command entries', async () => {
  const state = await fixture([response('one'), response('two')], [], true);
  for (const id of ['input-one', 'input-two']) {
    await state.kernel.submitPrompt('same', undefined, { text: 'same', hostContextPrefix: '' }, id);
    await state.kernel.waitForIdle();
  }
  const before = state.host.journal.committedSnapshot();
  const users = before.entries.filter(entry => entry.type === 'message' && entry.message.role === 'user');
  expect(users).toHaveLength(2);
  expect(users.map(entry => before.entryIds.find(identity => identity.nativeId === entry.id)?.productMessageId))
    .toEqual(['input-one', 'input-two']);
  expect(new Set(users.map(entry => entry.id)).size).toBe(2);
  expect(JSON.stringify(users)).toContain('normalized');
  await state.kernel.submitPrompt('/local', undefined, { text: '/local', hostContextPrefix: '' }, 'handled-command');
  await state.kernel.waitForIdle();
  expect(state.host.journal.committedSnapshot().entries.filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(2);
  expect((await readNativeSessionDescriptor(state.sessionPath)).entryIds.some(entry => entry.productMessageId === 'handled-command')).toBe(false);
  expect(state.calls).toHaveLength(2);
});

test('provider context omits host identity while committed native messages keep their association', async () => {
  const state = await fixture([response('done')]);
  await state.kernel.submitPrompt('same', undefined, { text: 'same', hostContextPrefix: '' }, 'host-private-identity');
  await state.kernel.waitForIdle();
  const snapshot = state.host.journal.committedSnapshot();
  expect(snapshot.entryIds.some(entry => entry.productMessageId === 'host-private-identity')).toBe(true);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].messages.some(message => message.role === 'user')).toBe(true);
  expect(JSON.stringify(state.calls[0].messages)).toContain('normalized');
  expect(state.calls[0].messages.some(message => 'hostMessageId' in message)).toBe(false);
});

test('queued follow-up input keeps its original host ID through durable admission', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const state = await fixture([
    { ...response(''), stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'gate-call', name: 'gate', arguments: {} }] },
    response('first done'), response('queued done'),
  ], [{
    name: 'gate', description: 'Hold this fixture turn', parameters: { type: 'object', properties: {} },
    execute: async (_args, _api, context) => {
      entered.resolve();
      await awaitWithContext(release.promise, context);
      return { output: [{ type: 'text', text: 'released' }] };
    },
  }], true);
  try {
    await state.kernel.submitPrompt('first', undefined, { text: 'first', hostContextPrefix: '' }, 'first-host-input');
    await entered.promise;
    await state.kernel.submitPrompt('same', undefined, { text: 'same', hostContextPrefix: '' }, 'queued-host-input');
    const queued = state.host.session.exportDurableState().queues.followUp;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ hostMessageId: 'queued-host-input' });
    release.resolve();
    await state.kernel.waitForIdle();
    const snapshot = state.host.journal.committedSnapshot();
    const users = snapshot.entries.filter(entry => entry.type === 'message' && entry.message.role === 'user');
    expect(users.map(entry => snapshot.entryIds.find(identity => identity.nativeId === entry.id)?.productMessageId))
      .toEqual(['first-host-input', 'queued-host-input']);
    expect((await readNativeSessionDescriptor(state.sessionPath)).entryIds.filter(entry => entry.productMessageId === 'queued-host-input')).toHaveLength(1);
    expect(state.calls).toHaveLength(3);
  } finally { release.resolve(); }
});
