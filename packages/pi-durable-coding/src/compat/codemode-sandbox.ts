import { CodemodeSandbox, getQuickJSWasmPath, loadQuickJSWasm } from '@earendil-works/pi-durable/codemode/node';
import type { CodemodeSandboxLease } from '@earendil-works/pi-durable/codemode';
import { getCodemodeWorkerSpecifier } from '../native-config.ts';

const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const WORKER_WAIT_MS = 60_000;
let activeWorkers = 0;
const waiters: Array<() => void> = [];

function maxWorkers(): number {
  const value = Number(process.env.PI_CODEMODE_MAX_WORKERS);
  return Number.isInteger(value) && value > 0 ? value : 2;
}

function admit(): void {
  while (waiters.length > 0 && activeWorkers < maxWorkers()) {
    activeWorkers++;
    waiters.shift()?.();
  }
}

function releaseWorker(): void {
  activeWorkers--;
  admit();
}

function reserve(signal: AbortSignal | undefined, timeoutMs: number): Promise<'reserved' | 'aborted' | 'timeout'> {
  if (signal?.aborted) return Promise.resolve('aborted');
  return new Promise(resolve => {
    const settle = (result: 'reserved' | 'aborted' | 'timeout') => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const index = waiters.indexOf(grant);
      if (index >= 0) waiters.splice(index, 1);
      resolve(result);
    };
    const grant = () => settle('reserved');
    const onAbort = () => settle('aborted');
    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    waiters.push(grant);
    signal?.addEventListener('abort', onAbort, { once: true });
    admit();
  });
}

/** Admission has no VM result; the native entry point retains its existing pre-start error display. */
export class CodemodeAdmissionError extends Error {}

/** Native worker policy over durable's per-attempt lease. Effects stop before the lease settles. */
export async function leaseNativeCodemodeSandbox(options: {
  signal?: AbortSignal;
  deadline?: number;
  timeoutMs?: number;
  now(): number;
  stop?(): void | Promise<void>;
}): Promise<CodemodeSandboxLease> {
  const remaining = options.deadline === undefined ? Infinity : options.deadline - options.now();
  const admission = await reserve(options.signal, Math.min(remaining, WORKER_WAIT_MS));
  if (admission !== 'reserved') {
    const reason = options.signal?.reason;
    throw new CodemodeAdmissionError(admission === 'aborted'
      ? `Script aborted: ${reason instanceof Error ? reason.message : 'Execution aborted'}`
      : remaining <= WORKER_WAIT_MS
        ? `Script timed out: Execution timed out after ${options.timeoutMs ?? remaining} ms while waiting for a free codemode worker`
        : `No codemode worker became free within ${WORKER_WAIT_MS / 1000} seconds. All ${maxWorkers()} workers, shared by every session in this process, are held by other scripts. Retry after they finish.`);
  }

  let reserved = true;
  let sandbox: CodemodeSandbox | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    try {
      // Stop effects even if close fails, and close the VM even if effect cleanup fails.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => options.stop?.()),
        Promise.resolve().then(() => sandbox?.close()),
      ]);
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Codemode cleanup failed');
    } finally {
      if (reserved) {
        reserved = false;
        releaseWorker();
      }
    }
  })();
  try {
    sandbox = new CodemodeSandbox({
      memoryLimitBytes: MEMORY_LIMIT_BYTES,
      wasm: loadQuickJSWasm(getQuickJSWasmPath()),
      workerUrl: getCodemodeWorkerSpecifier(),
      acquireWorker: () => {
        if (!reserved) throw new Error('The script already settled');
        reserved = false;
        return releaseWorker;
      },
    });
    return { sandbox, release: close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Codemode startup and cleanup failed');
    }
    throw error;
  }
}
