import { createHash } from 'node:crypto';
import type { TruncationOptions } from '../../src/pi/core/tools/truncate.ts';

type Native = typeof import('../../src/pi/core/tools/truncate.ts');
export type TruncateCase = { name: string; run: (api: Native) => unknown };
export const truncateCases: TruncateCase[] = [];
const texts = [
  ['', 'empty'], ['a', 'one'], ['a\n', 'trailing newline'], ['\n', 'blank'], ['\n\n', 'two blanks'],
  ['a\nb\n', 'two lines'], ['abc\ndef', 'two words'], ['a\r\nb\r\n', 'CRLF'],
  ['中文\n😀x\n', 'Unicode'], ['\ud800\n\udc00', 'unpaired surrogates'], ['é\u0301\n', 'combining'],
  ['x'.repeat(51200), 'byte limit'], ['x'.repeat(51201), 'byte limit plus one'],
  ['x'.repeat(51200) + '\n', 'byte limit with newline'],
  ['x\n'.repeat(2000), 'line limit'], ['x\n'.repeat(2001), 'line limit plus one'],
] as const;
const limits: TruncationOptions[] = [
  {}, { maxLines: 1 }, { maxLines: 0 }, { maxLines: -1 }, { maxLines: 0.5 },
  { maxLines: Number.NaN }, { maxLines: Infinity },
  ...[-1, 0, 1, 2, 3, 4, 8, 51200, Infinity, Number.NaN].map(maxBytes => ({ maxBytes })),
  { maxLines: 1, maxBytes: 1 }, { maxLines: 1, maxBytes: 2 },
];
for (const [content, label] of texts) {
  for (const [index, options] of limits.entries()) {
    truncateCases.push(
      { name: `head ${label} limits ${index}`, run: api => api.truncateHead(content, options) },
      { name: `tail ${label} limits ${index}`, run: api => api.truncateTail(content, options) },
    );
  }
  for (const maxBytes of [-1, 0, 1, 2, 3, 4, 5, 8, 51200, Infinity, Number.NaN]) {
    truncateCases.push({ name: `middle ${label} bytes ${maxBytes}`, run: api => api.truncateMiddle(content, maxBytes) });
  }
  for (const maxChars of [-1, 0, 1, 3, 500]) {
    truncateCases.push({ name: `line ${label} chars ${maxChars}`, run: api => api.truncateLine(content, maxChars) });
  }
}
for (const bytes of [-1, 0, 0.5, 1023, 1024, 1536, 1048575, 1048576, Infinity, Number.NaN]) {
  truncateCases.push({ name: `size ${bytes}`, run: api => api.formatSize(bytes) });
}
truncateCases.push({ name: 'constants', run: api => [api.DEFAULT_MAX_LINES, api.DEFAULT_MAX_BYTES, api.GREP_MAX_LINE_LENGTH] });

export function evaluate(row: TruncateCase, api: Native): { value?: unknown; error?: Error } {
  try { return { value: row.run(api) }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error };
  }
}
export function digest(outcome: ReturnType<typeof evaluate>): string {
  const value = outcome.error ? { error: { name: outcome.error.name } } : { value: outcome.value };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
