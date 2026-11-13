/** Exercise durable built-ins through the coding Agent, without the complete SDK or providers. */
import { afterEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Model } from '@earendil-works/pi-ai';
import {
  createRegistry, defineExtension, Harness, MemoryStorage,
  type Report, type ToolRegistration,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import * as s from '@earendil-works/pi-schema';
import { Agent, type AgentToolCall } from '../src/agent-runtime.ts';
import { DurableLoopBinding } from '../src/durable-coding/engine.ts';
import { hostToolToAgent } from '../src/host-tools.ts';
import { createCodemodeExtensionFor } from '../../pi-agent-server/src/tools/codemode.ts';
import { wrapToolForKernel, type ToolWrapDeps } from '../../pi-agent-server/src/tools/wrap.ts';
import { BackgroundShells } from '../../pi-agent-server/src/background-shell.ts';
import { response } from './fixtures/durable-harness.ts';

const context = BACKGROUND_CONTEXT;
const agents: Agent[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map(async agent => {
    agent.abort();
    await agent.waitForIdle();
    await agent.durable.close();
  }));
  await Promise.all(harnesses.splice(0).map(harness => harness.close(context)));
});

const model: Model<'faux'> = {
  id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function open(registrations: ToolRegistration<any>[], calls: AgentToolCall[]) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'coding-builtins-test', tools: registrations }));
  const reports: Report[] = [];
  const env = new NodeExecutionEnv({ cwd: tmpdir(), shellEnv: {} });
  const harness = await Harness.open(new MemoryStorage(), {
    registry, models: createModels(), env: () => env,
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
    onReport: report => { reports.push(report); },
  }, context);
  harnesses.push(harness);
  const conversation = await harness.root(context);
  const errors: unknown[] = [];
  const tools = registrations.map(registration => {
    const tool = hostToolToAgent(registration);
    return { ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
      try { return await tool.execute(...args); }
      catch (error) {
        errors.push(...(error instanceof AggregateError ? error.errors : [error]));
        throw error;
      }
    } };
  });
  const active = new Set(registrations.filter(tool =>
    !tool.deferred && tool.callers?.includes('model') !== false).map(tool => tool.name));
  const offered: string[][] = [];
  const activated: string[][] = [];
  let requests = 0;
  const agent = new Agent({
    durable: new DurableLoopBinding({
      kernel: { harness, conversation, registry },
      activateTools: names => {
        activated.push(names);
      },
    }),
    initialState: { model, tools: tools.filter(tool => active.has(tool.name)) },
    streamFn: (_model, transcript) => {
      const declared = new Set<string>();
      for (const message of transcript.messages) {
        if (message.role !== 'system') continue;
        for (const tool of message.toolsAdded ?? []) declared.add(tool.name);
        for (const tool of message.toolsRemoved ?? []) declared.delete(tool.name);
      }
      offered.push([...declared]);
      if (requests > calls.length) throw new Error('Unexpected provider request');
      const call = calls[requests++];
      const message = response('done', call ? 'toolUse' : 'stop');
      if (call) message.content = [call];
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({
        type: 'done', reason: call ? 'toolUse' : 'stop', message,
      }));
      return stream;
    },
  });
  agents.push(agent);
  return { agent, harness, conversation, reports, offered, activated, env, errors };
}

function call(name: string, args: Record<string, unknown>): AgentToolCall {
  return { type: 'toolCall', name, id: `${name}-call`, arguments: args };
}

function toolResults(agent: Agent) {
  return agent.state.messages.filter(message => message.role === 'toolResult');
}

