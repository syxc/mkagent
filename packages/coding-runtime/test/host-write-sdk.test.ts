import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getThemeByName, initTheme, type ExtensionContext, type ToolRenderContext } from '@earendil-works/pi-coding-agent';
import { createEditToolDefinition, createWriteTool, createWriteToolDefinition, withFileMutationQueue } from '../src/native.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'host-write-sdk-'));
  directories.push(directory);
  return directory;
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
}

test('write creates parents, preserves bytes and overwrites through file URLs', async () => {
  const cwd = await scratch();
  const path = join(cwd, '子目录', 'file.txt');
  const tool = createWriteTool(cwd);
  const content = '﻿中文\r\nnext\rline\n';
  const result = await tool.execute('write', { path: '子目录/file.txt', content });
  expect(await readFile(path, 'utf8')).toBe(content);
  expect(result).toEqual({ content: [{ type: 'text', text: 'Successfully wrote to 子目录/file.txt' }], details: undefined });
  await tool.execute('write-empty', { path: pathToFileURL(path).href, content: '' });
  expect(await readFile(path, 'utf8')).toBe('');
});

for (const [name, factory] of [['agent', createWriteTool], ['definition', createWriteToolDefinition]] as const) {
  test(`${name} write reads inherited operations once and uses the current context directory`, async () => {
    const cwd = await scratch();
    const calls: unknown[] = [];
    let reads = 0;
    class Options {
      get operations() {
        reads++;
        return {
          mkdir: async (path: string) => { calls.push(['mkdir', path]); },
          writeFile: async (path: string, content: string) => { calls.push(['write', path, content]); },
        };
      }
    }
    const tool = factory('/unused', new Options());
    await tool.execute('write', { path: 'remote/file.txt', content: 'raw\rbytes' }, undefined, undefined, { cwd } as ExtensionContext);
    expect(reads).toBe(1);
    expect(calls).toEqual([['mkdir', join(cwd, 'remote')], ['write', join(cwd, 'remote', 'file.txt'), 'raw\rbytes']]);
  });
}

for (const stage of ['mkdir', 'writeFile'] as const) {
  test(`write preserves the original ${stage} error`, async () => {
    const cwd = await scratch();
    const error = new Error('Remote operation failed');
    const operations = { mkdir: async () => {}, writeFile: async () => {} };
    operations[stage] = async () => { throw error; };
    const result = await outcome(createWriteTool(cwd, { operations }).execute('write', { path: 'file.txt', content: 'x' }));
    expect(result.error).toBe(error);
  });

  test(`cancellation during ${stage} holds the shared queue until the operation settles`, async () => {
    const cwd = await scratch();
    const path = join(cwd, 'file.txt');
    const reached = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const calls: string[] = [];
    const operations = {
      mkdir: async () => { calls.push('mkdir'); },
      writeFile: async () => { calls.push('writeFile'); },
    };
    operations[stage] = async () => { calls.push(stage); reached.resolve(); await finish.promise; };
    const controller = new AbortController();
    const pending = outcome(createWriteTool(cwd, { operations }).execute('write', { path, content: 'x' }, controller.signal));
    await reached.promise;
    let entered = false;
    const next = withFileMutationQueue(path, async () => { entered = true; });
    try {
      controller.abort();
      // Registration on another file is a barrier for the queued same-file operation.
      await withFileMutationQueue(join(cwd, 'other.txt'), async () => {});
      expect(entered).toBe(false);
    } finally {
      finish.resolve();
    }
    expect((await pending).error?.message).toBe('Operation aborted');
    await next;
    expect(entered).toBe(true);
    expect(calls).toEqual(stage === 'mkdir' ? ['mkdir'] : ['mkdir', 'writeFile']);
  });
}

test('edit waits for an in-flight cancelled write and sees its completed bytes', async () => {
  const cwd = await scratch();
  const path = join(cwd, 'file.txt');
  await writeFile(path, 'initial');
  const reached = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const controller = new AbortController();
  const write = createWriteTool(cwd, { operations: {
    mkdir: async () => {},
    writeFile: async (path, content) => { reached.resolve(); await finish.promise; await writeFile(path, content); },
  } });
  const pendingWrite = outcome(write.execute('write', { path, content: 'written' }, controller.signal));
  await reached.promise;
  const pendingEdit = outcome(createEditToolDefinition(cwd).execute('edit', { path, edits: [{ oldText: 'written', newText: 'edited' }] }));
  try {
    controller.abort();
    await withFileMutationQueue(join(cwd, 'other.txt'), async () => {});
    expect(await readFile(path, 'utf8')).toBe('initial');
  } finally {
    finish.resolve();
  }
  expect((await pendingWrite).error?.message).toBe('Operation aborted');
  expect((await pendingEdit).error).toBeUndefined();
  expect(await readFile(path, 'utf8')).toBe('edited');
});

test('write renderer reuses its streaming component and shows complete content', async () => {
  const cwd = await scratch();
  const tool = createWriteToolDefinition(cwd);
  initTheme('dark', false);
  const theme = getThemeByName('dark')!;
  const args = { path: join(cwd, 'file.ts'), content: 'const value = 1;\n' };
  const context = { cwd, args, argsComplete: false, expanded: false, isPartial: true, lastComponent: undefined } as ToolRenderContext;
  const first = tool.renderCall!(args, theme, context);
  const complete = { ...args, content: args.content + 'console.log(value);\n' };
  const second = tool.renderCall!(complete, theme, { ...context, lastComponent: first, argsComplete: true, isPartial: false });
  expect(second).toBe(first);
  const rendered = second.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  expect(rendered).toContain('console.log(value);');
  expect(rendered).toContain('file.ts');
});
