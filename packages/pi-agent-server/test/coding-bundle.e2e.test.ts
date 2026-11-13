import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('runs a standalone bundled coding subprocess with an unchanged Pi extension and host approval', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coding-bundle-'));
  const agentDir = join(directory, 'agent');
  const extensionsDir = join(agentDir, 'extensions');
  mkdirSync(extensionsDir, { recursive: true });
  copyFileSync(resolve(import.meta.dir, '../../coding-runtime/test/fixtures/upstream/hello.ts'), join(extensionsDir, 'hello.ts'));
  writeFileSync(join(agentDir, 'mcp.json'), '{}');
  const buildDir = join(directory, 'build');
  const artifact = join(directory, 'artifact');
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../src/index.ts'), resolve(import.meta.dir, '../src/tools/codemode-worker.ts')],
    outdir: buildDir, naming: '[name].[ext]', target: 'bun', format: 'esm',
    define: { PI_BUNDLED_NODE: 'true' }, external: ['koffi'],
  });
  expect(build.success).toBe(true);
  renameSync(buildDir, artifact);
  const requests: Array<Record<string, unknown>> = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      requests.push(await request.json() as Record<string, unknown>);
      const first = requests.length === 1;
      const delta = first ? { tool_calls: [{ index: 0, id: 'bundle-hello', type: 'function',
        function: { name: 'hello', arguments: '{"name":"bundle"}' } }] } : { content: 'bundle-ready' };
      const chunk = { id: 'local', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const env: NodeJS.ProcessEnv = {
    HOME: directory, USERPROFILE: directory, CONFIG_DIR: directory, TMPDIR: directory,
    XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1', MKAGENT_TELEMETRY_DISABLED: '1',
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  const child = spawn(process.execPath, ['--no-env-file', '--config=/dev/null', join(artifact, 'index.js')], {
    cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Array<Record<string, any>> = [];
  let buffer = '';
  let errors = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.type === 'native_history_commit') send({
        type: 'native_history_receipt', id: message.id, success: true,
        ownerSessionId: message.ownerSessionId, runtimeGeneration: message.runtimeGeneration,
      });
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const scope = { ownerSessionId: 'bundle', runtimeGeneration: 1 };
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ ...scope, ...message })}\n`);
  const wait = async (predicate: (message: Record<string, any>) => boolean) => {
    for (let attempt = 0; attempt < 250; attempt++) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      if (child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    throw new Error(`Bundle protocol timeout: ${JSON.stringify(messages)} ${errors}`);
  };
  try {
    send({
      type: 'init', agentProfile: 'coding', apiKey: 'local-fixture', model: 'pi/local',
      cwd: directory, thinkingLevel: 'off', workspaceRootPath: directory, sessionId: 'bundle',
      agentDir, sessionPath: directory, workingDirectory: directory, plansFolderPath: join(directory, 'plans'),
      baseUrl: `http://127.0.0.1:${provider.port}/v1`, customEndpoint: { api: 'openai-completions' },
    });
    await wait(message => message.type === 'ready');
    send({ type: 'prompt', id: 'bundle-prompt', message: 'hello', systemPrompt: 'local-bundle-system' });
    const approval = await wait(message => message.type === 'pre_tool_use_request' && message.toolName === 'hello');
    expect(approval.input).toEqual({ name: 'bundle' });
    send({ type: 'pre_tool_use_response', requestId: approval.requestId, action: 'modify', input: { name: 'approved-bundle' } });
    const result = await wait(message => message.type === 'event' && message.event?.type === 'tool_execution_end');
    expect(JSON.stringify(result.event.result)).toContain('Hello, approved-bundle!');
    await wait(message => message.type === 'event' && message.event?.type === 'agent_end');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain('Hello, approved-bundle!');
    expect(JSON.stringify(messages)).toContain('bundle-ready');
  } finally {
    send({ type: 'shutdown' });
    if (!await Promise.race([exited.then(() => true), Bun.sleep(3_000).then(() => false)])) child.kill('SIGKILL');
    await exited;
    provider.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
