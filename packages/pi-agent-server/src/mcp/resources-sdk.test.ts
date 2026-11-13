import { expect, test } from 'bun:test';
import { readFile, stat, unlink } from 'node:fs/promises';
import type { McpRequestOptions, Resource, ResourceTemplate } from '@earendil-works/pi-mcp';
import * as sdk from '@mkagent/coding-runtime/mcp-tools';
import * as host from './resources.ts';

function server(name: string, overrides: Partial<sdk.McpResourceServer> = {}): sdk.McpResourceServer {
  return {
    name, timeoutMs: 123,
    resourcesPage: async () => ({ resources: [] }),
    resourceTemplatesPage: async () => ({ resourceTemplates: [] }),
    allResources: async () => [],
    allResourceTemplates: async () => [],
    readResource: async () => ({ contents: [] }),
    ...overrides,
  };
}

function tools(servers: () => sdk.McpResourceServer[], exposure: host.McpResourceToolOptions['exposure'] = 'direct') {
  const registrations = host.createMcpResourceToolDefinitions({ exposure, servers });
  const invoke = (index: number, args?: Record<string, unknown>, signal?: AbortSignal) => registrations[index]!.execute!(
    args, { callId: 'resource-fixture' } as never, { abortSignal: signal } as never,
  );
  return { registrations, invoke };
}

test('resource registrations use SDK schemas and descriptions', () => {
  const options = { exposure: 'direct' as const, servers: () => [] };
  const definitions = sdk.createMcpResourceToolDefinitions(options);
  const actual = host.createMcpResourceToolDefinitions(options);
  expect(actual.map(tool => tool.name)).toEqual([host.LIST_MCP_RESOURCES_TOOL, host.LIST_MCP_RESOURCE_TEMPLATES_TOOL, host.READ_MCP_RESOURCE_TOOL]);
  for (const [index, tool] of actual.entries()) {
    expect(tool.description).toBe(definitions[index]!.description);
    expect(tool.parameters).toBe(definitions[index]!.parameters);
    expect(tool.structuredOutputSchema).toBe(definitions[index]!.outputSchema);
  }
  expect(host.isMcpAppResource).toBe(sdk.isMcpAppResource);
});

for (const [exposure, visibility] of [
  ['direct', {}], ['deferred', { deferred: true }], ['codemode', { callers: ['tools'] }], ['hidden', { callers: [] }],
] as const) {
  test(`resource registrations retain durable ${exposure} visibility`, () => {
    for (const tool of tools(() => [], exposure).registrations) {
      expect({ ...(tool.callers === undefined ? {} : { callers: tool.callers }), ...(tool.deferred === undefined ? {} : { deferred: tool.deferred }) }).toEqual(visibility);
    }
  });
}

for (const templates of [false, true]) {
  test(`single-server ${templates ? 'templates' : 'resources'} preserve paging, filtering and request options`, async () => {
    const controller = new AbortController();
    const resources: Array<Resource & { icons?: Array<{ src: string }> }> = [
      { uri: 'fixture://text', name: 'text', _meta: { private: true }, icons: [{ src: 'fixture://icon' }] },
      { uri: 'ui://panel', name: 'panel' },
      { uri: 'fixture://panel', name: 'app', mimeType: 'text/html; profile="mcp-app"' },
    ];
    const resourceTemplates: ResourceTemplate[] = resources.map(({ uri, ...rest }) => ({ ...rest, uriTemplate: uri + '/{id}' }));
    let calls = 0;
    const check = (cursor: string | undefined, options: McpRequestOptions) => {
      calls++;
      expect(cursor).toBe('page-2');
      expect(options).toEqual({ signal: controller.signal, timeoutMs: 123 });
    };
    const connection = server('live', {
      resourcesPage: async (cursor, options) => { check(cursor, options); return { resources, nextCursor: 'page-3' }; },
      resourceTemplatesPage: async (cursor, options) => { check(cursor, options); return { resourceTemplates, nextCursor: 'page-3' }; },
    });
    const result = await tools(() => [connection]).invoke(templates ? 1 : 0, { server: ' live ', cursor: ' page-2 ' }, controller.signal);
    const key = templates ? 'resourceTemplates' : 'resources';
    const item = templates ? { name: 'text', uriTemplate: 'fixture://text/{id}' } : { uri: 'fixture://text', name: 'text' };
    const payload = { server: 'live', [key]: [{ server: 'live', ...item }], nextCursor: 'page-3' };
    expect(result.structuredOutput as unknown).toEqual(payload);
    expect(result.output).toEqual([{ type: 'text', text: JSON.stringify(payload) }]);
    expect(result.details).toEqual({ server: 'live', tool: templates ? host.LIST_MCP_RESOURCE_TEMPLATES_TOOL : host.LIST_MCP_RESOURCES_TOOL });
    expect(calls).toBe(1);
    expect(resources[0]!._meta).toEqual({ private: true });
  });
}

