import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  type ToolExecutionApi,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { createToolSearchExtension, createToolSearchTool } from '@earendil-works/pi-durable/tool-search';
import { closeMcpConnections, loadMcpTools } from './extension.ts';
import type { McpExposure } from './mcp-servers.ts';
import { createMcpToolDefinition } from './tools.ts';

const resourcesFixture = join(import.meta.dir, '..', 'test-fixtures', 'mcp-server-resources.ts');
const dynamicFixture = join(import.meta.dir, '..', 'test-fixtures', 'mcp-server-dynamic.ts');

/** A server entry running the resources fixture. */
function fixtureServer(): Record<string, unknown> {
  return { command: process.execPath, args: [resourcesFixture] };
}

/** Write an `mcp.json` for `servers` and return its agent directory. */
function mcpConfig(dir: string, servers: Record<string, unknown>): string {
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: servers }));
  return agentDir;
}

/** An MCP tool registration of the given exposure, without a live server. */
function mcpTool(exposure: McpExposure, toolName: string, description: string): ToolRegistration {
  return createMcpToolDefinition({
    server: 'demo',
    tool: { name: toolName, description, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } } as never,
    name: `mcp__demo__${toolName}`,
    exposure,
    timeoutMs: undefined,
    getClient: async () => {
      throw new Error('the test never calls the tool');
    },
  });
}

