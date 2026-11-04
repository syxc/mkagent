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
      if (command.type === 'exit') process.exit(0);
      for (const frame of command.frames ?? []) console.log(JSON.stringify(frame));
      if (command.noReply) return;
      console.log(JSON.stringify(command.type === 'stop_background_task'
        ? { type: 'stop_background_task_result', id: command.id, stopped: true,
            ownerSessionId: command.ownerSessionId, runtimeGeneration: command.runtimeGeneration }
        : command.type === 'legacy'
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

test('retains only known source background events and matching stop replies after a transfer', async () => {
  const { child, connection } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  const scope = { ownerSessionId: 'source', runtimeGeneration: first.generation };
  first.send({ type: 'echo', id: 'source-ready', frames: [
    { ...scope, id: 'launched', type: 'background_task_event', event: { type: 'shell_backgrounded', shellId: 'owned-task' } },
  ] });
  await source.waitFor('source-ready');
  const target = receiver('target');
  const second = connection.bind(target.sink);
  first.release();
  expect(first.send({ type: 'shutdown' })).toBe(false);
  expect(first.send({ type: 'stop_background_task', id: 'unknown-stop', taskId: 'unknown-task' })).toBe(false);
  expect(first.send({ type: 'stop_background_task', id: 'source-stop', taskId: 'owned-task', frames: [
    { ...scope, id: 'stale-foreground', type: 'event', event: { type: 'agent_end' } },
    { ...scope, id: 'unsolicited-stop', type: 'stop_background_task_result', stopped: true },
    { ...scope, id: 'unknown-completion', type: 'background_task_event', event: { type: 'task_completed', taskId: 'unknown-task' } },
    { ...scope, id: 'known-completion', type: 'background_task_event', event: { type: 'task_completed', taskId: 'owned-task' } },
  ], ownerSessionId: 'target', runtimeGeneration: second.generation })).toBe(true);
  second.send({ type: 'echo', id: 'barrier' });
  expect((await target.waitFor('barrier')).pid).toBe(child.pid);
  expect(await source.waitFor('source-stop')).toMatchObject({ stopped: true, ...scope });
  expect(source.messages.map(message => message.id)).toEqual(['launched', 'source-ready', 'known-completion', 'source-stop']);
  expect(target.messages.map(message => message.id)).toEqual(['barrier']);
  expect(first.send({ type: 'stop_background_task', id: 'finished', taskId: 'owned-task' })).toBe(false);
});

test('reports process exit to both the foreground and retained background owners', async () => {
  const { connection } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  first.send({ type: 'echo', id: 'source-ready', frames: [{
    ownerSessionId: 'source', runtimeGeneration: first.generation,
    type: 'background_task_event', event: { type: 'shell_backgrounded', shellId: 'owned-task' },
  }] });
  await source.waitFor('source-ready');
  const target = receiver('target');
  const second = connection.bind(target.sink);
  const sourceExit = new Promise<number | null>(resolve => { source.sink.onExit = resolve; });
  const targetExit = new Promise<number | null>(resolve => { target.sink.onExit = resolve; });
  second.send({ type: 'exit' });
  expect(await Promise.all([sourceExit, targetExit])).toEqual([0, 0]);
  expect(first.send({ type: 'stop_background_task', id: 'dead', taskId: 'owned-task' })).toBe(false);
  expect(second.send({ type: 'echo', id: 'dead' })).toBe(false);
});

test('releases a finished background owner when its pending stop reply is abandoned', async () => {
  const { connection } = fixture();
  const source = receiver('source');
  const first = connection.bind(source.sink);
  const scope = { ownerSessionId: 'source', runtimeGeneration: first.generation };
  first.send({ type: 'echo', id: 'source-ready', frames: [
    { ...scope, type: 'background_task_event', event: { type: 'shell_backgrounded', shellId: 'owned-task' } },
  ] });
  await source.waitFor('source-ready');
  const target = receiver('target');
  const second = connection.bind(target.sink);
  first.send({ type: 'stop_background_task', id: 'abandoned', taskId: 'owned-task', noReply: true, frames: [
    { ...scope, id: 'completed', type: 'background_task_event', event: { type: 'task_completed', taskId: 'owned-task' } },
  ] });
  await source.waitFor('completed');
  first.cancelBackgroundStop('abandoned');
  let sourceExits = 0;
  source.sink.onExit = () => { sourceExits++; };
  second.send({ type: 'echo', id: 'barrier', frames: [
    { ...scope, id: 'abandoned', type: 'stop_background_task_result', stopped: true },
  ] });
  await target.waitFor('barrier');
  expect(source.messages.some(message => message.id === 'abandoned')).toBe(false);
  const targetExit = new Promise<number | null>(resolve => { target.sink.onExit = resolve; });
  second.send({ type: 'exit' });
  expect(await targetExit).toBe(0);
  expect(sourceExits).toBe(0);
});
