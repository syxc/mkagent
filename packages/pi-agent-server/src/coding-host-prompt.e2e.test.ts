import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { defineExtension } from '@earendil-works/pi-durable';
import { durableFixture, response } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { DurableKernel } from './kernel.ts';

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
