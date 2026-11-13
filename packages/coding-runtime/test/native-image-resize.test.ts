import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { resizeImageInProcess, type ResizedImage } from '../src/compat/image-resize.ts';
import { resizeImage } from '../src/native-image-process.ts';
import snapshot from './fixtures/native-image-resize.json';
import { createResizeFixtures } from './fixtures/native-image-resize.ts';

const { images, cases } = createResizeFixtures();
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function summarize(result: ResizedImage | null) {
  if (!result) return null;
  const { data, ...metadata } = result;
  return { ...metadata, dataSha256: digest(data) };
}

test.each(cases)('Native resize matches pinned original behavior: $name', async sample => {
  const expected = snapshot.results.find(row => row.name === sample.name);
  if (!expected) throw new Error('Missing original resize result');
  const bytes = images[sample.input];
  expect(digest(bytes)).toBe(expected.inputSha256);
  const result = await resizeImageInProcess(bytes, sample.mimeType, sample.options);
  expect(summarize(result)).toEqual(expected.expected);
  if (result && sample.options?.maxBytes !== undefined) expect(result.data.length).toBeLessThan(sample.options.maxBytes);
});

test.each(['sequential-dimension-rounding', 'orientation-resized'])(
  'Native worker runs its actual module for $name',
  async name => {
    const sample = cases.find(row => row.name === name);
    if (!sample) throw new Error('Missing resize fixture');
    const expected = snapshot.results.find(row => row.name === name);
    if (!expected) throw new Error('Missing original worker result');
    const worker = new Worker(new URL('./utils/image-resize-worker.js', import.meta.resolve('@earendil-works/pi-coding-agent')), {
      workerData: { imageResizeModule: new URL('../src/compat/image-resize.ts', import.meta.url).href },
    });
    try {
      const response = await new Promise<{ type: string; result: ResizedImage | null }>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('message', resolve);
        worker.once('exit', code => reject(new Error(`Worker exited before its reply: ${code}`)));
        worker.postMessage({ inputBytes: images[sample.input], mimeType: sample.mimeType, options: sample.options });
      });
      expect(response.type).toBe('pi:image-resize-response');
      expect(summarize(response.result)).toEqual(expected.expected);
    } finally {
      await worker.terminate();
    }
  },
  5000,
);

test('Native resize public entry preserves the caller bytes', async () => {
  const sample = cases.find(row => row.name === 'sequential-dimension-rounding');
  if (!sample) throw new Error('Missing resize fixture');
  const bytes = new Uint8Array(images[sample.input]), before = new Uint8Array(bytes);
  const result = await resizeImage(bytes, sample.mimeType, sample.options);
  const expected = snapshot.results.find(row => row.name === sample.name);
  if (!expected) throw new Error('Missing original entry result');
  expect(summarize(result)).toEqual(expected.expected);
  expect(bytes).toEqual(before);
}, 5000);
