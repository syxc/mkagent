/** Native registrations share host connections without restarting unrelated configured servers. */
import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { loadMcpTools } from './extension.ts';
import type { RegisteredMcpServer } from '@mkagent/coding-runtime/native';

const fixture = join(import.meta.dir, '..', 'test-fixtures', 'mcp-server-resources.ts');
const config = { command: process.execPath, args: [fixture], exposure: 'direct' as const };
const registration = (name: string): RegisteredMcpServer => ({ name, config, extensionPath: '/fixture/plugin.ts' });

test('native server changes preserve configured connections, honor namespace precedence, and revoke old tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-registration-'));
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({
    mcpServers: { 'fixed-name': config, disabled: { ...config, enabled: false } },
  }));
  const mcp = await loadMcpTools({ agentDir: root, cwd: root, version: 'test', debugLog() {} });
  try {
    const fixed = mcp.connections[0]!;
    const overrides = [registration('fixed_name'), registration('disabled')];
    await mcp.updateRegisteredServers([...overrides, registration('live')]);
    expect(mcp.connections.map(connection => connection.name)).toEqual(['fixed-name', 'live']);
    expect(mcp.connections[0]).toBe(fixed);
    expect(mcp.tools.map(tool => tool.name)).toContain('mcp__live__hello');
    const live = mcp.connections[1]!;
    const client = live.client;
    await mcp.updateRegisteredServers([...overrides, registration('live')]);
    expect(live.client).toBe(client);
    expect((await live.callTool('hello', {}, {})).content).toEqual([{ type: 'text', text: 'hello from MCP' }]);
    await mcp.updateRegisteredServers([...overrides, {
      ...registration('live'), config: { ...config, exposure: 'hidden' },
    }]);
    expect(live.closed).toBe(true);
    expect(mcp.tools.map(tool => tool.name)).not.toContain('mcp__live__hello');
    expect(mcp.connections.find(connection => connection.name === 'live')).not.toBe(live);
    await mcp.updateRegisteredServers([]);
    expect(mcp.connections).toEqual([fixed]);
    expect(fixed.closed).toBe(false);
    expect(mcp.errors).toEqual([]);
  } finally { await mcp.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native server declarations reject plaintext provider and OAuth credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-registration-auth-'));
  const mcp = await loadMcpTools({ agentDir: root, cwd: root, version: 'test', debugLog() {} });
  try {
    await mcp.updateRegisteredServers([
      { ...registration('provider'), config: { url: 'http://example.invalid/mcp', auth: { provider: 'fixture' } } },
      { ...registration('insecure'), config: { url: 'http://example.invalid/mcp', oauth: {} } },
    ]);
    expect(mcp.connections).toEqual([]);
    expect(mcp.errors).toHaveLength(2);
    expect(mcp.errors[0]).toContain('auth requires an https URL');
    expect(mcp.errors[1]).toContain('oauth requires an https URL');
  } finally { await mcp.close(); rmSync(root, { recursive: true, force: true }); }
});

test.each(['same declaration', 'changed neighbor'])('failed native connections retry with %s', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-registration-retry-'));
  const recoveringFixture = join(root, 'server.ts');
  const recovering = { ...registration('recovering'), config: { ...config, args: [recoveringFixture] } };
  const mcp = await loadMcpTools({ agentDir: root, cwd: root, version: 'test', debugLog() {} });
  try {
    await mcp.updateRegisteredServers([recovering]);
    expect(mcp.connections).toEqual([]);
    expect(mcp.errors).toHaveLength(1);
    copyFileSync(fixture, recoveringFixture);
    await mcp.updateRegisteredServers(mode === 'same declaration' ? [recovering] : [recovering, registration('neighbor')]);
    expect(mcp.connections.map(connection => connection.name)).toContain('recovering');
    expect(mcp.tools.map(tool => tool.name)).toContain('mcp__recovering__hello');
  } finally { await mcp.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native registrations recover after a disconnect callback fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-registration-disconnect-'));
  let fail = false;
  const mcp = await loadMcpTools({ agentDir: root, cwd: root, version: 'test', debugLog() {},
    async beforeDisconnect(connections) {
      if (fail && connections.length) { fail = false; throw new Error('fixture disconnect failure'); }
    },
  });
  try {
    await mcp.updateRegisteredServers([registration('live')]);
    const old = mcp.connections[0]!;
    fail = true;
    await expect(mcp.updateRegisteredServers([])).rejects.toThrow('fixture disconnect failure');
    expect(old.closed).toBe(true);
    expect(mcp.connections).toEqual([]);
    await mcp.updateRegisteredServers([registration('live')]);
    expect(mcp.connections.map(connection => connection.name)).toEqual(['live']);
    expect(mcp.tools.map(tool => tool.name)).toContain('mcp__live__hello');
  } finally { await mcp.close(); rmSync(root, { recursive: true, force: true }); }
});

test.each(['mcp__live__hello', 'list_mcp_resources'])('removed native %s stops before authorization draining finishes', async name => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-registration-revoke-'));
  const draining = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const mcp = await loadMcpTools({ agentDir: root, cwd: root, version: 'test', debugLog() {},
    async beforeDisconnect() { draining.resolve(); await release.promise; },
  });
  let removing: Promise<void> | undefined;
  try {
    await mcp.updateRegisteredServers([registration('live')]);
    const old = mcp.connections[0]!;
    const tool = mcp.tools.find(tool => tool.name === name)!;
    const api = { output() {} } as unknown as ToolExecutionApi;
    const params = name === 'list_mcp_resources' ? { server: 'live' } : {};
    const before = await tool.execute(params, api, BACKGROUND_CONTEXT);
    expect(JSON.stringify(before.output)).toContain(name === 'list_mcp_resources' ? 'resources' : 'hello from MCP');
    removing = mcp.updateRegisteredServers([]);
    await draining.promise;
    expect(old.closed).toBe(false);
    expect(mcp.tools).toEqual([]);
    await expect(tool.execute(params, api, BACKGROUND_CONTEXT)).rejects.toThrow();
  } finally {
    release.resolve();
    await removing;
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('closing during a native connection drains updates and never starts a queued server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-registration-close-'));
  const requested = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++;
    requested.resolve();
    return new Promise<Response>(() => {});
  } });
  const mcp = await loadMcpTools({ agentDir: root, cwd: root, version: 'test', debugLog() {} });
  try {
    const updating = mcp.updateRegisteredServers([{
      ...registration('slow'), config: { url: `http://127.0.0.1:${server.port}/mcp` },
    }]);
    await requested.promise;
    const slow = mcp.connections[0]!;
    const queued = mcp.updateRegisteredServers([registration('late')]);
    await mcp.close();
    await Promise.all([updating, queued]);
    expect(slow.closed).toBe(true);
    expect(requests).toBe(1);
    expect(mcp.closed).toBe(true);
    expect(mcp.connections).toEqual([]);
    expect(mcp.tools).toEqual([]);
    await expect(mcp.updateRegisteredServers([registration('late')])).rejects.toThrow('closed');
  } finally {
    server.stop(true);
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 5_000);
