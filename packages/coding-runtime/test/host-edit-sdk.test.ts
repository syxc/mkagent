import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEditToolDefinition as sdkDefinition, getThemeByName, initTheme, type EditOperations, type ExtensionContext, type ToolRenderContext } from '@earendil-works/pi-coding-agent';
import { createEditTool, createEditToolDefinition, withFileMutationQueue } from '../src/native.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'host-edit-sdk-'));
  directories.push(directory);
  return directory;
}
const edits = [{ oldText: 'before', newText: 'after' }];

for (const [name, factory] of [['agent', createEditTool], ['definition', createEditToolDefinition]] as const) {
  test(`${name} edit preserves BOM, CRLF and unchanged fuzzy-match bytes`, async () => {
    const cwd = await scratch();
    const path = join(cwd, '中文.txt');
    await writeFile(path, '﻿keep \t\r\nTarget’s  \r\nkeep \t\r\n');
    const result = await factory('/unused').execute('edit', {
      path: pathToFileURL(path).href, edits: [{ oldText: "Target's", newText: 'changed' }],
    });
    expect(await readFile(path, 'utf8')).toBe('﻿keep \t\r\nchanged\r\nkeep \t\r\n');
    expect(result.details?.diff).toContain('+2 changed');
    expect(result.details?.patch).toContain('+changed');
    expect(result.details?.firstChangedLine).toBe(2);
  });

  test(`${name} edit preserves inherited options, operations receivers and ctx.cwd`, async () => {
    const calls: unknown[] = [];
    let reads = 0;
    const operations: EditOperations = {
      async access(path) { expect(this).toBe(operations); calls.push(['access', path]); },
      async readFile(path) { expect(this).toBe(operations); calls.push(['read', path]); return Buffer.from('before'); },
      async writeFile(path, content) { expect(this).toBe(operations); calls.push(['write', path, content]); },
    };
    class Options { get operations() { reads++; return operations; } }
    const tool = factory('/unused', new Options());
    await tool.execute('edit', { path: 'remote.txt', edits }, undefined, undefined, { cwd: '/remote' } as ExtensionContext);
    expect(reads).toBe(1);
    expect(calls).toEqual([['access', '/remote/remote.txt'], ['read', '/remote/remote.txt'], ['write', '/remote/remote.txt', 'after']]);
  });

  for (const stage of ['access', 'readFile', 'writeFile'] as const) {
    test(`${name} edit preserves ${stage} failure semantics`, async () => {
      const error = Object.assign(new Error('Remote edit failed'), { code: 'EACCES' });
      const operations: EditOperations = { access: async () => {}, readFile: async () => Buffer.from('before'), writeFile: async () => {} };
      operations[stage] = async () => { throw error; };
      const result = factory('/remote', { operations }).execute('edit', { path: 'file.txt', edits });
      if (stage === 'access') await expect(result).rejects.toThrow('Could not edit file: file.txt. Error code: EACCES.');
      else await expect(result).rejects.toBe(error);
    });
  }

  test(`${name} edit rejects pre-cancellation before file access`, async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const operations: EditOperations = {
      access: async () => { calls++; }, readFile: async () => { calls++; return Buffer.from('before'); }, writeFile: async () => { calls++; },
    };
    await expect(factory('/remote', { operations }).execute('edit', { path: 'file.txt', edits }, controller.signal)).rejects.toThrow('Operation aborted');
    expect(calls).toBe(0);
  });
}

for (const stage of ['access', 'readFile', 'writeFile'] as const) {
  test(`edit holds the shared queue until cancelled ${stage} settles`, async () => {
    const cwd = await scratch();
    const reached = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const controller = new AbortController();
    const calls: string[] = [];
    const wait = async (name: string) => {
      calls.push(name);
      if (name === stage) { reached.resolve(); await finish.promise; }
    };
    const tool = createEditToolDefinition(cwd, { operations: {
      access: async () => wait('access'),
      readFile: async () => { await wait('readFile'); return Buffer.from('before'); },
      writeFile: async () => wait('writeFile'),
    } });
    const pending = tool.execute('edit', { path: 'file.txt', edits }, controller.signal).then(
      value => ({ value, error: undefined }), error => ({ value: undefined, error }),
    );
    await reached.promise;
    controller.abort();
    let nextStarted = false;
    const next = withFileMutationQueue(join(cwd, 'file.txt'), async () => { nextStarted = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(nextStarted).toBe(false);
    finish.resolve();
    expect((await pending).error?.message).toBe('Operation aborted');
    await next;
    expect(nextStarted).toBe(true);
    expect(calls).toEqual(['access', 'readFile', 'writeFile'].slice(0, ['access', 'readFile', 'writeFile'].indexOf(stage) + 1));
  });
}

for (const [name, content, replacements, expected] of [
  ['BOM and CRLF', '﻿before\r\nkeep\r\n', edits, '+1 after'],
  ['unordered edits', 'a\nb\nc\n', [{ oldText: 'c', newText: 'C' }, { oldText: 'a', newText: 'A' }], '+3 C'],
  ['duplicate text', 'before\nbefore\n', edits, 'Found 2 occurrences'],
  ['missing file', undefined, edits, 'Error code: ENOENT'],
] as const) {
  test(`edit renderer previews ${name} without changing files`, async () => {
    const cwd = await scratch();
    const path = join(cwd, 'file.txt');
    if (content !== undefined) await writeFile(path, content);
    initTheme('dark', false);
    const theme = getThemeByName('dark')!;
    const tool = createEditToolDefinition(cwd);
    const args = { path: 'file.txt', edits: [...replacements] };
    const invalidated = Promise.withResolvers<void>();
    const context = {
      cwd, args, state: {}, argsComplete: true, outputPad: 1, expanded: true,
      showImages: false, isError: false, invalidate: () => invalidated.resolve(), lastComponent: undefined,
    } as ToolRenderContext;
    const component = tool.renderCall!(args, theme, context);
    await invalidated.promise;
    expect(tool.renderCall!(args, theme, { ...context, lastComponent: component })).toBe(component);
    expect(component.render(120).join('\n').replace(/\x1b\[[0-9;]*m/g, '')).toContain(expected);
    if (content !== undefined) expect(await readFile(path, 'utf8')).toBe(content);
  });
}

test('edit uses SDK renderers and suppresses duplicate settled diff output', () => {
  const tool = createEditToolDefinition('/remote');
  const sdk = sdkDefinition('/remote');
  expect(tool.renderCall).toBe(sdk.renderCall);
  expect(tool.renderResult).toBe(sdk.renderResult);
  initTheme('dark', false);
  const theme = getThemeByName('dark')!;
  const args = { path: 'file.txt', edits };
  const context = { cwd: '/remote', args, state: {}, argsComplete: false, outputPad: 1, expanded: true, showImages: false, isError: false } as ToolRenderContext;
  const component = tool.renderCall!(args, theme, context);
  const result = { content: [{ type: 'text' as const, text: 'done' }], details: { diff: '-1 before\n+1 after', patch: '', firstChangedLine: 1 } };
  const output = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, context);
  expect(output.render(120)).toEqual([]);
  expect(component.render(120).join('\n')).toContain('after');
});
