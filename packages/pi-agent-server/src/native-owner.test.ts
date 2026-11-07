import { expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { NativeOwnerExchange, type NativeOwnerWork } from './native-owner.ts';
import type { PiWorkerScope } from '../../shared/src/agent/backend/pi/protocol.ts';
import type {
  PiNativeOwnerActivation, PiNativeOwnerEvent, PiNativeOwnerRequest,
} from '../../shared/src/agent/backend/pi/native-owner-protocol.ts';

const source = { ownerSessionId: 'source', runtimeGeneration: 1 };
const target = { ownerSessionId: 'target', runtimeGeneration: 2 };
const request: PiNativeOwnerRequest = {
  inputId: 'product-input', sourceNativeSessionId: 'native-source', operation: { type: 'new' },
};
const activation: PiNativeOwnerActivation = {
  config: {
    agentProfile: 'coding', apiKey: '', model: 'local', thinkingLevel: 'off',
    cwd: '/tmp/owner-fixture', workspaceRootPath: '/tmp/owner-fixture', sessionId: 'target',
    sessionPath: '/tmp/owner-fixture/target', workingDirectory: '/tmp/owner-fixture',
    plansFolderPath: '/tmp/owner-fixture/target/plans',
  },
  tools: [], systemPrompt: 'Target prompt', reason: 'new',
};

function fixture(overrides: Partial<NativeOwnerWork> = {}) {
  const events: PiNativeOwnerEvent[] = [];
  const waiting = new Map<PiNativeOwnerEvent['type'], ReturnType<typeof Promise.withResolvers<PiNativeOwnerEvent>>>();
  const scopes = new AsyncLocalStorage<PiWorkerScope>();
  const calls: string[] = [];
  const exchange = new NativeOwnerExchange({
    send(event) { events.push(event); waiting.get(event.type)?.resolve(event); },
    withTargetScope(scope, work) { return scopes.run(scope, work); },
  });
  const work: NativeOwnerWork = {
    async closeSource() { expect(scopes.getStore()).toEqual(source); calls.push('close'); },
    async bindTarget() { expect(scopes.getStore()).toEqual(target); calls.push('bind'); return { nativeSessionId: 'native-target' }; },
    async runTarget() { expect(scopes.getStore()).toEqual(target); calls.push('callbacks'); },
    ...overrides,
  };
  const running = scopes.run(source, () => exchange.replace(source, request, work));
  void running.catch(() => {});
  const transactionId = events[0]!.transactionId;
  return {
    exchange, calls, events, running, transactionId, scopes,
    next(type: PiNativeOwnerEvent['type']): Promise<PiNativeOwnerEvent> {
      const previous = events.find(event => event.type === type);
      if (previous) return Promise.resolve(previous);
      const pending = Promise.withResolvers<PiNativeOwnerEvent>();
      waiting.set(type, pending);
      return pending.promise;
    },
    prepare() { return exchange.receive({ type: 'owner_prepared', transactionId, targetSessionId: 'target' }, source); },
    activate(scope = target, value = activation) {
      return exchange.receive({ type: 'owner_activate', transactionId, activation: value }, scope);
    },
    commit(scope = target) { return exchange.receive({ type: 'owner_committed', transactionId }, scope); },
  };
}

test('original coroutine closes the source and waits for durable commit before target callbacks', async () => {
  const f = fixture();
  expect(f.events[0]).toEqual({ type: 'owner_prepare', transactionId: f.transactionId, ...request, ...source });
  expect(f.calls).toEqual([]);
  expect(f.prepare()).toBe(true);
  await f.next('owner_source_closed');
  expect(f.calls).toEqual(['close']);
  expect(f.activate()).toBe(true);
  await f.next('owner_target_bound');
  expect(f.calls).toEqual(['close', 'bind']);
  expect(f.commit()).toBe(true);
  expect(f.commit()).toBe(true);
  await f.running;
  expect(f.calls).toEqual(['close', 'bind', 'callbacks']);
  expect(f.events.map(event => event.type)).toEqual([
    'owner_prepare', 'owner_source_closed', 'owner_target_bound', 'owner_finished',
  ]);
  expect(f.events.at(-1)).toMatchObject({ ...target, outcome: 'complete' });
  expect(f.commit()).toBe(false);
});

test('foreign transactions, wrong scopes, stale generations and wrong target configurations cannot activate', async () => {
  const f = fixture();
  expect(f.exchange.receive({ type: 'owner_prepared', transactionId: 'foreign', targetSessionId: 'target' }, source)).toBe(false);
  expect(f.exchange.receive({ type: 'owner_prepared', transactionId: f.transactionId, targetSessionId: 'target' }, target)).toBe(false);
  expect(f.activate()).toBe(false);
  expect(f.commit()).toBe(false);
  expect(f.calls).toEqual([]);
  f.prepare();
  await f.next('owner_source_closed');
  expect(f.activate({ ...target, runtimeGeneration: 1 })).toBe(false);
  expect(f.activate(target, { ...activation, config: { ...activation.config, sessionId: 'other' } })).toBe(false);
  expect(f.calls).toEqual(['close']);
  f.activate();
  await f.next('owner_target_bound');
  expect(f.commit(source)).toBe(false);
  expect(f.exchange.receive({ type: 'owner_abort', transactionId: f.transactionId, error: 'old source' }, source)).toBe(false);
  f.commit();
  await f.running;
  expect(f.calls).toEqual(['close', 'bind', 'callbacks']);
});

test('an aborted preparation never closes the source or starts callbacks', async () => {
  const f = fixture();
  expect(f.exchange.receive({ type: 'owner_abort', transactionId: f.transactionId, error: 'Stopped' }, source)).toBe(true);
  await expect(f.running).rejects.toThrow('Stopped');
  expect(f.calls).toEqual([]);
  expect(f.events.at(-1)).toMatchObject({ type: 'owner_failed', ...source, phase: 'preparing', sourceClosed: false });
});

test('abort during source teardown records the completed close without activating a target', async () => {
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const f = fixture({ async closeSource() { entered.resolve(); await closed.promise; } });
  f.prepare();
  await entered.promise;
  f.exchange.cancel('Stopped while closing');
  closed.resolve();
  await expect(f.running).rejects.toThrow('Stopped while closing');
  expect(f.events.at(-1)).toMatchObject({ type: 'owner_failed', phase: 'prepared', sourceClosed: true, ...source });
  expect(f.events.some(event => event.type === 'owner_target_bound')).toBe(false);
});

test('an uncommitted target abort cannot run callbacks or roll a new request into the old coroutine', async () => {
  const f = fixture();
  await expect(f.exchange.replace(source, request, {
    async closeSource() {}, async bindTarget() { return { nativeSessionId: 'unexpected' }; }, async runTarget() {},
  })).rejects.toThrow('already in progress');
  f.prepare();
  await f.next('owner_source_closed');
  f.activate();
  await f.next('owner_target_bound');
  expect(f.exchange.receive({ type: 'owner_abort', transactionId: f.transactionId, error: 'Commit failed' }, target)).toBe(true);
  await expect(f.running).rejects.toThrow('Commit failed');
  expect(f.calls).toEqual(['close', 'bind']);
  expect(f.events.at(-1)).toMatchObject({ type: 'owner_failed', phase: 'target_bound', sourceClosed: true, ...target });
});

test('callback failures after commit finish on the target and never report source rollback', async () => {
  const f = fixture({ async runTarget() { throw new Error('Plugin failed'); } });
  f.prepare();
  await f.next('owner_source_closed');
  f.activate();
  await f.next('owner_target_bound');
  f.commit();
  await expect(f.running).rejects.toThrow('Plugin failed');
  expect(f.events.at(-1)).toMatchObject({ type: 'owner_finished', outcome: 'error', error: 'Plugin failed', ...target });
  expect(f.events.some(event => event.type === 'owner_failed')).toBe(false);
});
