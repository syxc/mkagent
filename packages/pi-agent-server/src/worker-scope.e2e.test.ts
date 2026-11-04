import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

type Frame = Record<string, any>;
interface WorkerFixture {
  directory: string;
  exited: Promise<number | null>;
  requests: Array<Record<string, unknown>>;
  toolCalls: Array<{ name: string; arguments: string }>;
  messages: Frame[];
  send(message: Record<string, unknown>): void;
  sendBatch(...messages: Array<Record<string, unknown>>): void;
  waitFor(match: (message: Frame) => boolean): Promise<Frame>;
  init(owner: string, generation: number): Record<string, unknown>;
}

async function withWorker(profile: 'default' | 'coding', run: (fixture: WorkerFixture) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-worker-scope-'));
  const home = join(directory, 'home');
  mkdirSync(home);
  const requests: Array<Record<string, unknown>> = [];
  const toolCalls: WorkerFixture['toolCalls'] = [];
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    const call = toolCalls.shift();
    const delta = call
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'owned-shell', type: 'function', function: call }] }
      : { role: 'assistant', content: 'local reply' };
    return new Response([
      { id: `scope-${requests.length}`, choices: [{ index: 0, delta, finish_reason: null }] },
      { id: `scope-${requests.length}`, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
      { id: `scope-${requests.length}`, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  } });
  const child = spawn(process.execPath, [join(import.meta.dir, 'index.ts')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, CONFIG_DIR: join(directory, 'config'),
      CRAFT_CONFIG_DIR: join(directory, 'config'), PI_CODING_AGENT_DIR: join(directory, 'pi') },
  });
  const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const reader = createInterface({ input: child.stdout });
  const messages: Array<Record<string, any>> = [];
  const waiters: Array<{ match: (message: Frame) => boolean; resolve: (message: Frame) => void; timeout: ReturnType<typeof setTimeout> }> = [];
  reader.on('line', line => {
    const message = JSON.parse(line);
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.match(message)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    }
  });
  const waitFor = (match: (message: Frame) => boolean) => new Promise<Frame>((resolve, reject) => {
    const previous = messages.find(match);
    if (previous) resolve(previous);
    else {
      const waiter = { match, resolve, timeout: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`Worker protocol timed out: ${stderr}`));
      }, 5000) };
      waiters.push(waiter);
    }
  });
  const sendBatch = (...batch: Array<Record<string, unknown>>) =>
    child.stdin.write(batch.map(message => JSON.stringify(message)).join('\n') + '\n');
  const send = (message: Record<string, unknown>) => sendBatch(message);
  const init = (ownerSessionId: string, runtimeGeneration: number) => ({
    type: 'init', ownerSessionId, runtimeGeneration, sessionId: ownerSessionId,
    agentProfile: profile,
    ...(profile === 'coding' ? { codingResources: { agentDir: join(directory, 'pi'), resourcePolicy: 'host-only' } } : {}),
    apiKey: '', authType: 'none', providerType: 'pi_compat', model: 'local-scope',
    cwd: directory, workspaceRootPath: directory, workspaceId: 'scope',
    sessionPath: join(directory, 'sessions', ownerSessionId), workingDirectory: directory,
    plansFolderPath: join(directory, 'plans'), thinkingLevel: 'off',
    baseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
    customEndpoint: { api: 'openai-completions' }, customModels: [{ id: 'local-scope', contextWindow: 100_000 }],
  });
  try {
    await run({ directory, exited, requests, toolCalls, messages, send, sendBatch, waitFor, init });
  } finally {
    for (const waiter of waiters) clearTimeout(waiter.timeout);
    child.stdin.end();
    const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(deadline); }
    reader.close();
    endpoint.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function prepareTransfer(
  f: WorkerFixture, beforeTransfer?: (port: number) => Promise<void>, launch: 'prompt' | 'startup' = 'prompt',
) {
  const source = { ownerSessionId: 'source', runtimeGeneration: 1 };
  const target = { ownerSessionId: 'target', runtimeGeneration: 2 };
  const plugin = join(f.directory, 'transfer.ts');
  writeFileSync(plugin, `export default function(pi) {
    pi.registerCommand('fresh', { handler: async (_, ctx) => ctx.newSession() });
    pi.on('session_start', event => {
      if (event.reason === 'startup' && ${JSON.stringify(launch)} === 'startup') {
        pi.sendUserMessage('/fresh', { expandPromptTemplates: true });
      }
    });
  }`);
  f.send({ ...f.init('source', 1), codingResources: {
    agentDir: join(f.directory, 'pi'), resourcePolicy: 'host-only', extensionPaths: [plugin],
  } });
  const ready = await f.waitFor(message => message.type === 'ready');
  await beforeTransfer?.(ready.callbackPort);
  f.send(launch === 'prompt'
    ? { type: 'prompt', id: 'transfer', message: '/fresh', systemPrompt: '', ...source }
    : { type: 'ensure_session_ready', id: 'startup-transfer', ...source });
  const prepare = await f.waitFor(message => message.type === 'owner_prepare');
  f.send({ type: 'owner_prepared', transactionId: prepare.transactionId, targetSessionId: 'target', ...source });
  await f.waitFor(message => message.type === 'owner_source_closed');
  return { source, target, transactionId: prepare.transactionId, sourcePort: ready.callbackPort };
}

