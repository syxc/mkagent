import { expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createRegistry, Harness, MemoryStorage, ToolTask, type TaskId } from '@earendil-works/pi-durable';
import { executeNativeCodemode } from '../src/compat/codemode-native.ts';
import {
  currentCodingHostToolApi, currentCodingToolInvocation, DurableLoopBinding, runDurableToolCall,
} from '../src/durable-coding/engine.ts';
import type { ExtensionToolContext } from '../src/pi/core/extensions/types.ts';

test('the actual Native task entry retains nested preparation, permission denial and result hooks', async () => {
  const context = BACKGROUND_CONTEXT;
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { registry, models: createModels() }, context);
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const binding = new DurableLoopBinding({ kernel: { harness, conversation, registry } });
  let effects = 0, before = 0, after = 0, issued = 0;
  let root!: TaskId;
  const leaf: AgentTool<{ value: string }> = {
    name: 'echo', label: 'Echo', description: 'Exercise the Native nested pipeline',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    execute: async (_id, args) => {
      effects++;
      expect(args.value).toBe('permission-modified');
      const own = currentCodingToolInvocation();
      expect((await own.runtime.getTask(own.runtime.taskId, own.context))?.kind).toBe('pi.coding.tool');
      const kinds: string[] = [];
      let id: TaskId | undefined = own.runtime.taskId;
      for (let i = 0; i < 8 && id; i++) {
        const task = await own.runtime.getTask(id, own.context);
        if (!task) throw new Error('Missing Native ancestor');
        kinds.push(task.kind);
        if (id === root) break;
        id = task.owner;
      }
      expect(id).toBe(root);
      expect(kinds).toContain(ToolTask.definition.name);
      return { content: [{ type: 'text', text: args.value }], details: {} };
    },
  };
  const ctx = {
    tools: [leaf], sessionManager: { getBranch: () => [] },
    executeTool: async (name: string, args: Record<string, unknown>, options: { signal?: AbortSignal }) => {
      expect(currentCodingHostToolApi()).toBeDefined();
      return runDurableToolCall({ type: 'toolCall', id: `native-leaf-${++issued}`, name, arguments: args }, {
        tools: [leaf], assistantMessage: fauxAssistantMessage([]),
        context: { messages: [], tools: [leaf] }, signal: options.signal,
        beforeToolCall: async event => {
          before++;
          if ((event.args as { value: string }).value === 'deny') return { block: true, reason: 'permission refused' };
          (event.args as { value: string }).value = 'permission-modified';
        },
        afterToolCall: async () => {
          after++;
          return { content: [{ type: 'text', text: 'after-hook-result' }] };
        },
      });
    },
  } as unknown as ExtensionToolContext;
  const native: AgentTool<{ code: string }> = {
    name: 'codemode', label: 'Code', description: 'Actual Native task entry',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    execute: async (id, args, signal, update) => {
      root = currentCodingToolInvocation().runtime.taskId;
      expect(currentCodingHostToolApi()?.api.taskId).toBe(root);
      return executeNativeCodemode(id, args, signal, update, ctx);
    },
  };
  try {
    const result = await binding.runTool({ type: 'toolCall', id: 'native-entry', name: native.name, arguments: {
      code: `const allowed=await tools.echo({value:"original"});
        let refused; try { await tools.echo({value:"deny"}); } catch(error) { refused=error.message; }
        return {allowed,refused};`,
    } }, { tools: [native], assistantMessage: fauxAssistantMessage([]), context: { messages: [], tools: [native] } });
    if (result.isError) throw new Error(JSON.stringify(result.result));
    const output = result.result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
    expect(output).toContain('after-hook-result');
    expect(output).toContain('permission refused');
    expect(result.result.details).toMatchObject({ calls: [
      { id: 'native-leaf-1', name: 'echo', status: 'ok' },
      { id: 'native-leaf-2', name: 'echo', status: 'error' },
    ] });
    expect({ effects, before, after }).toEqual({ effects: 1, before: 2, after: 1 });
  } finally { await binding.close(); await harness.close(context); }
}, 6000);
