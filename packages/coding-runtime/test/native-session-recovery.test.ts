/** Actual process death must recover a native session from the durable JSONL journal. */
import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function worker(directory: string, mode: string, replay: string, point: string) {
  return new Promise<{ output: string; code: number | null; signal: string | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--no-env-file', '--no-install', new URL('./fixtures/native-recovery-worker.ts', import.meta.url).pathname,
      mode, directory, replay, point,
    ], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, 'agent'),
        XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, NO_COLOR: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Recovery worker timeout: ${error}`)); }, 8_000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (mode === 'resume' && code !== 0) reject(new Error(`Recovery failed (${code}/${signal}): ${error}`));
      else resolve({ output, code, signal });
    });
  });
}

for (const point of ['request-context', 'request-message-start']) test(`does not repeat an interrupted ${point}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-request-recovery-'));
  directories.push(directory);
  expect((await worker(directory, 'initial', 'never', point)).signal).toBe('SIGKILL');
  expect(readFileSync(join(directory, 'crash'), 'utf8')).toBe(point);
  const restored = JSON.parse((await worker(directory, 'resume', 'never', point)).output);
  const effects: string[] = readFileSync(join(directory, 'effects.jsonl'), 'utf8').trim()
    .split('\n').map(line => JSON.parse(line));
  expect(effects.filter(effect => effect === point)).toHaveLength(1);
  expect(effects.filter(effect => effect.startsWith('request:'))).toHaveLength(point === 'request-context' ? 0 : 1);
  if (point === 'request-message-start')
    expect(effects.filter(effect => effect === 'recovery-error-notification')).toHaveLength(1);
  expect(restored.recoveryError).toContain('request was interrupted');
  expect(restored.pending).toBe(0);
  expect(restored.isIdle).toBe(true);
}, 15_000);

for (const [point, replay, executions] of [
  ['pi.coding.tool:execute', 'never', 0],
  ['pi.coding.tool:execute', 'safe', 1],
  ['effect', 'never', 1],
  ['effect', 'safe', 2],
  ['pi.coding.tool:finalize', 'never', 1],
  ['pi.coding.run:finish', 'never', 1],
] as const) test(`reopens after ${point} with replay=${replay}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-coding-recovery-'));
  directories.push(directory);
  const killed = await worker(directory, 'initial', replay, point);
  expect(killed.signal).toBe('SIGKILL');
  expect(readFileSync(join(directory, 'crash'), 'utf8')).toBe(point);
  const restored = JSON.parse((await worker(directory, 'resume', replay, point)).output);
  const effects: string[] = existsSync(join(directory, 'effects.jsonl'))
    ? readFileSync(join(directory, 'effects.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  expect(effects.filter(effect => effect === 'execute')).toHaveLength(executions);
  expect(effects.filter(effect => effect === 'tool_result')).toHaveLength(1);
  expect(effects.filter(effect => effect === 'turn_end')).toHaveLength(2);
  expect(effects.filter(effect => effect === 'before_settle')).toHaveLength(1);
  expect(restored.error).toBeUndefined();
  expect(restored.recoveryError).toBeUndefined();
  expect(restored.pending).toBe(0);
  expect(restored.messages.filter((message: { role: string }) => message.role === 'assistant')).toHaveLength(2);
  expect(restored.messages.filter((message: { role: string }) => message.role === 'toolResult')).toHaveLength(1);
  expect(restored.context).toEqual(restored.messages);
  const boundaries = restored.entries.filter((entry: { type: string; customType: string }) =>
    entry.type === 'custom' && entry.customType === 'boundary');
  expect(boundaries).toHaveLength(2);
}, 15_000);

for (const [point, interrupted, deferred] of [
  ['pi.coding.session:post', false, false],
  ['pi.coding.session:before-settle', false, false],
  ['pi.coding.session:finalize', false, false],
  ['pi.coding.session:posting', true, false],
  ['pi.coding.session:settling', true, false],
  ['pi.coding.session:finalizing', true, false],
  ['pi.coding.session:actions', false, true],
  ['pi.coding.session:action-preparing', true, true],
  ['accepted-action', true, true],
  ['root-terminal-action', false, true],
] as const) test(`restores the root lifecycle at ${point}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-root-recovery-'));
  directories.push(directory);
  const killed = await worker(directory, 'initial', 'never', point);
  expect(killed.signal).toBe('SIGKILL');
  expect(readFileSync(join(directory, 'crash'), 'utf8')).toBe(point);
  const restored = JSON.parse((await worker(directory, 'resume', 'never', point)).output);
  const effects: string[] = readFileSync(join(directory, 'effects.jsonl'), 'utf8').trim()
    .split('\n').map(line => JSON.parse(line));
  expect(restored.pending).toBe(0);
  expect(restored.isIdle).toBe(true);
  expect(effects.filter(effect => effect === 'execute')).toHaveLength(1);
  expect(restored.context).toEqual(restored.messages);
  if (interrupted) expect(restored.recoveryError).toContain('interrupted');
  else expect(restored.recoveryError).toBeUndefined();
  const accepted = restored.messages.filter((message: { role: string; content: unknown }) =>
    message.role === 'user' && JSON.stringify(message.content).includes('deferred'));
  if (deferred && !interrupted) {
    expect(accepted).toHaveLength(2);
    expect(effects.filter(effect => effect === 'request:final')).toHaveLength(3);
  } else if (deferred) {
    expect(accepted).toHaveLength(0);
    expect(restored.blocked.batches).toHaveLength(1);
    expect(JSON.stringify(restored.blocked)).toContain('deferred A');
  }
}, 15_000);
