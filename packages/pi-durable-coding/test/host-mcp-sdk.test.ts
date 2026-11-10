import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing';
import type { ExtensionAPI, ExtensionContext, McpExtensionOptions, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createMcpExtension } from '../src/native.ts';
import { createCodemodeToolDefinition } from '../src/native-codemode.ts';
import { InMemoryAuthStorageBackend, McpOAuthCredentialStore } from '../src/mcp-oauth.ts';

type Handler = (event: any, context: ExtensionContext) => unknown;

for (const exposure of ['direct', 'codemode'] as const) {
  test(`SDK MCP ${exposure} connects, calls tools and resources, and closes its transport`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'host-mcp-sdk-'));
    const events = new Map<string, Handler>();
    const tools = new Map<string, ToolDefinition>();
    const requests: string[] = [];
    const notifications: string[] = [];
    let closed = false;
    let active: string[] = [];
    let status: Handler | undefined;
    const codemode = createCodemodeToolDefinition({ models: false });
    tools.set(codemode.name, codemode);
    const context = {
      cwd: directory, mode: 'rpc', isProjectTrusted: () => false,
      signal: new AbortController().signal,
      ui: { notify: (message: string) => notifications.push(message) },
    } as unknown as ExtensionContext;
    const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
    // This assignment checks that the SDK accepts the host store's public protocol.
    const options: McpExtensionOptions = {
      credentials, logPath: join(directory, 'mcp.log'),
      loadConfig: ctx => {
        expect(ctx).toBe(context);
        return { errors: [], servers: [{ name: 'fixture', source: 'fixture', config: {
          command: 'unused-in-memory-fixture', exposure,
        } }] };
      },
      createTransport: (entry, cwd) => {
        expect(entry.name).toBe('fixture');
        expect(cwd).toBe(directory);
        const { client, server } = createInMemoryTransportPair();
        client.onClose(() => { closed = true; });
        server.onMessage(message => {
          if (!('id' in message) || !('method' in message)) return;
          requests.push(message.method);
          const results: Record<string, unknown> = {
            initialize: { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} },
              serverInfo: { name: 'fixture', version: '1' }, instructions: 'Fixture tools' },
            'tools/list': { tools: [{ name: 'echo', description: 'Echo a value',
              inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] },
            'tools/call': { content: [{ type: 'text', text: String((message.params as any)?.arguments?.value) }] },
            'resources/list': { resources: [{ uri: 'fixture://one', name: 'one' }] },
            'resources/read': { contents: [{ uri: 'fixture://one', text: 'resource 中文' }] },
          };
          void server.send({ jsonrpc: '2.0', id: message.id, result: results[message.method] ?? {} });
        });
        void server.start();
        return client;
      },
    };
    await createMcpExtension(options)({
      on: (name: string, handler: Handler) => events.set(name, handler),
      registerToolRenderer: () => {},
      registerCommand: (_name: string, command: { handler: Handler }) => { status = command.handler; },
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      getMcpServers: () => [], getAllTools: () => [...tools.values()],
      getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    } as unknown as ExtensionAPI);
    const emit = (name: string, event: unknown = {}) => events.get(name)?.(event, context);
    try {
      await emit('session_start');
      await status!('', context);
      expect(notifications.some(message => message.includes('fixture'))).toBe(true);
      const tool = tools.get('mcp__fixture__echo')!;
      expect(tool).toBeDefined();
      expect(tool.exposure).toBe(exposure === 'codemode' ? 'deferred' : 'direct');
      const toolContext = {
        tools: [...tools.values()].map(definition => ({ ...definition, label: definition.name })) as AgentTool[],
        sessionManager: { getBranch: () => [] },
        executeTool: async (name: string, args: any, options: { signal?: AbortSignal }) => {
          await emit('tool_call', { toolName: name, input: args });
          const result = await tools.get(name)!.execute('mcp-child', args, options.signal, undefined, context);
          return { toolCall: { type: 'toolCall', id: 'mcp-child', name, arguments: args }, result, isError: false };
        },
      } as unknown as Parameters<typeof codemode.execute>[4];
      const result = exposure === 'codemode'
        ? await codemode.execute('script', { code: 'return await tools.mcp__fixture__echo({value:"tool 中文"});' }, undefined, undefined, toolContext)
        : await tool.execute('direct', { value: 'tool 中文' }, undefined, undefined, context);
      expect(JSON.stringify(result.content)).toContain('tool 中文');
      expect(active.includes('codemode')).toBe(exposure === 'codemode');
      const resource = await tools.get('read_mcp_resource')!.execute('resource', {
        server: 'fixture', uri: 'fixture://one',
      }, undefined, undefined, context);
      expect(JSON.stringify(resource.content)).toContain('resource 中文');
      expect(requests.filter(method => method === 'tools/call')).toHaveLength(1);
      expect(requests).toContain('resources/read');
    } finally {
      await emit('session_shutdown');
      expect(closed).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
