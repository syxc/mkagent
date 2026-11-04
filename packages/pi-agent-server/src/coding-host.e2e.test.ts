import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { defineExtension } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { NativeSessionJournal } from '@mkagent/pi-durable-coding/durable';
import { durableFixture, response } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { DurableKernel } from './kernel.ts';
import { BackgroundShells } from './background-shell.ts';
import { createBuiltinTools } from './tools/builtin.ts';
import { wrapToolForKernel } from './tools/wrap.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

describe('coding extensions on the production durable host', () => {
  test('runs explicit native plugins with host-only resources and restores their durable history', async () => {
    const root = await durableFixture([
      { ...response('', 'toolUse'), content: [{ type: 'toolCall', id: 'greeting', name: 'hello', arguments: { name: 'requested' } }] },
      response('first answer'), response('resumed answer'),
    ]);
    await root.harness.close(BACKGROUND_CONTEXT);
    cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
    const agentDir = join(root.directory, 'agent');
    for (const directory of [agentDir, join(root.directory, '.pi')]) {
      mkdirSync(join(directory, 'extensions'), { recursive: true });
      writeFileSync(join(directory, 'settings.json'), '{"compaction":{"enabled":false}}');
      writeFileSync(join(directory, 'SYSTEM.md'), 'ambient-system-must-stay-out');
      writeFileSync(join(directory, 'AGENTS.md'), 'ambient-instructions-must-stay-out');
      writeFileSync(join(directory, 'extensions', 'ambient.ts'), 'throw new Error("AMBIENT EXTENSION EXECUTED");');
    }
    const approved: string[] = [];
    const errors: string[] = [];
    const options: ConstructorParameters<typeof DurableKernel>[0] = {
      sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
      toolsExtension: defineExtension({ name: 'empty' }),
      coding: {
        agentDir, projectTrusted: true, resourcePolicy: 'host-only',
        extensionPaths: [resolve(import.meta.dir, '../../pi-durable-coding/test/fixtures/upstream/hello.ts')],
      },
      wrapCodingTool: tool => ({
        ...tool, execute: (args, api, context) => {
          approved.push(tool.name);
          return tool.execute({ ...args, name: 'approved' }, api, context);
        },
      }),
      hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
        isPrefetchableTool: () => false, debugLog: error => errors.push(error) },
    };
    const model = { provider: 'faux', modelId: 'local', contextWindow: 100_000 };
    const first = new DurableKernel(options);
    cleanup.push(() => first.close());
    first.systemPrompt = 'host-owned-system';
    await first.open({ model });
    await first.submitPrompt('first question');
    await first.waitForIdle();
    const id = first.sessionId;
    await first.close();
    const resumed = new DurableKernel(options);
    cleanup.push(() => resumed.close());
    resumed.systemPrompt = 'host-owned-system';
    await resumed.open({ model });
    await resumed.submitPrompt('second question');
    await resumed.waitForIdle();
    expect(resumed.sessionId).toBe(id);
    expect(root.calls).toHaveLength(3);
    expect(approved).toEqual(['hello']);
    expect(JSON.stringify(root.calls[2]!.messages)).toContain('Hello, approved!');
    for (const call of root.calls) {
      expect(getCurrentTools(call.messages).map(tool => tool.name)).toEqual(['hello']);
      const system = JSON.stringify(call.messages.filter(message => message.role === 'system'));
      expect(system).toContain('host-owned-system');
      expect(system).not.toContain('ambient-');
    }
    expect((await resumed.contextUsagePayload()).compactionSettings.enabled).toBe(true);
    expect(errors).toEqual([]);
  });

  test('native commands can wait and reload while replacement requires a product owner', async () => {
    const root = await durableFixture([]);
    await root.harness.close(BACKGROUND_CONTEXT);
    cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
    const agentDir = join(root.directory, 'agent');
    mkdirSync(agentDir);
    const plugin = join(agentDir, 'commands.ts');
    writeFileSync(plugin, `
      export default function(pi) {
        pi.on('session_start', event => pi.appendEntry('started', { reason: event.reason }));
        pi.registerCommand('idle', { handler: async (_args, ctx) => {
          await ctx.waitForIdle(); pi.appendEntry('idle', {});
        } });
        pi.registerCommand('fresh', { handler: async (_args, ctx) => {
          try { await ctx.newSession(); }
          catch (error) { pi.appendEntry('owner-required', { error: String(error) }); }
        } });
        pi.registerCommand('refresh', { handler: async (_args, ctx) => { await ctx.reload(); } });
        pi.registerTool({ name: 'local', description: 'Synthetic local tool',
          parameters: { type: 'object', properties: {} },
          execute: async (_id, _args, _signal, _update, ctx) => {
            return { content: [{ type: 'text', text: ctx.model.id }], details: {} };
          }
        });
      }
    `);
    const errors: string[] = [];
    const kernel = new DurableKernel({
      sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
      toolsExtension: defineExtension({ name: 'empty' }), coding: { agentDir, extensionPaths: [plugin] },
      wrapCodingTool: tool => tool,
      hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
        isPrefetchableTool: () => false, debugLog: error => errors.push(error) },
    });
    cleanup.push(() => kernel.close());
    await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
    const original = kernel.sessionId;
    await kernel.submitPrompt('/idle');
    await kernel.submitPrompt('/fresh');
    expect(kernel.sessionId).toBe(original);
    const replaced = kernel.sessionId;
    await kernel.submitPrompt('/refresh');
    expect(kernel.sessionId).toBe(replaced);
    const coding = (kernel as unknown as { coding: { journal: NativeSessionJournal } }).coding;
    expect(coding.journal.manager.getEntries().filter(entry => entry.customType === 'started').map(entry => entry.data))
      .toEqual([{ reason: 'startup' }, { reason: 'reload' }]);
    expect(coding.journal.manager.getEntries().filter(entry => entry.customType === 'owner-required')).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(root.calls).toHaveLength(0);
  });

  test('selects an extension model and keeps it usable after host model replacements', async () => {
    const root = await durableFixture([response('registered answer')]);
    await root.harness.close(BACKGROUND_CONTEXT);
    cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
    const base = root.models.getProvider('faux')!;
    let models = root.models;
    const replaceModels = () => {
      models = builtinModels({ credentials: new InMemoryCredentialStore() });
      models.setProvider(base);
    };
    const agentDir = join(root.directory, 'agent');
    mkdirSync(agentDir);
    const plugin = join(agentDir, 'models.ts');
    const registered = { ...root.models.getModel('faux', 'local')!, id: 'registered' };
    writeFileSync(plugin, `
      export default function(pi) {
        let model;
        pi.registerProvider('faux', { models: [${JSON.stringify(registered)}] });
        pi.on('session_start', (_event, ctx) => { model = ctx.modelRegistry.find('faux', 'registered'); });
        pi.registerCommand('select-registered', { handler: async (_args, ctx) => {
          const selected = await pi.setModel(model);
          pi.appendEntry('model-selected', { selected, model: ctx.model?.id });
        } });
      }
    `);
    const kernel = new DurableKernel({
      sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => models,
      toolsExtension: defineExtension({ name: 'empty' }), coding: { agentDir, extensionPaths: [plugin] },
      wrapCodingTool: tool => tool,
      hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
        isPrefetchableTool: () => false, debugLog: () => {} },
    });
    cleanup.push(() => kernel.close());
    await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
    replaceModels();
    await kernel.submitPrompt('/select-registered');
    const store = (kernel as unknown as { coding: { journal: NativeSessionJournal } }).coding.journal.manager;
    expect((await store.getEntries()).find(entry => entry.customType === 'model-selected')?.data)
      .toEqual({ selected: true, model: 'registered' });
    expect(kernel.currentModel?.modelId).toBe('registered');
    replaceModels();
    await kernel.submitPrompt('hello');
    await kernel.waitForIdle();
    expect(root.calls).toHaveLength(1);
    expect(models.getModel('faux', 'registered')).toBeUndefined();
    expect(root.requestedModels).toEqual([{ provider: 'faux', id: 'registered' }]);
  });

  test('rejects unsupported session options before replacing the current session', async () => {
    const root = await durableFixture([]);
    await root.harness.close(BACKGROUND_CONTEXT);
    cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
    const agentDir = join(root.directory, 'agent');
    mkdirSync(agentDir);
    const plugin = join(agentDir, 'session-contract.ts');
    writeFileSync(plugin, `
      export default function(pi) {
        pi.on('session_start', () => pi.appendEntry('ready', {}));
        pi.registerCommand('session-contract', { handler: async (_args, ctx) => {
          const calls = [
            () => ctx.newSession({ setup: async () => {} }),
            () => ctx.newSession({ parentSession: 'other-session' }),
            () => ctx.newSession({ withSession: async () => {} }),
            () => ctx.fork(ctx.sessionManager.getLeafId(), { withSession: async () => {} }),
            () => ctx.navigateTree(ctx.sessionManager.getLeafId(), { summarize: true }),
          ];
          for (const call of calls) {
            try { await call(); pi.appendEntry('unexpected-success', {}); }
            catch (error) { pi.appendEntry('session-error', { error: String(error) }); }
          }
        } });
      }
    `);
    const kernel = new DurableKernel({
      sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
      toolsExtension: defineExtension({ name: 'empty' }), coding: { agentDir, extensionPaths: [plugin] },
      wrapCodingTool: tool => tool,
      hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
        isPrefetchableTool: () => false, debugLog: () => {} },
    });
    cleanup.push(() => kernel.close());
    await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
    const coding = () => (kernel as unknown as { coding: { journal: NativeSessionJournal } }).coding;
    const original = coding().journal.manager.getSessionId();
    await kernel.submitPrompt('/session-contract');
    expect(coding().journal.manager.getSessionId()).toBe(original);
    const entries = await coding().journal.manager.getEntries();
    expect(entries.filter(entry => entry.customType === 'session-error')).toHaveLength(5);
    expect(entries.filter(entry => entry.customType === 'unexpected-success')).toHaveLength(0);
    expect(root.calls).toHaveLength(0);
  });

  test('keeps nextTurn messages out of history until an input and restores the queue after reopen', async () => {
    const root = await durableFixture([response('answer')]);
    await root.harness.close(BACKGROUND_CONTEXT);
    cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
    const agentDir = join(root.directory, 'agent');
    mkdirSync(agentDir);
    const plugin = join(agentDir, 'next-turn.ts');
    writeFileSync(plugin, `
      export default function(pi) {
        pi.registerCommand('aside', { handler: () => pi.sendMessage({
          customType: 'aside', content: 'next-input-context', display: false,
        }, { deliverAs: 'nextTurn' }) });
      }
    `);
    const options = {
      sessionPath: join(root.directory, 'session'), cwd: root.directory, modelsSource: () => root.models,
      toolsExtension: defineExtension({ name: 'empty' }), coding: { agentDir, extensionPaths: [plugin] },
      wrapCodingTool: (tool: Parameters<typeof wrapToolForKernel>[0]) => tool,
      hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
        isPrefetchableTool: () => false, debugLog: () => {} },
    };
    const kernel = new DurableKernel(options);
    cleanup.push(() => kernel.close());
    const model = { provider: 'faux', modelId: 'local', contextWindow: 100_000 };
    await kernel.open({ model });
    await kernel.submitPrompt('/aside');
    const projected = (instance: DurableKernel) =>
      (instance as unknown as { coding: { journal: NativeSessionJournal } }).coding.journal.manager.getEntries();
    expect((await projected(kernel)).some(entry => entry.customType === 'aside')).toBe(false);
    expect(root.calls).toHaveLength(0);
    await kernel.close();
    const reopened = new DurableKernel(options);
    cleanup.push(() => reopened.close());
    await reopened.open({ model });
    expect((await projected(reopened)).some(entry => entry.customType === 'aside')).toBe(false);
    await reopened.submitPrompt('hello');
    await reopened.waitForIdle();
    expect(root.calls[0].messages.filter(message => message.role !== 'system').map(message => message.content))
      .toEqual([[{ type: 'text', text: 'hello' }], [{ type: 'text', text: 'next-input-context' }]]);
    expect((await projected(reopened)).filter(entry => entry.customType === 'aside')).toHaveLength(1);
  });

  test('loads native resources and the official hello extension through real host approvals, then restores plugin state', async () => {
    const root = await durableFixture([
      {
        ...response(''), stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'hello-call', name: 'hello', arguments: { name: 'original' } },
          { type: 'toolCall', id: 'write-call', name: 'write', arguments: { path: 'requested.txt', content: 'original' } },
        ],
      },
      response('first answer'), response('final answer'), response('raw answer'), response('expanded answer'), response('idle steer answer'),
    ]);
    await root.harness.close(BACKGROUND_CONTEXT);
    cleanup.push(() => rmSync(root.directory, { recursive: true, force: true }));
    const agentDir = join(root.directory, 'agent');
    const sessionPath = join(root.directory, 'session');
    mkdirSync(join(agentDir, 'prompts'), { recursive: true });
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false, reserveTokens: 123 } }));
    writeFileSync(join(agentDir, 'SYSTEM.md'), 'native-system');
    writeFileSync(join(agentDir, 'AGENTS.md'), 'host-system');
    writeFileSync(join(agentDir, 'prompts/say.md'), 'Say $1');
    const plugin = join(agentDir, 'coding-extension.ts');
    writeFileSync(plugin, `
      export default function (pi) {
        pi.registerCommand('mark', { handler: (_args, ctx) => {
          const settings = pi.getSettings();
          pi.appendEntry('marked', { session: ctx.sessionManager.getSessionId(), reserve: settings.compaction?.reserveTokens });
          if (settings.compaction) settings.compaction.reserveTokens = 999;
          pi.appendEntry('settings-copy', { reserve: pi.getSettings().compaction?.reserveTokens });
        } });
        pi.on('session_start', event => pi.appendEntry('started', { reason: event.reason }));
        pi.on('before_agent_start', () => pi.setActiveTools(['hello', 'write']));
        pi.registerCommand('extension-raw', { handler: () => pi.sendUserMessage('/say extension') });
        pi.registerCommand('extension-expanded', { handler: () =>
          pi.sendUserMessage('/say extension', { expandPromptTemplates: true }) });
        pi.on('input', event => {
          pi.appendEntry('input-observed', { source: event.source, text: event.text });
          return event.text.startsWith('/say ') ? { action: 'transform', text: '/say transformed' } : undefined;
        });
        pi.on('before_agent_start', event => ({
          systemPrompt: event.systemPrompt + '\\nplugin-system',
          message: { customType: 'prelude', content: 'before-agent-message', display: false },
        }));
        pi.on('tool_call', event => {
          if (event.toolName === 'hello') event.input.name = 'hook-name';
          if (event.toolName === 'write') event.input.content = 'hook-content';
        });
        pi.on('tool_result', event => pi.appendEntry('approved-input', {
          tool: event.toolName, input: event.input,
        }));
        pi.on('turn_end', (event, ctx) => {
          pi.appendEntry('turn', {
            index: event.turnIndex, toolIds: event.toolResults.map(result => result.toolCallId),
            idsMatch: event.toolResultEntryIds.every((id, index) =>
              ctx.sessionManager.getEntry(id).message.toolCallId === event.toolResults[index].toolCallId),
          });
          return event.turnIndex === 1 ? {
            entries: [{ type: 'custom_message', customType: 'check', content: 'verify-result', display: false }],
            continue: true,
          } : undefined;
        });
      }
    `);
    const approvals: Array<{ name: string; input: Record<string, unknown> }> = [];
    const shells = new BackgroundShells(() => {});
    cleanup.push(() => shells.dispose());
    const env = new NodeExecutionEnv({ cwd: root.directory });
    const wrap = (tool: Parameters<typeof wrapToolForKernel>[0]) => wrapToolForKernel(tool, {
      requestApproval: async (name, input) => {
        approvals.push({ name, input });
        return name === 'hello' ? { ...input, name: 'approved-name' }
          : name === 'Write' ? { ...input, file_path: join(root.directory, 'approved.txt'), content: 'approved-content' } : input;
      },
      backgroundShells: shells, tasksDirectory: join(root.directory, 'tasks'), shellEnv: env,
      getContextWindow: () => 100_000, summarize: async () => null, getUserRequest: () => '',
      getSessionPath: () => sessionPath, debugLog: () => {},
    });
    const errors: string[] = [];
    const options = {
      sessionPath, cwd: root.directory, modelsSource: () => root.models,
      toolsExtension: defineExtension({ name: 'mkagent-tools', tools: createBuiltinTools(root.directory).map(wrap) }),
      coding: { agentDir, extensionPaths: [resolve(import.meta.dir, '../../pi-durable-coding/test/fixtures/upstream/hello.ts'), plugin] },
      wrapCodingTool: wrap,
      hooks: {
        emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
        isPrefetchableTool: () => false, debugLog: (message: string) => errors.push(message),
      },
    };
    const kernel = new DurableKernel(options);
    cleanup.push(() => kernel.close());
    kernel.systemPrompt = 'host-system';
    await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
    await kernel.submitPrompt('/mark');
    expect(root.calls).toHaveLength(0);
    await kernel.submitPrompt('/say hello');
    await kernel.waitForIdle();
    expect(root.calls).toHaveLength(3);
    expect(root.calls[0].messages.filter(message => message.role !== 'system').map(message => message.content))
      .toEqual([[{ type: 'text', text: 'Say transformed' }], [{ type: 'text', text: 'before-agent-message' }]]);
    expect(root.calls[0].messages[0].content).toContain('host-system');
    expect(root.calls[0].messages[0].content).toContain('native-system');
    expect(root.calls[0].messages[0].content).toContain(join(agentDir, 'AGENTS.md'));
    expect(root.calls[0].messages[0].content).toContain('plugin-system');
    expect(getCurrentTools(root.calls[0].messages).map(tool => tool.name).sort()).toEqual(['hello', 'write']);
    expect(JSON.stringify(root.calls[2].messages.at(-1)?.content)).toContain('verify-result');
    expect(approvals.find(item => item.name === 'hello')?.input.name).toBe('hook-name');
    expect(approvals.find(item => item.name === 'Write')?.input.content).toBe('hook-content');
    expect(readFileSync(join(root.directory, 'approved.txt'), 'utf8')).toBe('approved-content');
    expect(existsSync(join(root.directory, 'requested.txt'))).toBe(false);
    const projected = async () => {
      const coding = (kernel as unknown as { coding: { journal: NativeSessionJournal } }).coding;
      return coding.journal.manager.getEntries();
    };
    const entries = await projected();
    expect(entries.some(entry => entry.customType === 'marked')).toBe(true);
    expect(entries.find(entry => entry.customType === 'marked')?.data.reserve).toBe(123);
    expect(entries.find(entry => entry.customType === 'settings-copy')?.data.reserve).toBe(123);
    expect(entries.filter(entry => entry.customType === 'turn').map(entry => entry.data))
      .toEqual([
        { index: 0, toolIds: ['hello-call', 'write-call'], idsMatch: true },
        { index: 1, toolIds: [], idsMatch: true },
        { index: 2, toolIds: [], idsMatch: true },
      ]);
    expect(entries.find(entry => entry.customType === 'approved-input'
      && (entry.data as { tool: string }).tool === 'hello')?.data)
      .toEqual({ tool: 'hello', input: { name: 'approved-name' } });
    await kernel.submitPrompt('/extension-raw');
    await kernel.waitForIdle();
    expect(root.calls[3].messages.filter(message => message.role !== 'system').slice(-2).map(message => message.content))
      .toEqual([[{ type: 'text', text: '/say transformed' }], [{ type: 'text', text: 'before-agent-message' }]]);
    await kernel.submitPrompt('/extension-expanded');
    await kernel.waitForIdle();
    expect(root.calls[4].messages.filter(message => message.role !== 'system').slice(-2).map(message => message.content))
      .toEqual([[{ type: 'text', text: 'Say transformed' }], [{ type: 'text', text: 'before-agent-message' }]]);
    await kernel.steer('idle steer');
    await kernel.waitForIdle();
    expect(root.calls[5].messages.filter(message => message.role !== 'system').slice(-2).map(message => message.content))
      .toEqual([[{ type: 'text', text: 'idle steer' }], [{ type: 'text', text: 'before-agent-message' }]]);
    expect((await projected()).filter(entry => entry.customType === 'input-observed').map(entry => entry.data))
      .toEqual([
        { source: 'interactive', text: '/say hello' }, { source: 'extension', text: '/say extension' },
        { source: 'extension', text: '/say extension' }, { source: 'interactive', text: 'idle steer' },
      ]);
    const id = kernel.sessionId;
    await kernel.close();
    const reopened = new DurableKernel(options);
    cleanup.push(() => reopened.close());
    await reopened.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
    const restored = await (reopened as unknown as { coding: { journal: NativeSessionJournal } }).coding.journal.manager.getEntries();
    expect(reopened.sessionId).toBe(id);
    expect(restored.some(entry => entry.customType === 'marked')).toBe(true);
    expect(restored.filter(entry => entry.customType === 'started').map(entry => entry.data))
      .toEqual([{ reason: 'startup' }, { reason: 'resume' }]);
    expect(restored.filter(entry => entry.customType === 'turn')).toHaveLength(6);
    expect(root.calls).toHaveLength(6);
    expect(errors.filter(message => message.includes('[coding:') || message.includes('[kernel]'))).toEqual([]);
  });
});
