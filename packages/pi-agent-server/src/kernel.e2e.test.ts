/**
 * End-to-end kernel tests over a real durable `Harness` with a scripted
 * provider: prompt streaming, tool rounds, resume, retry synthesis, and
 * branch-fork anchoring. The assertions target the synthesized
 * `AgentSessionEvent` shapes the host's `PiEventAdapter` consumes.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  createProvider,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Model,
  type MutableModels,
  type ProviderStreams,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { DurableKernel } from './kernel.ts';

const USAGE: Usage = {
  input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'faux' as Api,
    provider: 'faux',
    model: 'faux-1',
    usage: USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

/** A full well-formed event stream for one text response. */
function textEvents(text: string): AssistantMessageEvent[] {
  const final = assistantMessage([{ type: 'text', text }], 'stop');
  return [
    { type: 'start', partial: { ...final, content: [] } },
    { type: 'text_start', contentIndex: 0, partial: { ...final, content: [{ type: 'text', text: '' }] } },
    { type: 'text_delta', contentIndex: 0, delta: text, partial: { ...final, content: [{ type: 'text', text }] } },
    { type: 'text_end', contentIndex: 0, content: text, partial: final },
    { type: 'done', reason: 'stop', message: final },
  ];
}

/** A full event stream for one tool-call response. */
function toolCallEvents(toolCall: ToolCall): AssistantMessageEvent[] {
  const final = assistantMessage([toolCall], 'toolUse');
  return [
    { type: 'start', partial: { ...final, content: [] } },
    { type: 'toolcall_start', contentIndex: 0, partial: { ...final, content: [{ ...toolCall, arguments: {} }] } },
    { type: 'toolcall_end', contentIndex: 0, toolCall, partial: final },
    { type: 'done', reason: 'toolUse', message: final },
  ];
}

function errorEvents(errorMessage: string): AssistantMessageEvent[] {
  return [{
    type: 'error',
    reason: 'error',
    error: { ...assistantMessage([], 'error'), errorMessage },
  }];
}

interface FauxSetup {
  models: MutableModels;
  /** TranscriptContext of each model invocation, in order. */
  calls: TranscriptContext[];
  /** One event-script per expected model invocation. */
  script: AssistantMessageEvent[][];
}

/** Register the scripted 'faux' provider on a fresh in-memory model catalog. */
function createFauxModels(script: AssistantMessageEvent[][]): FauxSetup {
  const calls: TranscriptContext[] = [];
  const queue = [...script];
  const fauxApi: ProviderStreams = {
    stream() {
      throw new Error('stream() is not expected in these tests');
    },
    streamSimple(_model, context) {
      calls.push(context);
      const events = queue.shift();
      if (!events) throw new Error('Script exhausted: unexpected model invocation');
      const stream = createAssistantMessageEventStream();
      // Deliver like a real provider — the watcher synthesizes message_update
      // by diffing partial states between throttled live-doc flushes
      // (progress.partialIntervalMs, default 100ms), so events must be spaced
      // wider than that for an intermediate partial to be observed.
      void (async () => {
        for (const event of events) {
          await new Promise(resolve => setTimeout(resolve, 120));
          stream.push(event);
        }
      })();
      return stream;
    },
  };
  const credentials = new InMemoryCredentialStore();
  const models = builtinModels({ credentials });
  const model: Model<'faux'> = {
    id: 'faux-1', name: 'faux-1', api: 'faux', provider: 'faux',
    baseUrl: 'http://faux.test', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000, maxTokens: 4_096,
  };
  models.setProvider(createProvider({
    id: 'faux', name: 'Faux', baseUrl: 'http://faux.test',
    auth: { apiKey: { name: 'Faux key', resolve: async () => ({ auth: { apiKey: 'test-key' } }) } },
    models: [model],
    api: { faux: fauxApi },
  }));
  return { models, calls, script: queue };
}

