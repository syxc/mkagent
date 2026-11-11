import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpConfig as loadSdkMcpConfig } from '@mkagent/pi-durable-coding/mcp-config';
import { validateMcpServerConfig } from '@mkagent/pi-durable-coding/mcp-servers';
import { loadMcpConfig } from './config.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mcp-loader-sdk-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const options = (base = root) => ({ agentDir: join(base, 'host'), nativeAgentDir: join(base, 'native'), cwd: base, projectTrusted: true });
function write(directory: string, value: unknown): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'mcp.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

test('four configuration layers share overrides, metadata and codemode precedence', () => {
  const paths = options();
  write(paths.nativeAgentDir, { mcpServers: { shared: { command: 'native' } }, autoEnableCodemode: false });
  const source = write(paths.agentDir, { mcpServers: { shared: { command: 'host', hostField: 42 } }, autoEnableCodemode: true });
  write(join(root, '.pi'), { mcpServers: { shared: { enabled: false, exposure: 'deferred' } }, autoEnableCodemode: false });
  const override = write(join(root, '.mkagent'), { mcpServers: { shared: { enabled: true, toolExposure: { hello: 'direct' } } }, autoEnableCodemode: true });
  expect(loadMcpConfig(paths)).toEqual({ servers: [{ name: 'shared', source, scope: 'global', override,
    config: { command: 'host', hostField: 42, enabled: true, exposure: 'deferred', toolExposure: { hello: 'direct' } } }],
    errors: [], autoEnableCodemode: true, projectConfig: override });
});

test('namespace collisions are checked across every pair of configuration layers', () => {
  for (let earlier = 0; earlier < 4; earlier++) for (let later = earlier + 1; later < 4; later++) {
    const paths = options(join(root, `${earlier}-${later}`));
    const dirs = [paths.nativeAgentDir, paths.agentDir, join(paths.cwd, '.pi'), join(paths.cwd, '.mkagent')];
    const source = write(dirs[earlier]!, { mcpServers: { 'same-name': { command: 'first' } } });
    const rejected = write(dirs[later]!, { mcpServers: { same_name: { command: 'second' } } });
    const loaded = loadMcpConfig(paths);
    expect(loaded.servers).toEqual([{ name: 'same-name', config: { command: 'first' }, source, scope: earlier < 2 ? 'global' : 'project' }]);
    expect(loaded.errors).toEqual([`${rejected}: server "same_name" conflicts with "same-name"`]);
  }
});

test('rejected definitions keep the earlier server, including the host OAuth destination policy', () => {
  const paths = options();
  const source = write(paths.nativeAgentDir, { mcpServers: { retained: { command: 'safe' } } });
  const rejected = write(paths.agentDir, { mcpServers: { retained: { url: 'http://example.invalid/mcp', oauth: {} } } });
  const loaded = loadMcpConfig(paths);
  expect(loaded.servers).toEqual([{ name: 'retained', config: { command: 'safe' }, source, scope: 'global' }]);
  expect(loaded.errors).toEqual([`${rejected}: server "retained": oauth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`]);
});

test('project overrides reject missing bases and fields outside the override allowlist', () => {
  const paths = options();
  write(paths.agentDir, { mcpServers: { retained: { command: 'safe' } } });
  const path = write(join(root, '.mkagent'), { mcpServers: { retained: { headers: { BAD: 'fixture' } }, absent: { enabled: false } } });
  const loaded = loadMcpConfig(paths);
  expect(loaded.servers[0]!.config).toEqual({ command: 'safe' });
  expect(loaded.servers[0]!.override).toBeUndefined();
  expect(loaded.errors).toEqual([`${path}: server "retained": an override can only set enabled, exposure, toolExposure`,
    `${path}: server "absent" needs "command" or "url", or a global server to override`]);
});

test('project definitions cannot select provider credentials while safe overrides retain the global provider', () => {
  const paths = options(), provider = { url: 'https://example.invalid/mcp', auth: { provider: 'fixture' } };
  const source = write(paths.agentDir, { mcpServers: { retained: provider } });
  write(join(root, '.pi'), { mcpServers: { unsafeNative: provider, retained: { enabled: false } } });
  const override = write(join(root, '.mkagent'), { mcpServers: { unsafeHost: provider, retained: { exposure: 'hidden' } } });
  const loaded = loadMcpConfig(paths);
  expect(loaded.servers).toEqual([{ name: 'retained', config: { ...provider, enabled: false, exposure: 'hidden' }, source, scope: 'global', override }]);
  expect(loaded.errors).toHaveLength(2);
  expect(loaded.errors.every(error => error.includes('auth is only allowed in the global mcp.json'))).toBe(true);
});

