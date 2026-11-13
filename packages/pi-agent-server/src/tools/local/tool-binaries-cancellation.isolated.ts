/** Resolver spies are process-local: the normal suite must keep the real tool resolvers. */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import * as binaries from './tool-binaries.ts';
import type { FdManagerDeps, FdStatus } from './tool-binaries.ts';
import { createSearchTools } from '../search.ts';

type Tool = 'fd' | 'rg';
type Stage = 'version' | 'download' | 'body';
let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'mkagent-binary-cancel-')); });
afterEach(() => {
  mock.restore();
  rmSync(scratch, { recursive: true, force: true });
});

function ensure(tool: Tool, deps: FdManagerDeps, signal?: AbortSignal, statuses: FdStatus[] = []) {
  const status = (value: FdStatus) => statuses.push(value);
  return tool === 'fd' ? binaries.ensureFd(status, deps, signal) : binaries.ensureRipgrep(status, deps, undefined, signal);
}

function outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ kind: 'value' as const, value }), error => ({ kind: 'error' as const, error }));
}

async function promptly<T>(promise: Promise<T>): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<'pending'>(resolve => { timer = setTimeout(() => resolve('pending'), 500); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real temporary files, fake HTTP and fake extraction; the held body intentionally ignores fetch's signal. */
function fixture(tool: Tool, stage: Stage) {
  const controller = new AbortController();
  const release = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const requests: string[] = [];
  const repo = tool === 'fd' ? 'sharkdp/fd' : 'BurntSushi/ripgrep';
  let heldSignal: AbortSignal | undefined;
  let cancelled = false;
  let extractions = 0;
  let listeners: { add: ReturnType<typeof spyOn>; remove: ReturnType<typeof spyOn> } | undefined;
  const deps: FdManagerDeps = {
    binDir: join(scratch, 'bin'), platform: 'linux', arch: 'x64', offline: false,
    findOnPath: () => undefined,
    fetch: (async (input, init) => {
      const url = String(input);
      requests.push(url);
      const version = url.endsWith('/latest');
      const response = () => version
        ? new Response(null, { status: 302, headers: { location: `https://github.com/${repo}/releases/tag/v1.2.3` } })
        : new Response('fake archive');
      if ((stage === 'version' && version) || (stage === 'download' && !version)) {
        heldSignal = init?.signal ?? undefined;
        const aborted = () => rejectRequest(heldSignal!.reason);
        let rejectRequest: (error: unknown) => void = () => {};
        try {
          return await new Promise<Response>((resolve, reject) => {
            rejectRequest = reject;
            heldSignal?.addEventListener('abort', aborted, { once: true });
            release.promise.then(() => resolve(response()));
            reached.resolve();
            if (heldSignal?.aborted) aborted();
          });
        } finally {
          heldSignal?.removeEventListener('abort', aborted);
        }
      }
      if (stage === 'body' && !version) {
        heldSignal = init?.signal ?? undefined;
        if (heldSignal) listeners = { add: spyOn(AbortSignal.prototype, 'addEventListener'), remove: spyOn(AbortSignal.prototype, 'removeEventListener') };
        let pulled = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(stream) {
            if (!pulled) {
              pulled = true;
              stream.enqueue(new TextEncoder().encode('partial archive'));
              return;
            }
            reached.resolve();
            return release.promise.then(() => {
              if (!cancelled) {
                stream.enqueue(new TextEncoder().encode(' remaining archive'));
                stream.close();
              }
            });
          },
          cancel() { cancelled = true; },
        }));
      }
      return response();
    }) as typeof fetch,
    runCommand: (_command, args) => {
      extractions++;
      const dir = args[args.indexOf('-C') + 1]!;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, tool), 'fake executable');
      return { status: 0 };
    },
  };
  return { deps, controller, release, reached, requests, signal: () => heldSignal,
    cancelled: () => cancelled, extractions: () => extractions, listeners: () => listeners };
}

function cleanBin(deps: FdManagerDeps) {
  return existsSync(deps.binDir) ? readdirSync(deps.binDir) : [];
}