test('real worker preserves transformed prompt, steer and follow-up identities across reopening', async () => {
  await withWorker('coding', async f => {
    const scope = { ownerSessionId: 'source', runtimeGeneration: 1 };
    const plugin = join(f.directory, 'input-identity.ts');
    writeFileSync(plugin, `export default function(pi) {
      pi.on('input', event => ({ action: 'transform', text: event.text.replace('same', 'normalized') }));
      pi.on('message_end', event => {
        if (event.message.role === 'user') return { message: {
          role: 'user', content: event.message.content, timestamp: event.message.timestamp,
        } };
      });
    }`);
    const config = { ...f.init('source', 1), codingResources: {
      agentDir: join(f.directory, 'pi'), resourcePolicy: 'host-only', extensionPaths: [plugin],
    } };
    f.toolCalls.push({ name: 'bash', arguments: JSON.stringify({ command: 'printf identity-gate' }) });
    f.send(config);
    await f.waitFor(message => message.type === 'ready');
    f.send({ type: 'prompt', id: 'first-rpc', inputId: 'host-first', message: 'same',
      nativeInput: { text: 'same', hostContextPrefix: '' }, systemPrompt: '', ...scope });
    const approval = await f.waitFor(message => message.type === 'pre_tool_use_request');
    // The following prompt receipt fences both queued admissions while the tool awaits approval.
    f.sendBatch(
      { type: 'steer', inputId: 'host-steer', message: 'same', ...scope },
      { type: 'prompt', id: 'follow-rpc', inputId: 'host-follow', message: 'same',
        nativeInput: { text: 'same', hostContextPrefix: '' }, systemPrompt: '', ...scope },
    );
    await f.waitFor(message => message.type === 'prompt_result' && message.id === 'follow-rpc');
    f.send({ type: 'pre_tool_use_response', requestId: approval.requestId, action: 'allow', ...scope });
    await f.waitFor(message => message.type === 'event' && message.event.type === 'agent_end' && f.requests.length === 3);
    await f.waitFor(message => message.type === 'event' && message.event.type === 'native_session_projection'
      && message.event.descriptor.entryIds.some((entry: Frame) => entry.productMessageId === 'host-follow'));
    const sessionPath = join(f.directory, 'sessions', 'source');
    const readManifest = () => JSON.parse(readFileSync(join(sessionPath, 'meta', 'native-session.json'), 'utf8')) as Frame;
    const rows = readFileSync(join(sessionPath, 'native-session', 'session.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as Frame);
    const users = rows.filter(entry => entry.type === 'message' && entry.message.role === 'user');
    const manifest = readManifest();
    expect(manifest.sessionId).toBe('source');
    expect(users).toHaveLength(3);
    expect(users.map(user => manifest.entryIds.find((entry: Frame) => entry.nativeId === user.id)?.productMessageId))
      .toEqual(['host-first', 'host-steer', 'host-follow']);
    expect(JSON.stringify(users)).toContain('normalized');
    expect(JSON.stringify(f.requests)).toContain('normalized');
    expect(JSON.stringify(f.requests)).not.toContain('host-first');
    expect(JSON.stringify(f.requests)).not.toContain('host-steer');
    expect(JSON.stringify(f.requests)).not.toContain('host-follow');
    const resumedScope = { ownerSessionId: 'source', runtimeGeneration: 2 };
    f.send({ ...config, ...resumedScope });
    await f.waitFor(message => message.type === 'ready' && message.runtimeGeneration === 2);
    f.send({ type: 'ensure_session_ready', id: 'reopened-native', ...resumedScope });
    await f.waitFor(message => message.id === 'reopened-native');
    const reopened = readManifest();
    expect(reopened.nativeSessionId).toBe(manifest.nativeSessionId);
    expect(reopened.entryIds.filter((entry: Frame) => entry.productMessageId?.startsWith('host-')))
      .toEqual(manifest.entryIds.filter((entry: Frame) => entry.productMessageId?.startsWith('host-')));
    expect(f.requests).toHaveLength(3);
  });
}, 15_000);

test.each(['prompt', 'startup'] as const)('release during target extension loading from %s waits for cleanup and retires target admission', async launch => {
  await withWorker('coding', async f => {
    const { target, transactionId } = await prepareTransfer(f, undefined, launch);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
      entered.resolve();
      await gate.promise;
      return new Response('released');
    } });
    const plugin = join(f.directory, 'delayed-target.ts');
    writeFileSync(plugin, `export default async function(pi) {
      await fetch('http://127.0.0.1:${endpoint.port}/gate');
      pi.on('session_start', () => { throw new Error('Released target must not start'); });
    }`);
    try {
      f.send({ type: 'owner_activate', transactionId, activation: {
        config: { ...f.init('target', 2), codingResources: {
          agentDir: join(f.directory, 'pi'), resourcePolicy: 'host-only', extensionPaths: [plugin],
        } }, tools: [], systemPrompt: '', reason: 'new',
      }, ...target });
      await entered.promise;
      f.sendBatch({ type: 'release_owner', id: 'released-loading', ...target },
        { type: 'ensure_session_ready', id: 'retired-loading', ...target });
      // A source-scoped shell control reply provides an event-loop fence.
      f.send({ type: 'stop_background_task', id: 'release-fence', taskId: 'absent',
        ownerSessionId: 'source', runtimeGeneration: 1 });
      await f.waitFor(message => message.id === 'release-fence');
      await new Promise(resolve => setTimeout(resolve, 100));
      const premature = f.messages.some(message => message.id === 'released-loading');
      gate.resolve();
      expect(premature).toBe(false);
      expect(await f.waitFor(message => message.id === 'released-loading')).toMatchObject({ released: true, ...target });
      expect(f.messages.some(message => message.type === 'owner_target_bound')).toBe(false);
      expect(f.messages.some(message => message.id === 'retired-loading')).toBe(false);
      expect(f.requests).toHaveLength(0);
    } finally {
      gate.resolve();
      endpoint.stop(true);
    }
  });
}, 15_000);

