import { afterEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PiWorkerConnection, type PiWorkerLease, type PiWorkerSink } from './worker-connection.ts';

const fixtures: Array<{ child: ChildProcess; connection: PiWorkerConnection }> = [];

afterEach(async () => {
  for (const { child, connection } of fixtures.splice(0)) {
    connection.close();
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
  }
});

function deadline<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function mailbox() {
  const messages: Array<Record<string, unknown>> = [];
  const waiters = new Map<string, (message: Record<string, unknown>) => void>();
  return {
    messages,
    accept(line: string) {
      const message = JSON.parse(line);
      messages.push(message);
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    },
    waitFor(id: string) {
      const message = messages.find(message => message.id === id);
      return deadline(message ? Promise.resolve(message) : new Promise<Record<string, unknown>>(resolve => {
        waiters.set(id, resolve);
      }), id);
    },
  };
}

function receiver(ownerSessionId: string) {
  const box = mailbox();
  const exits: Array<{ code: number | null; signal: string | null }> = [];
  const errors: Error[] = [];
  const sink: PiWorkerSink = {
    ownerSessionId,
    onLine: line => box.accept(line),
    onStderr: () => {},
    onError: error => { errors.push(error); },
    onExit: (code, signal) => { exits.push({ code, signal }); },
  };
  return { ...box, sink, exits, errors };
}

