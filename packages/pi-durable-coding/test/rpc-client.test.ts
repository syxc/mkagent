import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'bun:test';
import { RpcClient } from '../src/pi/modes/rpc/rpc-client.ts';

const roots: string[] = [];
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
      process.stdout.write(JSON.stringify({
        type: 'response', id: command.id, command: command.type, success,
        ...(success ? { data: { cwd: process.cwd(), args, marker: process.env.RPC_FIXTURE_MARKER } }
          : { error: 'fixture rejected command' }),
      }) + '\n');
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
