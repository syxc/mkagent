import { afterEach, describe, expect, test } from 'bun:test';
import type { CodemodeSandboxLease } from '@earendil-works/pi-durable/codemode';
import { CodemodeAdmissionError, leaseNativeCodemodeSandbox } from '../src/compat/codemode-sandbox.ts';

const originalLimit = process.env.PI_CODEMODE_MAX_WORKERS;
const leases = new Set<CodemodeSandboxLease>();
afterEach(async () => {
  for (const lease of leases) await lease.release();
  leases.clear();
  if (originalLimit === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
  else process.env.PI_CODEMODE_MAX_WORKERS = originalLimit;
});

async function acquire(options: Partial<Parameters<typeof leaseNativeCodemodeSandbox>[0]> = {}) {
  const lease = await leaseNativeCodemodeSandbox({ now: Date.now, ...options });
  leases.add(lease);
  return lease;
}

describe('native sandbox lease policy', () => {
  test('the default two reservations admit waiting scripts in FIFO order', async () => {
    delete process.env.PI_CODEMODE_MAX_WORKERS;
    const first = await acquire();
    const second = await acquire();
    const admitted: number[] = [];
    const third = acquire().then(lease => { admitted.push(3); return lease; });
    const fourth = acquire().then(lease => { admitted.push(4); return lease; });
    expect(admitted).toEqual([]);
    await first.release();
    await third;
    expect(admitted).toEqual([3]);
    await second.release();
    await fourth;
    expect(admitted).toEqual([3, 4]);
  });

  test('the real worker runs deterministic code with native asset paths', async () => {
    const lease = await acquire();
    const run = lease.sandbox.start('text("native lease"); return 7;', {
      startedAt: Date.now(), seed: 1, onCall: () => { throw new Error('Unexpected tool'); },
    });
    const result = await run.result;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toBe(7);
    expect(result.output).toContainEqual({ type: 'text', text: 'native lease' });
    await lease.release();
  }, 6000);

  test('deadline and cancellation remove waiting reservations without leaking the slot', async () => {
    process.env.PI_CODEMODE_MAX_WORKERS = '1';
    const first = await acquire();
    await expect(acquire({ deadline: Date.now() + 10, timeoutMs: 10 })).rejects
      .toThrow('Execution timed out after 10 ms while waiting for a free codemode worker');
    const abort = new AbortController();
    const waiting = acquire({ signal: abort.signal });
    const refused = waiting.catch(error => error);
    abort.abort(new Error('lease cancelled'));
    expect(await refused).toBeInstanceOf(CodemodeAdmissionError);
    await first.release();
    const next = await acquire();
    await next.release();
  }, 6000);

  test('release aborts a waiting VM, joins effect cleanup and runs once', async () => {
    let entered!: () => void;
    const ready = new Promise<void>(done => { entered = done; });
    let finish!: () => void;
    const gate = new Promise<void>(done => { finish = done; });
    const events: string[] = [];
    const lease = await acquire({ stop: async () => {
      events.push('stop');
      await gate;
      events.push('joined');
    } });
    const run = lease.sandbox.start('text("partial"); await tools.wait({});', {
      startedAt: Date.now(), seed: 1, tools: [{ name: 'wait' }], onCall: () => entered(),
    });
    await ready;
    const closing = lease.release();
    expect(lease.release()).toBe(closing);
    try {
      expect(await run.result).toMatchObject({ ok: false, error: { kind: 'aborted' } });
      expect(events).toEqual(['stop']);
    } finally {
      finish();
      await closing;
    }
    expect(events).toEqual(['stop', 'joined']);
  }, 6000);

  test('an effect cleanup error propagates once and releases an unused reservation', async () => {
    process.env.PI_CODEMODE_MAX_WORKERS = '1';
    const refused = new Error('effect cleanup refused');
    let stops = 0;
    const lease = await acquire({ stop: () => { stops++; throw refused; } });
    leases.delete(lease);
    const closing = lease.release();
    expect(lease.release()).toBe(closing);
    await expect(closing).rejects.toBe(refused);
    expect(stops).toBe(1);
    const next = await acquire();
    await next.release();
  }, 6000);
});