test('all-server listings are sorted, retain successful servers and collect failures', async () => {
  const controller = new AbortController(), calls: string[] = [];
  const make = (name: string) => server(name, {
    allResources: async options => {
      calls.push(name);
      expect(options).toEqual({ signal: controller.signal, timeoutMs: 123 });
      if (name === 'b') throw new Error('fixture failure');
      if (name === 'c') throw 'fixture rejection';
      return [{ uri: 'fixture://' + name, name, icons: [{ src: 'fixture://icon' }] }, { uri: 'ui://app', name: 'app' }];
    },
  });
  const result = await tools(() => [make('z'), make('c'), make('b'), make('a')]).invoke(0, undefined, controller.signal);
  expect(calls).toEqual(['a', 'b', 'c', 'z']);
  expect(result.structuredOutput as unknown).toEqual({
    resources: [{ server: 'a', uri: 'fixture://a', name: 'a' }, { server: 'z', uri: 'fixture://z', name: 'z' }],
    errors: [{ server: 'b', error: 'fixture failure' }, { server: 'c', error: 'fixture rejection' }],
  });
});

test('resource tools discover live servers at execution time', async () => {
  let current = [server('old')];
  const fixture = tools(() => current);
  current = [server('new', { allResourceTemplates: async () => [{ uriTemplate: 'fixture://{id}', name: 'live' }] })];
  expect((await fixture.invoke(1)).structuredOutput).toEqual({ resourceTemplates: [{ server: 'new', uriTemplate: 'fixture://{id}', name: 'live' }] });
  await expect(fixture.invoke(2, { server: 'old', uri: 'fixture://old' })).rejects.toThrow('MCP server "old" has no resources. Servers with resources: new');
  current = [];
  expect((await fixture.invoke(0)).structuredOutput).toEqual({ resources: [] });
});

for (const [args, index, error] of [
  [{ cursor: 'next' }, 0, 'cursor can only be used when a server is specified'],
  [{ server: 42 }, 0, 'server must be a string'],
  [{ cursor: false }, 1, 'cursor must be a string'],
  [{ server: 'missing' }, 0, 'MCP server "missing" has no resources'],
  [{}, 2, 'server must be provided'],
  [{ server: 'live', uri: '  ' }, 2, 'uri must be provided'],
  [{ server: 'live', uri: 42 }, 2, 'uri must be a string'],
] as const) {
  test(`resource argument validation: ${error}`, async () => {
    await expect(tools(() => [server('live')]).invoke(index, args)).rejects.toThrow(error);
  });
}

test('reads preserve URI labels, text, images, complete script data and cancellation', async () => {
  const controller = new AbortController();
  const contents = [
    { uri: 'fixture://text', text: 'hello', _meta: { private: true } },
    { uri: 'fixture://json', mimeType: 'application/json', blob: Buffer.from('{"ok":true}').toString('base64') },
    { uri: 'fixture://image', mimeType: 'image/png', blob: 'fixture-image' },
  ];
  const fixture = tools(() => [server('live', { readResource: async (uri, options) => {
    expect(uri).toBe('fixture://bundle');
    expect(options).toEqual({ signal: controller.signal, timeoutMs: 123 });
    return { contents };
  } })]);
  const result = await fixture.invoke(2, { server: ' live ', uri: ' fixture://bundle ' }, controller.signal);
  expect(result.output).toEqual([
    { type: 'text', text: 'fixture://text:' }, { type: 'text', text: 'hello' },
    { type: 'text', text: 'fixture://json:' }, { type: 'text', text: '{"ok":true}' },
    { type: 'text', text: 'fixture://image:' }, { type: 'image', data: 'fixture-image', mimeType: 'image/png' },
  ]);
  expect(result.structuredOutput as unknown).toEqual({ server: 'live', uri: 'fixture://bundle', contents: contents.map(({ _meta, ...rest }) => rest) });
  expect(contents[0]!._meta).toEqual({ private: true });
  expect(result.details).toEqual({ server: 'live', tool: host.READ_MCP_RESOURCE_TOOL });
});

test('empty resources and rejected requests retain their results', async () => {
  const fixture = tools(() => [server('live')]);
  expect((await fixture.invoke(2, { server: 'live', uri: 'fixture://empty' })).output).toEqual([{ type: 'text', text: 'Resource fixture://empty is empty.' }]);
  const controller = new AbortController();
  controller.abort(new Error('fixture cancelled'));
  const cancelled = tools(() => [server('live', { readResource: async (_uri, options) => { options.signal!.throwIfAborted(); return { contents: [] }; } })]);
  await expect(cancelled.invoke(2, { server: 'live', uri: 'fixture://cancelled' }, controller.signal)).rejects.toThrow('fixture cancelled');
});

test('truncated resource output saves the full text and keeps the full script payload', async () => {
  const text = '前😀é\n'.repeat(5000);
  const result = await tools(() => [server('live', { readResource: async () => ({ contents: [{ uri: 'fixture://large', text }] }) })]).invoke(2, { server: 'live', uri: 'fixture://large' });
  const path = (result.details as { fullOutputPath: string }).fullOutputPath;
  try {
    expect(path).toBeString();
    expect(await readFile(path, 'utf8')).toBe(text);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(result.structuredOutput as unknown).toEqual({ server: 'live', uri: 'fixture://large', contents: [{ uri: 'fixture://large', text }] });
    expect((result.output![0] as { text: string }).text).toContain('Warning: truncated output');
    expect((result.output![0] as { text: string }).text).not.toContain('�');
  } finally {
    await unlink(path);
  }
});
