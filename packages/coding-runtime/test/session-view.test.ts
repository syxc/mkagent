import { describe, expect, test } from 'bun:test';
import { CodingSessionView, type CodingEntry } from '../src/session-view.ts';

function setup() {
  const entries: CodingEntry[] = [];
  const store = {
    id: crypto.randomUUID(), cwd: '/isolated', sessionPath: '/isolated/session',
    read: async () => entries.slice(),
    append: async (batch: CodingEntry[]) => { entries.push(...batch); },
  };
  return { entries, store, session: new CodingSessionView(store) };
}

describe('native session projection commit barriers', () => {
  test('rejects invalid data before changing the branch and detaches mutable plugin data', async () => {
    const { session, entries } = setup();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => session.appendEntry('invalid', cyclic)).toThrow();
    const data = { count: 1 };
    session.appendEntry('valid', data);
    data.count = 99;
    await session.flush();
    expect(entries).toHaveLength(1);
    expect(entries[0].parentId).toBe(null);
    expect(entries[0].data).toEqual({ count: 1 });
  });

  test('retains failed writes, exposes the failure, and allows an explicit retry', async () => {
    const { session, store, entries } = setup();
    const append = store.append;
    store.append = async () => { throw new Error('disk full'); };
    session.setSessionName('test\nsession');
    await expect(session.flush()).rejects.toThrow('disk full');
    store.append = append;
    await session.flush();
    expect(entries).toHaveLength(1);
    expect(session.getSessionName()).toBe('test session');
    const resumed = new CodingSessionView(store);
    await resumed.refresh();
    expect(resumed.getSessionName()).toBe('test session');
  });

  test('serializes refresh with flush and keeps synchronous writes during reads', async () => {
    const { session, store, entries } = setup();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    store.read = async () => {
      const snapshot = entries.slice();
      started.resolve();
      await finish.promise;
      return snapshot;
    };
    const refresh = session.refresh();
    await started.promise;
    session.appendEntry('during-read', { value: true });
    const flush = session.flush();
    finish.resolve();
    await Promise.all([refresh, flush]);
    expect(entries).toHaveLength(1);
    expect(session.view.getEntries()).toEqual(entries);
  });

  test('reattaches writes during a read to the newly persisted leaf', async () => {
    const { session, store, entries } = setup();
    session.appendEntry('first', {});
    await session.flush();
    const first = entries[0];
    const next = { ...first, id: 'persisted-next', parentId: first.id, customType: 'next' };
    entries.push(next);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    store.read = async () => {
      started.resolve();
      await finish.promise;
      return entries.slice();
    };
    const refresh = session.refresh();
    await started.promise;
    session.appendEntry('during-read', {});
    finish.resolve();
    await refresh;
    await session.flush();
    expect(entries[2].parentId).toBe(next.id);
    expect(session.view.getBranch().map((entry: CodingEntry) => entry.id)).toEqual(entries.map(entry => entry.id));
  });
});