test('native transfer revokes partial source callbacks and publishes a working target port', async () => {
  await withWorker('coding', async f => {
    const body = JSON.stringify({ prompt: 'retired callback marker', model: 'local-scope' });
    let request!: http.ClientRequest;
    let finished!: Promise<void>;
    const { target, transactionId, sourcePort } = await prepareTransfer(f, async port => {
      request = http.request({ hostname: '127.0.0.1', port, path: '/call-llm',
        method: 'POST', headers: { 'content-length': Buffer.byteLength(body) } });
      finished = new Promise<void>(resolve => {
        request.on('error', () => resolve());
        request.on('response', response => { response.resume(); response.on('end', resolve); });
      });
      await new Promise<void>((resolve, reject) => request.write(body.slice(0, 8),
        error => error ? reject(error) : resolve()));
      const fence = await fetch(`http://127.0.0.1:${port}/fence`);
      expect(fence.status).toBe(404);
    });
    f.send({ type: 'owner_activate', transactionId, activation: {
      config: f.init('target', 2), tools: [], systemPrompt: '', reason: 'new',
    }, ...target });
    await f.waitFor(message => message.type === 'owner_target_bound');
    request.end(body.slice(8));
    await finished;
    expect(f.requests).toHaveLength(0);
    const oldResult = await fetch(`http://127.0.0.1:${sourcePort}/call-llm`, {
      method: 'POST', body: JSON.stringify({ prompt: 'old listener marker', model: 'local-scope' }),
    }).then(async response => response.json()).catch(() => null);
    expect(oldResult?.text).toBeUndefined();
    expect(f.requests).toHaveLength(0);
    const portEvent = await f.waitFor(message => message.type === 'callback_port' && message.ownerSessionId === 'target');
    expect(portEvent.callbackPort).not.toBe(sourcePort);
    const result = await fetch(`http://127.0.0.1:${portEvent.callbackPort}/call-llm`, {
      method: 'POST', body: JSON.stringify({ prompt: 'target callback marker', model: 'local-scope' }),
    }).then(response => response.json());
    expect(result.text).toBe('local reply');
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests[0])).toContain('target callback marker');
    f.send({ type: 'owner_committed', transactionId, ...target });
    await f.waitFor(message => message.type === 'owner_finished');
  });
}, 15_000);

