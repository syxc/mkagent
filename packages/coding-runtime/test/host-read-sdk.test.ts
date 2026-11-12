import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReadToolDefinition as sdkReadDefinition, getThemeByName, initTheme, type ExtensionContext, type ReadOperations, type ToolRenderContext } from '@earendil-works/pi-coding-agent';
import { createReadTool, createReadToolDefinition, getReadmePath } from '../src/native.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'host-read-sdk-'));
  directories.push(directory);
  return directory;
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

for (const [name, factory] of [['agent', createReadTool], ['definition', createReadToolDefinition]] as const) {
  test(`${name} read preserves BOM, CR and Unicode bytes through file URLs`, async () => {
    const cwd = await scratch();
    const path = join(cwd, '中文.txt');
    const content = '﻿中文\r\nnext\rline\n';
    await writeFile(path, content);
    const result = await factory('/unused').execute('read', { path: pathToFileURL(path).href });
    expect(result.content).toEqual([{ type: 'text', text: content }]);
    expect(result.structuredContent).toBe(content);
  });

  test(`${name} read preserves inherited options, remote operations and context directory`, async () => {
    const cwd = await scratch();
    const calls: unknown[] = [];
    const getters: string[] = [];
    class Options {
      get autoResizeImages() { getters.push('resize'); return false; }
      get resizeOptions() { getters.push('profile'); return undefined; }
      get operations(): ReadOperations {
        getters.push('operations');
        return {
          access: async path => { calls.push(['access', path]); },
          readFile: async path => { calls.push(['read', path]); return Buffer.from('remote bytes'); },
        };
      }
    }
    const result = await factory('/unused', new Options()).execute('read', { path: 'remote.txt' }, undefined, undefined, { cwd } as ExtensionContext);
    expect(getters).toEqual(['resize', 'profile', 'operations']);
    expect(calls).toEqual([['access', join(cwd, 'remote.txt')], ['read', join(cwd, 'remote.txt')]]);
    expect(result.structuredContent).toBe('remote bytes');
  });
}

for (const [name, text, args, expected] of [
  ['limited', 'a\nb\nc\nd', { offset: 2, limit: 2 }, 'b\nc\n\n[1 more lines in file. Use offset=4 to continue.]'],
  ['empty', '', {}, ''],
  ['final empty line', 'a\n', { offset: 2 }, ''],
  ['line truncation', Array.from({ length: 2002 }, () => 'x').join('\n'), {}, '[Showing lines 1-2000 of 2002. Use offset=2001 to continue.]'],
  ['byte truncation', Array.from({ length: 101 }, () => '中'.repeat(200)).join('\n'), {}, '(50.0KB limit). Use offset=86 to continue.]'],
  ['oversize first line', 'x'.repeat(51201), {}, "Use bash: sed -n '1p' file.txt | head -c 51200]"],
] as const) {
  test(`read preserves ${name} pagination and structured output`, async () => {
    const cwd = await scratch();
    await writeFile(join(cwd, 'file.txt'), text);
    const result = await createReadToolDefinition(cwd).execute('read', { path: 'file.txt', ...args });
    expect(result.content[0]?.type).toBe('text');
    expect(result.structuredContent).toBe((result.content[0] as { text: string }).text);
    expect(result.structuredContent).toEndWith(expected);
  });
}

for (const stage of ['access', 'readFile'] as const) {
  test(`read preserves the original ${stage} error`, async () => {
    const error = new Error('Remote read failed');
    const operations: ReadOperations = { access: async () => {}, readFile: async () => Buffer.from('x') };
    operations[stage] = async () => { throw error; };
    await expect(createReadTool('/remote', { operations }).execute('read', { path: 'file.txt' })).rejects.toBe(error);
  });
}

test('read rejects pre-cancellation before invoking custom operations', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const tool = createReadTool('/remote', { operations: {
    access: async () => { calls++; }, readFile: async () => { calls++; return png; },
  } });
  await expect(tool.execute('read', { path: 'file.txt' }, controller.signal)).rejects.toThrow('Operation aborted');
  expect(calls).toBe(0);
});

