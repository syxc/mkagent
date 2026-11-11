import { expect, mock, test } from 'bun:test';
import { spawn as bareSpawn } from 'child_process';
import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createShellHelpers } from '@earendil-works/pi-coding-agent';
import { getBinDir } from '../src/pi/config.ts';
import {
  getShellConfig, getShellEnv, killProcessTree, killTrackedDetachedChildren, trackDetachedChildPid, untrackDetachedChildPid,
} from '../src/compat/shell.ts';

const originalChildModule = { ...await import('node:child_process') };
const fixtures = mkdtempSync(join(tmpdir(), 'native-shell-'));
const bashCases: [string, string | undefined, string, boolean][] = [
  ['system32', undefined, 'C:\\Windows\\System32\\bash.exe', true],
  ['sysnative case', undefined, 'D:\\WINDOWS\\SYSNATIVE\\BASH.EXE', true],
  ['Git Bash', undefined, 'C:\\Program Files\\Git\\bin\\bash.exe', false],
  ['nested bash', undefined, 'C:\\Windows\\extra\\bash.exe', false],
  ['custom Windows directory', 'Q:\\System', 'Q:\\System\\System32\\bash.exe', true],
  ['custom Sysnative', 'Q:\\System', 'Q:\\System\\Sysnative\\bash.exe', true],
  ['different Windows directory', 'Q:\\System', 'C:\\Windows\\System32\\bash.exe', false],
  ['relative Windows directory', '\\Windows', 'C:\\Windows\\System32\\bash.exe', false],
];
for (const shell of new Set(bashCases.map(([, , shell]) => shell))) {
  writeFileSync(join(fixtures, shell), 'fixture');
}

function withSystemRoot<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.SystemRoot;
  if (value === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = value;
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previous;
  }
}

test.each(bashCases)('Native explicit shell retains WSL transport: %s', (_name, root, shell, legacy) => {
  const cwd = process.cwd();
  process.chdir(fixtures);
  try {
    const result = withSystemRoot(root, () => getShellConfig(shell));
    expect(result).toEqual(legacy
      ? { shell, args: ['-s'], commandTransport: 'stdin' }
      : { shell, args: ['-c'] });
  } finally { process.chdir(cwd); }
});

test('Native explicit shell preserves its synchronous missing-path error', () => {
  const shell = join(fixtures, 'missing-shell');
  expect(() => getShellConfig(shell)).toThrow(new Error(`Custom shell path not found: ${shell}`));
});

type KillCall = [number, NodeJS.Signals | number | undefined];
function withSignals(platform: string, failures: string[], run: () => void): KillCall[] {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalKill = Object.getOwnPropertyDescriptor(process, 'kill')!;
  const calls: KillCall[] = [];
  const probe = (pid: number, signal?: NodeJS.Signals | number) => {
    calls.push([pid, signal]);
    if (failures.includes(`${pid}:${signal}`)) throw new Error('fixture signal error');
    return true;
  };
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'kill', { value: probe, configurable: true });
  try {
    expect(Object.is(process.kill, probe)).toBe(true);
    run();
    return calls;
  } finally {
    Object.defineProperty(process, 'kill', originalKill);
    Object.defineProperty(process, 'platform', originalPlatform);
  }
}

const signalCases: [string, string, string[], KillCall[]][] = [
  ['macOS group', 'darwin', [], [[-42, 'SIGSTOP'], [-42, 'SIGKILL']]],
  ['macOS stop failure', 'darwin', ['-42:SIGSTOP'], [[-42, 'SIGSTOP'], [-42, 'SIGKILL']]],
  ['macOS group failure', 'darwin', ['-42:SIGKILL'], [[-42, 'SIGSTOP'], [-42, 'SIGKILL'], [42, 'SIGKILL']]],
  ['Unix group', 'linux', [], [[-42, 'SIGKILL']]],
  ['Unix fallback', 'linux', ['-42:SIGKILL'], [[-42, 'SIGKILL'], [42, 'SIGKILL']]],
  ['Unix gone', 'linux', ['-42:SIGKILL', '42:SIGKILL'], [[-42, 'SIGKILL'], [42, 'SIGKILL']]],
];
test.each(signalCases)('Native tree cleanup preserves signal order: %s', (_name, platform, failures, expected) => {
  expect(withSignals(platform, failures, () => killProcessTree(42))).toEqual(expected);
});

