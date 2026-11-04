import { afterEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { PiWorkerConnection, type PiWorkerSink } from '../backend/pi/worker-connection.ts';

const children: ChildProcess[] = [];
const connections: PiWorkerConnection[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const stopped = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGTERM');
    await stopped;
  }
});

function fixture() {
  const child = spawn(process.execPath, ['--eval', `
    const reader = require('node:readline').createInterface({ input: process.stdin });
    reader.on('line', line => {
      const command = JSON.parse(line);
      for (const frame of command.frames ?? []) console.log(JSON.stringify(frame));
      console.log(JSON.stringify(command.type === 'legacy'
        ? { type: 'reply', id: command.id, pid: process.pid }
        : { type: 'reply', id: command.id, pid: process.pid,
            ownerSessionId: command.ownerSessionId, runtimeGeneration: command.runtimeGeneration }));
    });
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const connection = new PiWorkerConnection(child);
  connections.push(connection);
  return { child, connection };
}

function receiver(ownerSessionId: string) {
  const messages: Array<Record<string, unknown>> = [];
  const waiters = new Map<string, (value: Record<string, unknown>) => void>();
  const sink: PiWorkerSink = {
    ownerSessionId,
    onLine: line => {
      const message = JSON.parse(line);
      messages.push(message);
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    },
    onStderr: () => {},
    onError: error => { throw error; },
    onExit: () => {},
  };
  return {
    sink, messages,
    waitFor: (id: string) => new Promise<Record<string, unknown>>(resolve => {
      const previous = messages.find(message => message.id === id);
      if (previous) resolve(previous);
      else waiters.set(id, resolve);
    }),
  };
}

test('changes foreground ownership in the same process and rejects stale generations', async () => {
  const { child, connection } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  expect(first.send({ type: 'echo', id: 'first' })).toBe(true);
  expect((await source.waitFor('first')).pid).toBe(child.pid);
  const target = receiver('target');
  const second = connection.bind(target.sink);
  expect(first.send({ type: 'echo', id: 'stale-send' })).toBe(false);
  first.release();
  expect(second.send({
    type: 'echo', id: 'barrier', frames: [
      { id: 'old', ownerSessionId: 'source', runtimeGeneration: first.generation },
      { id: 'wrong-generation', ownerSessionId: 'target', runtimeGeneration: first.generation },
      { id: 'wrong-owner', ownerSessionId: 'source', runtimeGeneration: second.generation },
      { id: 'unscoped' },
    ],
    ownerSessionId: 'spoofed', runtimeGeneration: -1,
  })).toBe(true);
  expect(await target.waitFor('barrier')).toMatchObject({
    pid: child.pid, ownerSessionId: 'target', runtimeGeneration: second.generation,
  });
  expect(source.messages.map(message => message.id)).toEqual(['first']);
  expect(target.messages.map(message => message.id)).toEqual(['barrier']);
});

test('keeps initial unscoped protocol compatibility and releases only the matching binding', async () => {
  const { connection } = fixture();
  const source = receiver('source');
  const lease = connection.bind(source.sink);
  lease.send({ type: 'legacy', id: 'legacy' });
  expect((await source.waitFor('legacy')).id).toBe('legacy');
  lease.release();
  expect(lease.send({ type: 'echo', id: 'released' })).toBe(false);
  const target = receiver('target');
  const next = connection.bind(target.sink);
  next.send({ type: 'echo', id: 'active' });
  expect((await target.waitFor('active')).ownerSessionId).toBe('target');
  connection.close();
  expect(next.send({ type: 'echo', id: 'closed' })).toBe(false);
  expect(() => connection.bind(source.sink)).toThrow('closed');
});
