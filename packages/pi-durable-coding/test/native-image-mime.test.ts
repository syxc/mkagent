import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSupportedImageMimeType as detectDurableMime } from '@earendil-works/pi-durable/images';
import { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile } from '../src/compat/image-mime.ts';

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
function chunk(type: string, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  return result;
}
const ihdr = chunk('IHDR', Buffer.alloc(13));
const png = (...chunks: Buffer[]) => Buffer.concat([signature, ihdr, ...chunks]);
function bmp(dib: number, bits: number) {
  const result = Buffer.alloc(14 + dib + 4);
  result.write('BM', 0, 'ascii');
  result.writeUInt32LE(result.length, 2);
  result.writeUInt32LE(14 + dib, 10);
  result.writeUInt32LE(dib, 14);
  result.writeUInt16LE(1, dib === 12 ? 22 : 26);
  result.writeUInt16LE(bits, dib === 12 ? 24 : 28);
  return result;
}
const headers: [string, Uint8Array, string | null][] = [
  ['empty', new Uint8Array(), null],
  ['text', Buffer.from('a text file'), null],
  ['jpeg', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  ['jpeg-ls', Buffer.from([0xff, 0xd8, 0xff, 0xf7]), null],
  ['incomplete-jpeg', Buffer.from([0xff, 0xd8]), null],
  ['gif-87', Buffer.from('GIF87a'), 'image/gif'],
  ['gif-89', Buffer.from('GIF89a'), 'image/gif'],
  ['wrong-gif', Buffer.from('GIF88a'), null],
  ['webp', Buffer.from('RIFF0000WEBP'), 'image/webp'],
  ['incomplete-webp', Buffer.from('RIFF0000WEB'), null],
  ['png', png(chunk('IDAT')), 'image/png'],
  ['apng', png(chunk('acTL'), chunk('IDAT')), null],
  ['acTL-after-IDAT', png(chunk('IDAT'), chunk('acTL')), 'image/png'],
  ['png-without-IDAT', png(), 'image/png'],
  ['bmp-core', bmp(12, 24), 'image/bmp'],
  ['bmp-info', bmp(40, 24), 'image/bmp'],
  ['bmp-v5', bmp(124, 32), 'image/bmp'],
];

test.each(headers)('Native MIME retains the original header result: %s', (_name, bytes, expected) => {
  const before = new Uint8Array(bytes);
  expect(detectSupportedImageMimeType(bytes)).toBe(expected);
  expect(detectDurableMime(bytes)).toBe(expected ?? undefined);
  expect(bytes).toEqual(before);
  const padded = new Uint8Array(bytes.length + 9);
  padded.set(bytes, 4);
  expect(detectSupportedImageMimeType(padded.subarray(4, 4 + bytes.length))).toBe(expected);
});

test('Native MIME retains incomplete PNG header boundaries', () => {
  const bytes = png();
  for (let length = 0; length <= bytes.length; length++) {
    expect(detectSupportedImageMimeType(bytes.subarray(0, length))).toBe(length >= 16 ? 'image/png' : null);
  }
  const incorrectSize = png();
  incorrectSize.writeUInt32BE(12, 8);
  expect(detectSupportedImageMimeType(incorrectSize)).toBeNull();
});

test('Native MIME retains BMP depth, plane and size checks', () => {
  for (const dib of [12, 40, 124]) {
    for (const bits of [1, 4, 8, 16, 24, 32]) {
      expect(detectSupportedImageMimeType(bmp(dib, bits))).toBe('image/bmp');
    }
  }
  for (const bits of [0, 2, 15, 48]) expect(detectSupportedImageMimeType(bmp(40, bits))).toBeNull();
  const planes = bmp(40, 24);
  planes.writeUInt16LE(2, 26);
  expect(detectSupportedImageMimeType(planes)).toBeNull();
  const size = bmp(40, 24);
  size.writeUInt32LE(25, 2);
  expect(detectSupportedImageMimeType(size)).toBeNull();
  size.writeUInt32LE(0, 2);
  expect(detectSupportedImageMimeType(size)).toBe('image/bmp');
  size.writeUInt32LE(13, 10);
  expect(detectSupportedImageMimeType(size)).toBeNull();
  for (const dib of [11, 13, 39, 125]) {
    const bytes = bmp(40, 24);
    bytes.writeUInt32LE(dib, 14);
    expect(detectSupportedImageMimeType(bytes)).toBeNull();
  }
});

test('Native MIME file entry retains the exact 4100-byte APNG boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-mime-'));
  const file = join(directory, 'header.bin');
  try {
    for (const [payload, expected] of [[4047, null], [4048, 'image/png']] as const) {
      const bytes = png(chunk('tEXt', Buffer.alloc(payload)), chunk('acTL'), chunk('IDAT'));
      expect(detectSupportedImageMimeType(bytes)).toBeNull();
      await writeFile(file, bytes);
      expect(await detectSupportedImageMimeTypeFromFile(file)).toBe(expected);
    }
    await writeFile(file, Buffer.from('not an image'));
    expect(await detectSupportedImageMimeTypeFromFile(file)).toBeNull();
    await unlink(file);
    await expect(detectSupportedImageMimeTypeFromFile(file)).rejects.toThrow('ENOENT');
  } finally {
    await unlink(file).catch(() => undefined);
    await rmdir(directory);
  }
});
