import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as durable from '@earendil-works/pi-durable/tools';
import { generateDiffString, generateUnifiedPatch } from '../src/native.ts';
import { editDiffCases, editDiffDigest, evaluateEditDiff } from './fixtures/native-edit-diff-cases.ts';

const baseline: { sourceSha256: string; cases: { name: string; digest: string }[] } =
  JSON.parse(await readFile(new URL('./fixtures/native-edit-diff-1.5.0.json', import.meta.url), 'utf8'));
test('Native edit diff keeps its original source baseline', () => {
  expect(baseline.sourceSha256).toBe('f85a9809eb44b9828236050cf38a8e45933e5cfd583a186e9a0e55a664dd3e8d');
  expect(baseline.cases.length).toBe(editDiffCases.length);
  expect(generateDiffString).toBe(durable.generateDiffString);
  expect(generateUnifiedPatch).toBe(durable.generateUnifiedPatch);
});
for (const [index, row] of editDiffCases.entries()) {
  test(`Native edit diff retains ${row.name}`, () => {
    expect(baseline.cases[index]!.name).toBe(row.name);
    expect(editDiffDigest(evaluateEditDiff(row, durable))).toBe(baseline.cases[index]!.digest);
  });
}
