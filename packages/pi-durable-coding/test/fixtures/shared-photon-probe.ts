import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as sharedPhoton from '@silvia-odwyer/photon/photon_rs.js';
import { loadPhoton } from '../../src/compat/photon.ts';
import { resizeImageInProcess } from '../../src/compat/image-resize.ts';

const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const originalRead = fs.readFileSync;
const photon = await loadPhoton();
assert.equal(fs.readFileSync, originalRead);
if (process.argv.includes('--expect-missing')) {
  assert.equal(photon, null, 'A bundle must not load WASM from its build machine');
  assert.equal(await loadPhoton(), null);
  console.log(JSON.stringify({ available: false }));
} else {
  assert.ok(photon, 'The installed or bundled shared WASM must load');
  assert.equal(photon.PhotonImage, sharedPhoton.PhotonImage);
  const pixels = new Uint8Array(23 * 17 * 4);
  let seed = 37;
  for (let index = 0; index < pixels.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[index] = index % 4 === 3 ? 255 : seed >>> 24;
  }
  const image = new photon.PhotonImage(pixels, 23, 17);
  try {
    const resized = await resizeImageInProcess(image.get_bytes(), 'image/png', { maxWidth: 11, maxHeight: 7 });
    assert.ok(resized);
    const { data, ...metadata } = resized;
    console.log(JSON.stringify({ ...metadata, dataSha256: createHash('sha256').update(data).digest('hex') }));
  } finally {
    image.free();
  }
}
