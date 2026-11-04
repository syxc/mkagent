import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension, type ToolRegistration } from '@earendil-works/pi-durable';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { durableFixture, response } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { DurableKernel, type DurableKernelOptions } from './kernel.ts';
import type { CodingHost } from './coding-host.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });
const model = { provider: 'faux', modelId: 'local', contextWindow: 100_000 };
const coding = (kernel: DurableKernel) => (kernel as unknown as { coding: CodingHost }).coding;

function tool(name: string, extra: Partial<ToolRegistration> & { defaultActive?: boolean } = {}): ToolRegistration {
  return {
    name, description: name, parameters: { type: 'object', properties: {} },
    execute: async () => ({ output: [{ type: 'text', text: name }] }), ...extra,
  };
}

async function fixture(plugin = '', answers: AssistantMessage[] = [response('first'), response('second'), response('third')]) {
  const root = await durableFixture(answers);
  await root.harness.close(BACKGROUND_CONTEXT);
  cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const path = join(agentDir, 'extension.ts');
  writeFileSync(path, `export default function(pi) { ${plugin} }`);
  const errors: string[] = [];
  const options: DurableKernelOptions = {
    sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'host' }), coding: { agentDir, extensionPaths: [path] },
    wrapCodingTool: tool => tool,
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: error => errors.push(error) },
  };
  const open = async (resume = false) => {
    const kernel = new DurableKernel(options);
    cleanup.push(() => kernel.close());
    await kernel.open(resume ? {} : { model });
    return kernel;
  };
  return { ...root, open, options, errors, path };
}

test('host catalog updates retain independent extensions and native tool ownership', async () => {
  const state = await fixture(`
    pi.registerTool({ name: 'native_tool', label: 'Native', description: 'native tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'native' }] }) });
  `);
  state.options.toolsExtension = defineExtension({ name: 'host', tools: [tool('original')] });
  state.options.extensions = [defineExtension({ name: 'independent', tools: [tool('independent')] })];
  const kernel = await state.open();
  await kernel.submitPrompt('before');
  await kernel.waitForIdle();
  expect(getCurrentTools(state.calls[0].messages).map(tool => tool.name).sort())
    .toEqual(['independent', 'native_tool', 'original']);
  kernel.updateTools(defineExtension({ name: 'host', tools: [tool('updated')] }));
  await kernel.submitPrompt('after');
  await kernel.waitForIdle();
  expect(getCurrentTools(state.calls[1].messages).map(tool => tool.name).sort())
    .toEqual(['independent', 'native_tool', 'updated']);
  expect(coding(kernel).session.getAllTools().map(tool => tool.name).sort())
    .toEqual(['independent', 'native_tool', 'updated']);
  expect(state.errors.filter(error => error.includes('[coding:'))).toEqual([]);
});

test('initial host declarations respect deferred, caller and default-active policies', async () => {
  const state = await fixture();
  state.options.toolsExtension = defineExtension({ name: 'host', tools: [
    tool('direct'), tool('deferred', { deferred: true }), tool('scripts', { callers: ['tools'] }),
    tool('hidden', { callers: [] }), tool('model_only', { callers: ['model'] }),
    tool('model_deferred', { callers: ['model'], deferred: true }),
    tool('inactive', { defaultActive: false }),
  ] });
  const kernel = await state.open();
  await kernel.submitPrompt('before');
  await kernel.waitForIdle();
  expect(getCurrentTools(state.calls[0].messages).map(tool => tool.name).sort())
    .toEqual(['direct', 'model_only']);
  expect(coding(kernel).session.getAllTools().map(tool => tool.name).sort())
    .toEqual(['deferred', 'direct', 'hidden', 'inactive', 'model_deferred', 'model_only', 'scripts']);
});