test.each(['default', 'coding'] as const)('%s worker scopes replies and rejects retired foreground requests', async profile => {
  await withWorker(profile, async ({ requests, messages, send, waitFor, init }) => {
    send(init('source', 1));
    expect(await waitFor(message => message.type === 'ready')).toMatchObject({
      ownerSessionId: 'source', runtimeGeneration: 1,
    });
    send({ type: 'ensure_session_ready', id: 'source-ready', ownerSessionId: 'source', runtimeGeneration: 1 });
    expect(await waitFor(message => message.id === 'source-ready')).toMatchObject({ ownerSessionId: 'source', runtimeGeneration: 1 });
    send({ type: 'prompt', id: 'accepted-source', message: 'source marker', systemPrompt: 'source prompt',
      ownerSessionId: 'source', runtimeGeneration: 1 });
    await waitFor(message => message.type === 'event' && message.event?.type === 'agent_end' && message.ownerSessionId === 'source');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('source marker');
    send(init('target', 2));
    await waitFor(message => message.type === 'ready' && message.runtimeGeneration === 2);
    send({ type: 'prompt', id: 'stale', message: 'source marker', systemPrompt: 'stale',
      ownerSessionId: 'source', runtimeGeneration: 1 });
    send({ type: 'shutdown', ownerSessionId: 'source', runtimeGeneration: 1 });
    send({ type: 'ensure_session_ready', id: 'target-ready', ownerSessionId: 'target', runtimeGeneration: 2 });
    expect(await waitFor(message => message.id === 'target-ready')).toMatchObject({ ownerSessionId: 'target', runtimeGeneration: 2 });
    send({ type: 'prompt', id: 'accepted-target', message: 'target marker', systemPrompt: 'target prompt',
      ownerSessionId: 'target', runtimeGeneration: 2 });
    await waitFor(message => message.type === 'event' && message.event?.type === 'agent_end' && message.ownerSessionId === 'target');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain('target marker');
    expect(JSON.stringify(requests[1])).not.toContain('source marker');
    expect(messages.some(message => message.id === 'stale')).toBe(false);
  });
}, 15_000);

