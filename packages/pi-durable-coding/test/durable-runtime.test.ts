import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, type AssistantMessage, type Model, type TranscriptContext } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineExtension, type Conversation, type EntryRecord } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { NativeCodingRuntime, type NativeExtensionError } from '../src/native-runtime.ts';
import { DurableCodingSessionStore } from '../src/durable-session-store.ts';
import type { CodingEntry } from '../src/session-view.ts';
import type { CodingResources } from '../src/resources.ts';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

const model: Model<'faux'> = {
  id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant', content, stopReason, api: 'faux', provider: 'faux', model: 'local', timestamp: 1,
    usage: {
      input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

async function setup(pluginSource: string, answers: AssistantMessage[]) {
  const root = mkdtempSync(join(tmpdir(), 'durable-native-runtime-'));
  temporary.push(root);
  const plugin = join(root, 'extension.ts');
  writeFileSync(plugin, pluginSource);
  const calls: TranscriptContext[] = [];
  const models = builtinModels({ credentials: new InMemoryCredentialStore() });
  models.setProvider(createProvider({
    id: 'faux', name: 'Local', models: [model],
    auth: { apiKey: { name: 'Local', resolve: async () => ({ auth: { apiKey: 'local-fixture' } }) } },
    api: { faux: {
      stream: () => { throw new Error('Unexpected non-simple stream'); },
      streamSimple: (_model, context) => {
        calls.push(context);
        const message = answers.shift();
        if (!message) throw new Error('Unexpected model request');
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: 'start', partial: { ...message, content: [] } });
          const first = message.content[0];
          if (first?.type === 'text') {
            stream.push({ type: 'text_start', contentIndex: 0, partial: { ...message, content: [{ type: 'text', text: '' }] } });
            stream.push({ type: 'text_delta', contentIndex: 0, delta: first.text, partial: message });
            stream.push({ type: 'text_end', contentIndex: 0, content: first.text, partial: message });
          }
          stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
        });
        return stream;
      },
    } },
  }));
  const registry = createRegistry();
  const directory = join(root, 'store');
  const harness = await Harness.open(await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), {
    registry, models, settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: 'local' } } });
  const id = crypto.randomUUID();
  const read = async (source: Conversation): Promise<CodingEntry[]> => {
    return new DurableCodingSessionStore({
      id, cwd: root, sessionPath: directory, conversation: () => source, context: BACKGROUND_CONTEXT,
    }).read();
  };
  const errors: NativeExtensionError[] = [];
  let runtime: NativeCodingRuntime;
  let active: string[] = [];
  const resources: CodingResources = {
    extensions: [resolve(import.meta.dir, 'fixtures/upstream/hello.ts'), plugin],
    skills: [], prompts: [], contextFiles: [], themes: [], appendSystemPrompt: [], diagnostics: [],
  };
  runtime = await NativeCodingRuntime.load({
    resources,
    store: new DurableCodingSessionStore({
      id, cwd: root, sessionPath: directory, conversation: () => conversation, context: BACKGROUND_CONTEXT,
    }),
    modelRegistry: models,
    onError: error => errors.push(error),
    abortToolTask: (taskId, context) => harness.abortTask(taskId, context),
    commandActions: {},
    core: {
      sendMessage: () => { throw new Error('Unexpected sendMessage'); },
      sendUserMessage: () => { throw new Error('Unexpected sendUserMessage'); },
      getActiveTools: () => active,
      getAllTools: () => runtime.tools,
      getSettings: () => ({}),
      setActiveTools: names => { active = names; },
      refreshTools: () => {},
      setModel: async () => true,
      getThinkingLevel: () => 'off',
      setThinkingLevel: () => {},
    },
    context: {
      getModel: () => model, getScopedModels: () => [], isIdle: () => true,
      isProjectTrusted: () => false, getSignal: () => undefined, abort: () => {},
      hasPendingMessages: () => false, shutdown: () => {}, getContextUsage: () => undefined,
      compact: () => {}, getSystemPrompt: () => 'Local fixture',
      getSystemPromptOptions: () => ({ cwd: root, customPrompt: 'Local fixture' }),
    },
  });
  registry.install(runtime.extension);
  const approvals: Array<{ name: string; args: unknown; id: string }> = [];
  registry.install(defineExtension({
    name: 'host-permissions',
    tools: runtime.tools.map(tool => ({
      ...tool,
      execute: async (args, api, context) => {
        approvals.push({ name: tool.name, args, id: api.callId });
        if (tool.name === 'hello' && (args as { name: string }).name === 'denied') throw new Error('Permission denied');
        return tool.execute(args, api, context);
      },
    })),
  }));
  await runtime.start();
  return { harness, conversation, runtime, models, registry, directory, id, root, read, approvals, calls, errors };
}