test('production codemode runs an approved child in an official durable ToolTask', async () => {
  const approved: Array<{ name: string; value: unknown }> = [];
  const dependencies: ToolWrapDeps = {
    requestApproval: async (name, args) => {
      approved.push({ name, value: args.value });
      return { ...args, value: 'approved' };
    },
    backgroundShells: new BackgroundShells(() => {}),
    tasksDirectory: join(tmpdir(), 'unused-codemode-tasks'),
    shellEnv: new NodeExecutionEnv({ cwd: tmpdir(), shellEnv: {} }),
    getContextWindow: () => 100_000, summarize: async () => null,
    getUserRequest: () => 'fixture', getSessionPath: () => null, debugLog: () => {},
  };
  let effects = 0;
  let taskKind: string | undefined;
  let ownerKind: string | undefined;
  const leaf = wrapToolForKernel({
    name: 'leaf', description: 'Return the approved value', callers: ['tools'], replay: 'safe',
    parameters: s.obj({ value: s.str() }), structuredOutputSchema: s.obj({ value: s.str() }),
    execute: async (args, api, ctx) => {
      effects++;
      const task = await api.getTask(api.taskId, ctx);
      taskKind = task?.kind;
      ownerKind = task?.owner ? (await api.getTask(task.owner, ctx))?.kind : undefined;
      return { structuredOutput: { value: args.value } };
    },
  }, dependencies);
  const extension = createCodemodeExtensionFor([], async () => {
    throw new Error('Unexpected model helper request');
  });
  const opened = await open([...(extension.tools ?? []), leaf], [
    call('codemode', { code: 'text(await tools.leaf({value: "original"}));' }),
  ]);
  await opened.agent.prompt('Run the local codemode fixture');
  expect(opened.errors).toEqual([]);
  expect(opened.agent.state.errorMessage).toBeUndefined();
  expect(toolResults(opened.agent)).toMatchObject([{
    toolName: 'codemode', isError: false,
    content: expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('approved') }),
    ]),
  }]);
  expect(approved).toEqual([{ name: 'leaf', value: 'original' }]);
  expect(effects).toBe(1);
  expect(taskKind).toBe('pi.tool');
  expect(ownerKind).toBe('pi.coding.tool');
  expect(opened.offered[0]).toEqual(['codemode']);
  expect(opened.reports).toEqual([]);
});

test('production codemode cannot invoke a model-only tool', async () => {
  let effects = 0;
  const blocked: ToolRegistration = {
    name: 'model_only', description: 'Only callable by the model', callers: ['model'],
    parameters: s.obj({}),
    execute: async () => { effects++; return { output: [{ type: 'text', text: 'blocked effect' }] }; },
  };
  const opened = await open([...(createCodemodeExtensionFor().tools ?? []), blocked], [
    call('codemode', { code: 'text(await tools.model_only({}));' }),
  ]);
  await opened.agent.prompt('Try the denied local fixture');
  expect(opened.errors).toEqual([]);
  expect(opened.agent.state.errorMessage).toBeUndefined();
  expect(toolResults(opened.agent)).toMatchObject([{ toolName: 'codemode', isError: true }]);
  expect(toolResults(opened.agent)[0]?.content).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'text', text: expect.stringContaining('model_only') }),
  ]));
  expect(effects).toBe(0);
  expect(opened.reports).toEqual([]);
});

test('durable tool_search returns deferred tool activation to the owning coding run', async () => {
  let effects = 0;
  const leaf: ToolRegistration = {
    name: 'deferred_leaf', description: 'Local deferred leaf fixture', deferred: true,
    parameters: s.obj({}),
    execute: async () => { effects++; return { output: [{ type: 'text', text: 'leaf result' }] }; },
  };
  const opened = await open([...(createToolSearchExtension().tools ?? []), leaf], [
    call('tool_search', { query: 'deferred_leaf' }),
  ]);
  await opened.agent.prompt('Find and call the deferred fixture');
  expect(opened.errors).toEqual([]);
  expect(opened.agent.state.errorMessage).toBeUndefined();
  expect(opened.offered[0]).toEqual(['tool_search']);
  expect(opened.activated).toEqual([['deferred_leaf']]);
  expect(toolResults(opened.agent)).toMatchObject([
    { toolName: 'tool_search', isError: false, details: { loaded: ['deferred_leaf'] } },
  ]);
  expect(effects).toBe(0);
  expect(opened.reports).toEqual([]);
});
