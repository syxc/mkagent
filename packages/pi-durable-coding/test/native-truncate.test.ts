import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as native from '../src/pi/core/tools/truncate.ts';
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
