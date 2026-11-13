import * as photon from '@silvia-odwyer/photon-node';
import type { ImageResizeOptions } from '../../src/compat/image-resize.ts';

export interface ResizeCase {
  name: string;
  input: string;
  mimeType: string;
  options?: ImageResizeOptions;
}

export function createResizeFixtures(): { images: Record<string, Uint8Array>; cases: ResizeCase[] } {
  const pixels = new Uint8Array(23 * 17 * 4);
  let seed = 37;
  for (let index = 0; index < pixels.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[index] = index % 4 === 3 ? 255 : seed >>> 24;
  }
  const image = new photon.PhotonImage(pixels, 23, 17);
  const images: Record<string, Uint8Array> = { invalid: new Uint8Array([0, 1, 2]) };
  let jpeg85Length: number, jpeg40Length: number;
  try {
    images.png = image.get_bytes();
    images.jpeg = image.get_bytes_jpeg(80);
    jpeg85Length = Math.ceil(image.get_bytes_jpeg(85).length / 3) * 4;
    jpeg40Length = Math.ceil(image.get_bytes_jpeg(40).length / 3) * 4;
  } finally {
    image.free();
  }
  const tiff = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  images.oriented = Buffer.concat([images.jpeg.subarray(0, 2), app1, images.jpeg.subarray(2)]);
  const tall = new photon.PhotonImage(new Uint8Array(1 * 8 * 4).fill(255), 1, 8);
  try { images.tall = tall.get_bytes(); } finally { tall.free(); }
  const exact = Math.ceil(images.png.length / 3) * 4;
  return {
    images,
    cases: [
      { name: 'within-png', input: 'png', mimeType: 'image/png' },
      { name: 'within-jpeg', input: 'jpeg', mimeType: 'image/jpeg' },
      { name: 'exact-input-limit', input: 'png', mimeType: 'image/png', options: { maxBytes: exact } },
      { name: 'above-input-limit', input: 'png', mimeType: 'image/png', options: { maxBytes: exact + 1 } },
      { name: 'sequential-dimension-rounding', input: 'png', mimeType: 'image/png', options: { maxWidth: 11, maxHeight: 7 } },
      { name: 'custom-quality', input: 'png', mimeType: 'image/png', options: { maxWidth: 11, jpegQuality: 25 } },
      { name: 'quality-85-fallback', input: 'png', mimeType: 'image/png', options: { maxBytes: jpeg85Length + 1, jpegQuality: 100 } },
      { name: 'quality-40-fallback', input: 'png', mimeType: 'image/png', options: { maxBytes: jpeg40Length + 1, jpegQuality: 100 } },
      { name: 'exact-candidate-limit', input: 'png', mimeType: 'image/png', options: { maxBytes: jpeg40Length, jpegQuality: 40 } },
      { name: 'shrink', input: 'png', mimeType: 'image/png', options: { maxBytes: 1000 } },
      { name: 'cannot-fit', input: 'png', mimeType: 'image/png', options: { maxBytes: 1 } },
      { name: 'zero-width-after-rounding', input: 'tall', mimeType: 'image/png', options: { maxWidth: 1, maxHeight: 1 } },
      { name: 'empty-mime', input: 'png', mimeType: '' },
      { name: 'other-mime', input: 'png', mimeType: 'image/bmp' },
      { name: 'orientation-within', input: 'oriented', mimeType: 'image/jpeg' },
      { name: 'orientation-resized', input: 'oriented', mimeType: 'image/jpeg', options: { maxWidth: 11, maxHeight: 7 } },
      { name: 'invalid-bytes', input: 'invalid', mimeType: 'image/png' },
    ],
  };
}
