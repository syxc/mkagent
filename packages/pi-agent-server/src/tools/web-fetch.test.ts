import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createWebFetchTool } from './web-fetch.ts';

const publicUrl = 'https://8.8.8.8/start';
const directories: string[] = [];
let fetchMock: ReturnType<typeof spyOn>;
afterEach(() => {
  fetchMock?.mockRestore();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(url = publicUrl, signal?: AbortSignal, sessionPath: () => string | null = () => null) {
  return createWebFetchTool(sessionPath).execute({ url }, {} as never, { ...BACKGROUND_CONTEXT, abortSignal: signal });
}

describe('web_fetch request boundaries', () => {
  for (const destination of ['http://127.0.0.1/private', 'file:///etc/passwd']) {
    it(`refuses a redirect to ${new URL(destination).protocol} before requesting it`, async () => {
      fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 302, headers: { location: destination } }));
      const output = await run();
      expect(output.isError).toBe(true);
      expect(JSON.stringify(output)).toContain('Blocked:');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
    });
  }

  it('follows relative and absolute public redirects and reports the final URL', async () => {
    const requested: string[] = [];
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async url => {
      requested.push(String(url));
      return requested.length === 1
        ? new Response('', { status: 301, headers: { location: '/next' } })
        : requested.length === 2
          ? new Response('', { status: 307, headers: { location: 'https://1.1.1.1/final' } })
          : new Response('fixture result', { headers: { 'content-type': 'text/plain' } });
    });
    const output = await run();
    expect(output.isError).toBeUndefined();
    expect(requested).toEqual([publicUrl, 'https://8.8.8.8/next', 'https://1.1.1.1/final']);
    expect(JSON.stringify(output)).toContain('https://1.1.1.1/final');
    expect(JSON.stringify(output)).toContain('fixture result');
  });

  it('bounds redirect chains and refuses loops', async () => {
    let requests = 0;
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', {
      status: 302, headers: { location: `/hop-${++requests}` },
    }));
    expect(JSON.stringify(await run())).toContain('redirect limit');
    expect(requests).toBeLessThanOrEqual(6);
    fetchMock.mockImplementation(async () => new Response('', { status: 302, headers: { location: '/start' } }));
    expect(JSON.stringify(await run())).toContain('redirect loop');
  });

  it('does not request an already cancelled tool', async () => {
    const controller = new AbortController();
    controller.abort(new Error('fixture cancelled'));
    fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unexpected'));
    await expect(run(publicUrl, controller.signal)).rejects.toThrow('fixture cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates cancellation to a pending fetch', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      const signal = options!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started.resolve();
    }));
    const pending = run(publicUrl, controller.signal);
    await started.promise;
    controller.abort(new Error('fixture cancelled'));
    await expect(pending).rejects.toThrow('fixture cancelled');
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('enforces the download limit and closes the oversized stream', async () => {
    let cancelled = false;
    fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      pull(stream) { stream.enqueue(new Uint8Array(50 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 })));
    const output = await run();
    expect(output.isError).toBe(true);
    expect(JSON.stringify(output)).toContain('50MB limit');
    expect(cancelled).toBe(true);
  });

  it('cancels a pending body read and prevents a successful result', async () => {
    const controller = new AbortController();
    const reading = Promise.withResolvers<void>();
    let cancelled = false;
    const stream = new ReadableStream({
      pull() { reading.resolve(); return new Promise<void>(() => {}); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));
    const pending = run(publicUrl, controller.signal);
    await reading.promise;
    controller.abort(new Error('fixture cancelled'));
    await expect(pending).rejects.toThrow('fixture cancelled');
    expect(cancelled).toBe(true);
  });

  it('checks cancellation at the file save boundary and still saves a live download', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mkagent-fetch-'));
    directories.push(directory);
    const controller = new AbortController();
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('binary fixture', {
      headers: { 'content-type': 'image/png' },
    }));
    await expect(run(publicUrl, controller.signal, () => {
      controller.abort(new Error('fixture cancelled'));
      return directory;
    })).rejects.toThrow('fixture cancelled');
    expect(readdirSync(directory)).toEqual([]);
    expect((await run(publicUrl, undefined, () => directory)).isError).toBeUndefined();
    expect(readdirSync(join(directory, 'long_responses'))).toHaveLength(1);
  });
});
