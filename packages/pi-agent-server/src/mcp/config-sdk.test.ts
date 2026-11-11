/** Strict SDK configuration resolution at the three host MCP boundaries. */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as sdk from '@mkagent/pi-durable-coding/mcp-config';
import { createDefaultTransport, McpServerConnection } from './runtime.ts';

const variable = 'MKAGENT_CONFIG_SDK_FIXTURE';
const missing = 'MKAGENT_CONFIG_SDK_MISSING';

function withEnvironment(run: () => void): void {
  const previous = process.env[variable], absent = process.env[missing];
  delete process.env[missing];
  try { run(); } finally {
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
    if (absent === undefined) delete process.env[missing]; else process.env[missing] = absent;
  }
}

test('MCP commands keep the default shell in modeled Windows dispatch', () => {
  const entry = import.meta.resolve('@earendil-works/pi-coding-agent', new URL('../../../pi-durable-coding/package.json', import.meta.url).href);
  const source = readFileSync(new URL('./core/resolve-config-value.js', entry), 'utf8');
  const calls: string[] = [];
  // Execute the installed SDK with modeled Windows shells; no Windows binary runs here.
  const model = runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\n({ resolveConfigValueOrThrow, resolveHeadersOrThrow });', {
    process: { platform: 'win32', env: {} },
    getShellConfig: () => ({ shell: 'fixture-bash', args: ['-c'] }),
    execSync(command: string) { calls.push('default:' + command); return '  startup-fixture\n'; },
    spawnSync() { calls.push('configured'); return { status: 0, stdout: '%MKAGENT_CONFIG_SDK_FIXTURE%\n' }; },
  });
  const facade = readFileSync(new URL('../../../pi-durable-coding/src/mcp-config.ts', import.meta.url), 'utf8');
  const binding = new Bun.Transpiler({ loader: 'ts' }).transformSync(facade);
  const host = runInNewContext(binding.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\n({ resolveConfigValueOrThrow, resolveHeadersOrThrow });', {
    resolveValue: model.resolveConfigValueOrThrow, resolveHeaders: model.resolveHeadersOrThrow,
  });
  const command = '!echo %MKAGENT_CONFIG_SDK_FIXTURE%';
  expect(model.resolveConfigValueOrThrow(command, 'fixture')).toBe('%MKAGENT_CONFIG_SDK_FIXTURE%');
  expect(host.resolveConfigValueOrThrow(command, 'fixture')).toBe('startup-fixture');
  expect(host.resolveHeadersOrThrow({ Authorization: command }, 'fixture').Authorization).toBe('startup-fixture');
  expect(calls).toEqual(['configured', 'default:' + command.slice(1), 'default:' + command.slice(1)]);
});

test('configuration templates preserve literals, escapes and empty values', () => {
  const env = { [variable]: 'fixture' };
  for (const [input, expected] of [
    ['', ''], ['literal', 'literal'], [`Bearer $${variable}`, 'Bearer fixture'],
    [`prefix-\${${variable}}-suffix`, 'prefix-fixture-suffix'],
    ['$$!literal', '$!literal'], ['$!literal', '!literal'],
    ['${not-valid}', '${not-valid}'], ['${unclosed', '${unclosed'], ['$9', '$9'],
  ]) expect(sdk.resolveConfigValueOrThrow(input!, 'fixture', env)).toBe(expected!);
});

test('configuration environment overrides fall back to the process when empty', () => withEnvironment(() => {
  process.env[variable] = 'process-fixture';
  expect(sdk.resolveConfigValueOrThrow(`$${variable}`, 'fixture', { [variable]: 'override-fixture' })).toBe('override-fixture');
  expect(sdk.resolveConfigValueOrThrow(`$${variable}`, 'fixture', { [variable]: '' })).toBe('process-fixture');
  expect(sdk.resolveConfigValueOrThrow(`$${variable}`, 'fixture')).toBe('process-fixture');
}));