for (const tool of ['fd', 'rg'] as const) {
  describe(`${tool} binary cancellation`, () => {
    it('keeps resolver signals separate for concurrent calls to one registration', async () => {
      const gates = [Promise.withResolvers<string | undefined>(), Promise.withResolvers<string | undefined>()];
      const signals: Array<AbortSignal | undefined> = [];
      const resolve = (signal?: AbortSignal) => {
        const gate = gates[signals.length]!;
        signals.push(signal);
        return gate.promise;
      };
      if (tool === 'fd') spyOn(binaries, 'resolveFd').mockImplementation((_status, signal) => resolve(signal));
      else spyOn(binaries, 'resolveRipgrep').mockImplementation(signal => resolve(signal));
      const registration = createSearchTools(scratch).find(registration => registration.name === (tool === 'fd' ? 'find' : 'grep'))!;
      const controllers = [new AbortController(), new AbortController()];
      const pending = controllers.map(controller => outcome(registration.execute({ pattern: 'fixture' }, {} as never,
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT))));
      expect(signals).toEqual(controllers.map(controller => controller.signal));
      controllers[0]!.abort();
      gates[0]!.resolve(undefined);
      expect(await pending[0]!).toMatchObject({ kind: 'error' });
      expect(signals[1]!.aborted).toBe(false);
      gates[1]!.resolve(undefined);
      expect(await pending[1]!).toMatchObject({ kind: 'error', error: { message: expect.stringContaining('not available') } });
    });

    for (const stage of ['version', 'download'] as const) {
      it(`aborts the manager's ${stage} fetch without retries or unavailable fallback`, async () => {
        const f = fixture(tool, stage);
        const statuses: FdStatus[] = [];
        const reason = new Error('fixture caller aborted');
        const pending = outcome(ensure(tool, f.deps, f.controller.signal, statuses));
        await f.reached.promise;
        f.controller.abort(reason);
        let early: Awaited<ReturnType<typeof promptly>>;
        try { early = await promptly(pending); }
        finally { f.release.resolve(); await pending; }
        expect(f.signal()?.aborted).toBe(true);
        expect(early).toEqual({ kind: 'error', error: reason });
        expect(f.requests).toHaveLength(stage === 'version' ? 1 : 2);
        expect(f.extractions()).toBe(0);
        expect(cleanBin(f.deps)).toEqual([]);
        expect(statuses.filter(status => status.type === 'warning')).toEqual([]);
      });
    }

    for (const stage of ['version', 'download', 'body'] as const) {
      it(`ends the ${tool === 'fd' ? 'find' : 'grep'} tool during ${stage} and cannot publish after its gate opens`, async () => {
        const f = fixture(tool, stage);
        let resolving: Promise<string | undefined> | undefined;
        if (tool === 'fd') spyOn(binaries, 'resolveFd').mockImplementation((_status, signal) => (resolving = ensure(tool, f.deps, signal)));
        else spyOn(binaries, 'resolveRipgrep').mockImplementation(signal => (resolving = ensure(tool, f.deps, signal)));
        const context = withAbortSignal(f.controller.signal, BACKGROUND_CONTEXT);
        const registration = createSearchTools(scratch).find(registration => registration.name === (tool === 'fd' ? 'find' : 'grep'))!;
        const pending = outcome(registration.execute({ pattern: 'fixture' }, {} as never, context));
        await f.reached.promise;
        f.controller.abort(new Error('fixture caller aborted'));
        let early: unknown;
        let resolution: unknown;
        let cleanBeforeRelease: string[] = [];
        let bodyCancelled = false;
        try {
          early = await promptly(pending);
          // find may return before its resolver finishes; prove the resolver itself also settles and cleans up.
          resolution = await promptly(outcome(resolving!));
          cleanBeforeRelease = cleanBin(f.deps);
          bodyCancelled = f.cancelled();
        } finally {
          f.release.resolve();
          await outcome(resolving!);
          await pending;
        }
        expect(f.signal()?.aborted).toBe(true);
        expect(early).toMatchObject({ kind: 'error' });
        expect(resolution).toMatchObject({ kind: 'error' });
        expect(cleanBeforeRelease).toEqual([]);
        expect(f.extractions()).toBe(0);
        expect(cleanBin(f.deps)).toEqual([]);
        if (stage === 'body') {
          expect(bodyCancelled).toBe(true);
          const listeners = f.listeners()!;
          const added = listeners.add.mock.calls.find((call: unknown[]) => call[0] === 'abort');
          expect(added).toBeDefined();
          expect(listeners.remove.mock.calls.some((call: unknown[]) => call[0] === 'abort' && call[1] === added![1])).toBe(true);
        }
      });
    }

    it('keeps the total download deadline active while reading a streaming body', async () => {
      const deadline = new AbortController();
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 120_000 ? deadline.signal : timeout(ms));
      const f = fixture(tool, 'body');
      const statuses: FdStatus[] = [];
      const pending = outcome(ensure(tool, f.deps, f.controller.signal, statuses));
      await f.reached.promise;
      deadline.abort(new DOMException('fixture download deadline', 'TimeoutError'));
      let early: unknown;
      try { early = await promptly(pending); }
      finally { f.release.resolve(); await pending; }
      expect(f.controller.signal.aborted).toBe(false);
      expect(early).toEqual({ kind: 'value', value: undefined });
      expect(f.cancelled()).toBe(true);
      expect(f.requests).toHaveLength(2);
      expect(f.extractions()).toBe(0);
      expect(cleanBin(f.deps)).toEqual([]);
      expect(statuses.at(-1)?.message).toContain('fixture download deadline');
    });

    it('does not publish when cancellation occurs inside archive extraction', async () => {
      const f = fixture(tool, 'body');
      f.release.resolve();
      const extract = f.deps.runCommand;
      const reason = new Error('fixture aborted during extraction');
      f.deps.runCommand = (...args) => {
        const result = extract(...args);
        f.controller.abort(reason);
        return result;
      };
      const pending = outcome(ensure(tool, f.deps, f.controller.signal));
      expect(await pending).toEqual({ kind: 'error', error: reason });
      expect(f.extractions()).toBe(1);
      expect(cleanBin(f.deps)).toEqual([]);
    });

    it('does not continue after cancellation while discarding the version response body', async () => {
      const f = fixture(tool, 'version');
      const reason = new Error('fixture aborted during version body disposal');
      f.deps.fetch = (async input => {
        const url = String(input);
        f.requests.push(url);
        return url.endsWith('/latest') ? new Response(new ReadableStream({
          cancel() { f.controller.abort(reason); },
        }), { status: 302, headers: { location: 'https://github.com/fixture/releases/tag/v1.2.3' } }) : new Response('fake archive');
      }) as typeof fetch;
      expect(await outcome(ensure(tool, f.deps, f.controller.signal))).toEqual({ kind: 'error', error: reason });
      expect(f.extractions()).toBe(0);
      expect(f.requests).toHaveLength(1);
      expect(cleanBin(f.deps)).toEqual([]);
    });

    it('installs a fake archive for an uncancelled caller', async () => {
      const f = fixture(tool, 'body');
      f.release.resolve();
      const statuses: FdStatus[] = [];
      expect(await ensure(tool, f.deps, f.controller.signal, statuses)).toBe(join(f.deps.binDir, tool));
      expect(f.requests).toHaveLength(2);
      expect(f.extractions()).toBe(1);
      expect(cleanBin(f.deps)).toEqual([tool]);
      expect(statuses.at(-1)?.message).toContain('installed to');
      expect(f.controller.signal.aborted).toBe(false);
    });

    it('rejects an already cancelled caller without touching local lookup or the network', async () => {
      const f = fixture(tool, 'version');
      const reason = new Error('fixture cancelled before resolution');
      f.controller.abort(reason);
      f.release.resolve();
      const lookup = spyOn(f.deps, 'findOnPath');
      expect(await outcome(ensure(tool, f.deps, f.controller.signal))).toEqual({ kind: 'error', error: reason });
      expect(lookup).not.toHaveBeenCalled();
      expect(f.requests).toEqual([]);
    });
  });
}
