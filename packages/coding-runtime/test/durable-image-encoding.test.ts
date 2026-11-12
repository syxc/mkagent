import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createPhotonImages, encodePhotonImageWithin } from '@earendil-works/pi-durable/images';
import snapshot from './fixtures/durable-image-resize.json';
import { createResizeFixtures } from './fixtures/native-image-resize.ts';

const wasmPath = await realpath(new URL(import.meta.resolve('@silvia-odwyer/photon/photon_rs_bg.wasm')));
if (wasmPath.toLowerCase().includes('runtime-credentials')) throw new Error('Unexpected Photon alias');
const processor = createPhotonImages(new Uint8Array(await readFile(wasmPath)));
const { images, cases } = createResizeFixtures();

function summarize(result: Awaited<ReturnType<typeof processor.prepare>>) {
  if (!result) return null;
  const { data, ...metadata } = result;
  return { ...metadata, dataSha256: createHash('sha256').update(data).digest('hex') };
}

test.each(cases)('Durable default image factory matches original behavior: $name', async sample => {
  const limits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, ...sample.options };
  const result = await processor.prepare(images[sample.input], sample.mimeType, limits);
  const expected = snapshot.results.find(row => row.name === sample.name);
  if (!expected) throw new Error('Missing original durable result');
  expect(summarize(result)).toEqual(expected.expected);
});

function codec(pngLength: number, jpegLength: number) {
  let freed = 0;
  const qualities: number[] = [];
  return {
    image: {
      get_width: () => 2, get_height: () => 1,
      get_bytes: () => new Uint8Array(pngLength),
      get_bytes_jpeg: (quality: number) => { qualities.push(quality); return new Uint8Array(jpegLength); },
      free: () => { freed++; },
    },
    qualities,
    freed: () => freed,
  };
}

test('Shared encoder keeps the durable inclusive limit and lazy PNG preference', () => {
  const source = codec(4, 1);
  const result = encodePhotonImageWithin(source.image, { width: 2, height: 1 }, 8,
    () => { throw new Error('An unchanged durable image must not be rescaled'); });
  expect(result?.mimeType).toBe('image/png');
  expect(result?.data.length).toBe(8);
  expect(source.qualities).toEqual([]);
  expect(source.freed()).toBe(0);
});

test('Shared encoder retains Native eager quality order, strict limit and source ownership', () => {
  const source = codec(4, 1);
  const result = encodePhotonImageWithin(source.image, { width: 2, height: 1 }, 8,
    () => source.image, { native: { jpegQuality: 80 } });
  expect(result?.mimeType).toBe('image/jpeg');
  expect(source.qualities).toEqual([80, 85, 70, 55, 40]);
  expect(source.freed()).toBe(0);
});

test('Shared encoder keeps Native PNG preference when encoded lengths are equal', () => {
  const source = codec(1, 2);
  const result = encodePhotonImageWithin(source.image, { width: 2, height: 1 }, 5,
    () => source.image, { native: { jpegQuality: 85 } });
  expect(result?.mimeType).toBe('image/png');
  expect(source.qualities).toEqual([85, 70, 55, 40]);
});

test('Shared encoder frees a temporary image when Native eager encoding fails', () => {
  const source = codec(1, 1), temporary = codec(1, 1);
  temporary.image.get_bytes_jpeg = () => { throw new Error('codec failed'); };
  expect(() => encodePhotonImageWithin(source.image, { width: 1, height: 1 }, 100,
    () => temporary.image, { native: { jpegQuality: 80 } })).toThrow('codec failed');
  expect(temporary.freed()).toBe(1);
  expect(source.freed()).toBe(0);
});
