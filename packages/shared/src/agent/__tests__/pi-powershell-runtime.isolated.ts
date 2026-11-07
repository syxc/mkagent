/** Test the product wiring with a local process fixture, not a PowerShell interpreter. */
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { PiAgent } from '../pi-agent.ts';

test.skipIf(process.platform === 'win32')('exposes an opt-in coding PowerShell tool and executes only after host approval', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'powershell-wiring-'));
  const agentDir = join(directory, 'agent');
  const bin = join(directory, 'bin');
  const invocation = join(directory, 'invocation.txt');
  mkdirSync(bin);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'enable.ts'), `export default function(pi) {
    pi.registerCommand('enable-powershell', { handler: async () => pi.setActiveTools(['powershell']) });
  }`);
  writeFileSync(join(bin, 'pwsh'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${invocation}'\nprintf 'fixture 中文 output\\n'\n`);
  chmodSync(join(bin, 'pwsh'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + previousPath;
  let requests = 0;
  const bodies: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    bodies.push(await request.json());
    requests++;
    const delta = requests % 2 ? { tool_calls: [{ index: 0, id: `ps-${requests}`, type: 'function',
      function: { name: 'powershell', arguments: JSON.stringify({ command: 'Write-Output fixture' }) } }] } : { content: 'Fixture complete.' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: requests % 2 ? 'tool_calls' : 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const agent = new PiAgent({
    provider: 'pi', providerType: 'pi_compat', authType: 'none', model: 'fixture', agentProfile: 'coding',
    workspace: { id: 'ps-wiring', name: 'PowerShell fixture', slug: 'ps-wiring', rootPath: directory, createdAt: 1 },
    session: { id: 'ps-wiring', workspaceRootPath: directory, createdAt: 1, lastUsedAt: 1, workingDirectory: directory },
    isHeadless: true, skipConfigWatcher: true,
    nativeSessionOwner: { onProjection: async reference => { expect(reference.sessionId).toBe('ps-wiring'); },
      onEvent: async () => { throw new Error('Unexpected fixture replacement'); }, onExit: async () => {} },
    codingResources: { agentDir, resourcePolicy: 'host-only', extensionPaths: [join(agentDir, 'enable.ts')] },
    runtime: { paths: { node: process.execPath, piServer: resolve(import.meta.dir, '../../../../pi-agent-server/src/index.ts') },
      baseUrl: `http://127.0.0.1:${server.port}/v1`, customEndpoint: { api: 'openai-completions' },
      customModels: [{ id: 'fixture', contextWindow: 100_000 }] },
  });
  agent.setPermissionMode('ask');
  let allow = false;
  let prompts = 0;
  agent.onPermissionRequest = request => {
    expect(request.toolName).toBe('PowerShell');
    prompts++;
    agent.respondToPermission(request.requestId, allow);
  };
  try {
    for await (const _event of agent.chat('/enable-powershell')) {}
    expect(requests).toBe(0);
    for await (const _event of agent.chat('Denied fixture invocation')) {}
    expect(existsSync(invocation)).toBe(false);
    allow = true;
    const outputs: string[] = [];
    for await (const event of agent.chat('Approved fixture invocation')) {
      if (event.type === 'tool_result') outputs.push(String(event.result));
    }
    expect(prompts).toBe(2);
    expect(outputs.join('\n')).toContain('fixture 中文 output');
    expect(readFileSync(invocation, 'utf8')).toContain('-NoProfile\n-NonInteractive\n-ExecutionPolicy\nBypass\n-Command\n');
    expect(readFileSync(invocation, 'utf8')).toContain('[Console]::OutputEncoding');
    expect(readFileSync(invocation, 'utf8')).toContain('Write-Output fixture');
    expect(JSON.stringify(bodies[0])).toContain('"name":"powershell"');
    expect(requests).toBe(4);
  } finally {
    agent.destroy();
    server.stop(true);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