function fixture(stubborn = false) {
  const child = spawn(process.execPath, ['--eval', `
    const reader = require('node:readline').createInterface({ input: process.stdin });
    const stubborn = ${stubborn};
    if (stubborn) {
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => console.error('signal:SIGTERM'));
    }
    reader.on('close', () => {
      console.error('stdin:EOF');
      if (!stubborn) process.exit(0);
    });
    reader.on('line', line => {
      const command = JSON.parse(line);
      if (command.type === 'exit') process.exit(0);
      for (const frame of command.frames ?? []) console.log(JSON.stringify(frame));
      if (command.noReply) return;
      console.log(JSON.stringify(command.type === 'stop_background_task'
        ? { type: 'stop_background_task_result', id: command.id, stopped: true,
            ownerSessionId: command.ownerSessionId, runtimeGeneration: command.runtimeGeneration }
        : { type: 'reply', id: command.id, pid: process.pid,
            ownerSessionId: command.ownerSessionId, runtimeGeneration: command.runtimeGeneration }));
    });
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  const raw = mailbox();
  const observer = createInterface({ input: child.stdout! });
  observer.on('line', line => raw.accept(line));
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('close', (code, signal) => { observer.close(); resolve({ code, signal }); });
  });
  const connection = new PiWorkerConnection(child);
  fixtures.push({ child, connection });
  return {
    child, connection, closed, raw,
    stderr: () => stderr,
    inject: (frames: Array<Record<string, unknown>>) => {
      child.stdin!.write(JSON.stringify({ type: 'inject', noReply: true, frames }) + '\n');
    },
  };
}

function scope(lease: PiWorkerLease) {
  return { ownerSessionId: lease.ownerSessionId, runtimeGeneration: lease.generation };
}

function backgrounded(lease: PiWorkerLease, shellId = 'owned-task') {
  return { ...scope(lease), id: 'launched', type: 'background_task_event',
    event: { type: 'shell_backgrounded', shellId } };
}

function completed(lease: PiWorkerLease, taskId = 'owned-task', id = 'completed') {
  return { ...scope(lease), id, type: 'background_task_event', event: { type: 'task_completed', taskId } };
}

test('ends the physical process after its last foreground reference is released', async () => {
  const { connection, closed } = fixture();
  const source = receiver('source');
  const lease = connection.bind(source.sink);
  lease.send({ type: 'echo', id: 'ready' });
  await source.waitFor('ready');
  lease.release();
  lease.release();
  expect(lease.send({ type: 'echo', id: 'released' })).toBe(false);
  expect(await deadline(closed, 'last foreground process exit')).toEqual({ code: 0, signal: null });
  expect(source.exits).toEqual([]);
  expect(() => connection.bind(source.sink)).toThrow('closed');
});

test('pins the transfer gap and disposes the source without killing the adopted foreground', async () => {
  const { connection, child, closed, stderr } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  first.send({ type: 'echo', id: 'ready' });
  await source.waitFor('ready');
  const releaseTransfer = connection.holdTransfer(first);
  first.release();
  await Promise.resolve();
  const target = receiver('target');
  const second = connection.bind(target.sink);
  releaseTransfer();
  releaseTransfer();
  first.release();
  first.cancelBackgroundStop('old-timeout');
  expect(second.send({ type: 'echo', id: 'adopted' })).toBe(true);
  expect((await target.waitFor('adopted')).pid).toBe(child.pid);
  expect(stderr()).not.toContain('stdin:EOF');
  expect(source.exits).toEqual([]);
  expect(target.exits).toEqual([]);
  second.release();
  expect(await deadline(closed, 'adopted foreground release')).toEqual({ code: 0, signal: null });
});

test('keeps the process alive with only transfer pins and releases each pin once', async () => {
  const { connection, child, raw, closed } = fixture();
  const source = receiver('source');
  const lease = connection.bind(source.sink);
  const firstPin = connection.holdTransfer(lease);
  const lastPin = connection.holdTransfer(lease);
  lease.release();
  firstPin();
  firstPin();
  await Promise.resolve();
  child.stdin!.write(JSON.stringify({ type: 'echo', id: 'pin-only' }) + '\n');
  expect((await raw.waitFor('pin-only')).pid).toBe(child.pid);
  expect(source.messages).toEqual([]);
  lastPin();
  lastPin();
  expect(await deadline(closed, 'last transfer pin release')).toEqual({ code: 0, signal: null });
});

test('retains precise source shell completion and stop replies while another owner remains active', async () => {
  const { connection, child, closed } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  first.send({ type: 'echo', id: 'ready', frames: [backgrounded(first)] });
  await source.waitFor('ready');
  const target = receiver('target');
  const second = connection.bind(target.sink);
  first.release();
  first.release();
  expect(first.send({ type: 'shutdown' })).toBe(false);
  expect(first.send({ type: 'stop_background_task', id: 'unknown-stop', taskId: 'unknown-task' })).toBe(false);
  expect(first.send({
    type: 'stop_background_task', id: 'source-stop', taskId: 'owned-task',
    ownerSessionId: 'target', runtimeGeneration: second.generation,
    frames: [
      { ...scope(first), id: 'stale-foreground', type: 'event', event: { type: 'agent_end' } },
      { ...scope(first), id: 'unsolicited-stop', type: 'stop_background_task_result', stopped: true },
      completed(first, 'unknown-task', 'unknown-completion'),
      { ...completed(first), ownerSessionId: 'target' },
      completed(first),
    ],
  })).toBe(true);
  expect(await source.waitFor('source-stop')).toMatchObject({ ...scope(first), stopped: true });
  first.release();
  first.cancelBackgroundStop('source-stop');
  expect(second.send({ type: 'echo', id: 'barrier' })).toBe(true);
  expect((await target.waitFor('barrier')).pid).toBe(child.pid);
  expect(source.messages.map(message => message.id)).toEqual(['launched', 'ready', 'completed', 'source-stop']);
  expect(target.messages.map(message => message.id)).toEqual(['barrier']);
  expect(first.send({ type: 'stop_background_task', id: 'finished', taskId: 'owned-task' })).toBe(false);
  second.release();
  expect(await deadline(closed, 'all owners drained')).toEqual({ code: 0, signal: null });
});

test('keeps a retired shell alive after the last foreground leaves, then exits on completion', async () => {
  const { connection, child, closed } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  first.send({ type: 'echo', id: 'ready', frames: [backgrounded(first)] });
  await source.waitFor('ready');
  const second = connection.bind(receiver('target').sink);
  first.release();
  second.release();
  await Promise.resolve();
  expect(child.exitCode).toBeNull();
  expect(first.send({
    type: 'stop_background_task', id: 'last-stop', taskId: 'owned-task', frames: [completed(first)],
  })).toBe(true);
  await source.waitFor('last-stop');
  expect(await deadline(closed, 'last retired shell and stop reply')).toEqual({ code: 0, signal: null });
});

test('holds a completed shell lease until its pending stop reply arrives', async () => {
  const { connection, closed, inject } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  first.send({ type: 'echo', id: 'ready', frames: [backgrounded(first)] });
  await source.waitFor('ready');
  first.release();
  expect(first.send({
    type: 'stop_background_task', id: 'pending-stop', taskId: 'owned-task',
    noReply: true, frames: [completed(first)],
  })).toBe(true);
  await source.waitFor('completed');
  inject([
    { ...scope(first), id: 'unmatched', type: 'stop_background_task_result', stopped: true },
    { ...scope(first), id: 'pending-stop', type: 'stop_background_task_result', stopped: true },
  ]);
  expect(await source.waitFor('pending-stop')).toMatchObject({ ...scope(first), stopped: true });
  expect(source.messages.some(message => message.id === 'unmatched')).toBe(false);
  expect(await deadline(closed, 'pending stop reply drain')).toEqual({ code: 0, signal: null });
});

test('releases the last pending stop on timeout without releasing a live transfer pin', async () => {
  const { connection, closed, child, raw } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  const releaseTransfer = connection.holdTransfer(first);
  first.send({ type: 'echo', id: 'ready', frames: [backgrounded(first)] });
  await source.waitFor('ready');
  first.release();
  first.send({
    type: 'stop_background_task', id: 'abandoned', taskId: 'owned-task',
    noReply: true, frames: [completed(first)],
  });
  await source.waitFor('completed');
  first.cancelBackgroundStop('abandoned');
  first.cancelBackgroundStop('abandoned');
  await Promise.resolve();
  child.stdin!.write(JSON.stringify({ type: 'echo', id: 'still-pinned' }) + '\n');
  await raw.waitFor('still-pinned');
  releaseTransfer();
  expect(await deadline(closed, 'cancelled stop and pin drain')).toEqual({ code: 0, signal: null });
});

test('closes after the last pending stop is cancelled even without a transfer pin', async () => {
  const { connection, closed } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  first.send({ type: 'echo', id: 'ready', frames: [backgrounded(first)] });
  await source.waitFor('ready');
  first.release();
  first.send({
    type: 'stop_background_task', id: 'abandoned', taskId: 'owned-task',
    noReply: true, frames: [completed(first)],
  });
  await source.waitFor('completed');
  first.cancelBackgroundStop('abandoned');
  first.cancelBackgroundStop('abandoned');
  expect(await deadline(closed, 'cancelled last pending stop')).toEqual({ code: 0, signal: null });
});

test('isolates same-generation retired leases and exits across two physical connections', async () => {
  const older = fixture();
  const newer = fixture();
  const oldSource = receiver('source');
  const newSource = receiver('source');
  const first = older.connection.bind(oldSource.sink);
  const next = newer.connection.bind(newSource.sink);
  expect(first.generation).toBe(next.generation);
  expect(() => newer.connection.holdTransfer(first)).toThrow();
  first.send({ type: 'echo', id: 'old-ready', frames: [backgrounded(first)] });
  next.send({ type: 'echo', id: 'new-ready', frames: [backgrounded(next)] });
  await Promise.all([oldSource.waitFor('old-ready'), newSource.waitFor('new-ready')]);
  const b = receiver('B');
  const c = receiver('C');
  const releaseOldTransfer = older.connection.holdTransfer(first);
  const releaseNewTransfer = newer.connection.holdTransfer(next);
  first.release();
  next.release();
  const second = older.connection.bind(b.sink);
  const third = newer.connection.bind(c.sink);
  releaseOldTransfer();
  releaseNewTransfer();
  second.send({ type: 'exit' });
  expect(await deadline(older.closed, 'old physical connection exit')).toEqual({ code: 0, signal: null });
  expect(oldSource.exits).toEqual([{ code: 0, signal: null }]);
  expect(b.exits).toEqual([{ code: 0, signal: null }]);
  first.release();
  first.cancelBackgroundStop('stale-timeout');
  releaseOldTransfer();
  expect(next.send({
    type: 'stop_background_task', id: 'new-stop', taskId: 'owned-task', frames: [completed(next)],
  })).toBe(true);
  await newSource.waitFor('new-stop');
  expect(third.send({ type: 'echo', id: 'new-barrier' })).toBe(true);
  expect((await c.waitFor('new-barrier')).pid).toBe(newer.child.pid);
  expect(newSource.exits).toEqual([]);
  expect(c.exits).toEqual([]);
  third.release();
  expect(await deadline(newer.closed, 'new physical connection drain')).toEqual({ code: 0, signal: null });
});

test('rejects new binds and pins once final shutdown has started, before child exit', async () => {
  const { connection, child } = fixture(true);
  const source = receiver('source');
  const first = connection.bind(source.sink);
  first.send({ type: 'echo', id: 'ready' });
  await source.waitFor('ready');
  first.release();
  await Promise.resolve();
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(() => connection.bind(receiver('target').sink)).toThrow('closed');
  expect(() => connection.holdTransfer(first)).toThrow();
  expect(first.send({ type: 'echo', id: 'closing' })).toBe(false);
});

test('escalates an unreferenced process from EOF through SIGTERM to SIGKILL', async () => {
  const { connection, closed, stderr } = fixture(true);
  const source = receiver('source');
  const first = connection.bind(source.sink);
  first.send({ type: 'echo', id: 'ready' });
  await source.waitFor('ready');
  first.release();
  expect(await deadline(closed, 'forced process shutdown', 4_500)).toEqual({ code: null, signal: 'SIGKILL' });
  expect(stderr()).toContain('stdin:EOF');
  expect(stderr()).toContain('signal:SIGTERM');
}, 6_000);

test('preserves close as I/O disposal without signalling the physical process', async () => {
  const { connection, child, raw } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  connection.close();
  first.release();
  expect(first.send({ type: 'echo', id: 'closed' })).toBe(false);
  expect(() => connection.bind(source.sink)).toThrow('closed');
  child.stdout!.resume();
  child.stdin!.write(JSON.stringify({ type: 'echo', id: 'detached-process' }) + '\n');
  expect((await raw.waitFor('detached-process')).pid).toBe(child.pid);
  expect(source.messages).toEqual([]);
});
