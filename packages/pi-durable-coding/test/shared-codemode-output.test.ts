import { expect, test } from 'bun:test';
import {
  formatCodemodeResult, type CodemodeFormatOptions,
} from '@earendil-works/pi-durable/codemode';
import type { CodemodeResult } from '@earendil-works/pi-codemode/portable';

const result = (output: CodemodeResult['output'] = [], value?: unknown): CodemodeResult => ({
  ok: true, output, value, calls: [], storeWrites: { set: {}, delete: [] },
});
const options = (extra: Partial<CodemodeFormatOptions> = {}): CodemodeFormatOptions => ({
  generatedImages: 0, wallMs: 1500, maxOutputTokens: 10_000, calls: [], limits: false,
  write: async () => ({ error: 'no writer configured' }), ...extra,
});
const text = (content: readonly { type: string; text?: string }[]) =>
  content.flatMap(item => item.type === 'text' ? [item.text ?? ''] : []).join('\n');

test('shared formatting keeps text markers, console placement and returned JSON', async () => {
  const formatted = await formatCodemodeResult(result([
    { type: 'text', text: 'first' },
    { type: 'text', text: 'log', console: true },
    { type: 'text', text: 'second' },
  ], { done: true }), options());
  expect(formatted.content).toEqual([
    { type: 'text', text: 'Script completed\nWall time 1.5 seconds\nOutput:\n' },
    { type: 'text', text: '==> text 1/3 <==\nfirst\n==> text 2/3 <==\nsecond\n==> text 3/3 <==\n{"done":true}\n<console_output>\nlog\n</console_output>' },
  ]);
});

test('native token policy preserves high budgets and many lines', async () => {
  for (const value of ['x'.repeat(1_100_000), 'a\n'.repeat(120_000)]) {
    const formatted = await formatCodemodeResult(result([], value), options({ maxOutputTokens: 400_000 }));
    expect(formatted.content[1]).toEqual({ type: 'text', text: value });
    expect(formatted.fullOutputPath).toBeUndefined();
  }
});

test('token truncation preserves the original text and reports the spill path', async () => {
  const writes: { name: string; data: string | Uint8Array }[] = [];
  const formatted = await formatCodemodeResult(result([], 'alpha\nbeta\ngamma'), options({
    maxOutputTokens: 2,
    write: async (name, data) => { writes.push({ name, data }); return { path: '/fixture/full.txt' }; },
  }));
  expect(writes).toEqual([{ name: 'output.txt', data: 'alpha\nbeta\ngamma' }]);
  expect(formatted.fullOutputPath).toBe('/fixture/full.txt');
  expect(formatted.content[1]).toEqual({
    type: 'text',
    text: 'Warning: truncated output (original token count: 4)\nTotal output lines: 3\n\nalph…2 tokens truncated…amma\n\n[Full output: /fixture/full.txt (read with offset/limit)]',
  });
});

test('explicit byte limits retain the built-in policy while false keeps the token policy', async () => {
  const input = result([], 'x'.repeat(30));
  const bounded = await formatCodemodeResult(input, options({ limits: { maxBytes: 64, maxLines: 1000 } }));
  const native = await formatCodemodeResult(input, options());
  expect(text(bounded.content)).toContain('Warning: truncated output');
  expect(native.content[1]).toEqual({ type: 'text', text: 'x'.repeat(30) });
});

test('shared image handling writes duplicate bytes once and keeps native size labels', async () => {
  const image = { type: 'image' as const, data: 'AA==', mimeType: 'image/png' };
  const writes: { name: string; data: string | Uint8Array }[] = [];
  const formatted = await formatCodemodeResult(result([image, image]), options({
    imageSize: bytes => `${bytes} B`,
    write: async (name, data) => { writes.push({ name, data }); return { path: '/fixture/image.png' }; },
  }));
  expect(writes).toEqual([{ name: 'image-1.png', data: new Uint8Array([0]) }]);
  expect(formatted.content).toEqual([
    { type: 'text', text: 'Script completed\nWall time 1.5 seconds\nOutput:\n' },
    { type: 'text', text: '[Image saved to /fixture/image.png (image/png, 1 B)]' },
    image,
    { type: 'text', text: '[Image saved to /fixture/image.png (image/png, 1 B)]' },
    image,
  ]);
});

test('write failures preserve both the script text and images', async () => {
  const image = { type: 'image' as const, data: 'AA==', mimeType: 'image/png' };
  const formatted = await formatCodemodeResult(result([{ type: 'text', text: 'long output' }, image]), options({
    maxOutputTokens: 1, write: async () => ({ error: 'disk full' }),
  }));
  expect(text(formatted.content)).toContain('[Could not save the full output: disk full]');
  expect(text(formatted.content)).toContain('[Image (image/png, 1 bytes) could not be saved: disk full]');
  expect(formatted.content.at(-1)).toEqual(image);
});

test('cancelled scripts keep partial output and report calls already made', async () => {
  const formatted = await formatCodemodeResult({
    ok: false, output: [{ type: 'text', text: 'partial output' }], calls: [],
    error: { kind: 'aborted', message: 'stopped' },
  }, options({ calls: [{ name: 'echo', status: 'cancelled' }] }));
  expect(formatted.content).toEqual([
    { type: 'text', text: 'Script failed\nWall time 1.5 seconds\nOutput:\n' },
    { type: 'text', text: 'partial output\nScript error:\nScript aborted: stopped\n\nTool calls made before the failure (they are not undone): echo (cancelled)' },
  ]);
});

test('wall time can include the file write and unseen generated images remain visible', async () => {
  let wallMs = 0;
  const formatted = await formatCodemodeResult(result([], 'long output'), options({
    generatedImages: 2, maxOutputTokens: 1, wallMs: () => wallMs,
    write: async () => { wallMs = 1500; return { path: '/fixture/output.txt' }; },
  }));
  expect(formatted.content[0]).toEqual({ type: 'text', text: 'Script completed\nWall time 1.5 seconds\nOutput:\n' });
  const unseen = await formatCodemodeResult(result(), options({ generatedImages: 2 }));
  expect(text(unseen.content)).toContain('models.generateImages() returned 2 images that the script did not show');
});