describe('MCP tool visibility', () => {
  it('updates registrations when a server announces changed tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mkagent-mcp-dynamic-'));
    const agentDir = mcpConfig(dir, { dynamic: { command: process.execPath, args: [dynamicFixture], exposure: 'direct' } });
    const registry = createRegistry();
    let updated!: () => void;
    const updateReceived = new Promise<void>(resolve => { updated = resolve; });
    const mcp = await loadMcpTools({
      agentDir,
      cwd: dir,
      version: '1.0',
      debugLog: () => {},
      onUpdate: tools => {
        registry.install(defineExtension({ name: 'mcp', tools }));
        if (tools.some(tool => tool.name === 'mcp__dynamic__goodbye')) updated();
      },
    });
    const harness = await Harness.open(new MemoryStorage(), { models: builtinModels(), registry }, BACKGROUND_CONTEXT);
    try {
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      expect((await conversation.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).toContain('mcp__dynamic__hello');
      await mcp.connections[0]!.callTool('trigger', {}, {});
      await Promise.race([updateReceived, Bun.sleep(3_000).then(() => { throw new Error('MCP tool update timed out'); })]);
      const names = (await conversation.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name);
      expect(names).toContain('mcp__dynamic__goodbye');
      expect(names).not.toContain('mcp__dynamic__hello');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await closeMcpConnections(mcp.connections);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps default MCP tools searchable when codemode is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mkagent-mcp-no-codemode-'));
    const agentDir = mcpConfig(dir, { demo: fixtureServer() });
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ autoEnableCodemode: false, mcpServers: { demo: fixtureServer() } }));
    const mcp = await loadMcpTools({ agentDir, cwd: dir, version: '1.0', debugLog: () => {} });
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'mcp', tools: mcp.tools }));
    registry.install(createToolSearchExtension());
    const harness = await Harness.open(new MemoryStorage(), { models: builtinModels(), registry }, BACKGROUND_CONTEXT);
    try {
      expect(mcp.errors).toEqual([]);
      expect(mcp.autoEnableCodemode).toBe(false);
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      const agent = await conversation.agent(BACKGROUND_CONTEXT);
      expect(agent.tools.map(tool => tool.name)).not.toContain('mcp__demo__hello');
      expect(agent.deferred.map(tool => tool.name)).toContain('mcp__demo__hello');
      expect(agent.deferred.map(tool => tool.name)).toContain('list_mcp_resources');
      const search = createToolSearchTool();
      const result = await search.execute({ query: 'hello' }, {
        agent: () => conversation.agent(BACKGROUND_CONTEXT),
      } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
      expect(result.control?.addTools).toContain('mcp__demo__hello');
      const hello = agent.deferred.find(tool => tool.name === 'mcp__demo__hello')!;
      await conversation.configure({ modelTools: { add: [hello] } }, BACKGROUND_CONTEXT);
      expect((await conversation.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).toContain('mcp__demo__hello');
      const executed = await hello.execute({}, { output: () => {} } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
      expect(JSON.stringify(executed.output)).toContain('hello from MCP');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await closeMcpConnections(mcp.connections);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets tool_search find a deferred tool and keeps the other exposures unchanged', async () => {
    const registry = createRegistry();
    registry.install(defineExtension({
      name: 'mcp-demo',
      tools: [
        mcpTool('direct', 'direct_tool', 'A directly offered demo tool'),
        mcpTool('deferred', 'deferred_tool', 'Search the demo documentation index'),
        mcpTool('codemode', 'codemode_tool', 'A demo tool for code mode scripts'),
        mcpTool('hidden', 'hidden_tool', 'A demo tool hidden from the model'),
      ],
    }));
    registry.install(createToolSearchExtension());

    const harness = await Harness.open(new MemoryStorage(), {
      models: builtinModels(),
      registry,
    }, BACKGROUND_CONTEXT);
    try {
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      const agent = await conversation.agent(BACKGROUND_CONTEXT);
      const names = (tools: readonly ToolRegistration[]) => tools.map(tool => tool.name);

      expect(names(agent.tools)).toContain('mcp__demo__direct_tool');
      expect(names(agent.tools)).not.toContain('mcp__demo__deferred_tool');
      expect(names(agent.deferred)).toContain('mcp__demo__deferred_tool');
      expect(names(agent.deferred)).not.toContain('mcp__demo__direct_tool');
      expect(names(agent.tools)).not.toContain('mcp__demo__codemode_tool');
      expect(names(agent.tools)).not.toContain('mcp__demo__hidden_tool');
      expect(names(agent.deferred)).not.toContain('mcp__demo__codemode_tool');
      expect(names(agent.deferred)).not.toContain('mcp__demo__hidden_tool');
      expect(names(agent.callable)).toContain('mcp__demo__codemode_tool');
      expect(names(agent.callable)).not.toContain('mcp__demo__hidden_tool');

      const search = createToolSearchTool();
      const result = await search.execute({ query: 'demo documentation' }, {
        agent: () => conversation.agent(BACKGROUND_CONTEXT),
      } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
      const text = (result.output ?? [])
        .map(part => part.type === 'text' ? part.text : '')
        .join('\n');

      expect(text).toContain('mcp__demo__deferred_tool');
      expect(result.control?.addTools).toContain('mcp__demo__deferred_tool');

      // What the harness does with `control.addTools`: the next request offers it.
      const deferredTool = agent.deferred.find(tool => tool.name === 'mcp__demo__deferred_tool');
      if (!deferredTool) throw new Error('deferred tool is missing from the search list');
      await conversation.configure({ modelTools: { add: [deferredTool] } }, BACKGROUND_CONTEXT);
      const loaded = await conversation.agent(BACKGROUND_CONTEXT);
      expect(names(loaded.tools)).toContain('mcp__demo__deferred_tool');
      expect(names(loaded.deferred)).not.toContain('mcp__demo__deferred_tool');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('registers nothing for a hidden server, including its resource tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mkagent-mcp-hidden-'));
    const agentDir = mcpConfig(dir, { hidden: { ...fixtureServer(), exposure: 'hidden' } });
    const mcp = await loadMcpTools({ agentDir, cwd: dir, version: '1.0', debugLog: () => {} });
    try {
      expect(mcp.errors).toEqual([]);
      expect(mcp.tools).toEqual([]);
      expect(mcp.namespaces).toEqual([]);
    } finally {
      await closeMcpConnections(mcp.connections);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps hidden tools out of model, tool_search, and codemode discovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mkagent-mcp-visibility-'));
    const agentDir = mcpConfig(dir, {
      hidden: { ...fixtureServer(), exposure: 'hidden' },
      visible: { ...fixtureServer(), exposure: 'codemode' },
      partial: { ...fixtureServer(), exposure: 'codemode', toolExposure: { hello: 'hidden' } },
    });
    const mcp = await loadMcpTools({ agentDir, cwd: dir, version: '1.0', debugLog: () => {} });
    try {
      expect(mcp.errors).toEqual([]);
      const registered = mcp.tools.map(tool => tool.name);
      expect(registered).toContain('mcp__visible__hello');
      expect(registered).not.toContain('mcp__hidden__hello');
      expect(registered).not.toContain('mcp__partial__hello');
      // A visible server with a hidden tool keeps its resources; a hidden server contributes none.
      expect(registered).toContain('list_mcp_resources');
      expect(mcp.namespaces.map(namespace => namespace.name)).toEqual(['mcp__visible']);

      const registry = createRegistry();
      registry.install(defineExtension({ name: 'mcp', tools: mcp.tools }));
      registry.install(createToolSearchExtension());
      const harness = await Harness.open(new MemoryStorage(), {
        models: builtinModels(),
        registry,
      }, BACKGROUND_CONTEXT);
      try {
        const conversation = await harness.root(BACKGROUND_CONTEXT);
        const agent = await conversation.agent(BACKGROUND_CONTEXT);
        const callable = agent.callable.map(tool => tool.name);
        expect(callable).toContain('mcp__visible__hello');
        expect(callable).toContain('list_mcp_resources');
        expect(callable).not.toContain('mcp__hidden__hello');
        expect(callable).not.toContain('mcp__partial__hello');

        const offered = [...agent.tools, ...agent.deferred].map(tool => tool.name);
        expect(offered).not.toContain('mcp__hidden__hello');
        expect(offered).not.toContain('mcp__partial__hello');
        expect(offered).not.toContain('mcp__visible__hello');
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    } finally {
      await closeMcpConnections(mcp.connections);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
