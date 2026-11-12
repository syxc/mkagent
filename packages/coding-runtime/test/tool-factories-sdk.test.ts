import { expect, test } from 'bun:test';
import { trashFixture } from './fixtures/trash-fixture.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as native from '../src/native-tools.ts';
import { codingHostImport } from '../scripts/coding-sdk-imports.ts';

const names: sdk.ToolName[] = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];
const coding: sdk.ToolName[] = ['read', 'bash', 'edit', 'write'];
const readOnly: sdk.ToolName[] = ['read', 'grep', 'find', 'ls'];
const factories = {
  read: [sdk.createReadTool, sdk.createReadToolDefinition],
  bash: [sdk.createBashTool, sdk.createBashToolDefinition],
  powershell: [sdk.createPowerShellTool, sdk.createPowerShellToolDefinition],
  edit: [sdk.createEditTool, sdk.createEditToolDefinition],
  write: [sdk.createWriteTool, sdk.createWriteToolDefinition],
  grep: [sdk.createGrepTool, sdk.createGrepToolDefinition],
  find: [sdk.createFindTool, sdk.createFindToolDefinition],
  ls: [sdk.createLsTool, sdk.createLsToolDefinition],
};

test('SDK default aggregates retain tool order, schemas and unknown-tool errors', () => {
  expect([...sdk.allToolNames]).toEqual(names);
  for (const tool of names) {
    for (const [index, create] of [sdk.createTool, sdk.createToolDefinition].entries()) {
      const actual = create(tool, '/fixture');
      const expected = factories[tool][index]!('/fixture');
      expect(actual.name).toBe(expected.name);
      expect(actual.parameters).toEqual(expected.parameters);
    }
  }
  for (const tools of [sdk.createCodingTools('/fixture'), sdk.createCodingToolDefinitions('/fixture')]) {
    expect(tools.map(tool => tool.name)).toEqual(coding);
  }
  for (const tools of [sdk.createReadOnlyTools('/fixture'), sdk.createReadOnlyToolDefinitions('/fixture')]) {
    expect(tools.map(tool => tool.name)).toEqual(readOnly);
  }
  expect(Object.keys(sdk.createAllTools('/fixture'))).toEqual(names);
  expect(Object.keys(sdk.createAllToolDefinitions('/fixture'))).toEqual(names);
  for (const create of [sdk.createTool, sdk.createToolDefinition]) {
    expect(() => create('invalid' as sdk.ToolName, '/fixture')).toThrow('Unknown tool name: invalid');
  }
});

test('SDK assembly calls each selected factory once and preserves options by identity', () => {
  const calls: Array<{ tool: sdk.ToolName; definition: boolean; cwd: string; options: unknown }> = [];
  const dependencies: sdk.ToolFactoryDependencies = {};
  const options: sdk.ToolsOptions = {};
  for (const tool of names) {
    const title = tool === 'powershell' ? 'PowerShell' : tool[0].toUpperCase() + tool.slice(1);
    options[tool] = {};
    for (const definition of [false, true]) {
      const key = `create${title}Tool${definition ? 'Definition' : ''}` as keyof sdk.ToolFactoryDependencies;
      Object.assign(dependencies, { [key]: (cwd: string, supplied: unknown) => {
        calls.push({ tool, definition, cwd, options: supplied });
        return { name: tool };
      } });
    }
  }
  const bound = sdk.createToolFactories(dependencies);
  const cases = [
    [bound.createCodingTools, coding, false], [bound.createCodingToolDefinitions, coding, true],
    [bound.createReadOnlyTools, readOnly, false], [bound.createReadOnlyToolDefinitions, readOnly, true],
    [bound.createAllTools, names, false], [bound.createAllToolDefinitions, names, true],
  ] as const;
  for (const [create, selected, definition] of cases) {
    calls.length = 0;
    create('/fixture', options);
    expect(calls.map(call => call.tool)).toEqual(selected);
    for (const call of calls) {
      expect(call.definition).toBe(definition);
      expect(call.cwd).toBe('/fixture');
      expect(call.options).toBe(options[call.tool]);
    }
  }
  for (const tool of names) for (const definition of [false, true]) {
    calls.length = 0;
    (definition ? bound.createToolDefinition : bound.createTool)(tool, '/fixture', options);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ tool, definition, cwd: '/fixture', options: options[tool] });
    calls.length = 0;
    (definition ? bound.createToolDefinition : bound.createTool)(tool, '/fixture');
    expect(calls[0]?.options).toBeUndefined();
  }
  expect(sdk.createToolFactories({ createReadTool: undefined }).createTool('read', '/fixture').name).toBe('read');
  expect(sdk.createToolFactories({ createReadTool: native.createReadTool }).createTool('write', '/fixture').name).toBe('write');
  expect(sdk.createTool('read', '/fixture').name).toBe('read');
});

test('Native assembled tools write, edit and read a real file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'coding-tool-factories-'));
  try {
    const tools = native.createAllTools(cwd);
    await tools.write.execute('write', { path: 'note.txt', content: 'before\n' });
    const edit = tools.edit.prepareArguments!({ path: 'note.txt', oldText: 'before', newText: 'after' });
    await tools.edit.execute('edit', edit);
    const result = await tools.read.execute('read', { path: 'note.txt' });
    expect(readFileSync(join(cwd, 'note.txt'), 'utf8')).toBe('after\n');
    expect(result.content).toContainEqual({ type: 'text', text: 'after\n' });
  } finally {
    trashFixture(cwd);
  }
});

test('SDK assembly preserves inherited factories and propagates factory failures', () => {
  const failure = new Error('factory failure');
  const inherited = Object.create({ createReadTool: () => { throw failure; } });
  const bound = sdk.createToolFactories(inherited);
  expect(() => bound.createTool('read', '/fixture')).toThrow(failure);
  expect(bound.createTool('write', '/fixture').name).toBe('write');
  expect(sdk.createTool('read', '/fixture').name).toBe('read');
});

test('Native aggregates retain durable edit repair and host factories without changing SDK defaults', () => {
  expect(codingHostImport('index.ts', './core/tools/index.ts')).toBe('../native-tools.ts');
  expect(native.createWriteTool).toBe(sdk.createWriteTool);
  expect(native.createLsTool).toBe(sdk.createLsTool);
  expect(native.withFileMutationQueue).toBe(sdk.withFileMutationQueue);
  expect(native.allToolNames).toBe(sdk.allToolNames);
  for (const tool of names) for (const definition of [false, true]) {
    const actual = (definition ? native.createToolDefinition : native.createTool)(tool, '/fixture');
    expect(actual.name).toBe(tool);
    if (tool === 'edit') {
      expect(actual.prepareArguments).toBe(native.createEditTool('/fixture').prepareArguments);
      expect(actual.prepareArguments).toBeFunction();
      expect(sdk.createTool(tool, '/fixture').prepareArguments).toBe(sdk.createEditTool('/fixture').prepareArguments);
      expect(actual.prepareArguments).not.toBe(sdk.createEditTool('/fixture').prepareArguments);
    }
  }
  expect(native.createCodingTools('/fixture').map(tool => tool.name)).toEqual(coding);
  expect(native.createReadOnlyToolDefinitions('/fixture').map(tool => tool.name)).toEqual(readOnly);
  expect(Object.keys(native.createAllTools('/fixture'))).toEqual(names);
  expect(Object.keys(native.createAllToolDefinitions('/fixture'))).toEqual(names);
});
