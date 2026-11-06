import { expect, test } from 'bun:test';
import { tokenizeToolSearch } from '@earendil-works/pi-durable/tool-search';
import {
  Bm25Ranker,
  createToolSearchDocument,
  createToolSearchToolDefinition,
  tokenize,
} from '../src/pi/extensions/tool-search/tool.ts';

test('the SDK tokenizer is the shared durable tokenizer', () => {
  expect(tokenize).toBe(tokenizeToolSearch);
  expect(tokenize('搜索GitHub_repoIssues CAFÉ cafe\u0301')).toEqual([
    '搜索', 'git', 'hub', 'repo', 'issue', 'café', 'café',
  ]);
});

test('the SDK ranker preserves configurable BM25 scores', () => {
  const matches = new Bm25Ranker({ k1: 0.5, b: 1 }).rank('deploy', [
    { name: 'first', text: 'deploy deploy status' },
    { name: 'second', text: 'deploy' },
  ], 8);
  expect(matches).toEqual([
    { name: 'second', score: Math.log(1.2) * 1.2 },
    { name: 'first', score: Math.log(1.2) * (3 / 2.75) },
  ]);
});

test('namespace text remains a separate weighted search field', () => {
  expect(new Bm25Ranker().rank('kubernetes', [
    { name: 'run', text: 'Run it.', namespaceText: 'Kubernetes cluster tools' },
  ], 8)).toEqual([{ name: 'run', score: Math.log(1 + 0.5 / 1.5) * 0.5 }]);
});

test('schema metadata uses shared traversal and keeps namespace text separate', () => {
  expect(createToolSearchDocument({
    name: 'query', description: 'Search documents.',
    parameters: {
      type: 'object', description: 'Root schema', properties: {
        filters: { type: 'array', items: { anyOf: [{ description: 'first choice' }, { description: 'second choice' }] } },
      },
    },
  }, { name: 'docs', description: 'Reference', instructions: 'Use the archive' })).toEqual({
    name: 'query', text: 'Search documents. Root schema filters first choice second choice',
    namespaceText: 'docs Reference Use the archive',
  });
});

test('search retains native exposure filtering and session activation callbacks', async () => {
  const info = (name: string, exposure: 'direct' | 'codemode' | 'deferred' | 'model-only' | 'hidden') => ({
    name, label: name, description: 'Run a Kubernetes operation.', parameters: { type: 'object' },
    exposure,
  });
  const catalog = [
    info('direct', 'direct'), info('active', 'deferred'), info('script', 'codemode'),
    info('deferred', 'deferred'), info('model', 'model-only'), info('hidden', 'hidden'),
  ];
  let active = ['direct', 'active'];
  const changes: string[][] = [];
  const definition = createToolSearchToolDefinition({ tools: {
    getAllTools: () => catalog,
    getActiveTools: () => active,
    setActiveTools: (names) => { changes.push(names); active = names; },
  } });
  const result = await Reflect.apply(definition.execute, definition, ['search', { query: 'kubernetes' }]);
  expect(result.details.loaded).toEqual(['script', 'deferred']);
  expect(active).toEqual(['direct', 'active', 'script', 'deferred']);
  expect(changes).toHaveLength(1);
  const repeated = await Reflect.apply(definition.execute, definition, ['again', { query: 'kubernetes' }]);
  expect(repeated.details.loaded).toEqual([]);
  expect(changes).toHaveLength(1);
});
