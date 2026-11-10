import { parentPort, threadId } from 'node:worker_threads';
import type { ImageResizeOptions, ResizedImage } from '@earendil-works/pi-coding-agent';

parentPort?.postMessage({ unrelated: 'worker startup' });
export async function resizeImageInProcess(bytes: Uint8Array, mimeType: string, options?: ImageResizeOptions): Promise<ResizedImage | null> {
  if (options?.maxWidth === 0) throw new Error('Synthetic worker failure');
  return { data: Buffer.from(bytes).toString('base64'), mimeType, originalWidth: threadId, originalHeight: 1,
    width: options?.maxWidth ?? 1, height: options?.maxHeight ?? 1, wasResized: true };
}
