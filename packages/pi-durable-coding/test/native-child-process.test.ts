import { expect, test } from 'bun:test';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { spawnProcess, spawnProcessSync, waitForChildProcess } from '../src/compat/child-process.ts';

function fakeChild(stdout = true, stderr = true): ChildProcess {
  return Object.defineProperties(new ChildProcess(), {
    stdout: { value: stdout ? new PassThrough() : null },
    stderr: { value: stderr ? new PassThrough() : null },
  });
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function expectClean(child: ChildProcess): void {
  for (const event of ['exit', 'close', 'error']) expect(child.listenerCount(event)).toBe(0);
  for (const stream of [child.stdout, child.stderr]) {
    expect(stream?.listenerCount('data') ?? 0).toBe(0);
    expect(stream?.listenerCount('end') ?? 0).toBe(0);
  }
}

test.each([0, 7, null])('Native child close retains exit code %s', async code => {
  const child = fakeChild();
  const result = waitForChildProcess(child);
  child.emit('close', code, null);
  expect(await result).toBe(code);
  expect(child.stdout?.destroyed).toBe(true);
  expect(child.stderr?.destroyed).toBe(true);
  expectClean(child);
});

test.each([0, 9, null])('Native child without pipes settles on exit %s', async code => {
  const child = fakeChild(false, false);
  const result = waitForChildProcess(child);
  child.emit('exit', code, code === null ? 'SIGTERM' : null);
  expect(await result).toBe(code);
  expectClean(child);
});

test('Native child waits for both pipes to end after exit', async () => {
  const child = fakeChild();
  let settled = false;
  const result = waitForChildProcess(child).then(code => { settled = true; return code; });
  child.stdout?.emit('end');
  child.emit('exit', 5, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  child.stderr?.emit('end');
  expect(await result).toBe(5);
  expectClean(child);
});

test('Native child releases quiet inherited pipes after the idle grace', async () => {
  const child = fakeChild();
  const start = performance.now();
  const result = waitForChildProcess(child);
  child.emit('exit', 4, null);
  expect(await result).toBe(4);
  expect(performance.now() - start).toBeGreaterThanOrEqual(80);
  expect(child.stdout?.destroyed).toBe(true);
  expect(child.stderr?.destroyed).toBe(true);
  expectClean(child);
});

test('Native child rearms the idle grace on either output pipe', async () => {
  const child = fakeChild();
  let settled = false;
  const result = waitForChildProcess(child).then(code => { settled = true; return code; });
  child.emit('exit', 6, null);
  await delay(60);
  child.stdout?.emit('data', Buffer.from('out'));
  await delay(60);
  child.stderr?.emit('data', Buffer.from('err'));
  expect(settled).toBe(false);
  await delay(60);
  expect(settled).toBe(false);
  expect(await result).toBe(6);
  expectClean(child);
});

test.each([false, true])('Native child rejects the original error, after exit: %s', async exited => {
  const child = fakeChild();
  const error = new Error('fixture spawn failure');
  const result = waitForChildProcess(child);
  const rejection = result.catch(reason => reason);
  if (exited) child.emit('exit', 1, null);
  child.emit('error', error);
  expect(await rejection).toBe(error);
  expect(child.stdout?.destroyed).toBe(false);
  expect(child.stderr?.destroyed).toBe(false);
  expectClean(child);
  child.stdout?.destroy();
  child.stderr?.destroy();
});

test('Native child close uses its own code and cancels the idle wait', async () => {
  const child = fakeChild();
  const result = waitForChildProcess(child);
  child.emit('exit', 1, null);
  child.emit('close', 2, null);
  expect(await result).toBe(2);
  expectClean(child);
});

test('Native child cleanup preserves caller listeners', async () => {
  const child = fakeChild();
  const onData = () => {};
  child.stdout?.on('data', onData);
  const result = waitForChildProcess(child);
  child.emit('close', 0, null);
  expect(await result).toBe(0);
  expect(child.stdout?.listeners('data')).toEqual([onData]);
  expect(child.stdout?.listenerCount('end')).toBe(0);
});

test('Native child waits remain independent across children and on the same child', async () => {
  const first = fakeChild();
  const second = fakeChild(false, false);
  const one = waitForChildProcess(first);
  const repeated = waitForChildProcess(first);
  const two = waitForChildProcess(second);
  second.emit('exit', 12, null);
  expect(await two).toBe(12);
  first.emit('close', 13, null);
  expect(await one).toBe(13);
  expect(await repeated).toBe(13);
  expectClean(first);
  expectClean(second);
});

test('Native spawn captures the last stdout and stderr chunks', async () => {
  const child = spawnProcess(process.execPath, ['-e',
    'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7;'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  expect(await waitForChildProcess(child)).toBe(7);
  expect(stdout).toBe('out');
  expect(stderr).toBe('err');
});

test('Native spawn rejects a missing executable', async () => {
  const child = spawnProcess('/tmp/mkagent-durable-coding-20261104-jGkhZl/missing-child-command', [],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const error = await waitForChildProcess(child).catch(reason => reason);
  expect(error.code).toBe('ENOENT');
});

test('Native synchronous spawn retains its result', () => {
  const result = spawnProcessSync(process.execPath, ['-e', 'process.stdout.write("sync"); process.exitCode = 3;'],
    { encoding: 'utf8' });
  expect(result.status).toBe(3);
  expect(result.stdout).toBe('sync');
  expect(result.error).toBeUndefined();
});

test('Native spawn keeps active descendant output after its parent exits', async () => {
  const descendant = `
    process.stdout.write('first\\n');
    process.send('ready');
    let count = 0;
    const timer = setInterval(() => {
      process.stdout.write('out-' + ++count + '\\n');
      process.stderr.write('err-' + count + '\\n');
      if (count === 4) { clearInterval(timer); process.exit(0); }
    }, 60);
  `;
  const parent = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
      { stdio: ['ignore', 1, 2, 'ipc'] });
    child.on('error', () => process.exit(99));
    child.once('message', () => process.exit(7));
  `;
  const child = spawnProcess(process.execPath, ['-e', parent], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  expect(await waitForChildProcess(child)).toBe(7);
  expect(stdout).toBe('first\nout-1\nout-2\nout-3\nout-4\n');
  expect(stderr).toBe('err-1\nerr-2\nerr-3\nerr-4\n');
});
