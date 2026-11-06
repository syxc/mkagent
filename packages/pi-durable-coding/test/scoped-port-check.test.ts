import { expect, test } from 'bun:test';
import { join } from 'node:path';

const script = join(import.meta.dir, '../scripts/vendor-coding-runtime.ts');

test.each([
  { flags: ['--file=core/messages.ts'], error: '--file requires --check' },
  { flags: ['--check', '--inventory', '--file=core/messages.ts'], error: '--file requires --check' },
  { flags: ['--check', '--file=core/runtime-credentials.ts'], error: 'Source is not permitted for a scoped check' },
  { flags: ['--check', '--file=core/Runtime-Credentials.ts'], error: 'Source is not permitted for a scoped check' },
  { flags: ['--check', '--file=CORE/RUNTIME-CREDENTIALS.ts'], error: 'Source is not permitted for a scoped check' },
  { flags: ['--check', '--file=../private.ts'], error: 'Source is not permitted for a scoped check' },
  { flags: ['--check', '--file=/private.ts'], error: 'Source is not permitted for a scoped check' },
  { flags: ['--check', '--file='], error: 'Source is not permitted for a scoped check' },
  { flags: ['--check', '--file'], error: 'Unknown option: --file' },
])('rejects unsafe scoped checks before opening a source checkout: $flags', ({ flags, error }) => {
  // The nonexistent checkout proves validation runs before source discovery or reading.
  const result = Bun.spawnSync([process.execPath, script, '/nonexistent-pi-checkout', ...flags], {
    env: process.env, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(error);
  expect(result.stderr.toString()).not.toContain('Expected clean pinned');
});
