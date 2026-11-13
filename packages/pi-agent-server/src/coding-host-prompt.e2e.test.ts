import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { defineExtension } from '@earendil-works/pi-durable';
import { durableFixture, response } from '../../coding-runtime/test/fixtures/durable-harness.ts';
import { DurableKernel } from './kernel.ts';
import { getProjectContextFilesPrompt } from '../../shared/src/prompts/system.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

test.each(['native', 'host-only'] as const)('refreshes late host prompts before plugin hooks with %s resources', async resourcePolicy => {
  const prompts = ['host-one', 'host-two', ''];
  const root = await durableFixture(prompts.map(() => response('answer')));
  await root.harness.close(BACKGROUND_CONTEXT);
  cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'SYSTEM.md'), 'native-base');
  const plugin = join(agentDir, 'prompt.ts');
  writeFileSync(plugin, `export default function(pi) {
    pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + '\\nplugin-tail' }));
  }`);
  const kernel = new DurableKernel({
    sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'host', tools: [{
      name: 'echo', description: 'Local fixture', parameters: { type: 'object', properties: {} },
      execute: async () => ({ output: [{ type: 'text', text: 'echo' }] }),
    }] }),
    coding: { agentDir, resourcePolicy, extensionPaths: [plugin],
      globalSettings: { compaction: { enabled: false }, cacheWarming: 'off' }, projectSettings: {} },
    wrapCodingTool: tool => tool,
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: () => {} },
  });
  cleanup.push(() => kernel.close());
  await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
  for (const [index, prompt] of prompts.entries()) {
    // Production delivers its system prompt after the subprocess has opened the session.
    kernel.systemPrompt = prompt;
    await kernel.submitPrompt(`question ${index}`);
    await kernel.waitForIdle();
    const call = root.calls[index]!;
    const system = call.messages.find(message => message.role === 'system')!.content;
    expect(system).toContain('plugin-tail');
    if (prompt) expect(system).toContain(prompt);
    for (const previous of prompts.filter(value => value && value !== prompt)) {
      expect(system).not.toContain(previous);
    }
    if (resourcePolicy === 'native') expect(system).toContain('native-base');
    else expect(system).not.toContain('native-base');
    expect(getCurrentTools(call.messages).map(tool => tool.name)).toEqual(['echo']);
  }
});

test('keeps host instruction discovery and native source scopes across reload and context hooks', async () => {
  const root = await durableFixture([response('first'), response('second')]);
  await root.harness.close(BACKGROUND_CONTEXT);
  cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
  const cwd = join(root.directory, 'project');
  const agentDir = join(root.directory, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  mkdirSync(join(root.directory, '.git'));
  writeFileSync(join(root.directory, 'AGENTS.md'), 'ancestor-marker');
  // Equal text in separate scopes must retain both source paths.
  writeFileSync(join(agentDir, 'AGENTS.md'), 'shared-scope-marker');
  writeFileSync(join(cwd, 'AGENTS.md'), 'shared-scope-marker');
  const plugin = join(agentDir, 'context.ts');
  writeFileSync(plugin, `export default function(pi) {
    pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + '\\nhook-marker' }));
    pi.on('context', event => ({ messages: [...event.messages, { role: 'user',
      content: [{ type: 'text', text: 'context-marker' }], timestamp: 1 }] }));
  }`);
  const host = getProjectContextFilesPrompt(cwd);
  expect(host).toContain('AGENTS.md');
  expect(host).not.toContain('shared-scope-marker');
  const kernel = new DurableKernel({
    sessionPath: join(root.directory, 'session'), cwd, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'empty' }),
    coding: { agentDir, projectTrusted: true, extensionPaths: [plugin],
      globalSettings: { compaction: { enabled: false }, cacheWarming: 'off' }, projectSettings: {} },
    wrapCodingTool: tool => tool,
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: () => {} },
  });
  cleanup.push(() => kernel.close());
  kernel.systemPrompt = 'host-marker\n' + host;
  await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
  for (let index = 0; index < 2; index++) {
    await kernel.submitPrompt(`question ${index}`);
    await kernel.waitForIdle();
    const messages = root.calls[index]!.messages;
    const prompt = messages.find(message => message.role === 'system')!.content;
    for (const marker of ['ancestor-marker', 'host-marker', 'hook-marker']) expect(prompt.split(marker)).toHaveLength(2);
    expect(prompt.split('shared-scope-marker')).toHaveLength(3);
    for (const path of [join(agentDir, 'AGENTS.md'), join(cwd, 'AGENTS.md')]) expect(prompt).toContain(path);
    expect(JSON.stringify(messages.at(-1))).toContain('context-marker');
    if (index === 0) await kernel.submitPrompt('/reload');
  }
});
