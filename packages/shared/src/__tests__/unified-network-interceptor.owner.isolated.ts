import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This file needs a fresh process because the interceptor installs fetch once.
test('synthetic malformed-body errors keep their request owner across a delayed Request body', async () => {
  const root = process.env.MKAGENT_INTERCEPTOR_OWNER_TEST_ROOT ?? mkdtempSync(join(tmpdir(), 'interceptor-owner-'));
  if (!process.env.MKAGENT_INTERCEPTOR_OWNER_TEST_ROOT) {
    // bunfig preloads the interceptor before tests can change CONFIG_DIR.
    const child = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CONFIG_DIR: root, MKAGENT_INTERCEPTOR_OWNER_TEST_ROOT: root },
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      process.stderr.write(child.stderr);
      expect(child.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return;
  }
  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(source); mkdirSync(target);
  const previousFetch = globalThis.fetch;
  const previousInstall = process.env.MKAGENT_INTERCEPTOR_DISABLE_AUTO_INSTALL;
  const previousConfig = process.env.CONFIG_DIR;
  const previousSessionDir = process.env.MKAGENT_SESSION_DIR;
  let common: typeof import('../interceptor-common') | undefined;
  let networkRequests = 0;
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    networkRequests++;
    return Response.json({ error: { message: 'unexpected network request' } }, { status: 500 });
  } });
  try {
    process.env.CONFIG_DIR = root;
    delete process.env.MKAGENT_SESSION_DIR;
    delete process.env.MKAGENT_INTERCEPTOR_DISABLE_AUTO_INSTALL;
    common = await import('../interceptor-common');
    const { setStoredError, toolMetadataStore } = common;
    expect(common.CONFIG_FILE).toBe(join(root, 'config.json'));
    await import('../unified-network-interceptor');
    for (const sourceDir of [null, source]) {
      toolMetadataStore._clearForTesting();
      if (sourceDir) toolMetadataStore.setSessionDir(sourceDir);
      expect(common.getInterceptorSessionDir()).toBe(sourceDir);
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const request = new Request(`http://127.0.0.1:${endpoint.port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }),
      });
      const response = fetch(request);
      toolMetadataStore.setSessionDir(target);
      setStoredError({ status: 429, statusText: 'target', message: 'target error remains', timestamp: Date.now() }, target);
      body.enqueue(new TextEncoder().encode(JSON.stringify({ messages: [{ role: 'assistant', tool_calls: [
        { id: 'duplicate-source', type: 'function', function: { name: 'source_tool', arguments: '{}' } },
        { id: 'duplicate-source', type: 'function', function: { name: 'source_tool', arguments: '{}' } },
      ] }] })));
      body.close();
      const result = await response;
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({ error: { code: 'duplicate_tool_call_id' } });
      expect(networkRequests).toBe(0);
      const errorFile = join(sourceDir ?? root, 'api-error.json');
      expect(existsSync(errorFile)).toBe(true);
      expect(JSON.parse(readFileSync(errorFile, 'utf8')).message).toContain('duplicate-source');
      expect(JSON.parse(readFileSync(join(target, 'api-error.json'), 'utf8')).message).toBe('target error remains');
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousInstall === undefined) delete process.env.MKAGENT_INTERCEPTOR_DISABLE_AUTO_INSTALL;
    else process.env.MKAGENT_INTERCEPTOR_DISABLE_AUTO_INSTALL = previousInstall;
    common?.toolMetadataStore._clearForTesting();
    if (previousConfig === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = previousConfig;
    if (previousSessionDir === undefined) delete process.env.MKAGENT_SESSION_DIR; else process.env.MKAGENT_SESSION_DIR = previousSessionDir;
    endpoint.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
