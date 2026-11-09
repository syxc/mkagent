import { expect, test } from 'bun:test';
import { readPathVariants } from '@earendil-works/pi-durable/tools';

const { resolveReadToolPath } = await import(
  new URL('./path-utils.js', import.meta.resolve('@earendil-works/pi-durable/tools')).href);
const input = "/read-path-fixture/Café d'example";
const originalNormalize = String.prototype.normalize;

test('Shared read candidates keep Native lazy normalization and reuse', () => {
  let calls = 0;
  String.prototype.normalize = function (form) { calls++; return originalNormalize.call(this, form); };
  try {
    const iterator = readPathVariants(input);
    expect(iterator.next().value).toBe(input);
    iterator.next();
    expect(calls).toBe(0);
    iterator.next();
    expect(calls).toBe(1);
    [...iterator];
    expect(calls).toBe(1);
  } finally { String.prototype.normalize = originalNormalize; }
});

test('Durable normalizes both variants before the first existence probe', async () => {
  const calls: string[] = [];
  String.prototype.normalize = function (form) { calls.push('normalize'); return originalNormalize.call(this, form); };
  try {
    const result = await resolveReadToolPath({
      absolutePath: async () => ({ ok: true, value: input }),
      exists: async () => { calls.push('exists'); return { ok: true, value: true }; },
    }, input, {});
    expect(result).toBe(input);
    expect(calls).toEqual(['normalize', 'normalize', 'exists']);
  } finally { String.prototype.normalize = originalNormalize; }
});

test('Durable preserves errors from the second normalization before probing', async () => {
  const failure = new Error('second normalization failure');
  let calls = 0, probes = 0, caught: unknown;
  String.prototype.normalize = function (form) {
    if (++calls === 2) throw failure;
    return originalNormalize.call(this, form);
  };
  try {
    try {
      await resolveReadToolPath({
        absolutePath: async () => ({ ok: true, value: input }),
        exists: async () => { probes++; return { ok: true, value: true }; },
      }, input, {});
    } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(calls).toBe(2);
    expect(probes).toBe(0);
  } finally { String.prototype.normalize = originalNormalize; }
});
