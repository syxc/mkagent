import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertBoundaryPatchScope, BOUNDARY_PATCH_FILES, createBoundaryPatch } from '../scripts/durable-boundary-source.ts';

const header = (source: string, target = source) => `diff --git a/${source} b/${target}\n`;
const boundary = 'dist/harness/generation.js';
const refused = /four-file boundary generator cannot replace the complete SDK patch/;
const existing = /cannot overwrite an existing SDK patch/;

test('allows creation when there is no previous patch', () => {
  assert.doesNotThrow(() => assertBoundaryPatchScope(undefined));
});

test('allows read-only checks of the four historical sections with a hash header and CRLF', () => {
  const patch = '# patch sha256\n' + BOUNDARY_PATCH_FILES.map(path => header(path)).join('');
  assert.doesNotThrow(() => assertBoundaryPatchScope(patch.replaceAll('\n', '\r\n'), true));
});

for (const path of ['dist/codemode/codemode.js', 'dist/images/index.js', 'dist/tools/index.js']) {
  test(`preserves an existing additional section: ${path}`, () => {
    assert.throws(() => assertBoundaryPatchScope(header(boundary) + header(path), true), refused);
  });
}

test('rejects a rename from an additional SDK file', () => {
  assert.throws(() => assertBoundaryPatchScope(header('dist/search.js', boundary), true), refused);
});

test('rejects a rename to an additional SDK file', () => {
  assert.throws(() => assertBoundaryPatchScope(header(boundary, 'dist/search.js'), true), refused);
});

test('rejects an unrecognized file header', () => {
  assert.throws(() => assertBoundaryPatchScope('diff --git unexpected\n', true), refused);
});

test('rejects the current complete SDK patch', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const path = join(root, 'patches/@earendil-works%2Fpi-durable@1.5.0.patch');
  assert.equal(realpathSync(path), path);
  const patch = readFileSync(path, 'utf8');
  assert.throws(() => assertBoundaryPatchScope(patch), existing);
  assert.throws(() => assertBoundaryPatchScope(patch, true), refused);
});

for (const [name, patch] of [
  ['empty existing patch', ''],
  ['non-Git existing patch', '--- original\n+++ changed\n@@ -1 +1 @@\n-old\n+new\n'],
  ['existing four-file fragment', BOUNDARY_PATCH_FILES.map(path => header(path)).join('')],
  ['additional changes in the same four files', BOUNDARY_PATCH_FILES.map(path => header(path) + '@@ -1 +1 @@\n-old\n+independent change\n').join('')],
]) {
  test(`never replaces: ${name}`, () => {
    assert.throws(() => assertBoundaryPatchScope(patch!), existing);
  });
}

for (const patch of ['', 'not a Git patch', undefined]) {
  test(`rejects a read-only check with no file sections: ${JSON.stringify(patch)}`, () => {
    assert.throws(() => assertBoundaryPatchScope(patch, true), /requires (an existing |a )Git patch/);
  });
}

test('creates an absent patch without replacing other files', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'boundary-patch-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'sdk.patch');
  assertBoundaryPatchScope(undefined);
  createBoundaryPatch(path, header(boundary));
  assert.equal(realpathSync(path), path);
  assert.equal(readFileSync(path, 'utf8'), header(boundary));
});

test('preserves a patch created after preflight', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'boundary-patch-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'sdk.patch');
  assertBoundaryPatchScope(undefined);
  const independent = header(boundary) + '@@ -1 +1 @@\n-original\n+independent\n';
  writeFileSync(path, independent, { flag: 'wx' });
  assert.equal(realpathSync(path), path);
  assert.throws(() => createBoundaryPatch(path, header(boundary)), { code: 'EEXIST' });
  assert.equal(readFileSync(path, 'utf8'), independent);
});
