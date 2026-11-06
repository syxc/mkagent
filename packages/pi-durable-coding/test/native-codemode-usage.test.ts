import { expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, type ClassifierModel } from '@earendil-works/pi-ai';
import { createRegistry, Harness, MemoryStorage, UsageDoc } from '@earendil-works/pi-durable';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { executeNativeCodemode } from '../src/compat/codemode-native.ts';
import { DurableLoopBinding, currentCodingHostToolApi, currentCodingToolInvocation } from '../src/durable-coding/engine.ts';
import { NATIVE_CODEMODE_FORWARD } from '../src/durable-coding/codemode-forward.ts';
import { agentToolToHost, hostToolToAgent } from '../src/host-tools.ts';
import type { ExtensionToolContext } from '../src/pi/core/extensions/types.ts';

const context = BACKGROUND_CONTEXT;
const usage = (total: number) => ({
  input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

test.each([
  { kind: 'official', override: 'none' }, { kind: 'native', override: 'none' },
  { kind: 'official', override: 'wrapper' }, { kind: 'native', override: 'wrapper' },
  { kind: 'native', override: 'hook' },
  { kind: 'official', override: 'copy' }, { kind: 'native', override: 'passthrough' },
] as const)('Native usage accounting retains the presentation and explicit overrides (%s)', async ({ kind, override }) => {
  const accounted = override !== 'wrapper' && override !== 'hook';
  const displayUsage = accounted ? 5 : 13;
  const registry = createRegistry(), models = createModels();
  const model: ClassifierModel<'fixture'> = {
    id: 'judge', name: 'Judge', type: 'classifier', provider: 'local', api: 'fixture',
    baseUrl: 'https://host.invalid', input: ['text'], contextWindow: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  models.setProvider({ ...fauxProvider().provider, id: 'local', getAllModels: () => [model], getModels: () => [] });
  let modelEffects = 0, toolEffects = 0, appends = 0;
  models.classify = async () => {
    modelEffects++;
    return { api: model.api, provider: model.provider, model: model.id, timestamp: 0,
      stopReason: 'stop', answers: { valid: { type: 'bool', probability: 1 } }, usage: usage(5) };
  };
  const leaf: AgentTool = {
    name: 'leaf', label: 'leaf', description: 'Native usage leaf', parameters: { type: 'object' },
    execute: async () => ({ content: [], details: {} }),
  };
  const ctx = {
    tools: [leaf], modelRegistry: models, sessionManager: { getBranch: () => [] },
    executeTool: async (name: string, args: unknown) => {
      toolEffects++;
      return { toolCall: { type: 'toolCall', id: 'leaf-child', name, arguments: args },
        result: { content: [{ type: 'text', text: 'leaf result' }], details: {}, usage: usage(3) }, isError: false };
    },
  } as unknown as ExtensionToolContext;
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const binding = new DurableLoopBinding({ kernel: { harness, conversation, registry } });
  let nativeOwner: ReturnType<typeof currentCodingToolInvocation>['runtime']['taskId'] | undefined;
  let persistedResult: Awaited<ReturnType<typeof executeNativeCodemode>> | undefined;
  const native: AgentTool = {
    name: 'native-script', label: 'native-script', description: 'Native codemode as an official tool',
    parameters: { type: 'object' },
    execute: async (id, _args, signal) => {
      if (kind === 'native') nativeOwner = currentCodingToolInvocation().runtime.taskId;
      const run = () => executeNativeCodemode(id, {
        code: `await tools.leaf({}); store("once",1);
          return await models.classify({provider:"local",id:"judge"},
          {state:{},questions:{valid:{type:"bool",instructions:"fixture",criteria:{true:"yes",false:"no"}}}});`,
      }, signal, undefined, ctx, { models: true, appendEntry: () => { appends++; } });
      const first = await run();
      expect(await run()).toEqual(first);
      expect(first.usage?.totalTokens).toBe(5);
      // Native plugin wrappers use object spreads before the host adapter consumes the marker.
      return Object.freeze({ ...first, ...(override === 'wrapper' ? { usage: usage(13) } :
        override === 'copy' ? { usage: usage(5) } : {}) });
    },
  };
  registry.install({
    name: 'native-usage-test',
    tools: [agentToolToHost(native, (api, ctx, work) => binding.withHostToolScope(api, ctx, work))],
  });
  const bootstrap = hostToolToAgent({
    name: 'bootstrap', description: 'Exercise an official Native parent', parameters: { type: 'object' },
    execute: async (_args, api, ctx) => {
      expect(currentCodingHostToolApi()?.api.taskId).toBe(api.taskId);
      if (kind === 'official') {
        const result = await api.executeTool(native.name, {}, ctx);
        expect(result.isError).toBe(false);
        expect(result.usage?.totalTokens).toBe(override === 'wrapper' ? 13 : undefined);
      } else {
        expect(nativeOwner).toBeDefined();
        const record = await api.getTask(nativeOwner!, ctx);
        expect(record?.state).toMatchObject({ status: 'terminal', outcome: { result: {
          ...(accounted ? { hostUsageAccounted: true } : {}),
          result: { usage: usage(displayUsage) },
        } } });
        if (!accounted) {
          const outcome = record?.state.status === 'terminal' ? record.state.outcome : undefined;
          expect(outcome?.result).not.toHaveProperty('hostUsageAccounted');
        }
        const projected = await agentToolToHost({ ...native,
          execute: async () => ({ ...persistedResult! }),
        }).execute({}, api, ctx);
        expect(projected.usage?.totalTokens).toBe(accounted ? undefined : 13);
      }
      const ledger = await api.snapshot(UsageDoc, api.conversationId, ctx);
      expect(ledger?.tools[NATIVE_CODEMODE_FORWARD]?.totalTokens).toBe(8);
      expect(ledger?.tools[native.name]?.totalTokens).toBe(kind === 'official' && override === 'wrapper' ? 13 : undefined);
      return { output: [] };
    },
  });
  try {
    if (kind === 'native') {
      const result = await binding.runTool({ type: 'toolCall', id: 'native-usage-owner', name: native.name, arguments: {} }, {
        tools: [native], assistantMessage: fauxAssistantMessage([]), context: { messages: [], tools: [native] },
        ...(override === 'hook' ? { afterToolCall: async () => ({ usage: usage(13) }) } : {}),
        ...(override === 'passthrough' ? { afterToolCall: async () => ({ usage: usage(5) }) } : {}),
      });
      if (result.isError) throw new Error(JSON.stringify(result.result));
      persistedResult = result.result as Awaited<ReturnType<typeof executeNativeCodemode>>;
      expect(persistedResult.usage?.totalTokens).toBe(displayUsage);
    }
    const result = await binding.runTool({ type: 'toolCall', id: 'usage-owner', name: bootstrap.name, arguments: {} }, {
      tools: [bootstrap], assistantMessage: fauxAssistantMessage([]), context: { messages: [], tools: [bootstrap] },
    });
    if (result.isError) throw new Error(JSON.stringify(result.result));
    expect(modelEffects).toBe(1);
    expect(toolEffects).toBe(1);
    expect(appends).toBe(1);
  } finally { await binding.close(); await harness.close(context); }
}, 6000);

test.each(['completed', 'refused'] as const)('an interrupted Native script restores %s outcomes after the model catalog changes', async kind => {
  const registry = createRegistry(), models = createModels();
  const model: ClassifierModel<'fixture'> = {
    id: 'judge', name: 'Judge', type: 'classifier', provider: 'local', api: 'fixture',
    baseUrl: 'https://host.invalid', input: ['text'], contextWindow: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  models.setProvider({ ...fauxProvider().provider, id: 'local', getAllModels: () => [model], getModels: () => [] });
  const lookup = models.getModelOfType.bind(models);
  if (kind === 'refused') models.getModelOfType = () => undefined;
  let modelEffects = 0, toolEffects = 0, originalEffects = 0, wrongEffects = 0;
  models.classify = async () => {
    modelEffects++;
    return { api: model.api, provider: model.provider, model: model.id, timestamp: 0,
      stopReason: 'stop', answers: { valid: { type: 'bool', probability: 1 } }, usage: usage(5) };
  };
  let entered!: () => void;
  const ready = new Promise<void>(done => { entered = done; });
  const controller = new AbortController();
  const wait: AgentTool = {
    name: 'wait', label: 'wait', description: 'Wait for cancellation', parameters: { type: 'object' },
    execute: async () => ({ content: [], details: {} }),
  };
  const original: AgentTool = { ...wait, name: 'pi.codemode.custom' };
  const currentTools = [wait, original];
  const ctx = {
    get tools() { return currentTools; }, modelRegistry: models, sessionManager: { getBranch: () => [] },
    executeTool: async (name: string, args: unknown, options: { signal?: AbortSignal }) => {
      if (name !== 'wait') {
        if (name === original.name) originalEffects++;
        else wrongEffects++;
        return { toolCall: { type: 'toolCall', id: 'saved-native-custom', name, arguments: args },
          result: { content: [{ type: 'text', text: name === original.name ? 'original-prefix' : 'wrong-tool' }], details: {} },
          isError: false };
      }
      toolEffects++;
      entered();
      await new Promise<void>(done => {
        if (options.signal?.aborted) done();
        else options.signal?.addEventListener('abort', () => done(), { once: true });
      });
      return { toolCall: { type: 'toolCall', id: 'saved-native-child', name, arguments: args },
        result: { content: [{ type: 'text', text: 'cancelled fixture wait' }], details: {} }, isError: true };
    },
  } as unknown as ExtensionToolContext;
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const binding = new DurableLoopBinding({ kernel: { harness, conversation, registry } });
  const bootstrap = hostToolToAgent({
    name: 'bootstrap', description: 'Resume under the actual same owner', parameters: { type: 'object' },
    execute: async (_args, api, ctxHost) => {
      const classification = `await models.classify({provider:"local",id:"judge"},
        {state:{},questions:{valid:{type:"bool",instructions:"fixture",criteria:{true:"yes",false:"no"}}}});
      `;
      const code = kind === 'completed' ? `const result=${classification}
        try { await tools.wait({}); } catch {}
        return [result.answers.valid.probability,await tools.pi_codemode_custom({})];` : `
        try { ${classification} } catch (error) { text("old-validation:" + error.message); }
        try { await tools.wait({}); } catch {}
        return await tools.pi_codemode_custom({});`;
      const running = executeNativeCodemode(api.callId, { code }, controller.signal, undefined, ctx, { models: true });
      await ready;
      controller.abort(new Error('fixture interruption'));
      expect((await running).isError).toBe(true);
      currentTools.push({ ...original, name: 'mkagent.native:pi.codemode.custom' });
      models.getModelOfType = kind === 'completed' ? () => undefined : lookup;
      const resumed = await executeNativeCodemode(api.callId, { code }, undefined, undefined, ctx, { models: true });
      if (resumed.isError) throw new Error(JSON.stringify(resumed));
      expect(resumed.details.calls).toMatchObject(kind === 'completed' ? [
        { id: `${api.callId}/models.classify/1`, name: 'models.classify', status: 'ok' },
        { id: 'saved-native-child', name: 'wait', status: 'cancelled' },
        { id: 'saved-native-custom', name: original.name, status: 'ok' },
      ] : [
        { id: 'saved-native-child', name: 'wait', status: 'cancelled' },
        { id: 'saved-native-custom', name: original.name, status: 'ok' },
      ]);
      expect(JSON.stringify(resumed.content)).toContain('original-prefix');
      if (kind === 'refused') expect(JSON.stringify(resumed.content)).toContain('old-validation:');
      expect(resumed.usage?.totalTokens).toBe(kind === 'completed' ? 5 : undefined);
      expect((await api.snapshot(UsageDoc, api.conversationId, ctxHost))?.tools[NATIVE_CODEMODE_FORWARD]?.totalTokens)
        .toBe(kind === 'completed' ? 5 : undefined);
      return { output: [] };
    },
  });
  try {
    const result = await binding.runTool({ type: 'toolCall', id: 'resume-owner', name: bootstrap.name, arguments: {} }, {
      tools: [bootstrap], assistantMessage: fauxAssistantMessage([]), context: { messages: [], tools: [bootstrap] },
    });
    if (result.isError) throw new Error(JSON.stringify(result.result));
    expect(modelEffects).toBe(kind === 'completed' ? 1 : 0);
    expect(toolEffects).toBe(1);
    expect({ originalEffects, wrongEffects }).toEqual({ originalEffects: 1, wrongEffects: 0 });
  } finally { await binding.close(); await harness.close(context); }
}, 6000);
