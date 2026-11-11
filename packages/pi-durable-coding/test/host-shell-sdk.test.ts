import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  createLocalBashOperations as sdkBashOperations, createLocalPowerShellOperations as sdkPowerShellOperations,
  createBashToolDefinition as sdkBashDefinition, getThemeByName, initTheme,
  type BashOperations, type BashToolOptions, type ExtensionContext, type ToolRenderContext,
} from '@earendil-works/pi-coding-agent';
import { getBinDir } from '../src/native-config.ts';
import {
  createBashTool, createBashToolDefinition, createLocalBashOperations, createLocalPowerShellOperations,
  createPowerShellTool, createPowerShellToolDefinition,
} from '../src/native-shell-tools.ts';
import { waitForChildProcess } from '../src/compat/child-process.ts';
import { killProcessTree } from '../src/compat/shell.ts';

const directories: string[] = [];
const outputFiles: string[] = [];
const processTrees = new Set<string>();
const pidFiles = ['root.pid', 'child.pid', 'grandchild.pid'];
const processTreeCommand = [
  'printf "%s\\n" "$$" > root.pid',
  '/bin/sh -c \'printf "%s\\n" "$$" > child.pid; /bin/sleep 30 & printf "%s\\n" "$!" > grandchild.pid; printf ready; wait; printf unexpected > child-after-wait\' &',
  'wait "$!"',
  'printf unexpected > after-wait',
].join('\n');
afterEach(async () => {
  const failedTrees = [...processTrees];
  processTrees.clear();
  for (const cwd of failedTrees) {
    const pids = (await Promise.all(pidFiles.map(async file => {
      try { return Number(await readFile(join(cwd, file), 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    }))).filter(pid => Number.isInteger(pid) && pid > 1);
    // Let the bounded fixture finish rather than signal a PID that could be reused.
    if ((await waitForProcessExit(pids, 31_000)).length) {
      directories.splice(directories.indexOf(cwd), 1);
      throw new Error(`Shell fixture did not stop; retained ${cwd}`);
    }
  }
  for (const file of outputFiles.splice(0)) await rm(file, { force: true });
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
}, 35_000);
async function scratch() {
  const cwd = await mkdtemp(join(tmpdir(), 'host-shell-sdk-'));
  directories.push(cwd);
  return cwd;
}
const context = {
  cwd: '/remote', model: { provider: 'fixture-provider', id: 'fixture-model' }, thinkingLevel: 'high',
  sessionManager: { getSessionId: () => 'fixture-session', getSessionFile: () => '/fixture-session.jsonl' },
} as ExtensionContext;
const factories = [
  ['bash agent', createBashTool], ['bash definition', createBashToolDefinition],
  ['powershell agent', createPowerShellTool], ['powershell definition', createPowerShellToolDefinition],
] as const;

for (const [name, factory] of factories) {
  for (const shape of ['inherited', 'non-enumerable'] as const) {
    test(`${name} preserves ${shape} options, receivers and session environment`, async () => {
      let reads = 0;
      const calls: unknown[] = [];
      const operations: BashOperations = { async exec(command, cwd, options) {
        expect(this).toBe(operations);
        calls.push([command, cwd]);
        const env = options.env!;
        expect(env.PI_SESSION_ID).toBe('fixture-session');
        expect(env.PI_SESSION_FILE).toBe('/fixture-session.jsonl');
        expect(env.PI_PROVIDER).toBe('fixture-provider');
        expect(env.PI_MODEL).toBe('fixture-model');
        expect(env.PI_REASONING_LEVEL).toBe('high');
        const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')!;
        expect(env[pathKey]!.split(delimiter)).toContain(getBinDir());
        expect(env.HOST_SHELL_FIXTURE).toBe('hook');
        expect(options.timeout).toBe(3);
        options.onData(Buffer.from('stdout\n'));
        return { exitCode: 0 };
      } };
      const properties: PropertyDescriptorMap = {
        operations: { get() { expect(this).toBe(options); reads++; return operations; } },
        exposeSessionEnvironment: { value: true },
        spawnHook: { value: (spawn: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
          command: 'hook:' + spawn.command, cwd: spawn.cwd + '/hook', env: { ...spawn.env, HOST_SHELL_FIXTURE: 'hook' },
        }) },
      };
      const options: BashToolOptions = shape === 'inherited'
        ? Object.create(Object.defineProperties({}, properties)) : Object.defineProperties({}, properties);
      const result = await factory('/unused', options).execute('shell', { command: 'command', timeout: 3 }, undefined, undefined, context);
      expect(reads).toBe(1);
      expect(calls).toEqual([['hook:command', '/remote/hook']]);
      expect(result.content).toEqual([{ type: 'text', text: 'stdout\n' }]);
      expect(result.structuredContent).toMatchObject({ output: 'stdout\n', truncated: false, exit_code: 0 });
    });
  }

  test(`${name} suppresses session environment and preserves command prefix`, async () => {
    const tool = factory('/remote', { exposeSessionEnvironment: false, commandPrefix: 'prefix', operations: {
      async exec(command, cwd, { env }) {
        expect(command).toBe('prefix\ncommand');
        expect(cwd).toBe('/remote');
        for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL']) expect(env![key]).toBeUndefined();
        return { exitCode: 0 };
      },
    } } as BashToolOptions);
    expect(tool.promptGuidelines).toBeUndefined();
    const result = await tool.execute('shell', { command: 'command' }, undefined, undefined, context);
    expect(result.structuredContent).toMatchObject({ output: '', exit_code: 0 });
  });

  test(`${name} retains non-zero exits, null exits and original failures`, async () => {
    for (const exitCode of [7, null]) {
      const tool = factory('/remote', { operations: { async exec(_command, _cwd, { onData }) {
        onData(Buffer.from('partial output')); return { exitCode };
      } } });
      const pending = tool.execute('shell', { command: 'command' });
      if (exitCode === null) await expect(pending).rejects.toThrow('partial output\n\nCommand terminated without an exit code');
      else {
        const result = await pending;
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ output: 'partial output', exit_code: 7 });
      }
    }
    const error = new Error('remote shell failed');
    await expect(factory('/remote', { operations: { exec: async () => { throw error; } } }).execute('shell', { command: 'command' })).rejects.toBe(error);
  });

  test(`${name} streams UTF-8, retains private spill bytes and caps structured output`, async () => {
    const payload = Buffer.from('开始\n' + '中文 output\n'.repeat(100_000) + '结束');
    let lateData: (data: Buffer) => void = () => {};
    const updates: unknown[] = [];
    const result = await factory('/remote', { operations: { async exec(_command, _cwd, { onData }) {
      lateData = onData;
      for (const bytes of [payload.subarray(0, 1), payload.subarray(1, 2), payload.subarray(2, 6), payload.subarray(6)]) onData(bytes);
      return { exitCode: 0 };
    } } }).execute('shell', { command: 'command' }, undefined, update => updates.push(update));
    const output = result.structuredContent as { output: string; truncated: boolean; full_output_path: string };
    const path = result.details!.fullOutputPath!;
    outputFiles.push(path);
    expect(output.full_output_path).toBe(path);
    expect(output.truncated).toBe(true);
    expect(output.output).toStartWith('开始\n');
    expect(output.output).toEndWith('结束');
    expect(output.output).not.toContain('�');
    expect(output.output).toContain('bytes omitted');
    expect(await readFile(path)).toEqual(payload);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(updates.length).toBeGreaterThan(1);
    lateData(Buffer.from('ignored late data'));
    expect(await readFile(path)).toEqual(payload);
  });
}

