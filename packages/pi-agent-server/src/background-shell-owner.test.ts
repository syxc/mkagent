import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@mkagent/core/types';
import type { PiWorkerScope } from '../../shared/src/agent/backend/pi/protocol.ts';
import { BackgroundShells } from './background-shell.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

function fixture(owner: PiWorkerScope) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-background-owner-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const events: Array<{ event: AgentEvent; owner?: PiWorkerScope }> = [];
  const registry = new BackgroundShells((event, scope) => events.push({ event, owner: scope }));
  cleanup.push(() => registry.dispose());
  let began!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>(resolve => { began = resolve; });
  registry.start({ directory, owner, toolUseId: 'local-call', command: 'controlled fixture',
    execute: signal => new Promise(resolve => {
      began(signal);
      const done = () => resolve({ content: [{ type: 'text', text: 'fixture stopped' }] });
      if (signal.aborted) done();
      else signal.addEventListener('abort', done, { once: true });
    }),
  });
  const launch = events[0]!.event;
  if (launch.type !== 'shell_backgrounded') throw new Error('Missing launch');
  return { registry, events, taskId: launch.shellId, started };
}

test('captures task ownership at launch for both launch and completion events', async () => {
  const owner = { ownerSessionId: 'source', runtimeGeneration: 1 };
  const expected = { ...owner };
  const { registry, events, taskId, started } = fixture(owner);
  await started;
  owner.ownerSessionId = 'target';
  owner.runtimeGeneration = 2;
  expect(await registry.stop(taskId, expected)).toBe(true);
  expect(events.map(item => item.owner)).toEqual([expected, expected]);
  expect(events.at(-1)?.event).toMatchObject({ type: 'task_completed', status: 'stopped' });
});

test('requires the exact owning session and generation to stop a background task', async () => {
  const owner = { ownerSessionId: 'source', runtimeGeneration: 1 };
  const { registry, taskId, started } = fixture(owner);
  const signal = await started;
  expect(await registry.stop(taskId, { ...owner, runtimeGeneration: 2 })).toBe(false);
  expect(await registry.stop(taskId, { ...owner, ownerSessionId: 'target' })).toBe(false);
  expect(await registry.stop(taskId)).toBe(false);
  expect(signal.aborted).toBe(false);
  expect(await registry.stop(taskId, owner)).toBe(true);
  expect(signal.aborted).toBe(true);
  expect(await registry.stop(taskId, owner)).toBe(false);
});

test('disposing another owner keeps the source background task running', async () => {
  const owner = { ownerSessionId: 'source', runtimeGeneration: 1 };
  const { registry, started } = fixture(owner);
  const signal = await started;
  await registry.dispose({ ownerSessionId: 'target', runtimeGeneration: 2 });
  expect(signal.aborted).toBe(false);
  await registry.dispose(owner);
  expect(signal.aborted).toBe(true);
});
