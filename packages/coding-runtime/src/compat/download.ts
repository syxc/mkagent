import { open, type FileHandle } from 'node:fs/promises';

/** Bun's Node stream bridges wait for a pending Web body read during cancellation. */
export async function writeDownload(body: ReadableStream<Uint8Array>, destination: string, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  let file: FileHandle | undefined;
  try {
    signal.throwIfAborted();
    file = await open(destination, 'w');
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      await file.writeFile(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await file?.close();
  }
}
