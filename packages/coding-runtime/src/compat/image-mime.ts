import { open } from 'node:fs/promises';
import { detectSupportedImageMimeType as detectMime } from '@earendil-works/pi-durable/images';

const IMAGE_TYPE_SNIFF_BYTES = 4100;

export function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
  return detectMime(buffer) ?? null;
}

export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
  const fileHandle = await open(filePath, 'r');
  try {
    // Native intentionally sniffs only this prefix, including PNG animation metadata.
    const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
    return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
  } finally {
    await fileHandle.close();
  }
}