test('file errors accumulate while later valid configuration and flags still load', () => {
  const paths = options();
  write(paths.nativeAgentDir, '{');
  const shape = write(paths.agentDir, { mcpServers: [] });
  const flag = write(join(root, '.pi'), { autoEnableCodemode: 'unsafe' });
  write(join(root, '.mkagent'), { mcpServers: { retained: { command: 'safe', enabled: false } }, autoEnableCodemode: false });
  const loaded = loadMcpConfig(paths);
  expect(loaded.errors).toHaveLength(3);
  expect(loaded.errors[0]).toStartWith(join(paths.nativeAgentDir, 'mcp.json') + ': ');
  expect(loaded.errors.slice(1)).toEqual([`${shape}: expected an object with an "mcpServers" object`, `${flag}: autoEnableCodemode must be a boolean`]);
  expect(loaded.servers[0]!.config.enabled).toBe(false);
  expect(loaded.autoEnableCodemode).toBe(false);
});

test('custom project directories and matching native paths do not duplicate reads', () => {
  const paths = options();
  write(paths.agentDir, '{');
  write(join(root, '.pi'), '{');
  const native = loadMcpConfig({ ...paths, nativeAgentDir: paths.agentDir, projectConfigDirName: '.pi' });
  expect(native.errors).toHaveLength(2);
  expect(native.projectConfig).toBe(join(root, '.pi', 'mcp.json'));
  const custom = write(join(root, '.custom'), { mcpServers: { retained: { command: 'safe' } } });
  const hostOnly = loadMcpConfig({ agentDir: paths.agentDir, cwd: root, projectTrusted: true, projectConfigDirName: '.custom' });
  expect(hostOnly.errors).toHaveLength(1);
  expect(hostOnly.servers[0]!.source).toBe(custom);
  expect(hostOnly.projectConfig).toBe(custom);
});

test('SDK loading accepts UTF-8 BOM configuration', () => {
  const paths = options();
  write(paths.agentDir, '﻿' + JSON.stringify({ mcpServers: { retained: { command: 'safe' } } }));
  const loaded = loadMcpConfig(paths);
  expect(loaded.errors).toEqual([]);
  expect(loaded.servers[0]!.config).toEqual({ command: 'safe' });
});

test('SDK defaults still load the agent directory and trusted .pi configuration', () => {
  const paths = options();
  const source = write(paths.agentDir, { mcpServers: { retained: { command: 'safe' } } });
  const override = write(join(root, '.pi'), { mcpServers: { retained: { enabled: false } } });
  write(join(root, '.mkagent'), { mcpServers: { forbidden: { command: 'host' } } });
  expect(loadSdkMcpConfig(paths)).toEqual({ servers: [{ name: 'retained', config: { command: 'safe', enabled: false }, source, scope: 'global', override }], errors: [], projectConfig: override });
  const untrusted = loadSdkMcpConfig({ ...paths, projectTrusted: false });
  expect(untrusted.servers[0]!.config.enabled).toBeUndefined();
  expect(untrusted.projectConfig).toBeUndefined();
});

test('SDK ordered file lists preserve order and cannot bypass project trust', () => {
  const paths = options();
  const first = write(join(root, 'first'), { mcpServers: { retained: { command: 'first' } } });
  const second = write(join(root, 'second'), { mcpServers: { retained: { command: 'second' } } });
  const project = write(join(root, 'project'), { mcpServers: { retained: { enabled: false } } });
  const configFiles = [{ path: first, scope: 'global' as const }, { path: second, scope: 'global' as const }, { path: project, scope: 'project' as const }];
  const trusted = loadSdkMcpConfig({ ...paths, configFiles });
  expect(trusted.servers[0]).toMatchObject({ config: { command: 'second', enabled: false }, source: second, override: project });
  expect(trusted.projectConfig).toBe(project);
  write(join(root, 'project'), '{');
  const untrusted = loadSdkMcpConfig({ ...paths, configFiles, projectTrusted: false });
  expect(untrusted.errors).toEqual([]);
  expect(untrusted.servers[0]!.config).toEqual({ command: 'second' });
  expect(untrusted.projectConfig).toBeUndefined();
});

test('SDK host validation runs before definitions and merged overrides replace an entry', () => {
  const paths = options();
  write(paths.agentDir, { mcpServers: { retained: { command: 'safe' }, rejected: { command: 'blocked' } } });
  const project = write(join(root, '.pi'), { mcpServers: { retained: { enabled: false } } });
  const calls: unknown[] = [];
  const loaded = loadSdkMcpConfig({ ...paths, validateServerConfig(name, raw) {
    calls.push(raw);
    if (name === 'rejected' || (raw as { enabled?: boolean }).enabled === false) return 'fixture policy rejected';
    return validateMcpServerConfig(name, raw);
  } });
  expect(calls).toEqual([{ command: 'safe' }, { command: 'blocked' }, { command: 'safe', enabled: false }]);
  expect(loaded.servers[0]!.config).toEqual({ command: 'safe' });
  expect(loaded.servers[0]!.override).toBeUndefined();
  expect(loaded.servers).toHaveLength(1);
  expect(loaded.errors).toEqual([`${join(paths.agentDir, 'mcp.json')}: fixture policy rejected`, `${project}: fixture policy rejected`]);
});

test('an explicit empty SDK file list does not discover default configuration or project metadata', () => {
  const paths = options();
  write(paths.agentDir, '{');
  write(join(root, '.pi'), '{');
  expect(loadSdkMcpConfig({ ...paths, configFiles: [] })).toEqual({ servers: [], errors: [] });
});