test('missing variables retain strict contextual errors and deduplicate names', () => withEnvironment(() => {
  delete process.env[variable];
  expect(() => sdk.resolveConfigValueOrThrow(`$${missing}`, 'fixture')).toThrow(`Failed to resolve fixture from environment variable: ${missing}`);
  expect(() => sdk.resolveConfigValueOrThrow(`$${missing}/$${variable}/$${missing}`, 'fixture')).toThrow(`Failed to resolve fixture from environment variables: ${missing}, ${variable}`);
}));

test('strict headers preserve empty values, errors and the source object', () => withEnvironment(() => {
  const headers = { Authorization: `Bearer $${variable}`, Empty: '' };
  const before = structuredClone(headers);
  expect(sdk.resolveHeadersOrThrow(undefined, 'fixture')).toBeUndefined();
  expect(sdk.resolveHeadersOrThrow({}, 'fixture')).toBeUndefined();
  expect(sdk.resolveHeadersOrThrow(headers, 'fixture', { [variable]: 'header-fixture' })).toEqual({ Authorization: 'Bearer header-fixture', Empty: '' });
  expect(headers).toEqual(before);
  expect(() => sdk.resolveHeadersOrThrow({ Missing: `$${missing}` }, 'fixture')).toThrow(`Failed to resolve fixture header "Missing" from environment variable: ${missing}`);
}));

test.skipIf(process.platform === 'win32')('strict shell commands trim output and run again for each resolution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-config-'));
  const path = join(directory, 'value');
  const command = `!cat '${path.replaceAll("'", "'\\''")}'`;
  try {
    writeFileSync(path, '  first-fixture  \n');
    expect(sdk.resolveConfigValueOrThrow(command, 'fixture')).toBe('first-fixture');
    writeFileSync(path, '  second-fixture  \n');
    expect(sdk.resolveConfigValueOrThrow(command, 'fixture')).toBe('second-fixture');
  } finally { unlinkSync(path); rmdirSync(directory); }
});

test.skipIf(process.platform === 'win32')('failed and empty shell commands retain strict contextual errors', () => {
  for (const command of ['exit 3', 'printf ""']) {
    expect(() => sdk.resolveConfigValueOrThrow('!' + command, 'fixture')).toThrow(`Failed to resolve fixture from shell command: ${command}`);
  }
});

test('HTTP headers and stdio env reject unresolved configuration before transport startup', () => withEnvironment(() => {
  expect(() => createDefaultTransport({ name: 'fixture', scope: 'global', config: {
    url: 'https://example.invalid/mcp', headers: { Authorization: `$${missing}` },
  } }, tmpdir())).toThrow(`Failed to resolve MCP server "fixture" header "Authorization" from environment variable: ${missing}`);
  expect(() => createDefaultTransport({ name: 'fixture', scope: 'global', config: {
    command: 'unused-fixture', env: { CONFIG: `$${missing}` },
  } }, tmpdir())).toThrow(`Failed to resolve MCP server "fixture" env "CONFIG" from environment variable: ${missing}`);
}));

test('OAuth client secrets use the same strict resolver on each settings read', () => withEnvironment(() => {
  const connection = new McpServerConnection({
    entry: { name: 'fixture', scope: 'global', config: { url: 'https://example.invalid/mcp', oauth: { clientSecret: `$${variable}` } } },
    cwd: tmpdir(), version: 'test', log: undefined, onTools() {}, onChange() {},
    createTransport() { throw new Error('This test does not open a connection'); },
  });
  delete process.env[variable];
  expect(() => connection.oauthSettings()).toThrow(`Failed to resolve MCP server "fixture" oauth.clientSecret from environment variable: ${variable}`);
  process.env[variable] = 'first-fixture';
  expect(connection.oauthSettings().clientSecret).toBe('first-fixture');
  process.env[variable] = 'second-fixture';
  expect(connection.oauthSettings().clientSecret).toBe('second-fixture');
}));
