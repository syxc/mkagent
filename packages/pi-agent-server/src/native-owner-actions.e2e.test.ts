/** A real native command closes itself and runs target closures only after the owner commit. */
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension } from '@earendil-works/pi-durable';
import { DurableKernel, type DurableKernelOptions } from './kernel.ts';
import { durableFixture, response } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';

test('handled commands complete while a preceding agent run is settling', async () => {
  const root = await durableFixture([]);
  await root.harness.close(BACKGROUND_CONTEXT);
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const plugin = join(agentDir, 'marker.ts');
  writeFileSync(plugin, `export default function(pi) {
    pi.registerCommand('marker', { handler: async () => { pi.appendEntry('fixture-marker', {}); } });
  }`);
  const kernel = new DurableKernel({
    sessionPath: join(root.directory, 'source'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'empty' }), wrapCodingTool: tool => tool,
    coding: { agentDir, resourcePolicy: 'host-only', extensionPaths: [plugin],
      globalSettings: { cacheWarming: 'off', compaction: { enabled: false } } },
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: () => {} },
  });
  const native = kernel as unknown as { coding: { session: { isStreaming: boolean } } };
  try {
    await kernel.open({ model: { provider: 'faux', modelId: 'local' } });
    // agent_end precedes settlement. A handled command can run in that interval.
    Object.defineProperty(native.coding.session, 'isStreaming', { configurable: true, get: () => true });
    expect(await kernel.submitPrompt('/marker')).toEqual({ handled: true, completed: true });
    expect(root.calls).toHaveLength(0);
  } finally {
    Reflect.deleteProperty(native.coding.session, 'isStreaming');
    await kernel.close();
    rmSync(root.directory, { recursive: true, force: true });
  }
}, 15_000);

test('native new preserves the command coroutine and setup/start/withSession order across a commit barrier', async () => {
  const root = await durableFixture([response('target answer')]);
  await root.harness.close(BACKGROUND_CONTEXT);
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const tracePath = join(root.directory, 'trace.jsonl');
  writeFileSync(tracePath, '');
  const plugin = join(agentDir, 'owner.ts');
  writeFileSync(plugin, `
    import { appendFileSync } from 'node:fs';
    const trace = value => appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(value) + '\\n');
    export default function(pi) {
      pi.on('session_start', (event, ctx) => trace(['start', event.reason, ctx.sessionManager.getSessionId()]));
      pi.on('session_shutdown', event => trace(['shutdown', event.reason]));
      pi.on('session_before_switch', event => trace(['before', event.reason]));
      pi.registerCommand('fresh', { handler: async (_args, ctx) => {
        const original = ctx.sessionManager.getSessionId();
        await ctx.newSession({
          setup: async manager => {
            trace(['setup', manager.getSessionId()]);
            manager.appendMessage({ role: 'user', content: 'setup context', timestamp: Date.now() });
          },
          withSession: async target => {
            trace(['with', target.sessionManager.getSessionId()]);
            await target.sendUserMessage('target question');
          },
        });
        trace(['returned', original]);
      } });
    }
  `);
  const prepared = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  const errors: string[] = [];
  const kernels: DurableKernel[] = [];
  let current!: DurableKernel;
  const model = { provider: 'faux', modelId: 'local', contextWindow: 100_000 };
  const options: DurableKernelOptions = {
    sessionPath: join(root.directory, 'source'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'empty' }), wrapCodingTool: tool => tool,
    coding: { agentDir, resourcePolicy: 'host-only', extensionPaths: [plugin],
      globalSettings: { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' } },
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: error => errors.push(error) },
    replaceNativeSession: async (request, runTarget) => {
      expect(request.operation).toEqual({ type: 'new' });
      expect(request.sourceNativeSessionId).toBe(current.sessionId);
      await current.close('new');
      current = new DurableKernel({ ...options, sessionPath: join(root.directory, 'target') });
      kernels.push(current);
      await current.open({ model, codingReplacement: { reason: 'new' } });
      prepared.resolve();
      await committed.promise;
      await runTarget(current, new AbortController().signal);
    },
  };
  const traces = (): unknown[][] => readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  current = new DurableKernel(options);
  kernels.push(current);
  try {
    await current.open({ model });
    const source = current;
    const sourceId = source.sessionId;
    const operation = source.submitPrompt('/fresh');
    void operation.catch(() => {});
    await prepared.promise;
    expect(traces()).toEqual([['start', 'startup', sourceId], ['before', 'new'], ['shutdown', 'new']]);
    expect(root.calls).toHaveLength(0);
    const targetId = current.sessionId;
    expect(targetId).not.toBe(sourceId);
    committed.resolve();
    expect(await operation).toEqual({ handled: true, completed: true });
    expect(traces()).toEqual([
      ['start', 'startup', sourceId], ['before', 'new'], ['shutdown', 'new'],
      ['setup', targetId], ['start', 'new', targetId], ['with', targetId], ['returned', sourceId],
    ]);
    expect(root.calls).toHaveLength(1);
    expect(root.calls[0]!.messages.filter(message => message.role === 'user').map(message =>
      typeof message.content === 'string' ? message.content
        : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')))
      .toEqual(['setup context', 'target question']);
    expect(errors).toEqual([]);
  } finally {
    committed.resolve();
    for (const kernel of kernels.reverse()) await kernel.close();
    rmSync(root.directory, { recursive: true, force: true });
  }
}, 15_000);

test('aborting a loaded target before commit runs no startup or shutdown hooks', async () => {
  const root = await durableFixture([]);
  await root.harness.close(BACKGROUND_CONTEXT);
  const agentDir = join(root.directory, 'agent');
  mkdirSync(agentDir);
  const tracePath = join(root.directory, 'trace');
  writeFileSync(tracePath, '');
  const plugin = join(agentDir, 'hooks.ts');
  writeFileSync(plugin, `
    import { appendFileSync } from 'node:fs';
    export default function(pi) {
      for (const event of ['session_start', 'session_shutdown']) {
        pi.on(event, () => appendFileSync(${JSON.stringify(tracePath)}, event + '\\n'));
      }
    }
  `);
  const kernel = new DurableKernel({
    sessionPath: join(root.directory, 'target'), cwd: root.directory, modelsSource: () => root.models,
    toolsExtension: defineExtension({ name: 'empty' }), wrapCodingTool: tool => tool,
    coding: { agentDir, resourcePolicy: 'host-only', extensionPaths: [plugin] },
    hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
      isPrefetchableTool: () => false, debugLog: () => {} },
  });
  try {
    await kernel.open({ model: { provider: 'faux', modelId: 'local' }, codingReplacement: { reason: 'new' } });
    await kernel.close();
    expect(readFileSync(tracePath, 'utf8')).toBe('');
    expect(root.calls).toHaveLength(0);
  } finally {
    await kernel.close();
    rmSync(root.directory, { recursive: true, force: true });
  }
});
