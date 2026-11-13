import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImageConverters } from '@earendil-works/pi-coding-agent';
import { setCapabilities, setImageTranscoder } from '@earendil-works/pi-tui';
import { loadPhoton } from '../src/compat/photon.ts';
import { applyExifOrientation } from '../src/compat/image-orientation.ts';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('SDK PNG passthrough does not load an image runtime', async () => {
  const images = createImageConverters({ loadPhoton: async () => { throw new Error('unexpected load'); } });
  assert.deepEqual(await images.convertToPng('original PNG bytes', 'image/png'), {
    data: 'original PNG bytes', mimeType: 'image/png',
  });
});

test('SDK image instances keep unavailable and failed loaders separate', async () => {
  let unavailable = 0;
  const empty = createImageConverters({ loadPhoton: async () => { unavailable++; return null; } });
  assert.equal(await empty.convertImageBytesToPng(new Uint8Array([1])), null);
  assert.equal(await empty.convertToPng('AA==', 'image/gif'), null);
  assert.equal(await empty.loadPngTranscoder(), undefined);
  assert.equal(unavailable, 3);
  const error = new Error('host image runtime failed');
  const failed = createImageConverters({ loadPhoton: async () => { throw error; } });
  await assert.rejects(failed.convertImageBytesToPng(new Uint8Array([1])), value => value === error);
  await assert.rejects(failed.loadPngTranscoder(), value => value === error);
});

test('SDK encoders retain the host orientation result and release both image owners', async () => {
  const freed: string[] = [];
  const raw = { free() { freed.push('raw'); } };
  const upright = {
    get_bytes() { return new Uint8Array([137, 80, 78, 71]); },
    free() { freed.push('upright'); },
  };
  const input = new Uint8Array([0, 3, 4, 0]).subarray(1, 3);
  const photon = { PhotonImage: { new_from_byteslice(bytes: Uint8Array) {
    assert.deepEqual(bytes, input);
    return raw;
  } } };
  const images = createImageConverters({
    loadPhoton: async () => photon as any,
    applyExifOrientation(runtime, image, bytes) {
      assert.equal(runtime, photon);
      assert.equal(image, raw);
      assert.deepEqual(bytes, input);
      return upright as any;
    },
  });
  assert.deepEqual(await images.convertImageBytesToPng(input), new Uint8Array([137, 80, 78, 71]));
  assert.deepEqual(freed, ['raw', 'upright']);
  freed.length = 0;
  upright.get_bytes = () => { throw new Error('encode failed'); };
  assert.equal(await images.convertImageBytesToPng(input), null);
  assert.deepEqual(freed, ['raw', 'upright']);
});

test('SDK encoders release the decoded image when orientation fails', async () => {
  let decoded = 0, freed = 0;
  const images = createImageConverters({
    loadPhoton: async () => ({ PhotonImage: { new_from_byteslice() {
      decoded++;
      return { free() { freed++; } };
    } } }) as any,
    applyExifOrientation() { throw new Error('orientation failed'); },
  });
  assert.equal(await images.convertImageBytesToPng(new Uint8Array([1])), null);
  assert.equal(decoded, 1);
  assert.equal(freed, 1);
  const transcode = await images.loadPngTranscoder();
  assert.ok(transcode);
  assert.equal(transcode('AQ=='), null);
  assert.equal(decoded, 2);
  assert.equal(freed, 2);
});

test('SDK registration coalesces per instance and skips later callbacks', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
  setImageTranscoder(undefined);
  const photon = await loadPhoton();
  assert.ok(photon);
  const ready = Promise.withResolvers<typeof photon>();
  let loads = 0;
  const images = createImageConverters({ loadPhoton: () => { loads++; return ready.promise; }, applyExifOrientation });
  const callbacks: number[] = [];
  images.ensurePngTranscoder(() => callbacks.push(1));
  images.ensurePngTranscoder(() => callbacks.push(2));
  assert.equal(loads, 1);
  assert.deepEqual(callbacks, []);
  ready.resolve(photon);
  await turn();
  assert.deepEqual(callbacks, [1, 2]);
  images.ensurePngTranscoder(() => callbacks.push(3));
  await turn();
  assert.equal(loads, 1);
  assert.deepEqual(callbacks, [1, 2]);
  let otherLoads = 0;
  const other = createImageConverters({ loadPhoton: async () => { otherLoads++; return photon; }, applyExifOrientation });
  other.ensurePngTranscoder(() => callbacks.push(4));
  await turn();
  assert.equal(otherLoads, 1);
  assert.deepEqual(callbacks, [1, 2, 4]);
});

test('SDK registration does not load on non-Kitty terminals or notify without a transcoder', async () => {
  let loads = 0;
  let notified = false;
  const images = createImageConverters({ loadPhoton: async () => { loads++; return null; } });
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  images.ensurePngTranscoder(() => { notified = true; });
  await turn();
  assert.equal(loads, 0);
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
  images.ensurePngTranscoder(() => { notified = true; });
  images.ensurePngTranscoder(() => { notified = true; });
  await turn();
  assert.equal(loads, 1);
  assert.equal(notified, false);
  images.ensurePngTranscoder(() => { notified = true; });
  await turn();
  assert.equal(loads, 1);
  assert.equal(notified, false);
});
