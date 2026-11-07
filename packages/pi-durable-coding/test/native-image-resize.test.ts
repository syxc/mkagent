import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { portSharedHelpers } from '../scripts/shared-helper-port.ts';
import { IMAGE_RESIZE_WORKER_RESPONSE_TYPE, resizeImageInProcess, type ResizedImage } from '../src/pi/utils/image-resize-core.ts';
import { resizeImage } from '../src/pi/utils/image-resize.ts';
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
    const worker = new Worker(new URL('../src/pi/utils/image-resize-worker.ts', import.meta.url));
    try {
      const response = await new Promise<{ type: string; result: ResizedImage | null }>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('message', resolve);
        worker.once('exit', code => reject(new Error(`Worker exited before its reply: ${code}`)));
        worker.postMessage({ inputBytes: images[sample.input], mimeType: sample.mimeType, options: sample.options });
      });
      expect(response.type).toBe(IMAGE_RESIZE_WORKER_RESPONSE_TYPE);
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

test('Native resize generation refuses changed public declarations', async () => {
  async function sourceAt(relative: string) {
    const path = await realpath(new URL(relative, import.meta.url));
    if (path.toLowerCase().includes('runtime-credentials')) throw new Error('Unexpected source alias');
    return readFile(path, 'utf8');
  }
  const source = await sourceAt('../src/compat/image-resize.ts');
  const expected = await sourceAt('../src/pi/utils/image-resize-core.ts');
  expect(portSharedHelpers('utils/image-resize-core.ts', source)).toBe(expected);
  const mutations = [
    source.replace("= 'pi:image-resize-response';", "= 'pi:image-resize-response', extraReply = 1;"),
    source.replace('export async function', 'export default async function'),
    source.replace('maxWidth?: number', 'maxWidth: number'),
    source.replace('export interface ImageResizeOptions', 'export default interface ImageResizeOptions'),
  ];
  for (const changed of mutations) {
    expect(changed).not.toBe(source);
    expect(() => portSharedHelpers('utils/image-resize-core.ts', changed)).toThrow('Native image resize boundary changed');
  }
});

test('Native MIME generation refuses changed signatures or the file read limit', async () => {
  async function sourceAt(relative: string) {
    const path = await realpath(new URL(relative, import.meta.url));
    if (path.toLowerCase().includes('runtime-credentials')) throw new Error('Unexpected source alias');
    return readFile(path, 'utf8');
  }
  const source = await sourceAt('../src/compat/image-mime.ts');
  const expected = await sourceAt('../src/pi/utils/mime.ts');
  expect(portSharedHelpers('utils/mime.ts', source)).toBe(expected);
  for (const changed of [
    source.replace('= 4100;', '= 4096;'),
    source.replace('export function', 'export default function'),
    source.replace('buffer: Uint8Array', 'buffer: ArrayBuffer'),
  ]) {
    expect(changed).not.toBe(source);
    expect(() => portSharedHelpers('utils/mime.ts', changed)).toThrow('Native image MIME boundary changed');
  }
});