function initUI(fixture: WorkerFixture, owner: string, generation: number, available = true) {
  const plugin = join(fixture.directory, 'ui-plugin.ts');
  writeFileSync(plugin, `
    import { writeFileSync } from 'node:fs';
    export default function(pi) {
      let starts = 0;
      pi.on('session_start', async (_, ctx) => {
        starts++;
        const value = await ctx.ui.select('Startup', ['one', 'two']);
        writeFileSync(${JSON.stringify(join(fixture.directory, 'ui-result.json'))},
          JSON.stringify({ value: value ?? null, starts, hasUI: ctx.hasUI, mode: ctx.mode }));
      });
      pi.registerCommand('state', { handler: async (_, ctx) => {
        ctx.ui.notify(ctx.mode + '|' + ctx.hasUI + '|' + starts);
      } });
    }
  `);
  return { ...fixture.init(owner, generation), extensionUIAvailable: available,
    codingResources: { agentDir: join(fixture.directory, 'pi'), resourcePolicy: 'host-only', extensionPaths: [plugin] } };
}

test.each(['prompt', 'startup'] as const)('native owner %s activation keeps hooks behind commit and routes callback work to the target', async launch => {
  await withWorker('coding', async f => {
    const source = { ownerSessionId: 'source', runtimeGeneration: 1 };
    const target = { ownerSessionId: 'target', runtimeGeneration: 2 };
    const targetCwd = join(f.directory, 'target-cwd');
    mkdirSync(targetCwd);
    const tracePath = join(f.directory, 'owner-trace.jsonl');
    writeFileSync(tracePath, '');
    const plugin = join(f.directory, 'owner.ts');
    writeFileSync(plugin, `
      import { appendFileSync } from 'node:fs';
      const trace = value => appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(value) + '\\n');
      export default function(pi) {
        pi.on('session_start', (event, ctx) => {
          trace(['start', event.reason, ctx.cwd]);
          if (event.reason === 'startup' && ${JSON.stringify(launch)} === 'startup') {
            pi.sendUserMessage('/fresh', { expandPromptTemplates: true });
          }
        });
        pi.on('session_shutdown', event => trace(['shutdown', event.reason]));
        pi.on('session_before_switch', event => trace(['before', event.reason]));
        pi.registerCommand('fresh', { handler: async (_, ctx) => ctx.newSession({
          setup: async manager => {
            trace(['setup', manager.getCwd()]);
            manager.appendMessage({ role: 'user', content: 'setup marker', timestamp: Date.now() });
          },
          withSession: async next => {
            trace(['with', next.cwd]);
            await next.sendUserMessage('target marker');
          },
        }) });
      }
    `);
    const codingResources = { agentDir: join(f.directory, 'pi'), resourcePolicy: 'host-only',
      extensionPaths: [plugin], globalSettings: { compaction: { enabled: false }, cacheWarming: 'off' } };
    const traces = () => readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    f.sendBatch({ ...f.init('source', 1), codingResources }, { type: 'ensure_session_ready', id: 'owner-open', ...source });
    if (launch === 'prompt') {
      await f.waitFor(message => message.id === 'owner-open');
      f.send({ type: 'prompt', id: 'source-command', inputId: 'product-input', message: '/fresh', systemPrompt: '', ...source });
    }
    const prepare = await f.waitFor(message => message.type === 'owner_prepare');
    expect(prepare).toMatchObject({ ...source, operation: { type: 'new' } });
    expect(f.messages.find(message => message.type === 'session_id_update' && message.ownerSessionId === 'source'))
      .toMatchObject({ sessionId: prepare.sourceNativeSessionId });
    if (launch === 'prompt') expect(prepare.inputId).toBe('product-input');
    else expect(Object.hasOwn(prepare, 'inputId')).toBe(false);
    expect(traces()).toEqual([['start', 'startup', f.directory], ['before', 'new']]);
    const transactionId = prepare.transactionId;
    f.send({ type: 'owner_prepared', transactionId, targetSessionId: 'target', ...source });
    expect(await f.waitFor(message => message.type === 'owner_source_closed')).toMatchObject(source);
    expect(traces()).toEqual([['start', 'startup', f.directory], ['before', 'new'], ['shutdown', 'new']]);
    const config = { ...f.init('target', 2), codingResources, cwd: targetCwd, workingDirectory: targetCwd };
    f.send({ type: 'owner_activate', transactionId, activation: { config, tools: [], systemPrompt: 'target system marker',
      reason: 'new' }, ...target });
    const bound = await f.waitFor(message => message.type === 'owner_target_bound');
    expect(bound).toMatchObject(target);
    expect(bound.nativeSessionId).not.toBe(prepare.sourceNativeSessionId);
    expect(traces()).toHaveLength(3);
    expect(f.requests).toHaveLength(0);
    f.sendBatch(
      { type: 'owner_committed', transactionId, ...source },
      { type: 'ensure_session_ready', id: 'commit-fence', ...target },
    );
    await f.waitFor(message => message.id === 'commit-fence');
    expect(traces()).toHaveLength(3);
    f.send({ type: 'owner_committed', transactionId, ...target });
    expect(await f.waitFor(message => message.type === 'owner_finished')).toMatchObject({ ...target, outcome: 'complete' });
    expect(traces()).toEqual([
      ['start', 'startup', f.directory], ['before', 'new'], ['shutdown', 'new'],
      ['setup', targetCwd], ['start', 'new', targetCwd], ['with', targetCwd],
    ]);
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests[0])).toContain('setup marker');
    expect(JSON.stringify(f.requests[0])).toContain('target marker');
    expect(JSON.stringify(f.requests[0])).toContain('target system marker');
    expect(f.messages.filter(message => message.type === 'event' && message.event?.type === 'agent_start')
      .every(message => message.ownerSessionId === 'target' && message.runtimeGeneration === 2)).toBe(true);
    f.send({ type: 'release_owner', id: 'target-release', ...target });
    expect(await f.waitFor(message => message.id === 'target-release')).toMatchObject({ ...target, released: true });
    expect(traces().at(-1)).toEqual(['shutdown', 'quit']);
  });
}, 15_000);

