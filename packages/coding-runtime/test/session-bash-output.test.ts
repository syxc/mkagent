/** Stream errors must stay inside their test process. */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'coding-bash-output-tests-'));
afterAll(() => rm(directory, { recursive: true, force: true }));

for (const scenario of ['complete', 'cancel', 'file-error', 'execution-error']) {
  test(`SDK session Bash output: ${scenario}`, () => {
    const child = Bun.spawnSync([
      process.execPath, '--no-env-file', '--config=/dev/null',
      join(import.meta.dir, 'fixtures/session-bash-output.ts'), scenario,
    ], { env: { ...process.env, TMPDIR: directory }, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
    expect(JSON.parse(child.stdout.toString())).toEqual({ scenario, passed: true });
  });
}
