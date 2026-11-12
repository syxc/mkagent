import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as native from '@earendil-works/pi-coding-agent';
import { digest, evaluate, truncateCases } from './fixtures/native-truncate-cases.ts';

const baseline: { sourceSha256: string; cases: { name: string; digest: string; nodeDigest?: string; error: boolean }[] } =
  JSON.parse(readFileSync(new URL('./fixtures/native-truncate-1.5.0.json', import.meta.url), 'utf8'));

test('Native truncation retains the pinned source baseline', () => {
  expect(baseline.sourceSha256).toBe('8e4507c3ed7ca7548cf7c2d7f77d07f2ae63a38b756789cbb44e9062db6c8762');
  expect(baseline.cases.length).toBe(truncateCases.length);
});

for (const [index, row] of truncateCases.entries()) {
  test(`Native truncation retains ${row.name}`, () => {
    expect(baseline.cases[index]!.name).toBe(row.name);
    const outcome = evaluate(row, native);
    const recorded = baseline.cases[index]!;
    expect(digest(outcome)).toBe(process.versions.bun ? recorded.digest : recorded.nodeDigest ?? recorded.digest);
    if (baseline.cases[index]!.error) {
      let expected: Error | undefined;
      try { Reflect.apply(Buffer.byteLength, Buffer, [undefined, 'utf-8']); }
      catch (error) { if (error instanceof Error) expected = error; else throw error; }
      expect(outcome.error?.message).toBe(expected?.message);
      expect(outcome.error && 'code' in outcome.error ? outcome.error.code : undefined)
        .toBe(expected && 'code' in expected ? expected.code : undefined);
    }
  });
}

for (const [label, content] of [['number', 42], ['null', null], ['symbol', Symbol('fixture')]] as const) {
  test(`Native head keeps Buffer type errors for ${label}`, () => {
    const errors: Error[] = [];
    for (const run of [
      () => Reflect.apply(native.truncateHead, undefined, [content]),
      () => Reflect.apply(Buffer.byteLength, Buffer, [content, 'utf-8']),
    ]) {
      try { run(); }
      catch (error) { if (error instanceof Error) errors.push(error); else throw error; }
    }
    expect(errors.length).toBe(2);
    expect(errors[0]?.name).toBe(errors[1]?.name);
    expect(errors[0]?.message).toBe(errors[1]?.message);
  });
}

test('Native head reads each limit getter once in the original order', () => {
  const calls: string[] = [];
  const result = native.truncateHead('a\nb', {
    get maxLines() { calls.push('lines'); return calls.length; },
    get maxBytes() { calls.push('bytes'); return calls.length - 1; },
  });
  expect(calls).toEqual(['lines', 'bytes']);
  expect(result.content).toBe('a');
  expect(result.truncatedBy).toBe('lines');
  expect(result.maxLines).toBe(1);
  expect(result.maxBytes).toBe(1);
});

test('Native head retains an empty first line within a fractional byte allowance', () => {
  const result = native.truncateHead('\nabc\n', { maxBytes: 0.5 });
  expect(result.content).toBe('');
  expect(result.outputLines).toBe(1);
  expect(result.outputBytes).toBe(0);
  expect(result.truncatedBy).toBe('bytes');
  expect(result.firstLineExceedsLimit).toBe(false);
});

test('Native head preserves surrogate lines within their Buffer byte allowance', () => {
  const kept = ['\ud800', '\udc00'];
  const maxBytes = kept.reduce((bytes, line) => bytes + Buffer.byteLength(line, 'utf-8'), 1);
  const result = native.truncateHead(`${kept.join('\n')}\nlast\n`, { maxLines: 1.5, maxBytes });
  expect(result.content).toBe(kept.join('\n'));
  expect(result.outputLines).toBe(2);
  expect(result.outputBytes).toBe(Buffer.byteLength(kept.join('\n'), 'utf-8'));
  expect(result.truncatedBy).toBe('lines');
  expect(result.firstLineExceedsLimit).toBe(false);
});

test('Native tail retains an empty final line at a fractional byte limit', () => {
  const result = native.truncateTail('a\n\n', { maxBytes: 1.5, maxLines: 3 });
  expect(result.content).toBe('');
  expect(result.outputLines).toBe(1);
  expect(result.outputBytes).toBe(0);
  expect(result.truncatedBy).toBe('bytes');
  expect(result.lastLinePartial).toBe(false);
});

test('Native tail keeps original surrogate text within its Buffer byte allowance', () => {
  const kept = ['中\uFEFFa\uFEFF\udc00', '\ud800\ud800\uFEFF\udc00\ud800'];
  const maxBytes = kept.reduce((bytes, line) => bytes + Buffer.byteLength(line, 'utf-8'), 1);
  const result = native.truncateTail(`prefix\n${kept.join('\n')}\n`, { maxLines: 1.5, maxBytes });
  expect(result.content).toBe(kept.join('\n'));
  expect(result.outputLines).toBe(2);
  expect(result.outputBytes).toBe(Buffer.byteLength(kept.join('\n'), 'utf-8'));
  expect(result.truncatedBy).toBe('lines');
  expect(result.lastLinePartial).toBe(false);
});

test('Native tail retains fractional Buffer cuts within a UTF-8 character', () => {
  const result = native.truncateTail('é', { maxBytes: 0.5 });
  expect(result.content).toBe('\uFFFD');
  expect(result.outputLines).toBe(1);
  expect(result.lastLinePartial).toBe(true);
  expect(result.truncatedBy).toBe('bytes');
});

test('Native tail reads each limit getter once in the original order', () => {
  const calls: string[] = [];
  const result = native.truncateTail('a\nb', {
    get maxLines() { calls.push('lines'); return calls.length; },
    get maxBytes() { calls.push('bytes'); return calls.length - 1; },
  });
  expect(calls).toEqual(['lines', 'bytes']);
  expect(result.content).toBe('b');
  expect(result.truncatedBy).toBe('lines');
  expect(result.maxLines).toBe(1);
  expect(result.maxBytes).toBe(1);
});
