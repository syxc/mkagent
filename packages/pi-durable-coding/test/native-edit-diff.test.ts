import { expect, mock, test } from 'bun:test';
import { constants } from 'node:fs';
import { access as liveAccess, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as native from '../src/pi/core/tools/edit-diff.ts';
import { editDiffCases, editDiffDigest, evaluateEditDiff } from './fixtures/native-edit-diff-cases.ts';

const promises = { ...await import('node:fs/promises') };
const baseline: { sourceSha256: string; cases: { name: string; digest: string }[] } =
  JSON.parse(await readFile(new URL('./fixtures/native-edit-diff-1.5.0.json', import.meta.url), 'utf8'));
test('Native edit diff keeps its original source baseline', () => {
  expect(baseline.sourceSha256).toBe('f85a9809eb44b9828236050cf38a8e45933e5cfd583a186e9a0e55a664dd3e8d');
  expect(baseline.cases.length).toBe(editDiffCases.length);
});
for (const [index, row] of editDiffCases.entries()) {
  test(`Native edit diff retains ${row.name}`, () => {
    expect(baseline.cases[index]!.name).toBe(row.name);
    expect(editDiffDigest(evaluateEditDiff(row, native))).toBe(baseline.cases[index]!.digest);
  });
}
async function withDirectory(run: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'native-edit-preview-'));
  try { await run(path); }
  finally { await rm(path, { recursive: true, force: true }); }
}
test('Native preview strips BOM and CRLF without writing the file', async () => {
  await withDirectory(async cwd => {
    const path = join(cwd, 'sample.txt'), content = '\ufeffbefore\r\nkeep\r\n';
    await writeFile(path, content);
    expect(await native.computeEditDiff('sample.txt', 'before', 'after', cwd))
      .toEqual({ diff: '-1 before\n+1 after\n 2 keep', firstChangedLine: 1 });
    expect(await readFile(path, 'utf8')).toBe(content);
  });
});
test('Native preview matches unordered edits against the original file', async () => {
  await withDirectory(async cwd => {
    const path = join(cwd, 'sample.txt'), content = 'a\nb\nc\n';
    await writeFile(path, content);
    expect(await native.computeEditsDiff('sample.txt',
      [{ oldText: 'c', newText: 'C' }, { oldText: 'a', newText: 'A' }], cwd))
      .toEqual({ diff: '-1 a\n+1 A\n 2 b\n-3 c\n+3 C', firstChangedLine: 1 });
    expect(await readFile(path, 'utf8')).toBe(content);
  });
});
test('Native preview returns duplicate errors without writing the file', async () => {
  await withDirectory(async cwd => {
    const path = join(cwd, 'sample.txt'), content = 'a\na\n';
    await writeFile(path, content);
    expect(await native.computeEditDiff('sample.txt', 'a', 'A', cwd)).toEqual({
      error: 'Found 2 occurrences of the text in sample.txt. The text must be unique. Please provide more context to make it unique.',
    });
    expect(await readFile(path, 'utf8')).toBe(content);
  });
});
test('Native preview keeps missing file diagnostics', async () => {
  await withDirectory(async cwd => {
    expect(await native.computeEditDiff('missing.txt', 'a', 'A', cwd)).toEqual({
      error: 'Could not edit file: missing.txt. Error code: ENOENT.',
    });
  });
});
test('Native preview checks readability and returns the original permission diagnostic', async () => {
  const calls: unknown[][] = [];
  const denied = async (...args: unknown[]) => {
    calls.push(args);
    throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
  };
  const factory = () => ({ ...promises, access: denied });
  mock.module('node:fs/promises', factory);
  mock.module('fs/promises', factory);
  try {
    expect(Object.is(liveAccess, denied)).toBe(true);
    expect(await native.computeEditDiff('denied.txt', 'a', 'A', '/preview-fixture'))
      .toEqual({ error: 'Could not edit file: denied.txt. Error code: EACCES.' });
    expect(calls).toEqual([['/preview-fixture/denied.txt', constants.R_OK]]);
  } finally {
    mock.module('node:fs/promises', () => promises);
    mock.module('fs/promises', () => promises);
  }
});
test('Native preview preserves resolution errors outside its result conversion', async () => {
  await expect(native.computeEditDiff('file://remote-host/path', 'a', 'A', '/preview-fixture')).rejects.toThrow();
});
