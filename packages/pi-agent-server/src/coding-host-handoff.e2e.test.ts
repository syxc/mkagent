/** Official host handoffs reset native context in call order and retain accepted steering. */
import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension, type ToolRegistration } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';
import type { CodingHost } from './coding-host.ts';
import { DurableKernel, type DurableKernelOptions } from './kernel.ts';
import { durableFixture, response } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';

function users(messages: Message[]): string[] {
  return messages.filter(message => message.role === 'user').map(message =>
    typeof message.content === 'string' ? message.content
      : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'));
}

for (const summary of ['handoff summary', '']) test(`handoff ${JSON.stringify(summary)} resets context and survives reopen`, async () => {
  const root = await durableFixture([{
    ...response(''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'first', name: 'first', arguments: {} },
      { type: 'toolCall', id: 'second', name: 'second', arguments: {} },
    ],
  }, response('finished'), response('reopened')]);
  await root.harness.close(BACKGROUND_CONTEXT);
  const started = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  const secondFinished = Promise.withResolvers<void>();
  const executions: string[] = [];
  const tools: ToolRegistration[] = ['first', 'second'].map(name => ({
    name, description: name, parameters: { type: 'object', properties: {} },
    execute: async () => {
      started.resolve();
      await accepted.promise;
      if (name === 'first') await secondFinished.promise;
      executions.push(name);
      return { output: [{ type: 'text', text: name }], control: { handoff: name === 'first' ? 'wrong summary' : summary } };
    },
  }));
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const options: DurableKernelOptions = {
    sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'handoff', tools }), wrapCodingTool: tool => tool,
    coding: { agentDir, disabledBuiltinExtensions: ['codemode', 'tool-search', 'mcp'],
      globalSettings: { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' } },
    hooks: {
      emitEvent: event => {
        if (event.type === 'tool_execution_end' && event.toolName === 'second') secondFinished.resolve();
      },
      sessionToolCompleted: () => {}, prefetchToolCall: () => {}, isPrefetchableTool: () => false, debugLog: () => {},
    },
  };
  let kernel = new DurableKernel(options);
  try {
    await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
    await kernel.submitPrompt('old input');
    await started.promise;
    const coding = (kernel as unknown as { coding: CodingHost }).coding;
    await coding.session.steer('accepted steering');
    accepted.resolve();
    await kernel.waitForIdle();
    expect(executions).toEqual(['second', 'first']);
    expect(users(root.calls[1].messages)).toEqual([summary, 'accepted steering']);
    expect(root.calls[1].messages.filter(message => message.role === 'toolResult')).toHaveLength(0);
    await kernel.close();
    kernel = new DurableKernel(options);
    await kernel.open({});
    await kernel.submitPrompt('after reopen');
    await kernel.waitForIdle();
    expect(users(root.calls[2].messages)).toEqual([summary, 'accepted steering', 'after reopen']);
    expect(executions).toEqual(['second', 'first']);
  } finally {
    accepted.resolve();
    secondFinished.resolve();
    await kernel.close();
    rmSync(root.directory, { recursive: true, force: true });
  }
}, 15_000);
