import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { exifOrientation } from '@earendil-works/pi-durable/images';
import * as photon from '@silvia-odwyer/photon-node';
import { applyExifOrientation } from '../src/pi/utils/exif-orientation.ts';

const layouts = [
  [1, 2, 3, 4, 5, 6],
  [3, 2, 1, 6, 5, 4],
  [6, 5, 4, 3, 2, 1],
  [4, 5, 6, 1, 2, 3],
  [1, 4, 2, 5, 3, 6],
  [4, 1, 5, 2, 6, 3],
  [6, 3, 5, 2, 4, 1],
  [3, 6, 2, 5, 1, 4],
];

function pixels(order: number[]) {
  return Uint8Array.from(order.flatMap(value => [value, value + 10, value + 20, 255 - value]));
}

function metadata(orientation: number, little: boolean, format: string) {
  const tiff = new Uint8Array(26), view = new DataView(tiff.buffer);
  tiff.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 1, little);
  view.setUint16(10, 0x0112, little);
  view.setUint16(12, 3, little);
  view.setUint32(14, 1, little);
  view.setUint16(18, orientation, little);
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  if (format === 'jpeg') {
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, exif.length + 2]);
    return Buffer.concat([header, exif, Buffer.from([0xff, 0xd9])]);
  }
  const payload = format === 'webp-prefixed' ? exif : tiff;
  const chunk = Buffer.alloc(8);
  chunk.write('EXIF');
  chunk.writeUInt32LE(payload.length, 4);
  const padding = format === 'webp-padded' ? Buffer.from([0x4a, 0x55, 0x4e, 0x4b, 1, 0, 0, 0, 7, 0]) : Buffer.alloc(0);
  const riff = Buffer.from('RIFF\0\0\0\0WEBP');
  riff.writeUInt32LE(4 + padding.length + chunk.length + payload.length, 4);
  return Buffer.concat([riff, padding, chunk, payload]);
}

test.each(layouts.map((layout, index) => ({ orientation: index + 1, layout })))(
  'Native EXIF orientation $orientation preserves pixels, dimensions and object ownership',
  ({ orientation, layout }) => {
    for (const little of [true, false]) {
      for (const format of ['jpeg', 'webp', 'webp-prefixed', 'webp-padded']) {
        const input = new photon.PhotonImage(pixels(layouts[0]), 3, 2);
        let output: photon.PhotonImage | undefined;
        try {
          output = applyExifOrientation(photon, input, metadata(orientation, little, format));
          expect([output.get_width(), output.get_height()]).toEqual(orientation < 5 ? [3, 2] : [2, 3]);
          expect(output.get_raw_pixels()).toEqual(pixels(layout));
          expect(output === input).toBe(orientation < 5);
          if (output !== input) expect(input.get_raw_pixels()).toEqual(pixels(layouts[0]));
        } finally {
          if (output && output !== input) output.free();
          input.free();
        }
      }
    }
  },
);

test('Native EXIF keeps an image unchanged when metadata is missing, truncated or invalid', () => {
  const complete = metadata(6, true, 'jpeg');
  const truncatedWebp = metadata(6, true, 'webp');
  truncatedWebp.writeUInt32LE(truncatedWebp.length, 16);
  const samples = [
    new Uint8Array(), new Uint8Array([0xff]), Buffer.from('not an image'),
    complete.subarray(0, 10), complete.subarray(0, 25), truncatedWebp,
    metadata(0, true, 'jpeg'), metadata(9, false, 'webp'),
  ];
  for (const bytes of samples) {
    const image = new photon.PhotonImage(pixels(layouts[0]), 3, 2);
    try {
      expect(applyExifOrientation(photon, image, bytes)).toBe(image);
      expect(image.get_raw_pixels()).toEqual(pixels(layouts[0]));
    } finally {
      image.free();
    }
  }
});

test('Shared EXIF keeps the durable default and applies Native chunk bounds only on request', () => {
  const bytes = metadata(6, true, 'webp');
  bytes.writeUInt32LE(bytes.length, 16);
  expect(exifOrientation(bytes)).toBe(6);
  expect(exifOrientation(bytes, false)).toBe(6);
  expect(exifOrientation(bytes, true)).toBe(1);
});

test('Canonical durable patch stamps its complete content before cached installs', async () => {
  const path = await realpath(new URL('../../../patches/@earendil-works%252Fpi-durable@1.5.0.patch', import.meta.url));
  if (path.toLowerCase().includes('runtime-credentials')) throw new Error('Unexpected patch alias');
  const content = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
  const newline = content.indexOf('\n');
  const digest = createHash('sha256').update(content.slice(newline + 1)).digest('hex');
  expect(content.slice(0, newline)).toBe(`# Content SHA-256: ${digest}`);
});