test('cancelling an in-flight read does not publish a late result', async () => {
  const reached = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<Buffer>();
  const controller = new AbortController();
  const tool = createReadTool('/remote', { operations: {
    access: async () => {}, readFile: async () => { reached.resolve(); return finish.promise; },
  } });
  const pending = tool.execute('read', { path: 'file.txt' }, controller.signal).then(
    value => ({ value, error: undefined }), error => ({ value: undefined, error }),
  );
  await reached.promise;
  controller.abort();
  finish.resolve(Buffer.from('late bytes'));
  expect((await pending).error?.message).toBe('Operation aborted');
});

test('read uses native path fallbacks and rejects remote file URLs', async () => {
  const cwd = await scratch();
  await writeFile(join(cwd, 'Café.txt'), 'decomposed path');
  const tool = createReadTool(cwd);
  expect((await tool.execute('read', { path: '@Café.txt' })).structuredContent).toBe('decomposed path');
  await expect(tool.execute('read', { path: 'file://remote-host/path' })).rejects.toThrow();
  await expect(tool.execute('read', { path: 'Café.txt', offset: 2 })).rejects.toThrow('beyond end of file');
});

test('read returns image blocks and matching structured image output', async () => {
  const cwd = await scratch();
  await writeFile(join(cwd, 'image.bin'), png);
  const result = await createReadTool(cwd, { autoResizeImages: false }).execute('read', { path: 'image.bin' });
  expect(result.content).toEqual([
    { type: 'text', text: 'Read image file [image/png]' },
    { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
  ]);
  expect(result.structuredContent).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png', note: 'Read image file [image/png]' });
});

test('read renderer retains resource classification, range and component reuse', async () => {
  const cwd = await scratch();
  initTheme('dark', false);
  const theme = getThemeByName('dark')!;
  const tool = createReadToolDefinition(cwd);
  const sdkTool = sdkReadDefinition(cwd, { getReadmePath });
  const args = { path: 'AGENTS.md', offset: 2, limit: 3 };
  const context = { cwd, args, expanded: false, showImages: false, isError: false, lastComponent: undefined } as ToolRenderContext;
  const first = tool.renderCall!(args, theme, context);
  const rendered = first.render(120).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  expect(rendered).toContain('read resource');
  expect(rendered).toContain('AGENTS.md');
  const next = tool.renderCall!({ path: 'file.txt' }, theme, { ...context, lastComponent: first, expanded: true });
  expect(next).toBe(first);
  expect(next.render(120).join('\n')).toContain('file.txt');
  const docs = tool.renderCall!({ path: getReadmePath() }, theme, context);
  expect(docs.render(120).join('\n').replace(/\x1b\[[0-9;]*m/g, '')).toContain('read docs');
  expect(docs.render(120)).toEqual(sdkTool.renderCall!({ path: getReadmePath() }, theme, context).render(120));
});

for (const [name, factory] of [['sdk', sdkReadDefinition], ['host', createReadToolDefinition]] as const) {
  test(`${name} read injects image processing with the model resize profile`, async () => {
    const cwd = await scratch();
    const calls: unknown[] = [];
    const fallback = { maxWidth: 400 };
    const profile = { maxWidth: 200 };
    const tool = factory(cwd, {
      autoResizeImages: false, resizeOptions: fallback,
      operations: { access: async () => {}, readFile: async () => png, detectImageMimeType: async () => 'image/bmp' },
      processImage: async (bytes, mime, options) => {
        calls.push([bytes, mime, options]);
        return { ok: true, data: png.toString('base64'), mimeType: 'image/png', hints: ['Converted to PNG'] };
      },
    });
    const context = { cwd, model: { input: ['text'], inputLimits: { images: { resize: profile } } } } as ExtensionContext;
    const result = await tool.execute('read', { path: 'remote.bmp' }, undefined, undefined, context);
    expect(calls).toEqual([[png, 'image/bmp', { autoResizeImages: false, resizeOptions: profile }]]);
    expect(result.structuredContent).toEqual({
      type: 'image', data: png.toString('base64'), mimeType: 'image/png',
      note: 'Read image file [image/png]\nConverted to PNG\n[Current model does not support images. The image will be omitted from this request.]',
    });
    await tool.execute('read-fallback', { path: 'remote.bmp' });
    expect((calls[1] as unknown[])[2]).toEqual({ autoResizeImages: false, resizeOptions: fallback });
  });
}
