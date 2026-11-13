import { expect, test } from 'bun:test';
import { rankToolSearchDocuments, tokenizeToolSearch } from '@earendil-works/pi-durable/tool-search';
import { createToolSearchDocument, createToolSearchToolDefinition } from '../src/native-tool-search.ts';
import { createToolSearchExtension } from '../src/native.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';

test('the durable tokenizer preserves Unicode segmentation', () => {
  expect(tokenizeToolSearch('搜索GitHub_repoIssues CAFÉ café')).toEqual([
    '搜索', 'git', 'hub', 'repo', 'issue', 'café', 'café',
  ]);
});

test('the durable ranker preserves configurable BM25 scores', () => {
  const matches = rankToolSearchDocuments('deploy', [
    { name: 'first', text: 'deploy deploy status' },
    { name: 'second', text: 'deploy' },
  ], 8, { k1: 0.5, b: 1 });
  expect(matches).toEqual([
    { name: 'second', score: Math.log(1.2) * 1.2 },
    { name: 'first', score: Math.log(1.2) * (3 / 2.75) },
  ]);
});

test('namespace text remains a separate weighted search field', () => {
  expect(rankToolSearchDocuments('kubernetes', [
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

test('the public extension binds durable namespace search and remains inactive by default', async () => {
  let tool: ToolDefinition | undefined;
  let active: string[] = [];
  await createToolSearchExtension()({
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    getAllTools: () => [{ name: 'list', label: 'List', description: 'Read entries.',
      parameters: { type: 'object' }, exposure: 'deferred', namespace: { name: 'kubernetes' } }],
  } as unknown as ExtensionAPI);
  expect(tool?.defaultActive).toBe(false);
  expect(tool?.exposure).toBe('model-only');
  expect(tool?.reachesTools?.({})).toBe('all');
  const result = await Reflect.apply(tool!.execute, tool, ['namespace', { query: 'kubernetes' }]);
  expect(result.details.loaded).toEqual(['list']);
  expect(active).toEqual(['list']);
  expect(result.content).toEqual([{ type: 'text', text: 'Loaded 1 tool. They are available from your next call:\n- list: Read entries.' }]);
  await expect(Reflect.apply(tool!.execute, tool, ['empty', { query: ' ' }])).rejects.toThrow('query must not be empty');
  await expect(Reflect.apply(tool!.execute, tool, ['invalid', { query: 'kubernetes', limit: 0 }])).rejects.toThrow('limit must be a positive integer');
});
