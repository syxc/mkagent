import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createImageProcessor, createImageResizer, formatDimensionNote, type ResizedImage } from '@earendil-works/pi-coding-agent';

const resized: ResizedImage = { data: 'encoded', mimeType: 'image/jpeg', originalWidth: 20, originalHeight: 10, width: 10, height: 5, wasResized: true };

test('SDK processing normalizes supported MIME types without loading a converter', async () => {
  const process = createImageProcessor({
    convertImageBytesToPng: async () => { throw new Error('Unexpected conversion'); },
    resizeImage: async () => { throw new Error('Unexpected resizing'); },
  });
  const bytes = new Uint8Array([1, 2, 3]);
  for (const [mime, expected] of [[' IMAGE/JPG ; encoding=test', 'image/jpeg'], ['image/png', 'image/png'], ['image/gif', 'image/gif'], ['image/webp', 'image/webp']]) {
    assert.deepEqual(await process(bytes, mime, { autoResizeImages: false }), { ok: true, data: 'AQID', mimeType: expected, hints: [] });
  }
});

test('SDK processing passes converted bytes and options to the instance resizer and formats hints', async () => {
  const original = new Uint8Array([1]), converted = new Uint8Array([2]);
  const options = { maxWidth: 10 };
  const process = createImageProcessor({
    convertImageBytesToPng: async bytes => { assert.equal(bytes, original); return converted; },
    resizeImage: async (bytes, mime, actual) => {
      assert.equal(bytes, converted); assert.equal(mime, 'image/png'); assert.equal(actual, options);
      return resized;
    },
  });
  assert.deepEqual(await process(original, ' IMAGE/BMP ; v=1', { resizeOptions: options }), {
    ok: true, data: 'encoded', mimeType: 'image/jpeg',
    hints: ['[Image converted from image/bmp to image/jpeg.]', formatDimensionNote(resized)],
  });
  assert.deepEqual(await process(original, 'image/bmp', { autoResizeImages: false }), {
    ok: true, data: 'Ag==', mimeType: 'image/png', hints: ['[Image converted from image/bmp to image/png.]'],
  });
});

test('SDK processing preserves omission and rejection behavior independently per instance', async () => {
  const bytes = new Uint8Array();
  const absent = createImageProcessor({ convertImageBytesToPng: async () => null, resizeImage: async () => null });
  assert.deepEqual(await absent(bytes, 'image/bmp'), { ok: false, message: '[Image omitted: could not be converted to a supported inline image format.]' });
  assert.deepEqual(await absent(bytes, 'image/png'), { ok: false, message: '[Image omitted: could not be resized below the inline image size limit.]' });
  const failure = new Error('Synthetic conversion failure');
  const failed = createImageProcessor({ convertImageBytesToPng: async () => { throw failure; } });
  await assert.rejects(failed(bytes, 'image/bmp'), error => error === failure);
  assert.equal((await absent(bytes, 'image/png')).ok, false);
});

test('SDK worker uses only the supplied module, ignores unrelated messages and preserves caller bytes', async () => {
  const resize = createImageResizer({
    resizeModule: new URL('./fixtures/image-resize-worker-policy.ts', import.meta.url),
    resizeImageInProcess: async () => { throw new Error('Unexpected fallback'); },
  });
  const bytes = new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4);
  const before = new Uint8Array(bytes);
  const result = await resize(bytes, 'image/test', { maxWidth: 7, maxHeight: 9 });
  assert.ok(result && result.originalWidth > 0);
  assert.deepEqual({ ...result, originalWidth: 1 }, { ...resized, data: 'AQID', mimeType: 'image/test', originalWidth: 1, originalHeight: 1, width: 7, height: 9 });
  assert.deepEqual(bytes, before);
});

test('SDK worker errors and unavailable host modules use the instance fallback', async () => {
  const calls: unknown[][] = [];
  for (const [module, options] of [
    [new URL('./fixtures/image-resize-worker-policy.ts', import.meta.url), { maxWidth: 0 }],
    [new URL('./fixtures/missing-image-policy.ts', import.meta.url), { maxWidth: 7 }],
  ] as const) {
    const resize = createImageResizer({ resizeModule: module, resizeImageInProcess: async (...args) => { calls.push(args); return resized; } });
    const bytes = new Uint8Array([9]);
    assert.equal(await resize(bytes, 'image/png', options), resized);
    assert.deepEqual(calls.at(-1), [bytes, 'image/png', options]);
  }
  assert.equal(calls.length, 2);
});

test('SDK worker retains invalid request errors', async () => {
  const worker = new Worker(new URL('./utils/image-resize-worker.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
  try {
    const reply = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    worker.postMessage({ inputBytes: 'invalid', mimeType: 'image/png' });
    assert.deepEqual(await reply, { type: 'pi:image-resize-response', error: 'Invalid image resize worker request' });
  } finally {
    await worker.terminate();
  }
});
