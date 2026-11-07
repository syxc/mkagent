import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('relocated Node and Bun binaries use one installed image asset', { timeout: 60_000 }, () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/shared-photon-probe.ts', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'mkagent-shared-photon-'));
  const project = join(directory, 'project');
  const bundle = join(directory, 'bundle');
  const wasm = realpathSync(fileURLToPath(import.meta.resolve('@silvia-odwyer/photon/photon_rs_bg.wasm')));
  assert.equal(wasm.toLowerCase().includes('runtime-credentials'), false);
  const snapshot = JSON.parse(readFileSync(new URL('./fixtures/native-image-resize.json', import.meta.url), 'utf8'));
  const expected = snapshot.results.find((row: { name: string }) => row.name === 'sequential-dimension-rounding')?.expected;
  assert.ok(expected);
  try {
    mkdirSync(project);
    mkdirSync(bundle);
    writeFileSync(join(project, 'photon_rs_bg.wasm'), 'Project assets must never load');
    copyFileSync(wasm, join(bundle, 'photon_rs_bg.wasm'));
    for (const mode of ['node', 'bun'] as const) {
      const output = join(bundle, mode === 'node' ? 'probe.mjs' : 'probe');
      execFileSync('bun', [
        'build', '--no-env-file', fixture, '--outfile=' + output,
        ...(mode === 'node' ? ['--target=node', '--format=esm'] : ['--compile']),
      ], { cwd: root, timeout: 30_000, stdio: 'pipe' });
      const command = mode === 'node' ? 'node' : output;
      const args = mode === 'node' ? [output] : [];
      const result = execFileSync(command, args, { cwd: project, timeout: 10_000, encoding: 'utf8' });
      assert.deepEqual(JSON.parse(result), expected, mode);
      rmSync(join(bundle, 'photon_rs_bg.wasm'));
      const missing = execFileSync(command, [...args, '--expect-missing'], { cwd: project, timeout: 10_000, encoding: 'utf8' });
      assert.deepEqual(JSON.parse(missing), { available: false }, mode);
      copyFileSync(wasm, join(bundle, 'photon_rs_bg.wasm'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
