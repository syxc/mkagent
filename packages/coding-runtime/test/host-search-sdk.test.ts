import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createLsToolDefinition, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ENV_AGENT_DIR } from '../src/native-config.ts';
import {
  createFindTool, createFindToolDefinition, createGrepTool, createGrepToolDefinition, relativizeFindResultPath,
} from '../src/native-search-tools.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'host-search-sdk-'));
  directories.push(directory);
  return directory;
}

function context(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test.skipIf(process.platform === 'win32')('SDK search factories use managed POSIX binaries and the current context directory', async () => {
  const directory = await scratch();
  const project = join(directory, 'project');
  const bin = join(directory, 'agent', 'bin');
  await mkdir(project);
  await mkdir(bin, { recursive: true });
  const file = join(project, 'fixture.txt');
  await writeFile(file, 'fixture needle\n');
  for (const tool of ['fd', 'rg']) {
    const data = tool === 'fd' ? file : JSON.stringify({
      type: 'match', data: { path: { text: file }, lines: { text: 'fixture needle\n' }, line_number: 1, submatches: [] },
    });
    await writeFile(join(bin, tool), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(directory, tool + '-args.json'))}, JSON.stringify(process.argv.slice(2)));\nconsole.log(${JSON.stringify(data)});\n`, { mode: 0o755 });
  }
  const fixture = new URL('./fixtures/host-search-runner.ts', import.meta.url).pathname;
  const proc = Bun.spawnSync([process.execPath, '--no-env-file', '--config=/dev/null', fixture, project], {
    cwd: directory,
    env: { PATH: '', HOME: directory, [ENV_AGENT_DIR]: join(directory, 'agent'), PI_OFFLINE: '1', NO_COLOR: '1' },
  });
  expect(proc.exitCode).toBe(0);
  const result = JSON.parse(proc.stdout.toString());
  expect(result.grep.content[0].text).toBe('fixture.txt:1: fixture needle');
  expect(result.find.content[0].text).toBe('fixture.txt');
  expect(result.ls.content[0].text).toBe('fixture.txt');
  expect(result.renderers).toBe(true);
  expect(JSON.parse(await readFile(join(directory, 'rg-args.json'), 'utf8'))).toContain('--no-config');
  expect(JSON.parse(await readFile(join(directory, 'fd-args.json'), 'utf8'))).toContain(project);
});

test('SDK custom find operations keep result limits, relative paths and directory suffixes', async () => {
  let binaryCalls = 0;
  const cwd = await scratch();
  const tool = createFindToolDefinition('/unused', {
    operations: {
      exists: path => path === cwd,
      glob: (pattern, path, options) => {
        expect([pattern, path, options.ignore, options.limit]).toEqual(['*', cwd, ['**/node_modules/**', '**/.git/**'], 2]);
        return [join(cwd, 'one.txt'), join(cwd, 'folder') + '/'];
      },
    },
    ensureTool: async () => { binaryCalls++; throw new Error('Unexpected binary lookup'); },
  });
  const result = await tool.execute('find', { pattern: '*', limit: 2 }, undefined, undefined, context(cwd));
  expect(result.content).toEqual([{ type: 'text', text: 'one.txt\nfolder/\n\n[2 results limit reached]' }]);
  expect(result.details).toEqual({ resultLimitReached: 2 });
  expect(binaryCalls).toBe(0);
  expect(relativizeFindResultPath('C:\\project\\folder\\', 'C:\\project', win32)).toBe('folder/');
});

test('SDK custom grep operations decide directory status instead of local filesystem stat', async () => {
  const cwd = await scratch();
  const path = join(cwd, 'virtual-root');
  let inspected = '';
  const tool = createGrepToolDefinition(cwd, {
    ensureTool: async name => { expect(name).toBe('rg'); return '/unused-rg'; },
    operations: { isDirectory: candidate => { inspected = candidate; throw new Error('Remote path missing'); }, readFile: () => '' },
  });
  await expect(tool.execute('grep', { pattern: 'x', path })).rejects.toThrow('Path not found: ' + path);
  expect(inspected).toBe(path);
});

for (const shape of ['inherited', 'non-enumerable', 'enumerable'] as const) {
  test.each([['agent', createFindTool], ['definition', createFindToolDefinition]] as const)(`SDK find %s reads ${shape} operations once`, async (_name, factory) => {
    let reads = 0;
    const operations = { exists: () => true, glob: () => ['remote.txt'] };
    class Options {
      get operations() { reads++; return operations; }
      ensureTool = async () => { throw new Error('Unexpected local binary lookup'); };
    }
    const options = new Options();
    if (shape !== 'inherited') Object.defineProperty(options, 'operations', {
      get: () => { reads++; return operations; }, enumerable: shape === 'enumerable',
    });
    const result = await factory('/virtual', options).execute('find', { pattern: '*' });
    expect(result.content).toEqual([{ type: 'text', text: 'remote.txt' }]);
    expect(reads).toBe(1);
  });

  test.each([['agent', createGrepTool], ['definition', createGrepToolDefinition]] as const)(`SDK grep %s reads ${shape} operations once`, async (_name, factory) => {
    let reads = 0;
    let checks = 0;
    const operations = { isDirectory: () => { checks++; throw new Error('Remote directory checked'); }, readFile: () => '' };
    class Options {
      get operations() { reads++; return operations; }
      ensureTool = async () => '/not-spawned';
    }
    const options = new Options();
    if (shape !== 'inherited') Object.defineProperty(options, 'operations', {
      get: () => { reads++; return operations; }, enumerable: shape === 'enumerable',
    });
    await expect(factory('/virtual', options).execute('grep', { pattern: 'needle' })).rejects.toThrow('Path not found:');
    expect(reads).toBe(1);
    expect(checks).toBe(1);
  });
}

test('SDK search factories reject an already cancelled call before resolving binaries or operations', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const ensureTool = async () => { calls++; return undefined; };
  const tools = [
    createGrepToolDefinition('/unused', { ensureTool }),
    createFindToolDefinition('/unused', { ensureTool }),
  ];
  for (const tool of tools) {
    await expect(tool.execute('cancelled', { pattern: 'x' }, controller.signal)).rejects.toThrow('Operation aborted');
  }
  expect(calls).toBe(0);
});

test.each(['grep', 'find'] as const)('SDK %s stops when cancelled during binary resolution', async name => {
  const controller = new AbortController();
  const options = { ensureTool: async () => { controller.abort(); return undefined; } };
  const tool = name === 'grep' ? createGrepToolDefinition('/unused', options) : createFindToolDefinition('/unused', options);
  await expect(tool.execute('cancelled', { pattern: 'x' }, controller.signal)).rejects.toThrow('Operation aborted');
});

test('SDK grep stops when cancelled during a custom directory check', async () => {
  const controller = new AbortController();
  const tool = createGrepToolDefinition('/unused', {
    ensureTool: async () => '/must-not-spawn',
    operations: { isDirectory: () => { controller.abort(); return true; }, readFile: () => '' },
  });
  await expect(tool.execute('cancelled', { pattern: 'x' }, controller.signal)).rejects.toThrow('Operation aborted');
});

test('SDK find cancellation during a custom operation rejects promptly and ignores its later result', async () => {
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  const tool = createFindTool('/unused', {
    operations: { exists: () => true, glob: async () => { entered.resolve(); await release.promise; return ['late']; } },
    ensureTool: async () => { throw new Error('Unexpected binary lookup'); },
  });
  const result = tool.execute('cancelled', { pattern: '*' }, controller.signal).then(() => null, error => error);
  await entered.promise;
  controller.abort();
  expect(await result).toBeInstanceOf(Error);
  release.resolve();
});

test('SDK ls keeps custom directory checks, sorted names and entry-limit details', async () => {
  const cwd = await scratch();
  const tool = createLsToolDefinition('/unused', {
    operations: { exists: path => path === cwd, stat: async () => ({ isDirectory: () => true }), readdir: () => ['z', '.hidden', 'Folder'] },
  });
  const result = await tool.execute('ls', { limit: 2 }, undefined, undefined, context(cwd));
  expect(result.content).toEqual([{ type: 'text', text: '.hidden/\nFolder/\n\n[2 entries limit reached. Use limit=4 for more]' }]);
  expect(result.details).toEqual({ entryLimitReached: 2 });
});
