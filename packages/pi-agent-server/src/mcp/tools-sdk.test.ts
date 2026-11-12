import { expect, test } from 'bun:test';
import { readFile, stat, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import type { CallToolResult, McpRequestOptions } from '@earendil-works/pi-mcp';
import { compile } from '@earendil-works/pi-schema';
import * as sdk from '@mkagent/coding-runtime/mcp-tools';
import * as host from './tools.ts';

const image = { type: 'image' as const, data: 'fixture-image', mimeType: 'image/png' };

test('server MCP presentation helpers are the SDK functions', () => {
  for (const name of ['convertMcpResult', 'createMcpResultSchema', 'createMcpToolName', 'limitMcpContent', 'saveToTempFile', 'toModelContent'] as const) {
    expect(host[name]).toBe(sdk[name]);
  }
  expect(host.MCP_OUTPUT_MAX_BYTES).toBe(20 * 1024);
  const taken = host.createMcpToolName('a-b', 'read');
  const collision = host.createMcpToolName('a_b', 'read', name => name === taken);
  expect(collision).not.toBe(taken);
  expect(collision).toMatch(/^[A-Za-z0-9_]{1,64}$/);
  expect(host.createMcpToolName('server'.repeat(20), 'read')).toHaveLength(64);
});

test('truncation keeps Unicode, images and the full script result', async () => {
  const text = '前😀é\n'.repeat(5000);
  const result: CallToolResult = {
    content: [{ type: 'text', text }, image],
    structuredContent: { full: true },
    _meta: { fixture: true },
    isError: true,
  };
  let saved = '';
  const converted = await host.convertMcpResult('issues', 'read', result, {
    saveOutput: async (data, extension) => {
      saved = String(data);
      expect(extension).toBe('.txt');
      return '/fixture/full.txt';
    },
  });
  expect(saved).toBe(text);
  expect(converted.content[0]).toMatchObject({ type: 'text' });
  const shown = (converted.content[0] as { text: string }).text;
  expect(shown).toContain('Warning: truncated output');
  expect(shown).toContain('Total output lines: 5000');
  expect(shown).toContain('[Full output: /fixture/full.txt (read it with offset/limit)]');
  expect(shown).not.toContain('�');
  expect(converted.content[1]).toEqual(image);
  expect(converted.structuredContent).toEqual({ content: [{ type: 'text', text }, image], structuredContent: { full: true }, isError: true });
  expect(converted.details).toEqual({ server: 'issues', tool: 'read', fullOutputPath: '/fixture/full.txt' });
  expect(converted.isError).toBe(true);
});

test('a failed output save keeps the truncated result and reports the error', async () => {
  const limited = await host.limitMcpContent([{ type: 'text', text: 'x'.repeat(30_000) }], async () => {
    throw new Error('fixture disk failure');
  });
  expect(limited.fullOutputPath).toBeUndefined();
  expect(limited.content[0]).toMatchObject({ type: 'text' });
  expect((limited.content[0] as { text: string }).text).toContain('[Could not save the full output: fixture disk failure]');
});

test('SDK output files preserve bytes and restrict file permissions', async () => {
  const bytes = new Uint8Array([0, 1, 128, 255]);
  const path = await host.saveToTempFile(bytes, '.bin');
  try {
    expect(basename(path)).toMatch(/^pi-mcp-[0-9a-f]{16}\.bin$/);
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await unlink(path);
  }
});

test('MCP schemas relocate local references and preserve literal reference data', () => {
  const schema = host.createMcpResultSchema({
    type: 'object',
    $defs: { Item: { type: 'string' } },
    properties: {
      value: { $ref: '#/$defs/Item' },
      literal: { const: { $ref: '#/literal-data' } },
    },
  }) as any;
  expect(schema.properties.structuredContent.properties.value.$ref).toBe('#/properties/structuredContent/$defs/Item');
  expect(schema.properties.structuredContent.properties.literal.const).toEqual({ $ref: '#/literal-data' });
  expect(schema.properties.content.items.required).toEqual(['type']);
  expect(schema.properties.content.items.additionalProperties).toBe(true);
  expect(schema.required).toEqual(['content']);
});

for (const { name, id, nested } of [
  { name: 'root', id: 'https://example.test/result', nested: false },
  { name: 'nested', id: 'https://example.test/result', nested: true },
  { name: 'relative', id: 'result', nested: true },
  { name: 'empty', id: '', nested: false },
]) {
  test(`MCP schemas preserve ${name} $id resource references`, () => {
    const resource = {
      $id: id, type: 'object',
      $defs: { Item: { type: 'string' } },
      properties: { value: { $ref: '#/$defs/Item' } },
      required: ['value'],
    };
    const declared = nested ? { type: 'object', properties: { nested: resource } } : resource;
    const before = structuredClone(declared);
    const validator = compile(host.createMcpResultSchema(declared), { unresolvedRefs: 'reject' });
    const content = (value: unknown) => ({ content: [], structuredContent: nested ? { nested: { value } } : { value } });
    expect(validator.check(content('ok'))).toBe(true);
    expect(validator.check(content(42))).toBe(false);
    expect(declared).toEqual(before);
  });
}

test('resource links, text blobs and empty errors retain their model presentation', async () => {
  const content = await host.toModelContent('issues', [
    { type: 'resource_link', uri: 'fixture://report', name: 'report', mimeType: 'text/plain', size: 1024 },
    { type: 'resource', resource: { uri: 'fixture://report.json', mimeType: 'application/json', blob: Buffer.from('{"ok":true}').toString('base64') } },
  ], { readableResources: true });
  expect(content[0]).toMatchObject({ type: 'text' });
  expect((content[0] as { text: string }).text).toContain('Read it with read_mcp_resource (server "issues")');
  expect(content[1]).toEqual({ type: 'text', text: '{"ok":true}' });
  const error = await host.convertMcpResult('issues', 'read', { content: [], isError: true });
  expect(error.content).toContainEqual({ type: 'text', text: 'MCP tool issues/read returned an error' });
});

test('durable bindings resolve live clients and pass cancellation, timeout and progress', async () => {
  const controller = new AbortController(), progress: string[] = [];
  let client = 1;
  const registration = host.createMcpToolDefinition({
    server: 'issues', name: 'mcp__issues__read', exposure: 'codemode', timeoutMs: 456,
    tool: { name: 'read', inputSchema: { properties: { id: { type: 'number' } } } },
    getClient: async () => ({
      callTool: async (name: string, args: Record<string, unknown>, options: McpRequestOptions) => {
        expect(name).toBe('read');
        expect(args).toEqual({ id: 1 });
        expect(options.signal).toBe(controller.signal);
        expect(options.timeoutMs).toBe(456);
        options.onProgress?.({ progressToken: 'fixture', progress: 1, total: 2 });
        options.onProgress?.({ progressToken: 'fixture', progress: 2, message: 'done' });
        return { content: [{ type: 'text', text: 'client ' + client }], _meta: { private: true } };
      },
    }) as never,
  });
  expect(registration.callers).toEqual(['tools']);
  expect(registration.parameters).toMatchObject({ type: 'object', properties: { id: { type: 'number' } } });
  for (client of [1, 2]) {
    const result = await registration.execute!({ id: 1 }, { output: (text: string) => progress.push(text) } as never, { abortSignal: controller.signal } as never);
    expect(result.output).toEqual([{ type: 'text', text: 'client ' + client }]);
    expect(result.structuredOutput).toEqual({ content: [{ type: 'text', text: 'client ' + client }] });
    expect(result.details).toEqual({ server: 'issues', tool: 'read' });
  }
  expect(progress).toEqual(['Progress 1/2', 'done', 'Progress 1/2', 'done']);
});
