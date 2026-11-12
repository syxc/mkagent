import { expect, test } from 'bun:test';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { waitForChildProcess } from '@earendil-works/pi-durable/env/node';

test('durable child wait keeps exit signals in its public result', async () => {
  const child = Object.defineProperties(new ChildProcess(), {
    stdout: { value: null }, stderr: { value: null },
  });
  const result = waitForChildProcess(child, () => false);
  child.emit('exit', null, 'SIGTERM');
  expect(await result).toEqual({ code: null, signal: 'SIGTERM' });
  expect(child.listenerCount('close')).toBe(0);
});

test('durable child wait keeps output spill draining beyond the idle grace', async () => {
  const child = Object.defineProperties(new ChildProcess(), {
    stdout: { value: new PassThrough() }, stderr: { value: new PassThrough() },
  });
  let draining = true, settled = false, checks = 0;
  const result = waitForChildProcess(child, () => { checks++; return draining; })
    .then(value => { settled = true; return value; });
  child.emit('exit', 8, null);
  await new Promise<void>(resolve => setTimeout(resolve, 140));
  expect(settled).toBe(false);
  expect(checks).toBeGreaterThanOrEqual(1);
  draining = false;
  expect(await result).toEqual({ code: 8, signal: null });
  expect(checks).toBeGreaterThanOrEqual(2);
  expect(child.stdout?.destroyed).toBe(true);
  expect(child.stderr?.destroyed).toBe(true);
  expect(child.listenerCount('exit')).toBe(0);
});

test('durable child wait rejects its original error without destroying pipes', async () => {
  const child = Object.defineProperties(new ChildProcess(), {
    stdout: { value: new PassThrough() }, stderr: { value: null },
  });
  const error = new Error('fixture child error');
  const result = waitForChildProcess(child, () => false).catch(reason => reason);
  child.emit('error', error);
  expect(await result).toBe(error);
  expect(child.stdout?.destroyed).toBe(false);
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.stdout?.listenerCount('data')).toBe(0);
  child.stdout?.destroy();
});
