/** Native preflight remains authoritative when SDK ToolTask executes an accepted effect. */
import { expect, spyOn, test } from 'bun:test';
import { ToolTask } from '@earendil-works/pi-durable';
import type { AgentTool } from '../src/agent-runtime.ts';
import { runToolCall } from '../src/durable-loop.ts';
import { agentToolToHost, hostToolToAgent } from '../src/host-tools.ts';
import { createToolDefinitionFromAgentTool, wrapToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { hostToolExecution } from '../src/host-tool-task.ts';
import { response } from './fixtures/durable-harness.ts';

test('SDK tool conversions preserve durable ownership and declaration metadata', () => {
  const reachesTools = () => 'all' as const;
  const tool: AgentTool & Pick<ToolDefinition,
    'exposure' | 'namespace' | 'annotations' | 'reachesTools' | 'defaultActive' | 'promptSnippet' | 'promptGuidelines'> = {
    name: 'fixture', label: 'Fixture', description: 'Local metadata fixture', parameters: { type: 'object' },
    replay: 'safe', exposure: 'deferred', namespace: { name: 'fixture' }, annotations: { readOnlyHint: true },
    reachesTools, defaultActive: false, promptSnippet: 'Fixture prompt', promptGuidelines: ['Fixture rule'],
    execute: async () => ({ content: [], details: {} }),
  };
  Object.defineProperty(tool, hostToolExecution, { value: true });
  const definition = createToolDefinitionFromAgentTool(tool);
  const roundtrip = wrapToolDefinition(definition);
  for (const converted of [definition, roundtrip]) {
    expect(Object.getOwnPropertyDescriptor(converted, hostToolExecution))
      .toEqual(Object.getOwnPropertyDescriptor(tool, hostToolExecution));
    expect(converted).toMatchObject({
      replay: 'safe', exposure: 'deferred', namespace: { name: 'fixture' }, annotations: { readOnlyHint: true },
      reachesTools, defaultActive: false, promptSnippet: 'Fixture prompt', promptGuidelines: ['Fixture rule'],
    });
  }
});

type Mode = 'plain' | 'bridged' | 'roundtrip';
function targetTool(native: AgentTool, mode: Mode): AgentTool {
  const tool = mode === 'plain' ? native : hostToolToAgent(agentToolToHost(native));
  return mode === 'roundtrip' ? wrapToolDefinition(createToolDefinitionFromAgentTool(tool)) : tool;
}

for (const mode of ['plain', 'bridged', 'roundtrip'] as const) {
  test(`cancellation during SDK admission prevents a ${mode} effect`, async () => {
    const controller = new AbortController();
    let effects = 0;
    const native: AgentTool = {
      name: 'fixture', label: 'Fixture', description: 'Local cancellation fixture', parameters: { type: 'object' },
      execute: async () => { effects++; return { content: [{ type: 'text', text: 'unexpected effect' }], details: {} }; },
    };
    const target = targetTool(native, mode);
    const call = ToolTask.definition.phases.call;
    const phase = spyOn(ToolTask.definition.phases, 'call').mockImplementation(async (...args) => {
      controller.abort();
      await call(...args);
    });
    try {
      const outcome = await runToolCall({ type: 'toolCall', id: 'cancelled', name: target.name, arguments: {} }, {
        tools: [target], assistantMessage: response('context'), context: { messages: [], tools: [target] },
        signal: controller.signal,
      });
      expect(phase).toHaveBeenCalledTimes(1);
      expect(effects).toBe(0);
      expect(outcome.isError).toBe(true);
    } finally { phase.mockRestore(); }
  });

  test(`a ${mode} tool validates once before permission argument changes`, async () => {
    let effects = 0;
    let permissions = 0;
    const native: AgentTool = {
      name: 'fixture', label: 'Fixture', description: 'Local permission fixture',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      execute: async (_id, args) => {
        effects++;
        expect(args).toEqual({ value: 'accepted', internal: true });
        return { content: [{ type: 'text', text: 'accepted' }], details: {} };
      },
    };
    const target = targetTool(native, mode);
    const options = {
      tools: [target], assistantMessage: response('context'), context: { messages: [], tools: [target] },
      beforeToolCall: async (call: { args: unknown }) => {
        permissions++;
        (call.args as Record<string, unknown>).internal = true;
      },
    };
    const accepted = await runToolCall({ type: 'toolCall', id: 'accepted', name: target.name, arguments: { value: 'accepted' } }, options);
    expect(accepted.isError).toBe(false);
    expect(accepted.result.content).toEqual([{ type: 'text', text: 'accepted' }]);
    const invalid = await runToolCall({ type: 'toolCall', id: 'invalid', name: target.name, arguments: {} }, options);
    expect(invalid.isError).toBe(true);
    expect(invalid.result.content).toEqual([{ type: 'text', text: expect.stringContaining('Validation failed') }]);
    expect(effects).toBe(1);
    expect(permissions).toBe(1);
  });
}

test('a failed SDK effect preserves changed arguments for the Native result hook', async () => {
  const target: AgentTool = {
    name: 'fixture', label: 'Fixture', description: 'Local failing fixture', parameters: { type: 'object' },
    execute: async (_id, args) => { args.changed = true; throw new Error('fixture failure'); },
  };
  let finalized = false;
  const outcome = await runToolCall({ type: 'toolCall', id: 'failed', name: target.name, arguments: {} }, {
    tools: [target], assistantMessage: response('context'), context: { messages: [], tools: [target] },
    afterToolCall: async call => {
      expect(call.args).toEqual({ changed: true });
      expect(call.isError).toBe(true);
      finalized = true;
    },
  });
  expect(finalized).toBe(true);
  expect(outcome.isError).toBe(true);
});