describe('native extensions on the real durable Harness', () => {
  for (const role of ['custom', 'user']) test(`prepares the current ${role} contribution after committed context edits`, async () => {
    const state = await setup(`
      export default function(pi) {
        let continued = false;
        pi.on('turn_end', event => event.turnIndex === 0 ? {
          entries: [{ type: 'custom_message', customType: 'new-context', content: 'original', display: false }],
        } : undefined);
        pi.on('agent_before_settle', (_event, ctx) => {
          if (continued) return;
          continued = true;
          const target = ctx.sessionManager.getBranch().find(entry => entry.customType === 'new-context');
          return { entries: [{ type: 'context_edit', targetId: target.id,
            replacement: { role: '${role}', customType: 'new-context', content: 'edited', display: false, timestamp: 2 },
          }], continue: true };
        });
        pi.on('message_end', event => {
          const content = event.message.content;
          const text = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
          if (['original', 'edited'].includes(text)) {
            return { message: { ...event.message, content: text + '!' } };
          }
        });
      }
    `, [assistant([{ type: 'text', text: 'first' }], 'stop'), assistant([{ type: 'text', text: 'second' }], 'stop')]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      expect(state.errors).toEqual([]);
      expect(state.calls).toHaveLength(2);
      expect(JSON.stringify(state.calls[1].messages.at(-1)?.content)).toContain('edited!');
      expect(state.errors).toEqual([]);
    } finally { await state.runtime.close(); await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('awaits run and turn starts and persists input message replacement before requesting the provider', async () => {
    const key = `native-prepare-${crypto.randomUUID()}`;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    Reflect.set(globalThis, key, { entered, release });
    const state = await setup(`
      export default function(pi) {
        pi.on('agent_start', () => pi.appendEntry('lifecycle', { type: 'agent_start' }));
        pi.on('turn_start', async event => {
          pi.appendEntry('lifecycle', { type: 'turn_start', index: event.turnIndex });
          const gate = globalThis[${JSON.stringify(key)}];
          gate.entered.resolve();
          await gate.release.promise;
        });
        pi.on('message_start', event => {
          if (event.message.role === 'user') pi.appendEntry('lifecycle', { type: 'user_start' });
        });
        pi.on('message_end', event => {
          if (event.message.role !== 'user') return;
          pi.appendEntry('lifecycle', { type: 'user_end' });
          return { message: { ...event.message, content: 'edited input' } };
        });
      }
    `, [assistant([{ type: 'text', text: 'answer' }], 'stop')]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'original' }, BACKGROUND_CONTEXT);
      expect(await Promise.race([entered.promise.then(() => 'handler'), submission.wait(BACKGROUND_CONTEXT).then(() => 'settled')]))
        .toBe('handler');
      expect(state.calls).toHaveLength(0);
      release.resolve();
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      expect(state.calls[0].messages.find(message => message.role === 'user')?.content).toBe('edited input');
      expect((await state.read(state.conversation)).filter(entry => entry.customType === 'lifecycle').map(entry => entry.data))
        .toEqual([{ type: 'agent_start' }, { type: 'turn_start', index: 0 }, { type: 'user_start' }, { type: 'user_end' }]);
      expect(state.errors).toEqual([]);
    } finally {
      release.resolve();
      Reflect.deleteProperty(globalThis, key);
      await state.runtime.close();
      await state.harness.close(BACKGROUND_CONTEXT);
    }
  });

  test('awaits native stream handlers and emits assistant start, updates and end once', async () => {
    const key = `native-stream-${crypto.randomUUID()}`;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    Reflect.set(globalThis, key, { entered, release });
    const state = await setup(`
      export default function(pi) {
        pi.on('message_start', event => {
          if (event.message.role === 'assistant') pi.appendEntry('stream', { type: 'start', role: event.message.role });
        });
        pi.on('message_update', async event => {
          pi.appendEntry('stream', { type: event.assistantMessageEvent.type });
          if (event.assistantMessageEvent.type === 'text_delta') {
            const gate = globalThis[${JSON.stringify(key)}];
            gate.entered.resolve();
            await gate.release.promise;
          }
        });
        pi.on('message_end', event => {
          if (event.message.role === 'assistant') pi.appendEntry('stream', { type: 'end', role: event.message.role });
        });
      }
    `, [assistant([{ type: 'text', text: 'answer' }], 'stop')]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      const first = await Promise.race([
        entered.promise.then(() => 'handler'),
        submission.wait(BACKGROUND_CONTEXT).then(() => 'settled'),
      ]);
      expect(first).toBe('handler');
      expect((await submission.status(BACKGROUND_CONTEXT)).status).toBe('placed');
      expect((await state.conversation.context(BACKGROUND_CONTEXT)).messages.some(message => message.role === 'assistant')).toBe(false);
      release.resolve();
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.runtime.session.refresh();
      const entries = await state.read(state.conversation);
      expect(entries.filter(entry => entry.customType === 'stream').map(entry => entry.data)).toEqual([
        { type: 'start', role: 'assistant' }, { type: 'text_start' }, { type: 'text_delta' },
        { type: 'text_end' }, { type: 'end', role: 'assistant' },
      ]);
      expect(state.errors).toEqual([]);
    } finally {
      release.resolve();
      Reflect.deleteProperty(globalThis, key);
      await state.runtime.close();
      await state.harness.close(BACKGROUND_CONTEXT);
    }
  });

  for (const content of ['[]', 'null']) test(`replaces message_end fields and normalizes ${content} content`, async () => {
    const original = { ...assistant([{ type: 'text', text: 'answer' }], 'stop'), errorMessage: 'stale-field' };
    const state = await setup(`
      export default function(pi) {
        pi.on('message_end', event => {
          const { errorMessage, ...replacement } = event.message;
          return { message: { ...replacement, content: ${content} } };
        });
      }
    `, [original]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      const view = await state.conversation.context(BACKGROUND_CONTEXT);
      const message = view.messages.findLast(message => message.role === 'assistant');
      expect(message?.content).toEqual([]);
      expect(message && 'errorMessage' in message).toBe(false);
      expect(state.errors).toEqual([]);
    } finally { await state.runtime.close(); await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('atomically resolves a boundary compaction against synchronous plugin metadata', async () => {
    const state = await setup(`
      export default function (pi) {
        pi.on('turn_end', (event, ctx) => {
          if (event.turnIndex !== 0) return;
          pi.appendEntry('checkpoint', { ready: true });
          return {
            entries: [
              { type: 'custom_message', customType: 'kept', content: 'retained-context', display: false },
              { type: 'compaction', summary: 'earlier summary',
                firstKeptEntryId: ctx.sessionManager.getLeafId(), tokensBefore: 10 },
            ], continue: true,
          };
        });
      }
    `, [assistant([{ type: 'text', text: 'first' }], 'stop'), assistant([{ type: 'text', text: 'second' }], 'stop')]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(state.calls).toHaveLength(2);
      expect(JSON.stringify(state.calls[1].messages)).toContain('earlier summary');
      expect(JSON.stringify(state.calls[1].messages.findLast(message => message.role !== 'system')?.content)).toContain('retained-context');
      const entries = await state.read(state.conversation);
      expect(entries.filter(entry => entry.customType === 'checkpoint')).toHaveLength(1);
      expect(state.errors).toEqual([]);
    } finally { await state.runtime.close(); await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('chains native boundary previews, atomically saves plugin writes, and continues from custom context', async () => {
    const state = await setup(`
      export default function (pi) {
        pi.on('turn_end', (event, ctx) => {
          const ids = ctx.sessionManager.getBranch().map(entry => entry.id);
          pi.appendEntry('boundary-observed', {
            turnIndex: event.turnIndex, messageIdPresent: ids.includes(event.messageEntryId),
            toolResultIds: event.toolResultEntryIds,
          });
          return { entries: [...event.entries, { type: 'custom', customType: 'turn-draft', data: event.turnIndex }] };
        });
        pi.on('turn_end', event => {
          if (event.entries.at(-1)?.customType !== 'turn-draft') throw new Error('Missing chained draft');
          return event.turnIndex === 0 ? {
            entries: [...event.entries, { type: 'custom_message', customType: 'continue',
              content: 'boundary-input', display: false }],
            continue: true,
          } : undefined;
        });
        pi.on('turn_end', event => {
          if (event.turnIndex === 0 && event.context.llmMessages.at(-1)?.role !== 'user') {
            throw new Error('Missing custom message in chained preview');
          }
        });
        pi.on('agent_before_settle', (event, ctx) => {
          pi.appendEntry('settle-observed', {
            turnDrafts: ctx.sessionManager.getBranch().filter(entry => entry.customType === 'turn-draft').length,
            lastRole: event.context.llmMessages.at(-1)?.role,
          });
        });
      }
    `, [assistant([{ type: 'text', text: 'first' }], 'stop'), assistant([{ type: 'text', text: 'second' }], 'stop')]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(state.calls).toHaveLength(2);
      expect(JSON.stringify(state.calls[1].messages.at(-1)?.content)).toContain('boundary-input');
      const entries = await state.read(state.conversation);
      expect(entries.filter(entry => entry.customType === 'boundary-observed').map(entry => entry.data))
        .toEqual([
          { turnIndex: 0, messageIdPresent: true, toolResultIds: [] },
          { turnIndex: 1, messageIdPresent: true, toolResultIds: [] },
        ]);
      expect(entries.filter(entry => entry.customType === 'turn-draft').map(entry => entry.data)).toEqual([0, 1]);
      expect(entries.find(entry => entry.customType === 'settle-observed')?.data)
        .toEqual({ turnDrafts: 2, lastRole: 'assistant' });
      expect(state.errors).toEqual([]);
    } finally { await state.runtime.close(); await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('reports invalid JSON boundary drafts and preserves valid synchronous metadata', async () => {
    const state = await setup(`
      export default function (pi) {
        pi.on('turn_end', () => {
          pi.appendEntry('saved', { ok: true });
          return { entries: [{ type: 'custom', customType: 'invalid', data: { fn() {} } }], continue: true };
        });
      }
    `, [assistant([{ type: 'text', text: 'answer' }], 'stop')]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      const entries = await state.read(state.conversation);
      expect(entries.some(entry => entry.customType === 'saved')).toBe(true);
      expect(entries.some(entry => entry.customType === 'invalid')).toBe(false);
      expect(state.calls).toHaveLength(1);
      expect(state.errors).toHaveLength(1);
      expect(state.errors[0].error).toContain('Invalid boundary entries');
    } finally { await state.runtime.close(); await state.harness.close(BACKGROUND_CONTEXT); }
  });

  test('executes the unchanged hello tool through hooks and host permissions, then persists message edits and plugin state', async () => {
    const state = await setup(`
      export default function (pi) {
        pi.on('tool_call', event => { if (event.toolName === 'hello') event.input.name = 'modified'; });
        pi.on('tool_result', event => {
          if (event.input.name !== 'modified') throw new Error('Stale tool_result arguments');
          return { content: [{ type: 'text', text: event.content[0].text + ' [hook]' }] };
        });
        pi.on('message_end', event => {
          if (event.message.stopReason === 'stop') {
            pi.appendEntry('count', { count: 1 });
            return { message: { ...event.message, content: [{ type: 'text', text: 'edited answer' }] } };
          }
        });
      }
    `, [
      assistant([{ type: 'toolCall', id: 'hello-call', name: 'hello', arguments: { name: 'original' } }], 'toolUse'),
      assistant([{ type: 'text', text: 'original answer' }], 'stop'),
    ]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'greet' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      const view = await state.conversation.context(BACKGROUND_CONTEXT);
      expect(state.approvals).toEqual([{ name: 'hello', args: { name: 'modified' }, id: 'hello-call' }]);
      expect(state.calls[1].messages.some(message => message.role === 'toolResult'
        && message.content.some(part => part.type === 'text' && part.text === 'Hello, modified! [hook]'))).toBe(true);
      expect(view.contributions.flat().at(-1)?.content).toEqual([{ type: 'text', text: 'edited answer' }]);
      expect((await state.read(state.conversation)).some(entry => entry.customType === 'count')).toBe(true);
      expect(state.errors).toEqual([]);
      await state.runtime.close();
      await state.harness.close(BACKGROUND_CONTEXT);
      const reopened = await Harness.open(await openNodeJsonlStorage(state.directory, BACKGROUND_CONTEXT), {
        registry: state.registry, models: state.models,
      }, BACKGROUND_CONTEXT);
      try {
        const restored = await reopened.root(BACKGROUND_CONTEXT);
        expect((await state.read(restored)).some(entry => entry.customType === 'count')).toBe(true);
        expect((await restored.context(BACKGROUND_CONTEXT)).contributions.flat().at(-1)?.content)
          .toEqual([{ type: 'text', text: 'edited answer' }]);
      } finally { await reopened.close(BACKGROUND_CONTEXT); }
    } finally { await state.harness.close(BACKGROUND_CONTEXT); }
  }, 10_000);

  test('routes nested calls through durable validation and host denial exactly once', async () => {
    const state = await setup(`
      export default function (pi) {
        pi.registerTool({
          name: 'parent', label: 'Parent', description: 'Call hello',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, _signal, _update, ctx) {
            const result = await ctx.executeTool('hello', { name: 'denied' });
            pi.appendEntry('nested', { isError: result.isError, id: result.toolCall.id, content: result.result.content });
            return { content: [{ type: 'text', text: result.isError ? 'denied as expected' : 'unexpected' }] };
          },
        });
      }
    `, [
      assistant([{ type: 'toolCall', id: 'parent-call', name: 'parent', arguments: {} }], 'toolUse'),
      assistant([{ type: 'text', text: 'done' }], 'stop'),
    ]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'nested' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(state.approvals.map(call => [call.name, call.id])).toEqual([
        ['parent', 'parent-call'], ['hello', 'parent-call/1'],
      ]);
      const entries = await state.read(state.conversation);
      expect(entries.find(entry => entry.customType === 'nested')?.data).toEqual({
        isError: true, id: 'parent-call/1', content: [{ type: 'text', text: 'Permission denied' }],
      });
      const view = await state.conversation.context(BACKGROUND_CONTEXT);
      expect(view.contributions.flat().filter(message => message.role === 'toolResult')).toHaveLength(1);
      expect(state.errors).toEqual([]);
    } finally {
      await state.runtime.close();
      await state.harness.close(BACKGROUND_CONTEXT);
    }
  }, 10_000);

  test('keeps hidden tools unreachable and codemode tools callable only by tools', async () => {
    const state = await setup(`
      export default function (pi) {
        for (const exposure of ['hidden', 'codemode']) pi.registerTool({
          name: exposure, label: exposure, description: exposure, exposure,
          parameters: { type: 'object', properties: {} },
          async execute() { return { content: [{ type: 'text', text: 'executed ' + exposure }] }; },
        });
        pi.registerTool({
          name: 'parent', label: 'Parent', description: 'Call exposures',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, _signal, _update, ctx) {
            const hidden = await ctx.executeTool('hidden', {});
            const code = await ctx.executeTool('codemode', {});
            pi.appendEntry('exposures', { hidden: hidden.isError, code: code.isError, result: code.result.content });
            return { content: [{ type: 'text', text: 'checked' }] };
          },
        });
      }
    `, [
      assistant([{ type: 'toolCall', id: 'exposure-call', name: 'parent', arguments: {} }], 'toolUse'),
      assistant([{ type: 'text', text: 'done' }], 'stop'),
    ]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'exposures' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(state.approvals.map(call => call.name)).toEqual(['parent', 'codemode']);
      expect((await state.read(state.conversation)).find(entry => entry.customType === 'exposures')?.data)
        .toEqual({ hidden: true, code: false, result: [{ type: 'text', text: 'executed codemode' }] });
      const offered = getCurrentTools(state.calls[0].messages).map(tool => tool.name);
      expect(offered).toContain('parent');
      expect(offered).not.toContain('hidden');
      expect(offered).not.toContain('codemode');
      expect(state.errors).toEqual([]);
    } finally { await state.runtime.close(); await state.harness.close(BACKGROUND_CONTEXT); }
  }, 10_000);

  test('serializes sequential nested calls and allows their own nested calls to reenter', async () => {
    const state = await setup(`
      export default function (pi) {
        let active = 0, maximum = 0;
        pi.registerTool({
          name: 'inner', label: 'Inner', description: 'Inner', executionMode: 'sequential',
          parameters: { type: 'object', properties: {} },
          async execute() { return { content: [{ type: 'text', text: 'inner' }] }; },
        });
        pi.registerTool({
          name: 'leaf', label: 'Leaf', description: 'Sequential leaf', executionMode: 'sequential',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, _signal, _update, ctx) {
            maximum = Math.max(maximum, ++active);
            await ctx.executeTool('inner', {});
            await new Promise(resolve => setTimeout(resolve, 10));
            --active;
            return { content: [{ type: 'text', text: 'leaf' }] };
          },
        });
        pi.registerTool({
          name: 'parent', label: 'Parent', description: 'Concurrent caller',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, _signal, _update, ctx) {
            await Promise.all([ctx.executeTool('leaf', {}), ctx.executeTool('leaf', {})]);
            pi.appendEntry('maximum', maximum);
            return { content: [{ type: 'text', text: 'checked' }] };
          },
        });
      }
    `, [
      assistant([{ type: 'toolCall', id: 'sequence-call', name: 'parent', arguments: {} }], 'toolUse'),
      assistant([{ type: 'text', text: 'done' }], 'stop'),
    ]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'sequential' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect((await state.read(state.conversation)).find(entry => entry.customType === 'maximum')?.data).toBe(1);
      expect(state.approvals.map(call => call.id)).toEqual([
        'sequence-call', 'sequence-call/1', 'sequence-call/1/1', 'sequence-call/2', 'sequence-call/2/1',
      ]);
      expect(state.errors).toEqual([]);
    } finally { await state.runtime.close(); await state.harness.close(BACKGROUND_CONTEXT); }
  }, 10_000);

  test('forwards custom cancellation to the child task before returning its result', async () => {
    const state = await setup(`
      export default function (pi) {
        pi.registerTool({
          name: 'child', label: 'Child', description: 'Wait for cancellation',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, signal) {
            await new Promise(resolve => {
              signal.addEventListener('abort', resolve, { once: true });
              pi.events.emit('child-started', {});
            });
            pi.appendEntry('child-stopped', true);
            signal.throwIfAborted();
          },
        });
        pi.registerTool({
          name: 'parent', label: 'Parent', description: 'Cancel child',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, _signal, _update, ctx) {
            const controller = new AbortController();
            const off = pi.events.on('child-started', () => controller.abort());
            try {
              const result = await ctx.executeTool('child', {}, { signal: controller.signal });
              pi.appendEntry('child-returned', { isError: result.isError });
              return { content: [{ type: 'text', text: 'cancelled' }] };
            } finally { off(); }
          },
        });
      }
    `, [
      assistant([{ type: 'toolCall', id: 'cancel-call', name: 'parent', arguments: {} }], 'toolUse'),
      assistant([{ type: 'text', text: 'done' }], 'stop'),
    ]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'cancel child' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      const entries = await state.read(state.conversation);
      const stopped = entries.findIndex(entry => entry.customType === 'child-stopped');
      const returned = entries.findIndex(entry => entry.customType === 'child-returned');
      expect(stopped).toBeGreaterThanOrEqual(0);
      expect(returned).toBeGreaterThan(stopped);
      expect(entries[returned].data).toEqual({ isError: true });
      expect(state.errors).toEqual([]);
    } finally { await state.runtime.close(); await state.harness.close(BACKGROUND_CONTEXT); }
  }, 10_000);

  test('delivers nested progress before the child settles', async () => {
    const state = await setup(`
      export default function (pi) {
        pi.registerTool({
          name: 'child', label: 'Child', description: 'Publish progress',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, signal, update) {
            await new Promise((resolve, reject) => {
              const off = pi.events.on('progress-seen', () => { off(); resolve(); });
              signal.addEventListener('abort', () => { off(); reject(signal.reason); }, { once: true });
              update({ content: [{ type: 'text', text: 'working' }], details: { step: 1 } });
            });
            return { content: [{ type: 'text', text: 'finished' }] };
          },
        });
        pi.registerTool({
          name: 'parent', label: 'Parent', description: 'Observe child',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, _signal, _update, ctx) {
            let progress;
            const result = await ctx.executeTool('child', {}, {
              onUpdate(value) {
                if (value.details?.step !== 1) return;
                progress = value;
                pi.events.emit('progress-seen', {});
              },
            });
            pi.appendEntry('progress', { progress, final: result.result.content });
            return { content: [{ type: 'text', text: 'observed' }] };
          },
        });
      }
    `, [
      assistant([{ type: 'toolCall', id: 'progress-call', name: 'parent', arguments: {} }], 'toolUse'),
      assistant([{ type: 'text', text: 'done' }], 'stop'),
    ]);
    try {
      const submission = await state.conversation.submit({ type: 'input', content: 'progress' }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect((await state.read(state.conversation)).find(entry => entry.customType === 'progress')?.data).toEqual({
        progress: { content: [{ type: 'text', text: 'working' }], details: { step: 1 } },
        final: [{ type: 'text', text: 'finished' }],
      });
      expect(state.errors).toEqual([]);
    } finally { await state.runtime.close(); await state.harness.close(BACKGROUND_CONTEXT); }
  }, 10_000);
});