test('worker delivers startup UI and validates responses before the kernel becomes ready', async () => {
  await withWorker('coding', async f => {
    const scope = { ownerSessionId: 'source', runtimeGeneration: 1 };
    f.sendBatch(initUI(f, 'source', 1), { type: 'ensure_session_ready', id: 'opened', ...scope });
    const request = await f.waitFor(message => message.type === 'extension_ui_request' && message.method === 'select');
    expect(request).toMatchObject(scope);
    expect(f.messages.some(message => message.id === 'opened')).toBe(false);
    f.sendBatch(
      { type: 'extension_ui_response', responseId: 'wrong-epoch', id: request.id, uiEpoch: 'retired', value: 'one', ...scope },
      { type: 'extension_ui_response', responseId: 'wrong-owner', id: request.id, uiEpoch: request.uiEpoch,
        value: 'one', ownerSessionId: 'different', runtimeGeneration: 1 },
      { type: 'extension_ui_response', responseId: 'valid', id: request.id, uiEpoch: request.uiEpoch, value: 'two', ...scope },
    );
    expect(await f.waitFor(message => message.type === 'extension_ui_response_result' && message.id === 'wrong-epoch'))
      .toMatchObject({ ...scope, accepted: false });
    expect(await f.waitFor(message => message.type === 'extension_ui_response_result' && message.id === 'valid'))
      .toMatchObject({ ...scope, accepted: true });
    await f.waitFor(message => message.id === 'opened');
    expect(f.messages.some(message => message.id === 'wrong-owner')).toBe(false);
    expect(JSON.parse(readFileSync(join(f.directory, 'ui-result.json'), 'utf8')))
      .toEqual({ value: 'two', starts: 1, hasUI: true, mode: 'rpc' });
    f.send({ type: 'extension_ui_response', responseId: 'duplicate', id: request.id,
      uiEpoch: request.uiEpoch, value: 'one', ...scope });
    expect(await f.waitFor(message => message.id === 'duplicate')).toMatchObject({ accepted: false });
    expect(f.requests).toHaveLength(0);
  });
}, 15_000);

