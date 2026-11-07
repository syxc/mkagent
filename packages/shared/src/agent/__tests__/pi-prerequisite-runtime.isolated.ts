/** Actual built-in tools and approval round trips with a deterministic loopback model. */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PiAgent } from '../pi-agent.ts';
import { PrerequisiteManager } from '../core/prerequisite-manager.ts';

test.each(['default', 'coding'] as const)('confirms successful prerequisite reads through the real %s worker', async profile => {
  const directory = mkdtempSync(join(tmpdir(), 'prerequisite-runtime-'));
  const guide = join(directory, 'SKILL.md');
  const agentDir = join(directory, 'agent');
  mkdirSync(agentDir);
  let tool = { name: 'read', arguments: { path: 'SKILL.md' } as Record<string, unknown> };
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    await request.text();
    requests++;
    const delta = requests % 2 ? { tool_calls: [{ index: 0, id: `read-${requests}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: 'Fixture complete.' };
    const chunks = [{ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: requests % 2 ? 'tool_calls' : 'stop' }] }];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const sessionId = `prerequisite-${profile}`;
  const agent = new PiAgent({
    provider: 'pi', providerType: 'pi_compat', authType: 'none', model: 'fixture', agentProfile: profile,
    workspace: { id: sessionId, name: sessionId, slug: sessionId, rootPath: directory, createdAt: 1 },
    session: { id: sessionId, workspaceRootPath: directory, createdAt: 1, lastUsedAt: 1,
      permissionMode: 'allow-all', workingDirectory: directory },
    isHeadless: true, skipConfigWatcher: true,
    nativeSessionOwner: {
      onProjection: async reference => { expect(reference.sessionId).toBe(sessionId); },
      onEvent: async () => { throw new Error('Unexpected fixture session replacement'); }, onExit: async () => {},
    },
    codingResources: { agentDir, resourcePolicy: 'host-only' },
    runtime: { paths: { node: process.execPath, piServer: resolve(import.meta.dir, '../../../../pi-agent-server/src/index.ts') },
      baseUrl: `http://127.0.0.1:${server.port}/v1`, customEndpoint: { api: 'openai-completions' },
      customModels: [{ id: 'fixture', contextWindow: 100_000 }] },
  });
  const manager = new PrerequisiteManager({ workspaceRootPath: directory, browserToolsDocPath: guide,
    pathExists: () => true, browserToolEnabled: () => true });
  (agent as unknown as { prerequisiteManager: PrerequisiteManager }).prerequisiteManager = manager;
  agent.setPermissionMode('allow-all');
  agent.onPermissionRequest = request => agent.respondToPermission(request.requestId, false);
  const run = async (name: string, args: Record<string, unknown>, success: boolean) => {
    agent.resetPrerequisiteState();
    manager.registerSkillPrerequisites([guide]);
    tool = { name, arguments: args };
    let starts = 0;
    let results = 0;
    for await (const event of agent.chat('Run the local fixture tool.')) {
      if (event.type === 'tool_start') {
        starts++;
        expect(manager.hasRead(guide)).toBe(false);
      }
      if (event.type === 'tool_result') results++;
    }
    expect(starts).toBe(1);
    expect(results).toBe(1);
    expect(manager.hasRead(guide)).toBe(success);
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(success);
  };
  try {
    await run('read', { path: 'SKILL.md' }, false);
    await run('bash', { command: `cat '${guide}' || true` }, false);
    writeFileSync(guide, 'Fixture skill instructions.\n');
    await run('bash', { command: `cat 3< '${guide}'` }, false);
    await run('bash', { command: `cat 0< '${guide}'` }, true);
    await run('read', { path: 'SKILL.md' }, true);
    await run('bash', { command: `cat '${guide}'` }, true);
    agent.setPermissionMode('ask');
    await run('bash', { command: `cat '${guide}'; touch '${join(directory, 'denied')}'` }, false);
    expect(existsSync(join(directory, 'denied'))).toBe(false);
    expect(requests).toBe(14);
  } finally {
    agent.destroy();
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
