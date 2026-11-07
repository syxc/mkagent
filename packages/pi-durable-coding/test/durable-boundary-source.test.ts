import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertBoundaryPatchScope, BOUNDARY_PATCH_FILES } from '../scripts/durable-boundary-source.ts';

const header = (source: string, target = source) => `diff --git a/${source} b/${target}\n`;
const boundary = 'dist/harness/generation.js';
const refused = /four-file boundary generator cannot replace the complete SDK patch/;

test('allows a new patch with no previous sections', () => {
  assert.doesNotThrow(() => assertBoundaryPatchScope(''));
});

test('allows the four historical sections with a hash header and CRLF', () => {
  const patch = '# patch sha256\n' + BOUNDARY_PATCH_FILES.map(path => header(path)).join('');
  assert.doesNotThrow(() => assertBoundaryPatchScope(patch.replaceAll('\n', '\r\n')));
});

for (const path of ['dist/codemode/codemode.js', 'dist/images/index.js', 'dist/tools/index.js']) {
  test(`preserves an existing additional section: ${path}`, () => {
    assert.throws(() => assertBoundaryPatchScope(header(boundary) + header(path)), refused);
  });
}

test('rejects a rename from an additional SDK file', () => {
  assert.throws(() => assertBoundaryPatchScope(header('dist/search.js', boundary)), refused);
});

test('rejects a rename to an additional SDK file', () => {
  assert.throws(() => assertBoundaryPatchScope(header(boundary, 'dist/search.js')), refused);
});

test('rejects an unrecognized file header', () => {
  assert.throws(() => assertBoundaryPatchScope('diff --git unexpected\n'), refused);
});

test('rejects the current complete SDK patch', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const path = join(root, 'patches/@earendil-works%2Fpi-durable@1.5.0.patch');
  assert.equal(realpathSync(path), path);
  assert.throws(() => assertBoundaryPatchScope(readFileSync(path, 'utf8')), refused);
});
