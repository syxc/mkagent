import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Smoke test against the BUILT single-file bundle, not the source tree.
 *
 * Two 0.12.1 release breakages were invisible to source-mode tests because they
 * only exist in the bundled artifact or in the exact server injection path:
 *   1. "No API key found for openai-codex" — api_key credential shipped for an
 *      OAuth-only provider (pi SDK ≥0.81 typed resolver).
 *   2. "OAuth auth derivation failed" — lazyOAuth's bundler-opaque dynamic
 *      import cannot resolve flow modules next to a single-file bundle.
 *
 * This drives dist/index.js over its JSONL protocol from a directory outside
 * the repo (so nothing resolves from node_modules) with a ChatGPT Plus-shaped
 * init, and asserts the prompt gets past credential resolution and OAuth
 * derivation all the way to request building. The fake token is deliberately
 * not a JWT: failing at accountId extraction is the deterministic, offline
 * proof that the whole auth pipeline upstream of the HTTP request works.
 */

const packageDir = dirname(import.meta.dir);
const bundlePath = join(packageDir, 'dist', 'index.js');
const blockNetworkPreloadPath = join(import.meta.dir, 'test-fixtures', 'block-network.ts');
const mockProviderPreloadPath = join(import.meta.dir, 'test-fixtures', 'mock-provider.ts');
const RUN_TIMEOUT_MS = 30_000;

let scratchDir: string;

beforeAll(() => {
  const build = spawnSync('bun', ['run', 'build'], { cwd: packageDir, stdio: 'pipe', timeout: 120_000 });
  if (build.status !== 0) {
    throw new Error(`bundle build failed: ${build.stderr?.toString() ?? build.stdout?.toString()}`);
  }
  scratchDir = mkdtempSync(join(tmpdir(), 'pi-bundle-smoke-'));
  mkdirSync(join(scratchDir, 'plans'), { recursive: true });
});