test('new host tools use their exposure and default-active policy after a catalog update', async () => {
  const state = await fixture();
  const kernel = await state.open();
  kernel.updateTools(defineExtension({ name: 'host', tools: [
    tool('direct'), tool('deferred', { deferred: true }), tool('scripts', { callers: ['tools'] }),
    tool('hidden', { callers: [] }), tool('model_only', { callers: ['model'] }),
    tool('model_deferred', { callers: ['model'], deferred: true }),
    tool('inactive', { defaultActive: false }),
  ] }));
  await kernel.submitPrompt('after');
  await kernel.waitForIdle();
  expect(getCurrentTools(state.calls[0].messages).map(tool => tool.name).sort())
    .toEqual(['direct', 'model_only']);
  expect(coding(kernel).session.getAllTools().map(tool => tool.name).sort())
    .toEqual(['deferred', 'direct', 'hidden', 'inactive', 'model_deferred', 'model_only', 'scripts']);
});

test('official durable tool search activates deferred tools on the next request and after reopen', async () => {
  const state = await fixture('', [{
    ...response(''), stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'search', name: 'tool_search', arguments: { query: 'weather', limit: 1 } }],
  }, response('loaded'), response('restored')]);
  state.options.toolsExtension = defineExtension({ name: 'host', tools: [tool('weather', { deferred: true })] });
  state.options.extensions = [createToolSearchExtension()];
  const kernel = await state.open();
  await kernel.submitPrompt('discover');
  await kernel.waitForIdle();
  expect(getCurrentTools(state.calls[0].messages).map(tool => tool.name)).toEqual(['tool_search']);
  expect(JSON.stringify(state.calls[1].messages)).toContain('Loaded 1 tool');
  expect(getCurrentTools(state.calls[1].messages).map(tool => tool.name).sort()).toEqual(['tool_search', 'weather']);
  await kernel.close();
  const reopened = await state.open(true);
  await reopened.submitPrompt('again');
  await reopened.waitForIdle();
  expect(getCurrentTools(state.calls[2].messages).map(tool => tool.name).sort()).toEqual(['tool_search', 'weather']);
});

for (const virtual of [false, true]) {
  test(`restores selected ${virtual ? 'virtual' : 'extension'} model on reload and reopen without a prior request`, async () => {
    const selected = virtual ? { provider: 'router', id: 'auto' } : { provider: 'faux', id: 'registered' };
    const state = await fixture(`
      ${virtual ? `pi.registerVirtualModel({
        provider: 'router', id: 'auto', name: 'Auto',
        route: (_request, ctx) => ({ model: ctx.models.getModel('faux', 'local'), thinkingLevel: 'off' }),
      });` : ''}
      pi.registerCommand('select', { handler: async (_args, ctx) => {
        const selected = await pi.setModel(ctx.modelRegistry.find('${selected.provider}', '${selected.id}'));
        if (!selected) throw new Error('Fixture model selection failed');
      } });
      pi.registerCommand('refresh', { handler: async (_args, ctx) => { await ctx.reload(); } });
    `);
    if (!virtual) {
      const definition = { ...state.models.getModel('faux', 'local')!, id: 'registered' };
      const original = await Bun.file(state.path).text();
      writeFileSync(state.path, original.replace('export default function(pi) {',
        `export default function(pi) { pi.registerProvider('faux', {
          models: [${JSON.stringify(state.models.getModel('faux', 'local'))}, ${JSON.stringify(definition)}],
        });`));
    }
    const kernel = await state.open();
    await kernel.submitPrompt('/select');
    expect(kernel.currentModel?.modelId).toBe(selected.id);
    await kernel.submitPrompt('/refresh');
    expect(coding(kernel).session.model?.id).toBe(selected.id);
    expect(kernel.currentModel?.modelId).toBe(selected.id);
    expect(state.calls).toHaveLength(0);
    await kernel.close();
    const reopened = await state.open(true);
    expect(coding(reopened).session.model?.id).toBe(selected.id);
    expect(reopened.currentModel?.modelId).toBe(selected.id);
    expect(state.calls).toHaveLength(0);
    expect(state.models.getModel(selected.provider, selected.id)).toBeUndefined();
  });
}