test.each(['abort', 'disconnect'] as const)('worker %s releases an opening kernel and reconnect preserves one startup hook', async action => {
  await withWorker('coding', async f => {
    const scope = { ownerSessionId: 'source', runtimeGeneration: 1 };
    f.sendBatch(initUI(f, 'source', 1), { type: 'ensure_session_ready', id: 'opened', ...scope });
    const request = await f.waitFor(message => message.type === 'extension_ui_request' && message.method === 'select');
    f.send(action === 'abort' ? { type: 'abort', ...scope } : { type: 'extension_ui_available', available: false, ...scope });
    await f.waitFor(message => message.id === 'opened');
    expect(JSON.parse(readFileSync(join(f.directory, 'ui-result.json'), 'utf8')))
      .toEqual({ value: null, starts: 1, hasUI: false, mode: 'print' });
    if (action === 'disconnect') f.send({ type: 'extension_ui_available', available: true, ...scope });
    await f.waitFor(message => message.type === 'extension_ui_state' && message.available === true && message.reset === false);
    f.send({ type: 'prompt', id: 'state', message: '/state', systemPrompt: '', ...scope });
    expect(await f.waitFor(message => message.type === 'extension_ui_request' && message.method === 'notify'))
      .toMatchObject({ ...scope, message: 'rpc|true|1' });
    f.send({ type: 'extension_ui_response', responseId: 'late', id: request.id,
      uiEpoch: request.uiEpoch, value: 'one', ...scope });
    expect(await f.waitFor(message => message.id === 'late')).toMatchObject({ accepted: false });
    expect(f.requests).toHaveLength(0);
  });
}, 15_000);

test('reinitialization cancels source startup UI and gives the target an independent UI epoch', async () => {
  await withWorker('coding', async f => {
    const source = { ownerSessionId: 'source', runtimeGeneration: 1 };
    const target = { ownerSessionId: 'target', runtimeGeneration: 2 };
    f.sendBatch(initUI(f, 'source', 1), { type: 'ensure_session_ready', id: 'source-open', ...source });
    const previous = await f.waitFor(message => message.type === 'extension_ui_request' && message.method === 'select');
    f.sendBatch(initUI(f, 'target', 2), { type: 'ensure_session_ready', id: 'target-open', ...target });
    const next = await f.waitFor(message => message.type === 'extension_ui_request' && message.method === 'select'
      && message.ownerSessionId === 'target');
    expect(next.uiEpoch).not.toBe(previous.uiEpoch);
    f.sendBatch(
      { type: 'extension_ui_response', responseId: 'retired-epoch', id: previous.id,
        uiEpoch: previous.uiEpoch, value: 'one', ...target },
      { type: 'extension_ui_response', responseId: 'next-response', id: next.id,
        uiEpoch: next.uiEpoch, value: 'two', ...target },
    );
    expect(await f.waitFor(message => message.id === 'retired-epoch')).toMatchObject({ accepted: false });
    expect(await f.waitFor(message => message.id === 'next-response')).toMatchObject({ accepted: true });
    expect(await f.waitFor(message => message.id === 'target-open')).toMatchObject(target);
    expect(JSON.parse(readFileSync(join(f.directory, 'ui-result.json'), 'utf8')))
      .toMatchObject({ value: 'two', hasUI: true, mode: 'rpc' });
    expect(f.requests).toHaveLength(0);
  });
}, 15_000);

test('worker shutdown releases pending startup UI and exits without a forced kill', async () => {
  await withWorker('coding', async f => {
    const scope = { ownerSessionId: 'source', runtimeGeneration: 1 };
    f.sendBatch(initUI(f, 'source', 1), { type: 'ensure_session_ready', id: 'opened', ...scope });
    await f.waitFor(message => message.type === 'extension_ui_request' && message.method === 'select');
    f.send({ type: 'shutdown', ...scope });
    expect(await f.exited).toBe(0);
  });
}, 15_000);

test('worker without a UI responder preserves native print mode and no-op defaults', async () => {
  await withWorker('coding', async f => {
    const scope = { ownerSessionId: 'source', runtimeGeneration: 1 };
    f.sendBatch(initUI(f, 'source', 1, false), { type: 'ensure_session_ready', id: 'opened', ...scope });
    await f.waitFor(message => message.id === 'opened');
    expect(JSON.parse(readFileSync(join(f.directory, 'ui-result.json'), 'utf8')))
      .toEqual({ value: null, starts: 1, hasUI: false, mode: 'print' });
    expect(f.messages.some(message => message.type === 'extension_ui_request')).toBe(false);
    expect(f.requests).toHaveLength(0);
  });
}, 15_000);