test('SDK shell defaults still execute without host dependencies', async () => {
  const cwd = await scratch();
  const result = await sdkBashDefinition(cwd).execute('shell', { command: 'printf sdk-default' });
  expect(result.structuredContent).toMatchObject({ output: 'sdk-default', exit_code: 0 });
});

test('local bash operations keep explicit shells, environment, streams and spawn failures', async () => {
  const cwd = await scratch();
  const output: Buffer[] = [];
  const result = await createLocalBashOperations({ shellPath: '/bin/sh' }).exec('printf "$HOST_SHELL_FIXTURE"; printf stderr >&2', cwd, {
    onData: data => output.push(data), env: { PATH: '/usr/bin:/bin', HOST_SHELL_FIXTURE: 'stdout' },
  });
  expect(result.exitCode).toBe(0);
  expect(Buffer.concat(output).toString()).toContain('stdout');
  expect(Buffer.concat(output).toString()).toContain('stderr');
  await expect(createLocalBashOperations({ shellPath: join(cwd, 'missing') }).exec('true', cwd, { onData: () => {} })).rejects.toThrow('Custom shell path not found:');
  await expect(createLocalBashOperations().exec('true', join(cwd, 'missing'), { onData: () => {} })).rejects.toThrow('Working directory does not exist:');
});

