// Adoption probes: both executors are real; no ToolExecutionApi is fabricated.
import { afterEach, describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall,
} from '@earendil-works/pi-ai';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import {
  createRegistry, defineExtension, Harness, MemoryStorage,
  type ToolExecutionResult, type ToolRegistration,
} from '@earendil-works/pi-durable';
import {
  createCodemodeExtension, type CodemodeToolOptions,
} from '@earendil-works/pi-durable/codemode';
import type { AgentTool } from '../src/agent-runtime.ts';
import type { ExtensionToolContext } from '../src/pi/core/extensions/types.ts';
import { executeCodemode } from '../src/pi/extensions/codemode/execute.ts';
import type { CodemodeStoreEntryData } from '../src/pi/extensions/codemode/tool.ts';

const context = BACKGROUND_CONTEXT;
const cleanups: (() => Promise<unknown>)[] = [];
const files = new Set<string>();
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const path of files) {
    if (!path.startsWith(tmpdir())) throw new Error('Unexpected output file location');
    await unlink(path);
  }
  files.clear();
});

function texts(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap(item => item.type === 'text' ? [item.text ?? ''] : []).join('');
}

function itemText(content: readonly { type: string; text?: string }[], index: number): string {
  const item = content[index];
  if (item?.type !== 'text' || typeof item.text !== 'string') throw new Error('Expected text output');
  return item.text;
}

const nativeEcho: AgentTool = {
  name: 'echo', label: 'echo', description: 'Echo a value',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  execute: async (_id, args) => ({ content: [{ type: 'text', text: String(args.value) }], details: {} }),
};
const hostEcho: ToolRegistration = {
  name: 'echo', description: nativeEcho.description, parameters: nativeEcho.parameters,
  execute: async args => ({ output: [{ type: 'text', text: String(args.value) }] }),
};

// Only the native extension context is stubbed. The durable tool receives the official ToolTask API.
function nativeContext(tools: AgentTool[] = [nativeEcho], store: Record<string, unknown> = {}): ExtensionToolContext {
  return {
    tools,
    sessionManager: {
      getBranch: () => [{ type: 'custom', customType: 'codemode-store', data: { set: store, delete: [] } }],
    },
    executeTool: async (name: string, args: unknown, options: { signal?: AbortSignal }) => {
      const tool = tools.find(candidate => candidate.name === name)!;
      const toolCall = { type: 'toolCall' as const, id: 'native-child', name, arguments: args };
      const result = await tool.execute(toolCall.id, args, options.signal);
      return { toolCall, result, isError: result.isError ?? false };
    },
  } as unknown as ExtensionToolContext;
}

