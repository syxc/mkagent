import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadMcpConfig } from './config.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mcp-project-trust-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function config(directory: string, servers: Record<string, unknown>) {
  const path = join(directory, 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: servers }));
}
const server = (name: string) => ({ command: name });
const options = () => ({ agentDir: join(root, 'host'), nativeAgentDir: join(root, 'native'), cwd: root });

test('native and host project MCP share trust while existing host entries keep precedence', () => {
  const paths = options();
  config(paths.nativeAgentDir, { native: server('native'), common: server('native-global') });
  config(paths.agentDir, { host: server('host'), common: server('host-global') });
  config(join(root, '.pi'), { projectNative: server('native-project'), common: server('native-project') });
  config(join(root, '.mkagent'), { projectHost: server('host-project'), common: server('host-project') });
  const denied = loadMcpConfig(paths);
  expect(denied.errors).toEqual([]);
  expect(denied.servers.map(entry => entry.name).sort()).toEqual(['common', 'host', 'native']);
  expect(denied.servers.find(entry => entry.name === 'common')?.config).toMatchObject(server('host-global'));
  const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
  expect(trusted.errors).toEqual([]);
  expect(trusted.servers.map(entry => entry.name).sort()).toEqual(['common', 'host', 'native', 'projectHost', 'projectNative']);
  expect(trusted.servers.find(entry => entry.name === 'common')?.config).toMatchObject(server('host-project'));
});

test('ordinary and host-only MCP loading does not discover native configuration', () => {
  config(join(root, 'native'), { forbidden: server('native') });
  config(join(root, '.pi'), { forbiddenProject: server('native-project') });
  const { nativeAgentDir: _, ...hostOnly } = options();
  expect(loadMcpConfig({ ...hostOnly, projectTrusted: true }).servers).toEqual([]);
});

test('neither native nor host project URLs can select a host credential provider', () => {
  config(join(root, '.pi'), { native: { url: 'https://invalid.example/native', auth: { provider: 'host' } } });
  config(join(root, '.mkagent'), { host: { url: 'https://invalid.example/host', auth: { provider: 'host' } } });
  const loaded = loadMcpConfig({ ...options(), projectTrusted: true });
  expect(loaded.servers).toEqual([]);
  expect(loaded.errors).toHaveLength(2);
  expect(loaded.errors.every(error => error.includes('auth is only allowed in the global mcp.json'))).toBe(true);
});
