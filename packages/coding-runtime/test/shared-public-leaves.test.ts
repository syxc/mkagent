/** Small public implementations retain the Native contracts at their existing paths. */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { type Model } from '@earendil-works/pi-ai';
import { InMemoryCodingAgentModelsStore, StringEnum, Type } from '@earendil-works/pi-coding-agent';
import type { Static, TUnsafe } from 'typebox';
import { calculateContextTokens } from '../src/pi/core/compaction/compaction.ts';

test('Native model stores isolate providers and clone nested data on both boundaries', async () => {
  const store = new InMemoryCodingAgentModelsStore();
  const model: Model<'faux'> = {
    api: 'faux', provider: 'local', id: 'fixture', name: 'Fixture', baseUrl: 'http://unused.invalid',
    reasoning: false, input: ['text'], contextWindow: 10, maxTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const entry = { models: [model], etag: 'original' };
  await store.write('a', entry);
  model.cost.input = 4;
  entry.etag = 'changed';
  const first = (await store.read('a'))!;
  assert.equal(first.etag, 'original');
  assert.equal((first.models[0] as Model<'faux'>).cost.input, 0);
  first.etag = 'mutated read';
  assert.equal((await store.read('a'))?.etag, 'original');
  assert.equal(await store.read('b'), undefined);
  await store.delete('a');
  assert.equal(await store.read('a'), undefined);
  assert.equal(await new InMemoryCodingAgentModelsStore().read('a'), undefined);
  assert.equal(store.constructor.name, 'InMemoryCodingAgentModelsStore');
  assert.equal(InMemoryCodingAgentModelsStore.length, 0);
});

test('Native model stores reject cancellation and clone failures before changing data', async () => {
  const store = new InMemoryCodingAgentModelsStore();
  const entry = { models: [], etag: 'original' };
  await store.write('a', entry);
  const reason = new Error('Synthetic cancellation');
  const controller = new AbortController();
  controller.abort(reason);
  const options = { signal: controller.signal };
  for (const operation of [
    store.read('a', options), store.write('a', { models: [] }, options), store.delete('a', options),
  ]) await assert.rejects(operation, error => error === reason);
  await assert.rejects(store.write('a', { ...entry, invalid: () => {} } as typeof entry), { name: 'DataCloneError' });
  assert.deepEqual(await store.read('a'), entry);
});

test('Native StringEnum keeps TypeBox branding and literal inference', () => {
  const values = ['read', 'write'] as const;
  const schema = Type.Object({ action: StringEnum(values, { description: 'Action', default: 'read' }) });
  type Value = Static<typeof schema>;
  const value: Value = { action: 'write' };
  // @ts-expect-error The old plugin signature rejects values outside the literal union.
  const invalid: Value = { action: 'remove' };
  const legacySchema: TUnsafe<'read' | 'write'> = StringEnum(values);
  assert.equal(value.action, 'write');
  void invalid;
  assert.notEqual(Reflect.get(legacySchema, 'enum'), values);
  assert.deepEqual(Reflect.get(legacySchema, 'enum'), values);
  assert.deepEqual(Object.getOwnPropertyDescriptor(legacySchema, '~unsafe'), {
    value: null, enumerable: false, writable: true, configurable: true,
  });
  assert.notEqual(Reflect.get(schema.properties.action, 'enum'), values);
  assert.deepEqual(Reflect.get(schema.properties.action, 'enum'), values);
  assert.deepEqual(StringEnum([]), { type: 'string', enum: [] });
  assert.equal(Reflect.get(schema.properties.action, 'default'), 'read');
});

test('Native usage totals retain totalTokens preference and zero fallback', () => {
  const usage = {
    input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  assert.equal(calculateContextTokens(usage), 20);
  usage.totalTokens = 0;
  assert.equal(calculateContextTokens(usage), 10);
  usage.totalTokens = -1;
  assert.equal(calculateContextTokens(usage), -1);
  usage.totalTokens = Number.NaN;
  assert.equal(calculateContextTokens(usage), 10);
});
