/** Exercise SDK lifecycle hooks with an in-memory protocol transport. */
import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { StdioTransport, type McpTransport } from '@earendil-works/pi-mcp';
import { McpServerConnection as SdkConnection } from '@mkagent/pi-durable-coding/mcp-runtime';
import { createDefaultTransport, McpServerConnection } from './runtime.ts';

type Message = Parameters<McpTransport['send']>[0];
class FixtureTransport implements McpTransport {
  private readonly messages = new Set<(message: Message) => void>();
  private readonly closes = new Set<() => void>();
  readonly resourceRequested = Promise.withResolvers<void>();
  closed = false;
  holdResources = false;
  resources = [{ uri: 'fixture://visible', name: 'visible' }, { uri: 'ui://hidden', name: 'app' }];
  requests: string[] = [];
  clientInfo: unknown;
  async start() {}
  async send(message: Message) {
    if (!('method' in message) || !('id' in message)) return;
    this.requests.push(message.method);
    let result: Record<string, unknown>;
    switch (message.method) {
      case 'initialize':
        this.clientInfo = (message.params as { clientInfo: unknown }).clientInfo;
        result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' },
          capabilities: { tools: {}, resources: {} }, instructions: ' fixture instructions ' };
        break;
      case 'tools/list': result = { tools: [{ name: 'hello', inputSchema: { type: 'object' } }] }; break;
      case 'resources/list':
        this.resourceRequested.resolve();
        if (this.holdResources) return;
        result = { resources: this.resources };
        break;
      case 'resources/templates/list': result = { resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'template' }] }; break;
      case 'tools/call': result = { content: [{ type: 'text', text: 'fixture result' }] }; break;
      default: throw new Error('Unexpected fixture request: ' + message.method);
    }
    this.emit({ jsonrpc: '2.0', id: message.id!, result });
  }
  emit(message: Message) { for (const listener of this.messages) listener(message); }
  async close() {
    this.closed = true;
    for (const listener of this.closes) listener();
  }
  onMessage(listener: (message: Message) => void) { this.messages.add(listener); return () => this.messages.delete(listener); }
  onError() { return () => {}; }
  onClose(listener: () => void) { this.closes.add(listener); return () => this.closes.delete(listener); }
}

function connection(createTransport: () => FixtureTransport, onChange = () => {}) {
  return new McpServerConnection({
    entry: { name: 'fixture', scope: 'global', config: { command: 'fixture-command' } },
    cwd: tmpdir(), version: 'host-fixture-version', createTransport, onTools() {}, onChange, log: undefined,
  });
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('SDK runtime owns request dispatch while host discovery publishes filtered resource counts and notifications', async () => {
  const transport = new FixtureTransport();
  let changes = 0;
  const server = connection(() => transport, () => { changes++; });
  try {
    const opening = server.getClient();
    expect(server.getClient()).toBe(opening);
    await opening;
    expect(server).toBeInstanceOf(SdkConnection);
    expect(McpServerConnection.prototype.callTool).toBe(SdkConnection.prototype.callTool);
    expect(transport.clientInfo).toEqual({ name: 'mkagent', version: 'host-fixture-version' });
    expect(server.state).toBe('connected');
    expect(server.instructions).toBe('fixture instructions');
    expect(server.resources.map(resource => resource.uri)).toEqual(['fixture://visible']);
    expect(server.resourceTemplates).toHaveLength(1);
    expect((await server.callTool('hello', {}, {})).content).toEqual([{ type: 'text', text: 'fixture result' }]);
    const before = changes;
    transport.resources = [{ uri: 'fixture://changed', name: 'changed' }];
    transport.emit({ jsonrpc: '2.0', method: 'notifications/resources/list_changed', params: {} });
    await tick();
    expect(server.resources.map(resource => resource.uri)).toEqual(['fixture://changed']);
    expect(changes).toBeGreaterThan(before);
    const lists = transport.requests.filter(method => method === 'tools/list').length;
    transport.emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    await tick();
    expect(transport.requests.filter(method => method === 'tools/list')).toHaveLength(lists + 1);
  } finally { await server.close(); }
  expect(transport.closed).toBe(true);
});

test('close drains SDK discovery without publishing a partial connection', async () => {
  const transport = new FixtureTransport();
  transport.holdResources = true;
  const server = connection(() => transport);
  const opening = server.getClient();
  const outcome = opening.then(() => undefined, error => error);
  await transport.resourceRequested.promise;
  await server.close();
  expect(await outcome).toBeInstanceOf(Error);
  expect(server.state).toBe('closed');
  expect(server.client).toBeUndefined();
  expect(server.resources).toEqual([]);
  expect(transport.closed).toBe(true);
});

test('cancelled reconnect closes only that setup and permits a later connection', async () => {
  const held = new FixtureTransport(), next = new FixtureTransport();
  held.holdResources = true;
  let creates = 0;
  const server = connection(() => creates++ === 0 ? held : next);
  const controller = new AbortController();
  try {
    const reconnecting = server.reconnect(controller.signal);
    const outcome = reconnecting.then(() => undefined, error => error);
    await held.resourceRequested.promise;
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(held.closed).toBe(true);
    expect(server.closed).toBe(false);
    expect(server.client).toBeUndefined();
    expect(server.resources).toEqual([]);
    await server.getClient();
    expect(server.state).toBe('connected');
    expect(creates).toBe(2);
    expect(next.closed).toBe(false);
  } finally { await server.close(); }
});

test('default SDK connection retains Pi identity and lazy resource discovery without host hooks', async () => {
  const transport = new FixtureTransport();
  const server = new SdkConnection({
    entry: { name: 'fixture', source: '/fixture/mcp.json', config: { command: 'fixture-command' } }, cwd: tmpdir(),
    authProvider: undefined, createTransport: () => transport, onTools() {},
  });
  try {
    await server.getClient();
    expect(transport.clientInfo).toEqual({ name: 'pi', version: '1.5.0' });
    expect(server.hasResources).toBe(true);
    expect(transport.requests).not.toContain('resources/list');
    expect(await server.allResources({})).toHaveLength(2);
  } finally { await server.close(); }
});

test('partial host entries dispatch undefined URLs to the SDK stdio transport', () => {
  const transport = createDefaultTransport({ name: 'fixture', scope: 'global', config: { url: undefined, command: 'fixture-command' } }, tmpdir());
  expect(transport).toBeInstanceOf(StdioTransport);
});