test('Native detached child tracking keeps its own clear and untrack policy', () => {
  const calls = withSignals('linux', [], () => {
    trackDetachedChildPid(41);
    trackDetachedChildPid(42);
    untrackDetachedChildPid(41);
    killTrackedDetachedChildren();
    killTrackedDetachedChildren();
  });
  expect(calls).toEqual([[-42, 'SIGKILL']]);
});

test('SDK shell helper instances isolate their PID sets and retain host cleanup', () => {
  const firstCalls: number[] = [], secondCalls: number[] = [];
  const first = createShellHelpers({ killProcessTree: pid => { firstCalls.push(pid); } });
  const second = createShellHelpers({ killProcessTree: pid => { secondCalls.push(pid); } });
  first.trackDetachedChildPid(41);
  first.trackDetachedChildPid(42);
  first.untrackDetachedChildPid(41);
  second.trackDetachedChildPid(43);
  const nativeCalls = withSignals('linux', [], () => {
    trackDetachedChildPid(44);
    first.killTrackedDetachedChildren();
    first.killTrackedDetachedChildren();
    expect(secondCalls).toEqual([]);
    second.killTrackedDetachedChildren();
    second.killTrackedDetachedChildren();
    killTrackedDetachedChildren();
  });
  expect(firstCalls).toEqual([42]);
  expect(secondCalls).toEqual([43]);
  expect(nativeCalls).toEqual([[-44, 'SIGKILL']]);
});

test('SDK shell helpers validate explicit paths before calling the host Bash policy', () => {
  const calls: string[] = [];
  const helpers = createShellHelpers({ getBashShellConfig: shell => {
    calls.push(shell);
    return { shell, args: ['-s'], commandTransport: 'stdin' };
  } });
  const shell = join(fixtures, bashCases[0][2]);
  expect(helpers.getShellConfig(shell)).toEqual({ shell, args: ['-s'], commandTransport: 'stdin' });
  expect(() => helpers.getShellConfig(join(fixtures, 'missing'))).toThrow();
  expect(calls).toEqual([shell]);
});

test('Native shell environment keeps the PATH key, adds the host bin once and leaves process.env unchanged', () => {
  const previous = Object.keys(process.env).filter(key => key.toLowerCase() === 'path')
    .map(key => [key, process.env[key]!] as const);
  for (const [key] of previous) delete process.env[key];
  try {
    process.env.Path = 'fixture-bin';
    expect(getShellEnv().Path).toBe([getBinDir(), 'fixture-bin'].join(delimiter));
    expect(process.env.Path).toBe('fixture-bin');
    process.env.Path = ['fixture-bin', getBinDir()].join(delimiter);
    expect(getShellEnv().Path).toBe(process.env.Path);
    const helpers = createShellHelpers({ getBinDir: () => 'other-host-bin' });
    expect(helpers.getShellEnv().Path).toBe(['other-host-bin', process.env.Path].join(delimiter));
    expect(getShellEnv().PATH).toBeUndefined();
  } finally {
    delete process.env.Path;
    for (const [key, value] of previous) process.env[key] = value;
  }
});

test.each([false, true])('Native Windows cleanup uses the trusted executable, spawn failure: %s', fails => {
  const calls: unknown[][] = [];
  const children: ChildProcess[] = [];
  const probe = (...args: unknown[]) => {
    calls.push(args);
    if (fails) throw new Error('fixture spawn error');
    const child = new ChildProcess();
    children.push(child);
    return child;
  };
  const factory = () => ({ ...originalChildModule, spawn: probe });
  mock.module('node:child_process', factory);
  mock.module('child_process', factory);
  try {
    expect(Object.is(bareSpawn, probe)).toBe(true);
    expect(Object.is(nodeSpawn, probe)).toBe(true);
    withSystemRoot(fixtures, () => withSignals('win32', [], () => killProcessTree(42)));
    expect(calls).toEqual([[join(fixtures, 'System32', 'taskkill.exe'),
      ['/F', '/T', '/PID', '42'], { stdio: 'ignore', detached: true, windowsHide: true }]]);
    for (const child of children) {
      expect(child.listenerCount('error')).toBe(1);
      expect(child.emit('error', new Error('fixture async spawn failure'))).toBe(true);
      expect(child.listenerCount('error')).toBe(0);
    }
  } finally {
    mock.module('node:child_process', () => originalChildModule);
    mock.module('child_process', () => originalChildModule);
  }
});