afterAll(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

/**
 * Build an allowlisted subprocess environment. Besides keeping the smoke test
 * independent of the developer machine, this prevents ambient provider keys,
 * auth files, custom base URLs, and proxy/routing variables from bypassing the
 * fake credential or escaping the explicit network guard.
 */
function createOfflineEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: scratchDir,
    USERPROFILE: scratchDir,
    XDG_CONFIG_HOME: scratchDir,
    TMPDIR: scratchDir,
    TEMP: scratchDir,
    TMP: scratchDir,
  };

  // Keep only variables required to launch Bun on each supported platform.
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/** Spawn the bundle, send JSONL messages, and collect output until `done` matches or timeout. */
function driveBundle(
  messages: object[],
  done: (output: string) => boolean,
  options: { bundle?: string; preload?: string; approveTools?: boolean; env?: NodeJS.ProcessEnv; onMessage?: (message: any) => object[] | void; onStderr?: (line: string) => object[] | void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--preload', options.preload ?? blockNetworkPreloadPath, options.bundle ?? bundlePath], {
      cwd: scratchDir,
      env: { ...createOfflineEnvironment(), ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for terminal marker; output so far:\n${output.slice(-2000)}`)),
      RUN_TIMEOUT_MS,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (done(output)) finish();
    };
    let stdoutBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.approveTools || options.onMessage) {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const message = JSON.parse(line);
            if (options.approveTools && message.type === 'pre_tool_use_request') {
              child.stdin.write(`${JSON.stringify({ type: 'pre_tool_use_response', requestId: message.requestId, action: 'allow' })}\n`);
            }
            for (const next of options.onMessage?.(message) ?? []) child.stdin.write(`${JSON.stringify(next)}\n`);
          } catch { /* Non-protocol output is included in the test result. */ }
        }
      }
      onData(chunk);
    });
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (options.onStderr) {
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          for (const next of options.onStderr(line) ?? []) child.stdin.write(`${JSON.stringify(next)}\n`);
        }
      }
      onData(chunk);
    });
    child.on('error', (err) => finish(err));
    child.on('exit', () => {
      if (!done(output)) finish(new Error(`bundle exited early; output:\n${output.slice(-2000)}`));
    });
    for (const msg of messages) {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    }
  });
}

describe('pi-agent-server bundle', () => {
  it('ships the Photon image module next to the bundle', () => {
    expect(existsSync(join(packageDir, 'dist', 'photon_rs_bg.wasm'))).toBe(true);
  });

  it('reads a BMP through the bundled read tool using the adjacent Photon module', () => {
    const artifactDir = join(scratchDir, 'read-image');
    mkdirSync(artifactDir);
    const output = join(artifactDir, 'read-image.js');
    const build = spawnSync(process.execPath, [
      'build', join(import.meta.dir, 'test-fixtures', 'read-image.ts'), '--outfile', output,
      '--target=bun', '--format=esm', '--external=koffi',
    ], { cwd: packageDir, encoding: 'utf8', timeout: 120_000 });
    expect(build.status).toBe(0);
    copyFileSync(join(packageDir, 'dist', 'photon_rs_bg.wasm'), join(artifactDir, 'photon_rs_bg.wasm'));
    const proc = spawnSync(process.execPath, [output], {
      cwd: artifactDir,
      env: createOfflineEnvironment(),
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
    });
    expect(proc.stdout).toContain('"mimeType":"image/png"');
    expect(proc.status).toBe(0);
  });

  it('runs the packaged server with code mode and MCP enabled by default', async () => {
    const artifactDir = join(scratchDir, 'production-artifact');
    const agentDir = join(scratchDir, 'production-agent');
    mkdirSync(artifactDir);
    mkdirSync(agentDir);
    for (const name of ['index.js', 'codemode-worker.js', 'quickjs.wasm']) {
      copyFileSync(join(packageDir, 'dist', name), join(artifactDir, name));
    }
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      test: { command: process.execPath, args: [join(import.meta.dir, 'test-fixtures/mcp-server.ts')] },
    } }));
    const output = await driveBundle([
      {
        type: 'init', apiKey: 'test-key', model: 'pi/fake-model', cwd: scratchDir,
        thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'production-smoke',
        sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
        agentDir, baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
      },
      { type: 'prompt', id: 'code-mcp', message: 'call MCP', systemPrompt: 'You are a smoke test.' },
    ], out => out.includes('"type":"agent_end"'), {
      bundle: join(artifactDir, 'index.js'), preload: mockProviderPreloadPath, approveTools: true,
    });
    expect(output).toContain('hello from MCP');
    expect(output).toContain('"toolName":"mcp__test__hello"');
    expect(output).toContain('"toolName":"pi.codemode.models.generateImages"');
    expect(output).toContain('"type":"pre_tool_use_request","requestId"');
    const modelApproval = output.split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).find(message => message.type === 'pre_tool_use_request' && message.toolName === 'pi.codemode.models.generateImages');
    expect(modelApproval).toBeDefined();
    expect(output).not.toContain('OFFLINE_FETCH_BLOCKED');
  }, RUN_TIMEOUT_MS + 10_000);

  it('opens one kernel for concurrent session-ready requests', async () => {
    const output = await driveBundle([
      {
        type: 'init', apiKey: 'test-key', model: 'pi/fake-model', cwd: scratchDir,
        thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'concurrent-open',
        sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
        baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
      },
      { type: 'ensure_session_ready', id: 'open-1' },
      { type: 'ensure_session_ready', id: 'open-2' },
    ], out => out.includes('"id":"open-1"') && out.includes('"id":"open-2"'));
    const results = output.split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter(message => message.type === 'ensure_session_ready_result');
    expect(results).toHaveLength(2);
    expect(results[0].sessionId).toBeTruthy();
    expect(results[0].sessionId).toBe(results[1].sessionId);
    expect(output.match(/Created durable kernel session:/g)).toHaveLength(1);
  });

  it('opens the new session when readiness races with re-initialization', async () => {
    const agentDir = join(scratchDir, 'slow-mcp-agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      slow: { command: process.execPath, args: [join(import.meta.dir, 'test-fixtures/mcp-server.ts'), '--slow-initialize'] },
    } }));
    let phase = 0;
    const output = await driveBundle([{
      type: 'init', apiKey: 'test-key', model: 'pi/fake-model', cwd: scratchDir,
      thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'race-old', agentDir,
      sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
      baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
    }], () => phase === 3, {
      onMessage(message) {
        if (message.type === 'ready' && phase === 0) {
          phase = 1;
          return [
            { type: 'ensure_session_ready', id: 'race-old-ready' },
            { type: 'init', apiKey: 'test-key', model: 'pi/fake-model', cwd: scratchDir,
              thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'race-new', agentDir,
              sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
              baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' } },
            { type: 'ensure_session_ready', id: 'race-new-ready' },
          ];
        }
        if (message.type === 'ready' && phase === 1) {
          phase = 2;
          return [{ type: 'ensure_session_ready', id: 'race-after-init' }];
        }
        if (message.type === 'ensure_session_ready_result' && message.id === 'race-after-init') phase = 3;
      },
    });
    const results = output.split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter(message => message.type === 'ensure_session_ready_result');
    expect(results.find(result => result.id === 'race-new-ready')?.sessionId)
      .toBe(results.find(result => result.id === 'race-after-init')?.sessionId);
    expect(results.find(result => result.id === 'race-old-ready')?.sessionId)
      .not.toBe(results.find(result => result.id === 'race-after-init')?.sessionId);
  }, RUN_TIMEOUT_MS + 10_000);

  it('recovers from a failed initialization without using the rejected configuration', async () => {
    let phase = 0;
    let errors = 0;
    const output = await driveBundle([{
      type: 'init', apiKey: '', model: 'pi/fake-model', cwd: scratchDir,
      thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'rejected-init',
      sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
      baseUrl: 123,
    }], () => phase === 2 || errors >= 3, {
      onMessage(message) {
        if (message.type === 'error') {
          errors++;
          if (phase === 0) {
            phase = 1;
            return [
              { type: 'ensure_session_ready', id: 'rejected-ready' },
              { type: 'init', apiKey: '', model: 'pi/fake-model', cwd: scratchDir,
                thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'recovered-init',
                sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
                baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' } },
              { type: 'ensure_session_ready', id: 'recovered-ready' },
            ];
          }
        }
        if (message.type === 'ensure_session_ready_result' && message.id === 'recovered-ready') phase = 2;
      },
    });
    const results = output.split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter(message => message.type === 'ensure_session_ready_result');
    expect(results.find(result => result.id === 'rejected-ready')).toBeUndefined();
    expect(results.find(result => result.id === 'recovered-ready')?.sessionId).toBeTruthy();
  }, RUN_TIMEOUT_MS + 10_000);

  it('publishes newly registered tools without reopening the session', async () => {
    let phase = 0;
    const output = await driveBundle([{
      type: 'init', apiKey: 'test-key', model: 'pi/fake-model', cwd: scratchDir,
      thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'dynamic-tools',
      sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
      baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
    }], () => phase === 3, {
      preload: mockProviderPreloadPath,
      approveTools: true,
      onMessage(message) {
        if (message.type === 'ready' && phase === 0) {
          phase = 1;
          return [{ type: 'ensure_session_ready', id: 'before-tools' }];
        }
        if (message.type === 'ensure_session_ready_result' && phase === 1) {
          phase = 2;
          return [
            { type: 'register_tools', tools: [{ name: 'session__new_tool', description: 'fixture', inputSchema: { type: 'object', properties: {} } }] },
            { type: 'prompt', id: 'after-tools', message: 'test', systemPrompt: 'test' },
          ];
        }
        if (message.type === 'event' && message.event?.type === 'agent_end' && phase === 2) phase = 3;
      },
    });
    expect(output.match(/Created durable kernel session:/g)).toHaveLength(1);
    expect(output).toContain('Published updated proxy tools for the next request');
    expect(output).not.toContain('prompt_error');
    const sessionId = output.split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).find(message => message.type === 'session_id_update')?.sessionId;
    expect(sessionId).toBeTruthy();
    const { Database } = await import('bun:sqlite');
    const db = new Database(join(scratchDir, 'sessions', 'dynamic-tools', 'durable-store', 'store.db'), { readonly: true });
    try {
      const entries = db.query('SELECT record FROM entries').all() as Array<{ record: string }>;
      expect(entries.some(entry => entry.record.includes('session__new_tool'))).toBe(true);
    } finally {
      db.close();
    }
  }, RUN_TIMEOUT_MS + 10_000);

  it('continues serving a prompt while runtime configuration is rebuilt', async () => {
    let phase = 0;
    const output = await driveBundle([
      {
        type: 'init', apiKey: 'test-key', model: 'pi/fake-model', cwd: scratchDir,
        thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'runtime-prompt',
        sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
        baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
      },
    ], () => phase === 3, {
      preload: mockProviderPreloadPath,
      approveTools: true,
      onMessage(message) {
        if (message.type === 'ready' && phase === 0) {
          phase = 1;
          return [{ type: 'ensure_session_ready', id: 'runtime-ready' }];
        }
        if (message.type === 'ensure_session_ready_result' && phase === 1) {
          phase = 2;
          return [
            { type: 'prompt', id: 'runtime-prompt-concurrent', message: 'test', systemPrompt: 'test' },
            { type: 'update_runtime_config', id: 'runtime-update-concurrent', model: 'pi/fake-model', baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' } },
          ];
        }
        if (message.type === 'event' && message.event?.type === 'agent_end' && phase === 2) phase = 3;
      },
    });
    expect(output).toContain('"id":"runtime-update-concurrent","success":true');
    expect(output).not.toContain('Model runtime not initialized');
    expect(output).not.toContain('prompt_error');
  }, RUN_TIMEOUT_MS + 10_000);

  it('releases a pending tool approval before waiting for abort to finish', async () => {
    const agentDir = join(scratchDir, 'abort-mcp-agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      test: { command: process.execPath, args: [join(import.meta.dir, 'test-fixtures/mcp-server.ts')] },
    } }));
    const fixtureBundle = join(scratchDir, 'abort-wait.js');
    const bundle = readFileSync(bundlePath, 'utf8');
    const anchor = '      await kernel.abort();';
    expect(bundle.split(anchor)).toHaveLength(2);
    writeFileSync(fixtureBundle, bundle.replace(anchor,
      `${anchor}\n      process.stderr.write("TEST_ABORT_FINISHED\\n");`));
    for (const name of ['codemode-worker.js', 'quickjs.wasm']) {
      copyFileSync(join(packageDir, 'dist', name), join(scratchDir, name));
    }
    let requested = false;
    let finished = false;
    const output = await driveBundle([{
      type: 'init', apiKey: 'test-key', model: 'pi/fake-model', cwd: scratchDir,
      thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'abort-pending-approval', agentDir,
      sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
      baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
    }], () => finished, {
      bundle: fixtureBundle,
      preload: mockProviderPreloadPath,
      onMessage(message) {
        if (message.type === 'ready') return [{ type: 'prompt', id: 'blocked-tool', message: 'test', systemPrompt: 'test' }];
        if (message.type === 'pre_tool_use_request' && !requested) {
          requested = true;
          return [{ type: 'abort' }];
        }
      },
      onStderr(line) {
        if (line.includes('TEST_ABORT_FINISHED')) finished = true;
      },
    });
    expect(requested).toBe(true);
    expect(output).toContain('TEST_ABORT_FINISHED');
    expect(output).not.toContain('OFFLINE_FETCH_BLOCKED');
  }, RUN_TIMEOUT_MS + 10_000);

  it('applies runtime updates made while the first prompt opens the kernel', async () => {
    const fixtureBundle = join(scratchDir, 'opening-race.js');
    const bundle = readFileSync(bundlePath, 'utf8');
    // Pause a temporary bundle copy after model resolution to reproduce the race.
    const anchor = '  try {\n    await k3.open({';
    expect(bundle.split(anchor)).toHaveLength(2);
    writeFileSync(fixtureBundle, bundle.replace(anchor,
      '  process.stderr.write("TEST_KERNEL_OPEN_PAUSED\\n");\n  await Bun.sleep(400);\n' + anchor));
    let phase = 0;
    let updated = false;
    let finished = false;
    const output = await driveBundle([{
      type: 'init', apiKey: 'test-key', model: 'pi/fake-model', cwd: scratchDir,
      thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'opening-runtime-update',
      sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
      baseUrl: 'http://old-provider.invalid/v1', customEndpoint: { api: 'openai-completions' },
    }], () => updated && finished, {
      bundle: fixtureBundle,
      preload: mockProviderPreloadPath,
      approveTools: true,
      env: { TEST_EXPECT_MODEL: 'fake-model' },
      onMessage(message) {
        if (message.type === 'ready' && phase === 0) {
          phase = 1;
          return [{ type: 'prompt', id: 'opening-prompt', message: 'test', systemPrompt: 'test' }];
        }
        if (message.type === 'update_runtime_config_result' && message.id === 'opening-update') updated = true;
        if (message.type === 'event' && message.event?.type === 'agent_end') finished = true;
      },
      onStderr(line) {
        if (phase === 1 && line.includes('TEST_KERNEL_OPEN_PAUSED')) {
          phase = 2;
          return [
            { type: 'update_runtime_config', id: 'opening-stale-update', model: 'pi/new-model',
              baseUrl: 'http://old-provider.invalid/v1', customEndpoint: { api: 'openai-completions' } },
            { type: 'update_runtime_config', id: 'opening-update', model: 'pi/fake-model',
              baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' } },
          ];
        }
      },
    });
    expect(output).toContain('"id":"opening-stale-update","success":false');
    expect(output).toContain('"id":"opening-update","success":true');
    expect(output).toContain('"text":"done"');
    expect(output).not.toContain('OFFLINE_FETCH_BLOCKED');
    expect(output).not.toContain('TEST_WRONG_MODEL');
    expect(output).not.toContain('Model runtime not initialized');
    expect(output).not.toContain('prompt_error');
  }, RUN_TIMEOUT_MS + 10_000);

  it('retains a token update received before the model runtime opens', async () => {
    const output = await driveBundle([
      {
        type: 'init', apiKey: '', model: 'pi/gpt-6-astra', cwd: scratchDir,
        thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'early-token',
        sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
        piAuth: { provider: 'openai-codex', credential: { type: 'api_key', key: 'fake-old' } },
      },
      { type: 'token_update', piAuth: { provider: 'openai-codex', credential: { type: 'iam', accessKeyId: 'fake', secretAccessKey: 'fake' } } },
      { type: 'ensure_session_ready', id: 'early-token-ready' },
    ], out => out.includes('"id":"early-token-ready"'));
    expect(output).toContain('Not storing iam credential for provider: openai-codex');
    expect(output).not.toContain('Injected api_key credential for provider: openai-codex');
  });

  for (const [label, credential] of [
    ['a different credential', { type: 'api_key', key: 'fake-new' }],
    ['the same refresh token', { type: 'oauth', access: 'fake-new', refresh: 'fake-original-refresh', expires: Date.now() + 60_000 }],
  ] as const) {
    it(`does not publish an old OAuth refresh after re-initialization with ${label}`, async () => {
      let phase = 0;
      const output = await driveBundle([{
        type: 'init', apiKey: '', model: 'pi/gpt-6-astra', cwd: scratchDir,
        thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'old-auth-session',
        sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
        piAuth: { provider: 'openai-codex', credential: { type: 'oauth', access: 'fake-expired', refresh: 'fake-original-refresh', expires: 1 } },
      }], () => phase === 5, {
        preload: mockProviderPreloadPath,
        env: { TEST_DELAY_OAUTH_REFRESH: '1' },
        onStderr(line) {
          if (line === 'TEST_OAUTH_REFRESH_STARTED' && phase === 1) {
            phase = 2;
            return [{
              type: 'init', apiKey: '', model: 'pi/gpt-6-astra', cwd: scratchDir,
              thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'new-auth-session',
              sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
              piAuth: { provider: 'openai-codex', credential },
            }];
          }
          if (line === 'TEST_OAUTH_REFRESH_FINISHED' && phase === 3) {
            phase = 4;
            return [{ type: 'ensure_session_ready', id: 'new-auth-ready' }];
          }
        },
        onMessage(message) {
          if (message.type === 'ready' && phase === 0) {
            phase = 1;
            return [{ type: 'prompt', id: 'old-auth-prompt', message: 'first', systemPrompt: 'test' }];
          }
          if (message.type === 'ready' && phase === 2) phase = 3;
          if (message.type === 'ensure_session_ready_result' && message.id === 'new-auth-ready' && phase === 4) phase = 5;
        },
      });
      expect(output).toContain('TEST_OAUTH_REFRESH_FINISHED');
      expect(output).not.toContain('"type":"oauth_credential_update"');
    }, RUN_TIMEOUT_MS + 10_000);
  }

  it('keeps a rotated OAuth credential across runtime config updates', async () => {
    let phase = 0;
    const output = await driveBundle([
      {
        type: 'init', apiKey: '', model: 'pi/gpt-6-astra', cwd: scratchDir,
        thinkingLevel: 'off', workspaceRootPath: scratchDir, sessionId: 'rotated-token',
        sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
        piAuth: { provider: 'openai-codex', credential: { type: 'oauth', access: 'fake-expired', refresh: 'fake-original-refresh', expires: 1 } },
      },
    ], () => phase === 4, {
      preload: mockProviderPreloadPath,
      onMessage(message) {
        if (message.type === 'ready' && phase === 0) {
          phase = 1;
          return [{ type: 'prompt', id: 'before-update', message: 'first', systemPrompt: 'test' }];
        }
        if (message.type === 'event' && message.event?.type === 'agent_end' && phase === 1) {
          phase = 2;
          return [{ type: 'update_runtime_config', id: 'runtime-update', model: 'pi/gpt-6-astra' }];
        }
        if (message.type === 'update_runtime_config_result' && phase === 2) {
          phase = 3;
          return [{ type: 'prompt', id: 'after-update', message: 'second', systemPrompt: 'test' }];
        }
        if (message.type === 'event' && message.event?.type === 'agent_end' && phase === 3) phase = 4;
      },
    });
    expect(output).toContain('"type":"oauth_credential_update"');
    expect(output).toContain('"id":"runtime-update","success":true');
    expect(output).not.toContain('TEST_OAUTH_REFRESHED_TWICE');
    expect(output).not.toContain('OFFLINE_FETCH_BLOCKED');
  }, RUN_TIMEOUT_MS + 10_000);

  it('resolves a ChatGPT Plus credential for Astra through the bundled auth pipeline offline', async () => {
    const output = await driveBundle(
      [
        {
          type: 'init',
          apiKey: '',
          model: 'pi/gpt-6-astra',
          cwd: scratchDir,
          thinkingLevel: 'off',
          workspaceRootPath: scratchDir,
          sessionId: 'bundle-smoke',
          sessionPath: scratchDir,
          workingDirectory: scratchDir,
          plansFolderPath: join(scratchDir, 'plans'),
          providerType: 'pi',
          authType: 'oauth',
          piAuth: { provider: 'openai-codex', credential: { type: 'api_key', key: 'fake-not-a-jwt' } },
        },
        { type: 'prompt', id: 'p1', message: 'hi', systemPrompt: 'You are a smoke test.' },
      ],
      // The non-JWT token must fail exactly at request-build accountId extraction —
      // any earlier failure is one of the auth-pipeline regressions this test pins.
      (out) => out.includes('Failed to extract accountId from token') ||
        out.includes('OFFLINE_FETCH_BLOCKED') ||
        out.includes('No API key found') ||
        out.includes('OAuth auth derivation failed'),
    );

    expect(output).not.toContain('No API key found');
    expect(output).not.toContain('OAuth auth derivation failed');
    expect(output).not.toContain('Cannot find module');
    expect(output).not.toContain('OFFLINE_FETCH_BLOCKED');
    expect(output).toContain('Failed to extract accountId from token');
  }, RUN_TIMEOUT_MS + 130_000);
});
