import { expect, test } from 'bun:test';
import {
  LIST_MCP_RESOURCES_TOOL, LIST_MCP_RESOURCE_TEMPLATES_TOOL, READ_MCP_RESOURCE_TOOL,
  mcpNamespace, validateMcpServerConfig as sdkValidate,
} from '@mkagent/pi-durable-coding/mcp-servers';
import * as host from './mcp-servers.ts';

const invalidConfig = (config: unknown) => expect(typeof host.validateMcpServerConfig('fixture', config)).toBe('string');

test('host naming and resource constants use the public SDK facade', () => {
  expect(host.mcpNamespace).toBe(mcpNamespace);
  expect(host.mcpNamespace('fixture-one')).toBe('mcp__fixture_one');
  expect([host.LIST_MCP_RESOURCES_TOOL, host.LIST_MCP_RESOURCE_TEMPLATES_TOOL, host.READ_MCP_RESOURCE_TOOL])
    .toEqual([LIST_MCP_RESOURCES_TOOL, LIST_MCP_RESOURCE_TEMPLATES_TOOL, READ_MCP_RESOURCE_TOOL]);
});

test('SDK validation normalizes aliases without changing the input or extra host fields', () => {
  const raw = { command: 'fixture', exposure: 'codemode-deferred', toolExposure: { 'read*': 'codemode-deferred' }, hostData: { retained: true } };
  const result = host.validateMcpServerConfig('fixture', raw);
  expect(result).toEqual({ ...raw, exposure: 'codemode', toolExposure: { 'read*': 'codemode' } });
  expect(result).not.toBe(raw);
  expect(raw.exposure).toBe('codemode-deferred');
  expect(raw.toolExposure['read*']).toBe('codemode-deferred');
});

test('SDK validation rejects malformed transports, fields and exposure rules', () => {
  expect(typeof host.validateMcpServerConfig('bad/name', { command: 'fixture' })).toBe('string');
  for (const value of [null, [], {}, { type: 'sse', url: 'https://example.invalid' }, { url: 'file:///fixture' },
    { command: 'fixture', args: [1] }, { command: 'fixture', env: { BAD: 3 } }, { command: 'fixture', cwd: 3 },
    { url: 'https://example.invalid', headers: { BAD: 3 } }, { command: 'fixture', timeout: 0 },
    { command: 'fixture', exposure: 'unsafe' }, { command: 'fixture', toolExposure: { hello: 'unsafe' } }]) invalidConfig(value);
});

test('exposure ignores prototypes and preserves non-enumerable own exact overrides', () => {
  const overrides = Object.create({ hello: 'direct', 'secret*': 'direct' });
  Object.defineProperty(overrides, 'hidden-own', { value: 'direct' });
  for (const name of ['hello', 'secret-name', 'constructor', '__proto__', 'toString']) {
    expect(host.getMcpToolExposure({ exposure: 'hidden', toolExposure: overrides }, name)).toBe('hidden');
    expect(host.getMcpToolExposure({ exposure: 'hidden', toolExposure: { '*': 'deferred' } }, name)).toBe('deferred');
  }
  expect(host.getMcpToolExposure({ exposure: 'hidden', toolExposure: overrides }, 'hidden-own')).toBe('direct');
});

test('invalid and undefined own exposures stay hidden instead of falling through to a wildcard', () => {
  for (const value of [undefined, null, 1, 'unsafe', 'codemode-deferred']) {
    const config = { exposure: 'direct', toolExposure: { '*': 'direct', hello: value } } as unknown as host.McpServerConfig;
    expect(host.getMcpToolExposure(config, 'hello')).toBe('hidden');
    expect(host.getMcpToolExposure({ exposure: value } as unknown as host.McpServerConfig, 'hello')).toBe(value == null ? 'codemode' : 'hidden');
    expect(host.getMcpToolExposure({ toolExposure: { '*': value } } as unknown as host.McpServerConfig, 'hello')).toBe('hidden');
  }
});

test('exact exposure wins and wildcard matching preserves order and literal regex characters', () => {
  const config: host.McpServerConfig = { exposure: 'hidden', toolExposure: { 'read.*': 'deferred', '*': 'codemode', 'read.file': 'direct' } };
  expect(host.getMcpToolExposure(config, 'read.file')).toBe('direct');
  expect(host.getMcpToolExposure(config, 'read.other')).toBe('deferred');
  expect(host.getMcpToolExposure(config, 'readXother')).toBe('codemode');
});

test('host OAuth destination policy remains stricter than SDK field validation', () => {
  const remote = { url: 'http://example.invalid/mcp', oauth: {} };
  expect(typeof sdkValidate('fixture', remote)).toBe('object');
  invalidConfig(remote);
  for (const url of ['https://example.invalid/mcp', 'http://localhost:1234/mcp', 'http://127.0.0.1/mcp?q=fixture', 'http://[::1]/mcp']) {
    expect(host.isSecureMcpUrl(url)).toBe(true);
    expect(typeof host.validateMcpServerConfig('fixture', { url, oauth: {} })).toBe('object');
  }
  for (const url of ['http://example.invalid/mcp', 'http://localhost.example.invalid/mcp', 'file:///fixture', 'invalid']) expect(host.isSecureMcpUrl(url)).toBe(false);
  expect(typeof host.validateMcpServerConfig('fixture', { url: remote.url })).toBe('object');
  expect(typeof host.validateMcpServerConfig('fixture', { type: 'stdio', command: 'fixture', ...remote })).toBe('object');
  invalidConfig({ type: 'streamable-http', ...remote });
});

test('SDK OAuth and provider checks still reject unsafe callbacks and metadata', () => {
  for (const oauth of [false, { callbackPort: 0 }, { callbackUrl: 'https://localhost/callback' },
    { callbackUrl: 'http://localhost/callback?code=fixture' }, { callbackUrl: 'http://localhost:1234/callback', callbackPort: 2345 },
    { clientRegistration: 'cimd', clientId: 'fixture' }, { clientRegistration: 'cimd', callbackUrl: 'http://[::1]/callback' },
    { authServerMetadataUrl: 'http://example.invalid/metadata' }]) invalidConfig({ url: 'https://example.invalid', oauth });
  invalidConfig({ url: 'http://example.invalid', auth: { provider: 'fixture' } });
  invalidConfig({ url: 'https://example.invalid', auth: { provider: '' } });
});
