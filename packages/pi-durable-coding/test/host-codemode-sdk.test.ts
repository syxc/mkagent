import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { CodemodeSandbox, getQuickJSWasmPath, loadQuickJSWasm } from '@earendil-works/pi-durable/codemode/node';
import * as native from '../src/native.ts';
import { createCodemodeTool, createCodemodeToolDefinition, type CodemodeToolOptions } from '../src/native-codemode.ts';
import type { AgentTool } from '@earendil-works/pi-agent-core';

const echo: AgentTool = {
  name: 'echo', label: 'echo', description: 'Echo a value',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  execute: async (_id, args) => ({ content: [{ type: 'text', text: String(args.value) }], details: {} }),
};
function context(): sdk.ExtensionToolContext {
  return {
    tools: [echo], sessionManager: { getBranch: () => [] },
    executeTool: async (name: string, args: unknown, options: { signal?: AbortSignal }) => {
      expect(name).toBe('echo');
      const toolCall = { type: 'toolCall' as const, id: 'sdk-child', name, arguments: args };
      const result = await echo.execute(toolCall.id, args, options.signal);
      return { toolCall, result, isError: false };
    },
  } as unknown as sdk.ExtensionToolContext;
}

const factories = [
  ['definition', (options: CodemodeToolOptions) => createCodemodeToolDefinition(options)],
  ['agent', (options: CodemodeToolOptions) => createCodemodeTool([echo], options)],
  ['extension', async (options: CodemodeToolOptions) => {
    let registered: sdk.ToolDefinition | undefined;
    await native.createCodemodeExtension({ models: false })({
      registerTool: (tool: sdk.ToolDefinition) => { registered = tool; },
      appendEntry: options.appendEntry,
      getAllTools: () => [echo],
      getSettings: () => ({ codemode: { mode: 'on' } }),
    } as unknown as sdk.ExtensionAPI);
    expect(registered?.defaultActive).toBe(false);
    return registered!;
  }],
] as const;

for (const [name, factory] of factories) {
  test(`${name} uses the durable executor and keeps store writes and nested results`, async () => {
    const writes: unknown[] = [];
    const options = Object.freeze(Object.create({ models: false }, {
      appendEntry: { value: function (this: unknown, kind: string, value: unknown) {
        if (name !== 'extension') expect(this).toBe(options);
        writes.push([kind, value]);
      } },
    })) as CodemodeToolOptions;
    const tool = await factory(options);
    const result = await tool.execute('sdk-script', { code: 'store("kept", 9); return await tools.echo({value:"SDK 中文"});' }, undefined, undefined, context());
    expect(result.content.some(item => item.type === 'text' && item.text.includes('SDK 中文'))).toBe(true);
    expect(result.details?.calls).toMatchObject([{ name: 'echo', status: 'ok' }]);
    expect(writes).toEqual([['codemode-store', { set: { kept: 9 }, delete: [] }]]);
    expect(tool.exposure).toBe('model-only');
    const presentation = name === 'agent' ? sdk.createCodemodeTool([echo], options) : sdk.createCodemodeToolDefinition();
    expect(tool.constrainedSampling).toEqual(presentation.constrainedSampling);
    expect(tool.renderCall).toBe(presentation.renderCall);
    expect(tool.renderResult).toBe(presentation.renderResult);
  });
}

test('inherited loadout options and discovery reach use the SDK contract', () => {
  const options = Object.create({
    models: false,
    getMode(this: unknown) { expect(this).toBe(options); return 'only'; },
    getInlineBudget(this: unknown) { expect(this).toBe(options); return 0; },
  });
  const tool = createCodemodeToolDefinition(options);
  const loadout = {
    callable: [echo], declared: [echo], getExposure: () => 'direct',
    getNamespace: () => undefined, getPromptGuidelines: () => [],
  } as unknown as sdk.ToolLoadout;
  expect(tool.prepareLoadout?.(loadout)).toEqual(sdk.createCodemodeToolDefinition(options).prepareLoadout?.(loadout));
  expect(tool.prepareLoadout?.(loadout)?.hiddenDeclarations).toEqual(['echo']);
  expect(tool.reachesTools?.({ code: 'await describeTool("echo")' })).toBe('all');
  expect(tool.reachesTools?.({ code: 'return tools.echo({})' })).toContain('echo');
});

test('the SDK default executor remains available without a host binding', async () => {
  const result = await sdk.createCodemodeToolDefinition({ models: false }).execute('default', { code: 'return "SDK default";' }, undefined, undefined, context());
  expect(result.content.some(item => item.type === 'text' && item.text.includes('SDK default'))).toBe(true);
});

test('the public durable worker survives bundling and runs without project dependencies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'durable-codemode-worker-'));
  let sandbox: CodemodeSandbox | undefined;
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../pi-agent-server/src/tools/codemode-worker.ts')],
      outdir: directory, naming: '[name].[ext]', target: 'bun', format: 'esm',
    });
    expect(build.success).toBe(true);
    const wasm = join(directory, 'quickjs.wasm');
    copyFileSync(getQuickJSWasmPath(), wasm);
    sandbox = new CodemodeSandbox({ workerUrl: new URL(`file://${join(directory, 'codemode-worker.js')}`), wasm: loadQuickJSWasm(wasm) });
    const result = await sandbox.execute('return "bundled 中文";');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('bundled 中文');
    expect(existsSync(join(directory, 'node_modules'))).toBe(false);
  } finally {
    await sandbox?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
