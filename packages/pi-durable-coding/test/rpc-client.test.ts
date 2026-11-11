import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'bun:test';
import { RpcClient as SDKRpcClient, type RpcClientOptions } from '@earendil-works/pi-coding-agent';
import { RpcClient } from '../src/compat/rpc-client.ts';
import { codingHostImport, codingSDKImport } from '../scripts/coding-sdk-imports.ts';

const roots: string[] = [];
test('generation routes the client to host policy and protocol types to the SDK', () => {
  assert.equal(codingHostImport('modes/index.ts', './rpc/rpc-client.ts'), '../../compat/rpc-client.ts');
  assert.equal(codingSDKImport('modes/index.ts', './rpc/rpc-types.ts'), '@earendil-works/pi-coding-agent');
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mkagent-rpc-client-'));
  roots.push(root);
  writeFileSync(join(root, 'rpc fixture.mjs'), String.raw`
    import { writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const args = process.argv.slice(2);
    if (args.includes('--fail-start')) {
      process.stderr.write('fixture startup failure');
      process.exit(17);
    }
    process.on('SIGTERM', () => {
      writeFileSync('stopped', 'yes');
      process.exit(0);
    });
    createInterface({ input: process.stdin }).on('line', line => {
      const command = JSON.parse(line);
      if (args.includes('--exit-on-request')) {
        process.stderr.write('fixture request failure');
        process.exit(23);
      }
      const success = command.type === 'get_state';
      const data = { cwd: process.cwd(), args, marker: process.env.RPC_FIXTURE_MARKER,
        ...(args.includes('--fragment-jsonl') ? { text: 'A\rB C D\n😀' } : {}) };
      const response = JSON.stringify({
        type: 'response', id: command.id, command: command.type, success,
        ...(success ? { data } : { error: 'fixture rejected command' }),
      });
      if (args.includes('--fragment-jsonl')) {
        const bytes = Buffer.from(response + '\r\n');
        const split = bytes.indexOf(Buffer.from('😀')) + 2;
        process.stdout.write(bytes.subarray(0, split));
        setImmediate(() => process.stdout.write(bytes.subarray(split)));
      } else {
        process.stdout.write(response + '\n');
      }
      if (args.includes('--events')) {
        process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n');
        process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
      }
    });
  `);
  return root;
}

test('missing CLI entry fails before starting a cwd launcher', async () => {
  const root = fixture();
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/cli.js'), `require('node:fs').writeFileSync('unexpected-launch', 'yes'); setInterval(() => {}, 1000);`);
  const client = new RpcClient({ cwd: root });
  try {
    await assert.rejects(client.start(), /requires options\.cliPath.*does not include a CLI launcher/);
    assert.equal(existsSync(join(root, 'unexpected-launch')), false);
    await assert.rejects(client.getState(), /Client not started/);
  } finally { await client.stop(); }
});

test('an explicit CLI entry supports JSONL requests, options and shutdown', async () => {
  const root = fixture();
  const client = new RpcClient({
    cliPath: 'rpc fixture.mjs', cwd: root,
    provider: 'fixture-provider', model: 'fixture-model', args: ['--fixture-flag'],
    env: { RPC_FIXTURE_MARKER: 'local-only' },
  });
  try {
    await client.start();
    const state = await client.getState();
    assert.deepEqual(state, {
      cwd: realpathSync(root),
      args: ['--mode', 'rpc', '--provider', 'fixture-provider', '--model', 'fixture-model', '--fixture-flag'],
      marker: 'local-only',
    });
    await assert.rejects(client.getMessages(), /fixture rejected command/);
    await client.stop();
    assert.equal(readFileSync(join(root, 'stopped'), 'utf8'), 'yes');
    await assert.rejects(client.getState(), /Client not started/);
  } finally { await client.stop(); }
});

test('startup failure reports the child exit and stderr', async () => {
  const root = fixture();
  const client = new RpcClient({ cliPath: join(root, 'rpc fixture.mjs'), cwd: root, args: ['--fail-start'] });
  try {
    await assert.rejects(async () => {
      await client.start();
      await client.getState();
    }, /code=17.*fixture startup failure/s);
  } finally { await client.stop(); }
});

test('child exit rejects an outstanding request with its failure', async () => {
  const root = fixture();
  const client = new RpcClient({ cliPath: join(root, 'rpc fixture.mjs'), cwd: root, args: ['--exit-on-request'] });
  try {
    await client.start();
    await assert.rejects(client.getState(), /code=23.*fixture request failure/s);
    await assert.rejects(client.getState(), /code=23.*fixture request failure/s);
  } finally { await client.stop(); }
});

test('SDK keeps its default CLI and the host inherits its client methods', async () => {
  const root = fixture();
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/cli.js'), readFileSync(join(root, 'rpc fixture.mjs')));
  const client = new SDKRpcClient({ cwd: root });
  assert.equal(RpcClient.prototype.start, SDKRpcClient.prototype.start);
  assert.equal(RpcClient.prototype.stop, SDKRpcClient.prototype.stop);
  assert.equal(RpcClient.prototype.getState, SDKRpcClient.prototype.getState);
  try {
    await client.start();
    assert.equal(Reflect.get(await client.getState(), 'cwd'), realpathSync(root));
  } finally { await client.stop(); }
});

test('inherited options stay live and duplicate start precedes CLI validation', async () => {
  const root = fixture();
  let path: string | undefined, reads = 0;
  const options: RpcClientOptions = Object.create({ cwd: root });
  Object.defineProperty(options, 'cliPath', { get: () => { reads++; return path; } });
  const client = new RpcClient(options);
  assert(client instanceof SDKRpcClient);
  try {
    await assert.rejects(client.start(), /requires options\.cliPath/);
    assert.equal(reads, 1);
    path = 'rpc fixture.mjs';
    await client.start();
    assert.equal(reads, 2);
    path = undefined;
    await assert.rejects(client.start(), /Client already started/);
    assert.equal(reads, 2);
    await client.stop();
    path = 'rpc fixture.mjs';
    await client.start();
    assert.equal(reads, 3);
    assert.equal(Reflect.get(await client.getState(), 'cwd'), realpathSync(root));
  } finally { await client.stop(); }
});

test('SDK JSONL preserves Unicode separators, CR and fragmented UTF-8', async () => {
  const root = fixture();
  const client = new RpcClient({ cliPath: 'rpc fixture.mjs', cwd: root, args: ['--fragment-jsonl'] });
  try {
    await client.start();
    const state = await client.getState() as unknown as { text: string };
    assert.equal(state.text, 'A\rB C D\n😀');
  } finally { await client.stop(); }
});

test('SDK dispatches concurrent responses and removes settled event listeners', async () => {
  const root = fixture();
  const client = new RpcClient({ cliPath: 'rpc fixture.mjs', cwd: root, args: ['--events'] });
  try {
    await client.start();
    const events = client.collectEvents(2000), idle = client.waitForIdle(2000);
    let observed = 0;
    const unsubscribe = client.onEvent(() => { observed++; });
    const states = await Promise.all([client.getState(), client.getState()]);
    assert.equal(states.length, 2);
    assert(states.every(state => Reflect.get(state, 'cwd') === realpathSync(root)));
    assert.deepEqual((await events).map(event => event.type), ['agent_start', 'agent_settled']);
    await idle;
    unsubscribe();
    const previous = observed;
    await client.getState();
    assert.equal(observed, previous);
  } finally { await client.stop(); }
});

test('SDK idle and collection timeouts reject when the fixture emits no events', async () => {
  const root = fixture();
  const client = new RpcClient({ cliPath: 'rpc fixture.mjs', cwd: root });
  try {
    await client.start();
    await client.getState();
    await assert.rejects(client.waitForIdle(5), /Timeout waiting/);
    await assert.rejects(client.collectEvents(5), /Timeout collecting/);
  } finally { await client.stop(); }
});
