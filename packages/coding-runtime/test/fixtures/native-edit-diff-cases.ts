import { createHash } from 'node:crypto';
type API = Pick<typeof import('@earendil-works/pi-durable/tools'), 'generateDiffString' | 'generateUnifiedPatch'>;
export type EditDiffCase = { name: string; run: (api: API) => unknown };
export const editDiffCases: EditDiffCase[] = [];
const diffs = ['', 'one\n', 'one\nTWO\nthree\n', 'zero\none\nTWO\nthree\nfour\n', '﻿中文\r\n', '\ud800\n\udc00'];
for (const [left, oldText] of diffs.entries()) for (const [right, newText] of diffs.entries()) {
  for (const context of [-1, 0, 1, 4, Number.NaN, Infinity]) editDiffCases.push({
    name: `diff ${left} to ${right} context ${context}`,
    run: api => ({ display: api.generateDiffString(oldText, newText, context),
      patch: api.generateUnifiedPatch('fixture.txt', oldText, newText, context) }),
  });
}
export function evaluateEditDiff(row: EditDiffCase, api: API): unknown {
  try { return { value: row.run(api) }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: { name: error.name, message: error.message, code: 'code' in error ? error.code : undefined } };
  }
}
export function editDiffDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
