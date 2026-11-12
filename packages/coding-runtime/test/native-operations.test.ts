import { expect, test } from 'bun:test';
import {
  getExtensionModules, streamAssistantResponse as streamCoreResponse,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import {
  DEFAULT_AGENT_IDENTITY, prepareToolCall, streamAssistantResponse,
} from '../src/native-operations.ts';
import type { AgentTool, StreamFn } from '../src/agent-runtime.ts';

const { DEFAULT_AGENT_IDENTITY: coreIdentity } = (await getExtensionModules())['@earendil-works/pi-agent-core'] as {
  DEFAULT_AGENT_IDENTITY: Record<string, unknown>;
};

const model: Model<any> = {
  id: 'fixture', name: 'Fixture', api: 'fixture', provider: 'fixture', baseUrl: '',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000, maxTokens: 100,
};
function assistant(): AssistantMessage {
  return {
    role: 'assistant', content: [], api: 'fixture', provider: 'fixture', model: 'fixture',
    stopReason: 'stop', timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

test('Native request identity stays separate from the public core default', async () => {
  const coreBefore = Object.getOwnPropertyDescriptors(coreIdentity);
  const nativeBefore = DEFAULT_AGENT_IDENTITY.attribution;
  const identities: unknown[] = [];
  const stream: StreamFn = (_model, _context, options) => {
    identities.push(options?.identity);
    const response = createAssistantMessageEventStream(), message = assistant();
    response.push({ type: 'done', reason: 'stop', message });
    response.end(message);
    return response;
  };
  try {
    coreIdentity.attribution = { name: 'Core', url: 'https://core.invalid' };
    coreIdentity.userAgent = { custom: 'core-client' };
    coreIdentity.version = 'core-version';
    const config = { model, convertToLlm: () => [] };
    await streamAssistantResponse({ messages: [] }, config, undefined, () => {}, stream);
    const nativeMutation = { name: 'Native', url: 'https://native.invalid' };
    DEFAULT_AGENT_IDENTITY.attribution = nativeMutation;
    await streamAssistantResponse({ messages: [] }, config, undefined, () => {}, stream);
    await streamAssistantResponse({ messages: [] }, {
      ...config, identity: { attribution: null, userAgent: 'short' },
    }, undefined, () => {}, stream);
    await streamCoreResponse({ messages: [] }, config, undefined, () => {}, stream);
    expect(identities).toEqual([
      { attribution: nativeBefore }, { attribution: nativeMutation },
      { attribution: null, userAgent: 'short' },
      { attribution: { name: 'Core', url: 'https://core.invalid' },
        userAgent: { custom: 'core-client' }, version: 'core-version' },
    ]);
  } finally {
    DEFAULT_AGENT_IDENTITY.attribution = nativeBefore;
    for (const key of Reflect.ownKeys(coreIdentity)) Reflect.deleteProperty(coreIdentity, key);
    Object.defineProperties(coreIdentity, coreBefore);
  }
});

test('Tool preparation keeps hook arguments, call identity and cancellation', async () => {
  const trace: unknown[] = [], controller = new AbortController();
  const tool: AgentTool = {
    name: 'echo', label: 'Echo', description: 'Fixture',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    prepareArguments: () => ({ value: 'prepared' }),
    execute: async () => { throw new Error('Preparation must not execute the tool'); },
  };
  const toolCall = { type: 'toolCall' as const, id: 'call', name: 'echo', arguments: { value: 'raw' } };
  const message = assistant(), context = { messages: [message], tools: [tool] };
  const prepared = await prepareToolCall(context, message, toolCall, {
    beforeToolCall: async ({ args, toolCall: current }) => {
      trace.push(args, current === toolCall);
      await Promise.resolve();
      controller.abort();
      return undefined;
    },
  }, controller.signal);
  expect(trace).toEqual([{ value: 'prepared' }, true]);
  expect(prepared).toEqual({
    kind: 'immediate', result: { content: [{ type: 'text', text: 'Operation aborted' }], details: {} },
    isError: true,
  });
});