for (const timeout of [0, -1, Number.NaN, Infinity, 2_147_484]) {
  test(`local shell rejects invalid timeout ${timeout}`, async () => {
    await expect(createLocalBashOperations().exec('true', '/', { timeout, onData: () => {} })).rejects.toThrow('Invalid timeout:');
  });
}
function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function waitForProcessExit(pids: number[], timeout: number): Promise<number[]> {
  const deadline = Date.now() + timeout;
  while (pids.some(isRunning) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  return pids.filter(isRunning);
}
async function expectProcessTreeStopped(cwd: string) {
  const pids = await Promise.all(pidFiles.map(async file => Number(await readFile(join(cwd, file), 'utf8'))));
  expect(new Set(pids).size).toBe(3);
  for (const pid of pids) expect(Number.isInteger(pid) && pid > 1 && pid !== process.pid).toBe(true);
  expect(await waitForProcessExit(pids, 2000)).toEqual([]);
  for (const file of ['after-wait', 'child-after-wait']) {
    await expect(stat(join(cwd, file))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  processTrees.delete(cwd);
}
for (const [name, factory] of [['agent', createBashTool], ['definition', createBashToolDefinition]] as const) {
  test(`${name} shell cancels a running process tree without a later command`, async () => {
    const cwd = await scratch();
    processTrees.add(cwd);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    let ready = false;
    try {
      await expect(factory(cwd).execute('shell', { command: processTreeCommand }, controller.signal, update => {
        if (update.content.some(part => part.type === 'text' && part.text.includes('ready'))) {
          ready = true;
          controller.abort();
        }
      })).rejects.toThrow('Command aborted');
      expect(ready).toBe(true);
      await expectProcessTreeStopped(cwd);
    } finally { clearTimeout(timer); controller.abort(); }
  });
  test(`${name} shell times out a process tree and keeps partial output`, async () => {
    const cwd = await scratch();
    processTrees.add(cwd);
    await expect(factory(cwd).execute('shell', { command: processTreeCommand, timeout: 1 }))
      .rejects.toThrow('ready\n\nCommand timed out after 1 seconds');
    await expectProcessTreeStopped(cwd);
  });
}
test('pre-cancelled local shell performs no command', async () => {
  const cwd = await scratch();
  const controller = new AbortController(); controller.abort();
  await expect(createBashToolDefinition(cwd).execute('shell', { command: 'printf unexpected' }, controller.signal)).rejects.toThrow('Command aborted');
});

test('SDK local operations accept durable wait and host tracking', async () => {
  const cwd = await scratch();
  const calls: unknown[] = [];
  const operations = sdkBashOperations(undefined, {
    trackDetachedChildPid: pid => calls.push(['track', pid]),
    untrackDetachedChildPid: pid => calls.push(['untrack', pid]),
    waitForChildProcess: child => { calls.push(['wait', child.pid]); return waitForChildProcess(child); },
    killProcessTree,
  });
  expect((await operations.exec('printf tracking', cwd, { onData: () => {} })).exitCode).toBe(0);
  const pid = (calls[0] as unknown[])[1];
  expect(typeof pid).toBe('number');
  expect(calls).toEqual([['track', pid], ['wait', pid], ['untrack', pid]]);
});

test('SDK PowerShell local operations preserve the UTF-8 prefix and stdin transport', async () => {
  const cwd = await scratch();
  const output: Buffer[] = [];
  const operations = sdkPowerShellOperations({
    getPowerShellConfig: () => ({ shell: process.execPath, args: ['--no-env-file', '-e', 'process.stdin.pipe(process.stdout)'], commandTransport: 'stdin' }),
    waitForChildProcess,
  });
  expect((await operations.exec('fixture command', cwd, { onData: data => output.push(data) })).exitCode).toBe(0);
  expect(Buffer.concat(output).toString()).toBe('try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nfixture command');
  if (process.platform !== 'win32') await expect(createLocalPowerShellOperations().exec('fixture', cwd, { onData: () => {} })).rejects.toThrow('The powershell tool is only available on Windows.');
});

for (const [name, factory, prompt] of [['bash', createBashToolDefinition, '$'], ['powershell', createPowerShellToolDefinition, 'PS>']] as const) {
  test(`${name} SDK renderer retains components and stops its running timer`, () => {
    initTheme('dark', false);
    const theme = getThemeByName('dark')!;
    const tool = factory('/remote');
    const args = { command: 'fixture', timeout: 2 };
    const context = { cwd: '/remote', args, state: {}, argsComplete: true, outputPad: 1, expanded: false,
      showImages: false, isError: false, isRunning: true, invalidate: () => {}, lastComponent: undefined } as ToolRenderContext;
    try {
      const call = tool.renderCall!(args, theme, context);
      expect(call.render(100).join('\n')).toContain(prompt + ' fixture');
      expect(tool.renderCall!(args, theme, { ...context, lastComponent: call })).toBe(call);
      const result = { content: [{ type: 'text' as const, text: 'one\ntwo\nthree\nfour\nfive\nsix\nseven' }], details: undefined };
      const partial = tool.renderResult!(result, { expanded: false, isPartial: true }, theme, context);
      expect(partial.render(100).join('\n')).toContain('earlier lines');
      const settled = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, { ...context, lastComponent: partial });
      expect(settled).toBe(partial);
      expect(settled.render(100).join('\n')).toContain('seven');
      expect(context.state.interval).toBeUndefined();
    } finally { if (context.state.interval) clearInterval(context.state.interval); }
  });
}
