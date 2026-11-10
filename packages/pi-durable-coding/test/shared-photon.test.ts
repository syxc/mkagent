import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PhotonImage as OracleImage } from '@silvia-odwyer/photon-node';
import * as sharedPhoton from '@silvia-odwyer/photon/photon_rs.js';
import { loadPhoton } from '../src/pi/utils/photon.ts';
import { convertImageBytesToPng, convertToPng, loadPngTranscoder } from '../src/native-image-convert.ts';

test('Native shares durable Photon without replacing global file reads', async () => {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const readFileSync = fs.readFileSync;
  const modules = await Promise.all(Array.from({ length: 8 }, () => loadPhoton()));
  assert.ok(modules[0]);
  assert.ok(modules.every(module => module === modules[0]));
  const durable = createRequire(import.meta.resolve('@earendil-works/pi-durable/images'));
  assert.equal(
    realpathSync(durable.resolve('@silvia-odwyer/photon/photon_rs.js')),
    realpathSync(fileURLToPath(import.meta.resolve('@silvia-odwyer/photon/photon_rs.js'))),
  );
  assert.deepEqual({
    sharedImageClass: modules[0].PhotonImage === sharedPhoton.PhotonImage,
    unchangedFileReader: fs.readFileSync === readFileSync,
  }, { sharedImageClass: true, unchangedFileReader: true });
});

test('Native PNG entry points retain original Photon Node output', async () => {
  const pixels = Uint8Array.from({ length: 7 * 5 * 4 }, (_, index) => (index * 73 + 17) % 256);
  const image = new OracleImage(pixels, 7, 5);
  try {
    const inputs = [
      ['image/png', image.get_bytes()],
      ['image/jpeg', image.get_bytes_jpeg(70)],
      ['image/webp', image.get_bytes_webp()],
      ['image/gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')],
    ] as const;
    const transcode = await loadPngTranscoder();
    assert.ok(transcode);
    for (const [mime, input] of inputs) {
      const decoded = OracleImage.new_from_byteslice(input);
      let expected: Uint8Array;
      try {
        expected = decoded.get_bytes();
      } finally {
        decoded.free();
      }
      const base64 = Buffer.from(input).toString('base64');
      const png = Buffer.from(expected).toString('base64');
      assert.deepEqual(await convertImageBytesToPng(input), expected, mime);
      assert.deepEqual(await convertToPng(base64, mime), { data: mime === 'image/png' ? base64 : png, mimeType: 'image/png' }, mime);
      assert.equal(transcode(base64, mime), png, mime);
    }
  } finally {
    image.free();
  }
});
