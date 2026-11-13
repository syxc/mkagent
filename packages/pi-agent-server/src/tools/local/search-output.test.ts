import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { createBuiltinTools } from '../builtin.ts';
import { findOnPath } from './tool-binaries.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const api = {} as ToolExecutionApi;
const available = Boolean(findOnPath('rg') && findOnPath('fd'));

function searchTool(name: 'grep' | 'find' | 'ls', cwd: string) {
  return createBuiltinTools(cwd).find(tool => tool.name === name)!;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'coding-search-'));
  directories.push(directory);
  mkdirSync(join(directory, '.git'));
  mkdirSync(join(directory, '子目录'));
  writeFileSync(join(directory, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(directory, 'ignored.txt'), 'needle ignored\n');
  writeFileSync(join(directory, '.hidden.txt'), 'needle hidden\n');
  writeFileSync(join(directory, '子目录', '中文.txt'), 'before\nneedle 中文\nAFTER\n');
  return directory;
}

test.skipIf(!available)('searches Unicode and hidden paths, respects ignore rules, and reports limits', async () => {
  const directory = fixture();
  const grep = searchTool('grep', directory);
  const result = await grep.execute({ pattern: 'needle', context: 1 }, api, BACKGROUND_CONTEXT);
  const text = JSON.stringify(result.output);
  expect(text).toContain('子目录/中文.txt:2: needle 中文');
  expect(text).toContain('子目录/中文.txt-1- before');
  expect(text).toContain('子目录/中文.txt-3- AFTER');
  expect(text).toContain('.hidden.txt:1: needle hidden');
  expect(text).not.toContain('needle ignored');
  const limited = await grep.execute({ pattern: 'needle', limit: 1 }, api, BACKGROUND_CONTEXT);
  expect(limited.details).toMatchObject({ matchLimitReached: 1 });
  expect(JSON.stringify(limited.output)).toContain('1 matches limit reached');
  const find = searchTool('find', directory);
  const found = await find.execute({ pattern: '*.txt' }, api, BACKGROUND_CONTEXT);
  expect(JSON.stringify(found.output)).toContain('子目录/中文.txt');
  expect(JSON.stringify(found.output)).toContain('.hidden.txt');
  expect(JSON.stringify(found.output)).not.toContain('ignored.txt');
  expect((await find.execute({ pattern: '*.txt', limit: 1 }, api, BACKGROUND_CONTEXT)).details)
    .toMatchObject({ resultLimitReached: 1 });
});

test.skipIf(!available)('bounds long grep lines and returns explicit empty and missing-path results', async () => {
  const directory = fixture();
  writeFileSync(join(directory, 'long.txt'), `needle ${'文'.repeat(2000)}\n`);
  const grep = searchTool('grep', directory);
  const long = await grep.execute({ pattern: 'needle', path: 'long.txt' }, api, BACKGROUND_CONTEXT);
  expect(long.details).toMatchObject({ linesTruncated: true });
  expect(JSON.stringify(long.output)).toContain('Use read tool to see full lines');
  expect(JSON.stringify(long.output)).not.toContain('文'.repeat(501));
  expect((await grep.execute({ pattern: 'absent-pattern' }, api, BACKGROUND_CONTEXT)).output)
    .toEqual([{ type: 'text', text: 'No matches found' }]);
  await expect(grep.execute({ pattern: 'needle', path: 'missing' }, api, BACKGROUND_CONTEXT))
    .rejects.toThrow('Path not found');
  expect((await searchTool('find', directory).execute({ pattern: '*.absent' }, api, BACKGROUND_CONTEXT)).output)
    .toEqual([{ type: 'text', text: 'No files found matching pattern' }]);
});

test('ls includes ignored and hidden entries, marks directories, and reports limits and errors', async () => {
  const directory = fixture();
  const ls = searchTool('ls', directory);
  const text = JSON.stringify((await ls.execute({}, api, BACKGROUND_CONTEXT)).output);
  for (const entry of ['.hidden.txt', 'ignored.txt', '子目录/']) expect(text).toContain(entry);
  expect((await ls.execute({ limit: 1 }, api, BACKGROUND_CONTEXT)).details).toMatchObject({ entryLimitReached: 1 });
  await expect(ls.execute({ path: 'ignored.txt' }, api, BACKGROUND_CONTEXT)).rejects.toThrow('Not a directory');
  await expect(ls.execute({ path: 'missing' }, api, BACKGROUND_CONTEXT)).rejects.toThrow('Path not found');
});

test.skipIf(!available)('preserves CR-only context splitting and CRLF output through the production entry', async () => {
  const directory = fixture();
  const grep = searchTool('grep', directory);
  for (const [name, content] of [['cr.txt', 'needle\rcontinued\nlast\n'], ['crlf.txt', 'needle\r\ncontinued\r\nlast\r\n']]) {
    writeFileSync(join(directory, name!), content!);
    const result = await grep.execute({ pattern: 'needle', path: name, context: 1 }, api, BACKGROUND_CONTEXT);
    expect(result.output).toEqual([{ type: 'text', text: `${name}:1: needle\n${name}-2- continued` }]);
  }
});

test.skipIf(!available)('find keeps path globs and nested repository ignore boundaries', async () => {
  const directory = fixture();
  writeFileSync(join(directory, '.gitignore'), 'ignored.txt\nnested/\n');
  const nested = join(directory, 'nested');
  mkdirSync(join(nested, '.git'), { recursive: true });
  mkdirSync(join(nested, 'src'));
  writeFileSync(join(nested, 'src', 'nested.spec.ts'), 'fixture');
  const result = await searchTool('find', directory).execute({ pattern: 'src/**/*.spec.ts', path: pathToFileURL(nested).href }, api, BACKGROUND_CONTEXT);
  expect(result.output).toEqual([{ type: 'text', text: 'src/nested.spec.ts' }]);
});

for (const name of ['grep', 'find', 'ls'] as const) {
  test(`${name} rejects cancellation before search starts`, async () => {
    const controller = new AbortController();
    controller.abort();
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    await expect(searchTool(name, fixture()).execute({ pattern: '*' }, api, context)).rejects.toThrow('Operation aborted');
  });
}

test.skipIf(!available)('grep ignores ambient ripgrep configuration in the production entry', async () => {
  const directory = fixture();
  const config = join(directory, 'rg-config');
  writeFileSync(config, '--fixed-strings\n');
  const entry = new URL('../builtin.ts', import.meta.url).href;
  const code = `import { createBuiltinTools } from ${JSON.stringify(entry)};
    import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
    const tool = createBuiltinTools(${JSON.stringify(directory)}).find(tool => tool.name === 'grep');
    console.log(JSON.stringify(await tool.execute({ pattern: 'need.e', path: '.hidden.txt' }, {}, BACKGROUND_CONTEXT)));`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', '-e', code], {
    cwd: import.meta.dir, env: { ...process.env, RIPGREP_CONFIG_PATH: config }, stdout: 'pipe', stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
  expect(JSON.parse(output).output).toEqual([{ type: 'text', text: '.hidden.txt:1: needle hidden' }]);
});
