import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension } from '@earendil-works/pi-durable';
import { durableFixture, response } from '../../coding-runtime/test/fixtures/durable-harness.ts';
import { DurableKernel } from './kernel.ts';
import { createBuiltinTools } from './tools/builtin.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

test('spills full UTF-8 shell output and reads its first window after a durable reopen', async () => {
  const answers = [
    { ...response('', 'toolUse'), content: [{ type: 'toolCall' as const, id: 'large', name: 'bash', arguments: { command: 'cat payload.txt' } }] },
    response('done'),
  ];
  const root = await durableFixture(answers);
  await root.harness.close(BACKGROUND_CONTEXT);
  cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
  const payload = Array.from({ length: 3000 }, (_, index) => `row-${index} 中文 ${'x'.repeat(80)}`).join('\n') + '\n';
  writeFileSync(join(root.directory, 'payload.txt'), payload);
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  let spilled = '';
  const tools = createBuiltinTools(root.directory).map(tool => ({
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      const result = await tool.execute(...args);
      if (tool.name === 'bash') {
        expect(result.structuredOutput).toMatchObject({ exitCode: 0, truncated: true });
        const output = result.structuredOutput as { fullOutputPath: string; output: string };
        spilled = output.fullOutputPath;
        expect(output.output).toContain('row-2999 中文');
        expect(output.output).not.toContain('row-0 中文');
        expect(output.output).not.toContain('\uFFFD');
      }
      return result;
    },
  }));
  const options: ConstructorParameters<typeof DurableKernel>[0] = {
    sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'coding', tools }),
    coding: { agentDir, resourcePolicy: 'host-only',
      globalSettings: { compaction: { enabled: false }, cacheWarming: 'off' }, projectSettings: {} },
    wrapCodingTool: tool => tool,
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: () => {} },
  };
  const model = { provider: 'faux', modelId: 'local', contextWindow: 100_000 };
  const kernel = new DurableKernel(options);
  cleanup.push(() => kernel.close());
  await kernel.open({ model });
  await kernel.submitPrompt('produce output');
  await kernel.waitForIdle();
  expect(spilled).not.toBe('');
  cleanup.push(() => rmSync(spilled, { force: true }));
  expect(readFileSync(spilled, 'utf8')).toBe(payload);
  expect(JSON.stringify(root.calls[1]!.messages)).toContain(spilled);
  const id = kernel.sessionId;
  await kernel.close();
  answers.push(
    { ...response('', 'toolUse'), content: [{ type: 'toolCall', id: 'window', name: 'read', arguments: { path: spilled, offset: 1, limit: 2 } }] },
    response('read'),
  );
  const reopened = new DurableKernel(options);
  cleanup.push(() => reopened.close());
  await reopened.open({ model });
  expect(reopened.sessionId).toBe(id);
  await reopened.submitPrompt('recover beginning');
  await reopened.waitForIdle();
  expect(JSON.stringify(root.calls[2]!.messages)).toContain(spilled);
  const readResult = JSON.stringify(root.calls[3]!.messages.at(-1));
  expect(readResult).toContain('row-0 中文');
  expect(readResult).toContain('row-1 中文');
  expect(readResult).not.toContain('row-2 中文');
  expect(root.calls).toHaveLength(4);
});
