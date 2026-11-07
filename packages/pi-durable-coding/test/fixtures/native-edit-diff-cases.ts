import { createHash } from 'node:crypto';
type API = typeof import('../../src/pi/core/tools/edit-diff.ts');
export type EditDiffCase = { name: string; run: (api: API) => unknown };
export const editDiffCases: EditDiffCase[] = [];
const texts = ['', '\n', 'a\r\nb\r\n', 'a\rb\n', '\ufeffa\n',
  'Ｈｅｌｌｏ ‘世界’\u00a0\nkeep\t\n', 'one\nTWO\nthree\nfour\nfive\nsix\n', '\ud800\n\udc00'];
for (const [index, text] of texts.entries()) {
  editDiffCases.push({ name: `text forms ${index}`, run: api => ({
    ending: api.detectLineEnding(text), lf: api.normalizeToLF(text), fuzzy: api.normalizeForFuzzyMatch(text),
    restoredLF: api.restoreLineEndings(text, '\n'), restoredCRLF: api.restoreLineEndings(text, '\r\n'),
  }) });
  for (const [needle, oldText] of ['', 'a', 'TWO', "Hello '世界'", '世界', 'missing', '\ud800'].entries()) {
    editDiffCases.push({ name: `find ${index} needle ${needle}`, run: api => api.fuzzyFindText(text, oldText) });
  }
}
const edits: { name: string; text: string; edits: { oldText: string; newText: string }[] }[] = [
  { name: 'exact', text: 'a\nb\n', edits: [{ oldText: 'a', newText: 'A' }] },
  { name: 'unordered disjoint', text: 'a\nb\nc\n', edits: [{ oldText: 'c', newText: 'C' }, { oldText: 'a', newText: 'A' }] },
  { name: 'adjacent', text: 'abcd', edits: [{ oldText: 'ab', newText: 'A' }, { oldText: 'cd', newText: 'B' }] },
  { name: 'overlap', text: 'abcde', edits: [{ oldText: 'abc', newText: 'A' }, { oldText: 'cde', newText: 'B' }] },
  { name: 'duplicate', text: 'a\na\n', edits: [{ oldText: 'a', newText: 'A' }] },
  { name: 'empty old text', text: 'a\n', edits: [{ oldText: '', newText: 'A' }] },
  { name: 'empty batch', text: 'a\n', edits: [] },
  { name: 'missing single', text: 'a\n', edits: [{ oldText: 'absent', newText: 'A' }] },
  { name: 'missing batch', text: 'a\nb\n', edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'absent', newText: 'B' }] },
  { name: 'no change single', text: 'a\n', edits: [{ oldText: 'a', newText: 'a' }] },
  { name: 'no change batch', text: 'a\nb\n', edits: [{ oldText: 'a', newText: 'a' }, { oldText: 'b', newText: 'b' }] },
  { name: 'not incremental', text: 'a\n', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'b', newText: 'c' }] },
  { name: 'fuzzy quote', text: 'keep \t\nTarget’s  \nkeep \t\n', edits: [{ oldText: "Target's", newText: 'changed' }] },
  { name: 'fuzzy duplicate', text: "‘a’\n'a'\n", edits: [{ oldText: "'a'", newText: 'b' }] },
  { name: 'fuzzy mixed batch', text: 'keep \t\n‘a’ \nb \t\nkeep \t\n',
    edits: [{ oldText: "'a'", newText: 'A' }, { oldText: 'b', newText: 'B' }] },
  { name: 'CRLF edits', text: 'a\nb\n', edits: [{ oldText: 'a\r\nb', newText: 'A\r\nB' }] },
  { name: 'multiline replacement', text: 'before\none\ntwo\nafter\n', edits: [{ oldText: 'one\ntwo', newText: 'changed' }] },
  { name: 'delete', text: 'before\ninside\nafter\n', edits: [{ oldText: 'inside\n', newText: '' }] },
];
for (const row of edits) editDiffCases.push({ name: `edits ${row.name}`,
  run: api => api.applyEditsToNormalizedContent(row.text, row.edits, 'fixture.txt') });
const ranges = [
  { original: 'keep \t\n‘x’ \nkeep \t\n', base: "keep\n'x'\nkeep\n", replacements: [{ matchIndex: 5, matchLength: 3, newText: 'y' }] },
  { original: 'a\nb\nc\n', base: 'a\nb\nc\n', replacements: [{ matchIndex: 4, matchLength: 1, newText: 'C' }, { matchIndex: 0, matchLength: 1, newText: 'A' }] },
  { original: 'a\n', base: 'a\nb\n', replacements: [] },
  { original: 'a\n', base: 'a\n', replacements: [{ matchIndex: 9, matchLength: 1, newText: 'A' }] },
  { original: 'a\n', base: 'a\n', replacements: [{ matchIndex: 0, matchLength: 9, newText: 'A' }] },
  { original: '', base: '', replacements: [] },
];
for (const [index, row] of ranges.entries()) editDiffCases.push({ name: `preserved ranges ${index}`,
  run: api => api.applyReplacementsPreservingUnchangedLines(row.original, row.base, row.replacements) });
const diffs = ['', 'one\n', 'one\nTWO\nthree\n', 'zero\none\nTWO\nthree\nfour\n', '\ufeff中文\r\n', '\ud800\n\udc00'];
for (const [left, oldText] of diffs.entries()) for (const [right, newText] of diffs.entries()) {
  for (const context of [-1, 0, 1, 4, Number.NaN, Infinity]) editDiffCases.push({
    name: `diff ${left} to ${right} context ${context}`,
    run: api => ({ display: api.generateDiffString(oldText, newText, context),
      patch: api.generateUnifiedPatch('fixture.txt', oldText, newText, context) }),
  });
}
editDiffCases.push({ name: 'public function metadata', run: api =>
  ['detectLineEnding', 'normalizeToLF', 'restoreLineEndings', 'normalizeForFuzzyMatch',
    'applyReplacementsPreservingUnchangedLines', 'fuzzyFindText', 'applyEditsToNormalizedContent',
    'generateUnifiedPatch', 'generateDiffString'].map(name => {
      const fn = api[name as keyof API];
      return { name: fn.name, length: fn.length };
    }) });
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
