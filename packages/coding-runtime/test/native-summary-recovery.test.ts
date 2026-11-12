/** A lost native continuation must never silently issue another summary model request. */
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function worker(directory: string, mode: string, point: string) {
  return new Promise<{ output: string; code: number | null; signal: string | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-env-file', '--no-install',
      new URL('./fixtures/native-summary-worker.ts', import.meta.url).pathname, mode, directory, point], {
      cwd: directory, env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory,
        XDG_CACHE_HOME: directory, PI_CODING_AGENT_DIR: join(directory, 'agent'), CI: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Summary recovery timeout: ${error}`)); }, 8_000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (mode === 'resume' && code !== 0) reject(new Error(`Summary recovery failed (${code}/${signal}): ${error}`));
      else resolve({ output, code, signal });
    });
  });
}

for (const point of ['admitted', 'request', 'committed']) test(`does not replay a native summary after SIGKILL at ${point}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-summary-recovery-'));
  try {
    expect((await worker(directory, 'initial', point)).signal).toBe('SIGKILL');
    const outcome = JSON.parse((await worker(directory, 'resume', point)).output);
    const effects = existsSync(join(directory, 'effects.jsonl'))
      ? readFileSync(join(directory, 'effects.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    expect(effects).not.toContain('repeated request');
    expect(effects.filter(value => value === 'request')).toHaveLength(point === 'admitted' ? 0 : 1);
    if (point === 'committed') {
      expect(outcome.status).toBe('completed');
      expect(outcome.result.response.content).toEqual([{ type: 'text', text: 'saved summary' }]);
    } else {
      expect(outcome.status).toBe('faulted');
      expect(outcome.error.message).toContain('interrupted');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
