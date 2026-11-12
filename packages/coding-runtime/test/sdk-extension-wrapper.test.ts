import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import ts from 'typescript';
import {
  wrapRegisteredTool, wrapRegisteredTools,
  type ExtensionRunner, type ExtensionToolContext, type RegisteredTool,
} from '@earendil-works/pi-coding-agent';
import { codingSDKImport } from '../scripts/coding-sdk-imports.ts';

const context = { cwd: '/fixture' } as ExtensionToolContext;
const registered = (execute: RegisteredTool['definition']['execute']): RegisteredTool => ({
  sourceInfo: { path: '/fixture/extension.ts', source: 'fixture', scope: 'temporary', origin: 'top-level' },
  definition: {
    name: 'fixture', label: 'Fixture', description: 'Test tool',
    parameters: Type.Object({ value: Type.String() }), execute,
  },
});

// Only the context factory is a fixture; execution uses the published SDK wrappers.
const runner = (createToolContext: ExtensionRunner['createToolContext']): ExtensionRunner =>
  ({ createToolContext }) as ExtensionRunner;

describe('published extension tool wrappers', () => {
  test('generation routes the existing named exports to the SDK and removes the source copy', () => {
    expect(codingSDKImport('core/extensions/index.ts', './wrapper.ts')).toBe('@earendil-works/pi-coding-agent');
    const barrel = fileURLToPath(new URL('../src/pi/core/extensions/index.ts', import.meta.url));
    const source = ts.createSourceFile(barrel, readFileSync(barrel, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const name of ['wrapRegisteredTool', 'wrapRegisteredTools']) {
      const declaration = source.statements.find(node => ts.isExportDeclaration(node)
        && node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.some(element => element.name.text === name));
      expect(declaration && ts.isExportDeclaration(declaration)
        && (declaration.moduleSpecifier as ts.StringLiteral).text).toBe('@earendil-works/pi-coding-agent');
    }
    expect(existsSync(new URL('../src/pi/core/extensions/wrapper.ts', import.meta.url))).toBe(false);
  });

  test('tool context, progress, result and metadata retain their identities', async () => {
    const controller = new AbortController();
    const params = { value: 'input' };
    const result = { content: [{ type: 'text' as const, text: 'done' }], details: { value: 42 } };
    const updates: unknown[] = [];
    const progress = (update: unknown) => { updates.push(update); };
    const calls: unknown[][] = [];
    const item = registered(async (...args) => { calls.push(args); args[3]?.(result); return result; });
    item.definition.replay = 'safe';
    item.definition.executionMode = 'parallel';
    const metadata = Symbol('metadata');
    Object.defineProperty(item.definition, metadata, { value: { durable: true }, enumerable: false });
    const contexts: unknown[][] = [];
    const tool = wrapRegisteredTool(item, runner((...args) => { contexts.push(args); return context; }));
    expect(await tool.execute('call-1', params, controller.signal, progress)).toBe(result);
    expect(contexts).toEqual([['call-1', controller.signal]]);
    expect(calls[0]).toEqual(['call-1', params, controller.signal, progress, context]);
    expect(calls[0][1]).toBe(params);
    expect(calls[0][4]).toBe(context);
    expect(updates[0]).toBe(result);
    expect(tool.parameters).toBe(item.definition.parameters);
    expect(tool.replay).toBe('safe');
    expect(tool.executionMode).toBe('parallel');
    expect(Object.getOwnPropertyDescriptor(tool, metadata)).toEqual(Object.getOwnPropertyDescriptor(item.definition, metadata));
    expect(Object.getOwnPropertyDescriptor(tool, metadata)?.value).toBe(Object.getOwnPropertyDescriptor(item.definition, metadata)?.value);
  });

  test('batch wrapping preserves order and creates context for each call', async () => {
    const calls: string[] = [];
    const items = ['first', 'second'].map(name => {
      const item = registered(async () => ({ content: [], details: name }));
      item.definition.name = name;
      return item;
    });
    const factory = runner(id => { calls.push(id); return context; });
    expect(wrapRegisteredTools([], factory)).toEqual([]);
    const tools = wrapRegisteredTools(items, factory);
    expect(tools.map(tool => tool.name)).toEqual(['first', 'second']);
    expect((await tools[1].execute('second-call', {}, undefined)).details).toBe('second');
    expect((await tools[0].execute('first-call', {}, undefined)).details).toBe('first');
    expect(calls).toEqual(['second-call', 'first-call']);
  });

  test('cancellation retains the original signal and rejection', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel fixture');
    const tool = wrapRegisteredTool(registered(async (_id, _params, signal) => {
      expect(signal).toBe(controller.signal);
      signal?.throwIfAborted();
      return { content: [], details: {} };
    }), runner(() => context));
    controller.abort(reason);
    await expect(tool.execute('cancel-call', {}, controller.signal)).rejects.toBe(reason);
  });

  test('context and execution failures keep the original error', async () => {
    const failure = new Error('fixture failure');
    const item = registered(async () => { throw failure; });
    const tool = wrapRegisteredTool(item, runner(() => context));
    await expect(tool.execute('failure-call', {}, undefined)).rejects.toBe(failure);
    const contextFailure = wrapRegisteredTool(item, runner(() => { throw failure; }));
    let thrown: unknown;
    try {
      contextFailure.execute('context-failure', {}, undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
  });
});
