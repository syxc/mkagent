import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const env = { ...process.env, NODE_PATH: dirname(dirname(dirname(wasm))) };
  const snapshot = JSON.parse(readFileSync(new URL('./fixtures/native-image-resize.json', import.meta.url), 'utf8'));
  const expected = snapshot.results.find((row: { name: string }) => row.name === 'sequential-dimension-rounding')?.expected;
  assert.ok(expected);
  try {
    mkdirSync(project);
    mkdirSync(bundle);
    writeFileSync(join(project, 'photon_rs_bg.wasm'), 'Project assets must never load');
    copyFileSync(wasm, join(bundle, 'photon_rs_bg.wasm'));
    for (const mode of ['node', 'bun-script', 'bun'] as const) {
      const output = join(bundle, mode === 'bun' ? 'probe' : `probe-${mode}.mjs`);
      execFileSync('bun', [
        'build', '--no-env-file', fixture, '--outfile=' + output,
        ...(mode === 'bun' ? ['--compile'] : [`--target=${mode === 'node' ? 'node' : 'bun'}`, '--format=esm']),
      ], { cwd: root, timeout: 30_000, stdio: 'pipe' });
      const command = mode === 'node' ? 'node' : mode === 'bun-script' ? 'bun' : output;
      const args = mode === 'bun' ? [] : [output];
      const result = execFileSync(command, args, { cwd: project, env, timeout: 10_000, encoding: 'utf8' });
      assert.deepEqual(JSON.parse(result), expected, mode);
      rmSync(join(bundle, 'photon_rs_bg.wasm'));
      const missing = execFileSync(command, [...args, '--expect-missing'], { cwd: project, env, timeout: 10_000, encoding: 'utf8' });
      assert.deepEqual(JSON.parse(missing), { available: false }, mode);
      copyFileSync(wasm, join(bundle, 'photon_rs_bg.wasm'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