interface KernelSetup {
  kernel: DurableKernel;
  events: Array<Record<string, unknown>>;
  calls: TranscriptContext[];
  /** Resolves when the wanted event type has been synthesized. */
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Resolves when any event matches the predicate. */
  waitForWhere(predicate: (event: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function createKernel(options: {
  sessionPath: string;
  script: AssistantMessageEvent[][];
  systemPrompt?: string;
  tools?: boolean;
  open?: Parameters<DurableKernel['open']>[0];
}): KernelSetup {
  const faux = createFauxModels(options.script);
  const events: Array<Record<string, unknown>> = [];
  const echoTool = defineTool({
    name: 'echo',
    description: 'Echo the given text back.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: [] } as never,
    execute: async () => ({ output: [{ type: 'text' as const, text: 'echo-result' }] }),
  });
  const kernel = new DurableKernel({
    sessionPath: options.sessionPath,
    cwd: options.sessionPath,
    modelsSource: () => faux.models,
    hooks: {
      emitEvent: event => events.push(event as Record<string, unknown>),
      sessionToolCompleted: () => {},
      prefetchToolCall: () => {},
      isPrefetchableTool: () => false,
      debugLog: () => {},
    },
    toolsExtension: options.tools
      ? defineExtension({ name: 'test-tools', tools: [echoTool] })
      : defineExtension({ name: 'test-tools', tools: [] }),
  });
  if (options.systemPrompt) kernel.systemPrompt = options.systemPrompt;

  const waitFor = (type: string, timeoutMs = 15_000): Promise<Record<string, unknown>> =>
    waitForWhere(event => event.type === type, timeoutMs);

  const waitForWhere = (predicate: (event: Record<string, unknown>) => boolean, timeoutMs = 15_000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        const found = events.find(predicate);
        if (found) return resolve(found);
        if (Date.now() - startedAt > timeoutMs) {
          return reject(new Error(`timeout waiting for event; saw: ${events.map(e => e.type).join(',')}`));
        }
        setTimeout(check, 20);
      };
      check();
    });

  return { kernel, events, calls: faux.calls, waitFor, waitForWhere };
}

describe('DurableKernel end-to-end', () => {
  const scratchDirs: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-e2e-'));
    scratchDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('synthesizes the host event sequence for a plain prompt', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('hello world')], systemPrompt: 'SYS-PROMPT' });
    const { kernel, events, calls, waitFor } = setup;
    try {
      await kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      expect(kernel.sessionId).not.toBe('');
      await kernel.submitPrompt('hi');
      await waitFor('agent_end');

      const types = events.map(e => e.type);
      expect(types).toContain('agent_start');
      expect(types).toContain('turn_start');
      expect(types).toContain('message_start');
      expect(types).toContain('message_update');
      expect(types).toContain('message_end');
      expect(types).toContain('pi_turn_anchor');
      expect(types).toContain('context_usage');
      expect(types).toContain('turn_end');
      expect(events[events.length - 1]!.type).toBe('agent_end');

      const update = events.find(e => e.type === 'message_update') as Record<string, any>;
      expect(update.assistantMessageEvent.type).toBe('text_delta');
      expect(update.assistantMessageEvent.delta).toBe('hello world');

      const anchor = events.find(e => e.type === 'pi_turn_anchor') as Record<string, unknown>;
      expect(typeof anchor.sdkTurnAnchor).toBe('number');
      expect(typeof anchor.sdkMessageId).toBe('string');

      const usage = events.find(e => e.type === 'context_usage') as Record<string, any>;
      expect(usage.contextUsage).toEqual({ tokens: 15, contextWindow: 100_000, percent: 0 });
      expect(usage.compactionSettings.enabled).toBe(true);

      // The section-registered system prompt reaches the provider request.
      const systemMessages = calls[0]!.messages.filter(m => m.role === 'system');
      expect(systemMessages.length).toBeGreaterThan(0);
      expect(JSON.stringify(systemMessages)).toContain('SYS-PROMPT');
    } finally {
      await kernel.close();
    }
  });

  it('runs a tool round: tool events, then the follow-up model call', async () => {
    const toolCall: ToolCall = { type: 'toolCall', id: 't1', name: 'echo', arguments: { text: 'hi' } };
    const setup = createKernel({
      sessionPath: scratch(),
      script: [toolCallEvents(toolCall), textEvents('final answer')],
      tools: true,
    });
    const { kernel, events, calls, waitFor } = setup;
    try {
      await kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await kernel.submitPrompt('use the tool');
      await waitFor('agent_end');

      const start = events.find(e => e.type === 'tool_execution_start') as Record<string, any>;
      expect(start.toolCallId).toBe('t1');
      expect(start.toolName).toBe('echo');
      const end = events.find(e => e.type === 'tool_execution_end') as Record<string, any>;
      expect(end.isError).toBe(false);
      expect(JSON.stringify(end.result.content)).toContain('echo-result');

      // The tool result joined the transcript before the follow-up call.
      expect(calls.length).toBe(2);
      const toolResults = calls[1]!.messages.filter(m => m.role === 'toolResult');
      expect(toolResults.length).toBe(1);

      const finalEnd = events.filter(e => e.type === 'message_end').map(e => (e as Record<string, any>).message);
      expect(JSON.stringify(finalEnd[finalEnd.length - 1])).toContain('final answer');
    } finally {
      await kernel.close();
    }
  });

  it('resumes a persisted session: stable id, history carried into the next run', async () => {
    const dir = scratch();
    const first = createKernel({ sessionPath: dir, script: [textEvents('first reply')] });
    try {
      await first.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await first.kernel.submitPrompt('first question');
      await first.waitFor('agent_end');
    } finally {
      await first.kernel.close();
    }

    const second = createKernel({ sessionPath: dir, script: [textEvents('second reply')] });
    const { kernel, calls, waitFor } = second;
    try {
      await kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      expect(kernel.sessionId).toBe(first.kernel.sessionId);
      await kernel.submitPrompt('second question');
      await waitFor('agent_end');
      const userTexts = calls[0]!.messages
        .filter((m): m is Extract<Message, { role: 'user' }> => m.role === 'user')
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      expect(userTexts.join('\n')).toContain('first question');
    } finally {
      await kernel.close();
    }
  });

  it('synthesizes the retry contract: willRetry agent_end, auto_retry_start, recovered success', async () => {
    // 2+ seconds: the kernel's main-chat retry backoff (baseDelayMs 2000).
    const setup = createKernel({ sessionPath: scratch(), script: [errorEvents('provider overloaded (500)'), textEvents('recovered')] });
    const { kernel, events, calls, waitForWhere } = setup;
    try {
      await kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await kernel.submitPrompt('trigger a retry');
      // The first agent_end is the willRetry announcement; the run is over
      // only at the terminal, non-retrying one.
      await waitForWhere(e => e.type === 'agent_end' && e.willRetry === false, 20_000);

      const willRetryEnd = events.find(e => e.type === 'agent_end' && e.willRetry === true);
      expect(willRetryEnd).toBeDefined();
      const retryStart = events.find(e => e.type === 'auto_retry_start') as Record<string, any>;
      expect(retryStart.attempt).toBe(1);
      expect(retryStart.errorMessage).toBe('provider overloaded (500)');

      // Exactly one recovered success announcement before the run's agent_end.
      const retryEnds = events.filter(e => e.type === 'auto_retry_end');
      expect(retryEnds.length).toBe(1);
      expect(retryEnds[0]!.success).toBe(true);

      expect(calls.length).toBe(2);
      const lastAgentEnd = events[events.length - 1]!;
      expect(lastAgentEnd.type).toBe('agent_end');
      expect(lastAgentEnd.willRetry).toBe(false);
    } finally {
      await kernel.close();
    }
  });

  it('branches from a legacy parent: store copy, fork at the mapped anchor', async () => {
    const parent = scratch();
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'm1', message: { role: 'user', content: 'hi', timestamp: 1 } },
      { type: 'message', id: 'm2', message: {
        role: 'assistant', content: [{ type: 'text', text: 'hello' }],
        api: 'x', provider: 'p', model: 'm', usage: USAGE, stopReason: 'stop', timestamp: 1,
      } },
      { type: 'message', id: 'm3', message: { role: 'user', content: 'second', timestamp: 1 } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n';
    // findMostRecentSessionFile scans the `.pi-sessions` directory.
    mkdirSync(join(parent, '.pi-sessions'), { recursive: true });
    writeFileSync(join(parent, '.pi-sessions', 'legacy.jsonl'), transcript);

    const child = scratch();
    const setup = createKernel({
      sessionPath: child,
      script: [textEvents('child reply')],
      open: { branchFromSessionPath: parent, branchFromSdkTurnId: 'm2' },
    });
    const { kernel, calls, waitFor } = setup;
    try {
      await kernel.open({
        model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 },
        branchFromSessionPath: parent,
        branchFromSdkTurnId: 'm2',
      });
      await kernel.submitPrompt('child question');
      await waitFor('agent_end');

      const userTexts = calls[0]!.messages
        .filter((m): m is Extract<Message, { role: 'user' }> => m.role === 'user')
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      const joined = userTexts.join('\n');
      expect(joined).toContain('hi');
      expect(joined).toContain('child question');
      // Strict cutoff: the entry after the anchor is gone from the child's view.
      expect(joined).not.toContain('second');
    } finally {
      await kernel.close();
    }
  });
});
