/** Exercise real SIGKILLs through production SQLite/JSONL migration and queue admission. */
import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function worker(directory: string, backend: string, point: string, mode: string, variant = '') {
  return new Promise<{ signal: string | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-env-file', '--no-install',
      new URL('../../test/fixtures/coding-crash-worker.ts', import.meta.url).pathname, mode, directory, backend, point, variant], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, 'agent'),
        XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, NO_COLOR: '1', CI: '1' },
    });
    let output = '';
    let error = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Worker timeout: ${error}`)); }, 9_000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal !== 'SIGKILL' && code !== 0) reject(new Error(`Worker failed (${code}/${signal}): ${error}`));
      else resolve({ signal, output });
    });
  });
}
function texts(messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>) {
  return messages.filter(message => message.role === 'user').map(message =>
    typeof message.content === 'string' ? message.content :
      message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'));
}
for (const backend of ['sqlite', 'jsonl']) test(`production ${backend} resumes a committed handoff without repeating its tool`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'production-coding-handoff-'));
  directories.push(directory);
  const point = 'handoff:committed';
  expect((await worker(directory, backend, point, 'initial')).signal).toBe('SIGKILL');
  expect(readFileSync(join(directory, 'crash'), 'utf8')).toBe(point);
  const result = JSON.parse((await worker(directory, backend, point, 'resume')).output);
  expect(texts(result.messages)).toEqual(['handoff summary', 'handoff steering']);
  expect(texts(result.nativeMessages)).toEqual(['handoff summary', 'handoff steering']);
  expect(result.effects.filter((effect: string) => effect === 'handoff-tool')).toHaveLength(1);
  expect(result.errors).toEqual([]);
  expect(result.pending).toBe(0);
  const reopened = JSON.parse((await worker(directory, backend, point, 'reopen')).output);
  expect(reopened.messages).toEqual(result.messages);
  expect(reopened.effects).toEqual(result.effects);
}, 30_000);

for (const backend of ['sqlite', 'jsonl'])
for (const point of ['migration:running-without-child', 'migration:finalizing'])
test(`production ${backend} settles an interrupted input at ${point} without an older answer`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'production-coding-old-answer-'));
  directories.push(directory);
  await worker(directory, backend, point, 'seed');
  expect((await worker(directory, backend, point, 'initial')).signal).toBe('SIGKILL');
  expect(readFileSync(join(directory, 'crash'), 'utf8')).toBe(point);
  const result = JSON.parse((await worker(directory, backend, point, 'resume')).output);
  expect(texts(result.nativeMessages)).toEqual(['previous', 'original']);
  expect(result.admissions[0].status).toBe('unanswered');
  expect(result.admissions[0].answer).toBeUndefined();
  expect(result.errors.some((error: string) => /interrupted/.test(error))).toBe(true);
  expect(result.pending).toBe(0);
  expect(result.isIdle).toBe(true);
}, 30_000);

for (const backend of ['sqlite', 'jsonl'])
for (const point of ['migration:fence-before', 'migration:fence-after', 'migration:adopt-before',
  'migration:adopt-after', 'migration:child', 'migration:placed', 'migration:terminal',
  'queue:accepted', 'queue:drained', 'queue:placed', 'queue:nextTurn-child', 'queue:receipt-before-enqueue',
  'queue:cleared', 'queue:cleared-phase'])
test(`production ${backend} survives ${point}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'production-coding-crash-'));
  directories.push(directory);
  if (point.startsWith('migration:')) await worker(directory, backend, point, 'seed');
  const initial = await worker(directory, backend, point, 'initial');
  expect(initial.signal).toBe('SIGKILL');
  expect(readFileSync(join(directory, 'crash'), 'utf8')).toBe(point);
  const result = JSON.parse((await worker(directory, backend, point, 'resume')).output);
  expect(result.pending).toBe(0);
  expect(result.isIdle).toBe(true);
  const uncertainRequest = ['queue:accepted', 'queue:receipt-before-enqueue', 'queue:cleared', 'queue:cleared-phase'].includes(point);
  if (uncertainRequest) expect(result.errors.some((error: string) => /request was interrupted/.test(error))).toBe(true);
  else expect(result.errors).toEqual([]);
  // Native custom messages use their admission time; SessionManager uses its append time.
  const withoutTimestamp = (messages: Array<{ timestamp: number }>) =>
    messages.map(({ timestamp: _timestamp, ...message }) => message);
  // Durable model context excludes failure messages; native history keeps their diagnostics.
  const nativeContext = result.nativeAsModel.filter((message: { role: string; stopReason?: string }) =>
    message.role !== 'assistant' || !['error', 'aborted', 'deferred'].includes(message.stopReason ?? ''));
  expect(withoutTimestamp(result.messages)).toEqual(withoutTimestamp(nativeContext));
  if (uncertainRequest) expect(result.entries.filter((entry: {
    type: string; message?: { role: string; stopReason?: string };
  }) => entry.type === 'message' && entry.message?.role === 'assistant' && entry.message.stopReason === 'error')).toHaveLength(1);
  const remaining = point === 'queue:cleared' ? [] : Array(point === 'queue:cleared-phase' ? 1 : 4).fill('duplicate');
  // After an uncertain request the explicit new prompt starts before the retained native queues.
  const startsWithNewPrompt = point === 'queue:accepted' || point === 'queue:receipt-before-enqueue';
  expect(texts(result.nativeMessages)).toEqual(startsWithNewPrompt
    ? ['original', 'after', ...remaining]
    : ['original', ...remaining, ...(point.startsWith('queue:') ? ['after'] : [])]);
  if (point.startsWith('migration:')) {
    expect(result.admissions.map((item: { id: number }) => item.id))
      .toEqual(JSON.parse(readFileSync(join(directory, 'submissions.json'), 'utf8')));
    expect(result.admissions.map((item: { status: string }) => item.status)).toEqual(Array(5).fill('done'));
    expect(result.effects.filter((value: string) => value === 'input' || value === 'prepare')).toEqual([]);
  } else {
    expect(result.entries.filter((entry: { type: string; customType: string }) =>
      entry.type === 'custom_message' && entry.customType === 'next')).toHaveLength(2);
    expect(result.entries.filter((entry: { type: string; customType: string }) =>
      entry.type === 'custom_message' && entry.customType === 'context')).toHaveLength(2);
  }
  const reopened = JSON.parse((await worker(directory, backend, point, 'reopen')).output);
  expect(reopened.messages).toEqual(result.messages);
  expect(reopened.effects).toEqual(result.effects);
}, 30_000);

for (const backend of ['sqlite', 'jsonl']) test(`production ${backend} isolates admission from an unfinished hook`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'production-coding-hook-'));
  directories.push(directory);
  const point = 'queue:hook-accepted';
  expect((await worker(directory, backend, point, 'initial')).signal).toBe('SIGKILL');
  const result = JSON.parse((await worker(directory, backend, point, 'resume')).output);
  expect(result.pending).toBe(0);
  expect(result.isIdle).toBe(true);
  expect(result.effects.filter((value: string) => value === 'hook-admission')).toHaveLength(1);
  expect(texts(result.nativeMessages)).toEqual(['original', 'after']);
  expect(result.entries.filter((entry: { type: string; customType: string }) =>
    entry.type === 'custom_message' && entry.customType === 'next')).toHaveLength(1);
  expect(result.entries.filter((entry: { customType: string }) => entry.customType === 'uncommitted-hook')).toHaveLength(0);
  expect(result.errors.some((error: string) => /interrupted|uncertain/.test(error))).toBe(true);
}, 30_000);