async function builtin(
  options: Omit<CodemodeToolOptions, 'sandbox'> = {},
  tools: ToolRegistration[] = [hostEcho],
) {
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
  cleanups.push(() => sandbox.close());
  let result: ToolExecutionResult | undefined;
  let failure: unknown;
  const extension = createCodemodeExtension({ sandbox, models: false, ...options });
  const registry = createRegistry();
  registry.install({
    ...extension,
    tools: extension.tools?.map(tool => tool.name === 'codemode' ? {
      ...tool,
      outputLimits: { maxBytes: 16 * 1024 * 1024, maxLines: 1_000_000 },
      execute: async (args, api, ctx) => {
        try {
          result = await tool.execute(args, api, ctx);
          return result;
        } catch (error) {
          failure = error;
          throw error;
        }
      },
    } : tool),
  });
  registry.install(defineExtension({ name: 'fixtures', tools }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const reports: unknown[] = [];
  const harness = await Harness.open(new MemoryStorage(), {
    registry, models,
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
    onReport: report => { reports.push(report); },
  }, context);
  cleanups.push(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  return async (code: string) => {
    result = undefined;
    failure = undefined;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('codemode', { code }, { id: 'script' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('done')]),
    ]);
    expect((await (await root.submit({ type: 'input', content: 'Run the script' }, context)).wait(context)).status)
      .toBe('done');
    expect(reports).toEqual([]);
    if (failure !== undefined) throw failure;
    expect(result).toBeDefined();
    return result!;
  };
}

describe('public durable codemode adoption boundaries', () => {
  test('the public executor returns numeric call IDs while the SDK reports live string IDs', async () => {
    const updates: unknown[] = [];
    const code = 'return await tools.echo({ value: "hello" });';
    const native = await executeCodemode('script', { code }, undefined, result => {
      updates.push(result.details.calls[0]?.id);
    }, nativeContext());
    const run = await builtin();
    const durable = await run(code);
    expect(texts(native.content).replace(/Wall time [\d.]+/, 'Wall time')).toBe(
      texts(durable.output!).replace(/Wall time [\d.]+/, 'Wall time'),
    );
    expect(native.details.calls[0].id).toBe('native-child');
    expect(updates).toContain('script/?');
    expect(updates).toContain('native-child');
    expect(durable.details).toMatchObject({ calls: [{ id: 1, name: 'echo', status: 'ok' }] });
  }, 10_000);

  test('public namespace prefixes do not preserve native namespace aliases', async () => {
    const code = 'return [await describeNamespace("docs"), await describeNamespace("manual")];';
    const native = await executeCodemode('script', { code }, undefined, undefined, nativeContext(), {
      getToolNamespace: () => ({ name: 'docs', aliases: ['manual'], instructions: 'Read the manual' }),
    });
    const run = await builtin({
      namespaces: [{ name: 'docs', prefix: 'echo', instructions: 'Read the manual' }],
    });
    const durable = await run(code);
    const namespace = { name: 'docs', instructions: 'Read the manual', tools: ['echo'] };
    expect(JSON.parse(itemText(native.content, 1))).toEqual([namespace, namespace]);
    expect(JSON.parse(itemText(durable.output!, 1))).toEqual([namespace, null]);
  }, 10_000);

  test('the discovery override port accepts a same-named public global', async () => {
    const run = await builtin({
      globals: [{ name: 'describeNamespace', spread: true, execute: async () => 'override' }],
    });
    expect(itemText((await run('return await describeNamespace("docs");')).output!, 1)).toBe('override');
  }, 10_000);

  test('raising host output limits does not raise the built-in formatter ceiling', async () => {
    const code = '// @options: {"max_output_tokens":400000}\nreturn "x".repeat(1100000);';
    const native = await executeCodemode('script', { code }, undefined, undefined, undefined);
    const run = await builtin();
    const durable = await run(code);
    expect(itemText(native.content, 1).length).toBe(1_100_000);
    expect(native.details.fullOutputPath).toBeUndefined();
    expect(texts(durable.output!)).toContain('Warning: truncated output');
    expect(texts(durable.output!)).toContain('Could not save the full output: no execution environment');
  }, 10_000);

  test('standalone SDK images are saved even when the durable kernel has no execution environment', async () => {
    const code = 'image("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOXsAAAAASUVORK5CYII=");';
    const native = await executeCodemode('script', { code }, undefined, undefined, undefined);
    const path = /\[Image saved to (.+) \(image\/png,/.exec(texts(native.content))?.[1];
    expect(path).toBeDefined();
    files.add(path!);
    const run = await builtin();
    const durable = await run(code);
    expect(texts(durable.output!)).toContain('could not be saved: no execution environment');
    expect(native.content.filter(item => item.type === 'image')).toEqual(
      durable.output!.filter(item => item.type === 'image'),
    );
  }, 10_000);

  test('native append callbacks retain no-op writes and absent callbacks discard later-call state', async () => {
    const writes: CodemodeStoreEntryData[] = [];
    const code = 'store("kept", 1); store("missing", undefined); return load("kept");';
    await executeCodemode('script', { code }, undefined, undefined, nativeContext([], { kept: 1 }), {
      appendEntry: (_kind, data) => { writes.push(data); },
    });
    expect(writes).toEqual([{ set: { kept: 1 }, delete: ['missing'] }]);
    await executeCodemode('script', { code: 'store("ephemeral", 7);' }, undefined, undefined, undefined);
    const native = await executeCodemode('script', { code: 'return load("ephemeral");' }, undefined, undefined, undefined);
    expect(native.content).toHaveLength(1);
    const run = await builtin();
    await run('store("ephemeral", 7);');
    expect(itemText((await run('return load("ephemeral");')).output!, 1)).toBe('7');
  }, 10_000);
});