test.each(['default', 'coding'] as const)('%s worker keeps a source background shell across foreground reinitialization', async profile => {
  await withWorker(profile, async ({ requests, toolCalls, messages, send, waitFor, init }) => {
    toolCalls.push({ name: 'bash', arguments: JSON.stringify({
      command: 'printf source-background; sleep 30', run_in_background: true,
    }) });
    send(init('source', 1));
    await waitFor(message => message.type === 'ready');
    send({ type: 'prompt', id: 'launch-source', message: 'launch source shell', systemPrompt: 'local fixture',
      ownerSessionId: 'source', runtimeGeneration: 1 });
    const approval = await waitFor(message => message.type === 'pre_tool_use_request');
    expect(approval).toMatchObject({ ownerSessionId: 'source', runtimeGeneration: 1, toolName: 'Bash' });
    send({ type: 'pre_tool_use_response', requestId: approval.requestId, action: 'allow',
      ownerSessionId: 'source', runtimeGeneration: 1 });
    const launch = await waitFor(message => message.type === 'background_task_event' && message.event.type === 'shell_backgrounded');
    expect(launch).toMatchObject({ ownerSessionId: 'source', runtimeGeneration: 1 });
    const taskId = launch.event.shellId;
    await waitFor(message => message.type === 'event' && message.event.type === 'agent_end');
    send(init('target', 2));
    await waitFor(message => message.type === 'ready' && message.runtimeGeneration === 2);
    expect(messages.some(message => message.type === 'background_task_event' && message.event.type === 'task_completed')).toBe(false);
    send({ type: 'stop_background_task', id: 'wrong-owner', taskId, ownerSessionId: 'target', runtimeGeneration: 2 });
    expect(await waitFor(message => message.id === 'wrong-owner')).toMatchObject({
      stopped: false, ownerSessionId: 'target', runtimeGeneration: 2,
    });
    send({ type: 'stop_background_task', id: 'own-task', taskId, ownerSessionId: 'source', runtimeGeneration: 1 });
    expect(await waitFor(message => message.id === 'own-task')).toMatchObject({
      stopped: true, ownerSessionId: 'source', runtimeGeneration: 1,
    });
    expect(await waitFor(message => message.type === 'background_task_event' && message.event.type === 'task_completed')).toMatchObject({
      ownerSessionId: 'source', runtimeGeneration: 1, event: { taskId, status: 'stopped' },
    });
    send({ type: 'prompt', id: 'target-alive', message: 'target marker', systemPrompt: 'target fixture',
      ownerSessionId: 'target', runtimeGeneration: 2 });
    await waitFor(message => message.type === 'event' && message.event.type === 'agent_end' && message.ownerSessionId === 'target');
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[0])).toContain('launch source shell');
    expect(JSON.stringify(requests[2])).toContain('target marker');
    expect(JSON.stringify(requests[2])).not.toContain('launch source shell');
  });
}, 15_000);

test.each(['default', 'coding'] as const)('%s worker retires queued compaction IDs before accepting the target request', async profile => {
  await withWorker(profile, async ({ send, sendBatch, waitFor, init }) => {
    sendBatch(
      init('source', 1),
      { type: 'compact', id: 'reused-id', ownerSessionId: 'source', runtimeGeneration: 1 },
      init('target', 2),
    );
    await waitFor(message => message.type === 'ready' && message.runtimeGeneration === 2);
    send({ type: 'compact', id: 'reused-id', ownerSessionId: 'target', runtimeGeneration: 2 });
    expect(await waitFor(message => message.id === 'reused-id' && message.runtimeGeneration === 2)).toMatchObject({
      type: 'compact_result', ownerSessionId: 'target', runtimeGeneration: 2,
    });
  });
}, 15_000);
