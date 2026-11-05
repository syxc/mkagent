/**
 * End-to-end kernel tests over a real durable `Harness` with a scripted
 * provider: prompt streaming, tool rounds, resume, retry synthesis, and
 * branch-fork anchoring. The assertions target the synthesized
 * `AgentSessionEvent` shapes the host's `PiEventAdapter` consumes.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
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
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { CompactionTask, DEFAULT_COMPACTION_POLICY, InboxDoc, LiveDoc, UsageDoc, ROOT_CONVERSATION_ID, createRegistry, defineDoc, defineExtension, defineTask, defineTool, hook, type Extension, Harness, type StorageWrite, type SubmissionId, type TaskId, type TaskRecord, type ToolRegistration } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { commitWrites } from '@earendil-works/pi-durable/testing';
import { CacheWarmer } from './cache-warmer.ts';
import { DurableKernel } from './kernel.ts';
import { withModelRequestCompatibility } from './model-runtime.ts';
import { resolvePiModel } from './model-resolution.ts';
import { migrateLegacySession } from './migrate.ts';
import { openDurableStorage } from './storage/durable-storage.ts';
import { queryLlm } from './ephemeral.ts';
import { createBuiltinTools } from './tools/builtin.ts';
import { createSearchTool } from './tools/search/create-search-tool.ts';
import { createWebFetchTool } from './tools/web-fetch.ts';
import { createCodemodeExtensionFor } from './tools/codemode.ts';
import { createProxyTool } from './tools/proxy.ts';
import { restoreSessionBundleFiles } from '@mkagent/shared/sessions';
import { serializeSession } from '../../shared/src/sessions/bundle.ts';
import { writeSessionJsonl } from '../../shared/src/sessions/jsonl.ts';
import type { StoredSession } from '../../shared/src/sessions/types.ts';
import { restoreFiles } from '../../shared/src/utils/bundle-files.ts';
import { PiEventAdapter } from '../../shared/src/agent/backend/pi/event-adapter.ts';
import { EventQueue } from '../../shared/src/agent/backend/event-queue.ts';
import { closeMcpConnections, loadMcpTools, type McpToolsLoadResult } from './mcp/extension.ts';

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

function errorEvents(errorMessage: string, text = ''): AssistantMessageEvent[] {
  const content: AssistantMessage['content'] = text ? [{ type: 'text', text }] : [];
  const message = { ...assistantMessage(content, 'error'), errorMessage };
  const partial = { ...message, stopReason: 'pending' as const, errorMessage: undefined };
  return text ? [
    { type: 'start', partial: { ...partial, content: [] } },
    { type: 'text_start', contentIndex: 0, partial: { ...partial, content: [{ type: 'text', text: '' }] } },
    { type: 'text_delta', contentIndex: 0, delta: text, partial },
    { type: 'text_end', contentIndex: 0, content: text, partial },
    { type: 'error', reason: 'error', error: message },
  ] : [{ type: 'error', reason: 'error', error: message }];
}

type FauxScript = Array<AssistantMessageEvent[] | Promise<AssistantMessageEvent[]>>;

interface FauxSetup {
  models: MutableModels;
  /** TranscriptContext of each model invocation, in order. */
  calls: TranscriptContext[];
  /** One event-script per expected model invocation. */
  script: FauxScript;
}

/** Register the scripted 'faux' provider on a fresh in-memory model catalog. */
function createFauxModels(script: FauxScript): FauxSetup {
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
        for (const event of await events) {
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
  /** Calls the kernel reported through the sessionToolCompleted hook. */
  sessionCompletions: Array<{ toolName: string; args: Record<string, unknown>; isError: boolean }>;
  /** Resolves when the wanted event type has been synthesized. */
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Resolves when any event matches the predicate. */
  waitForWhere(predicate: (event: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function createKernel(options: {
  sessionPath: string;
  script: FauxScript;
  systemPrompt?: string;
  autoCompactWindow?: number;
  shellPath?: string;
  tools?: boolean;
  /** Registers the same session tool under both host prefixes. */
  sessionTools?: boolean;
  models?: MutableModels;
  codemode?: boolean;
  extensions?: Extension[];
  mcp?: McpToolsLoadResult;
  open?: Parameters<DurableKernel['open']>[0];
}): KernelSetup {
  const faux = createFauxModels(options.script);
  const events: Array<Record<string, unknown>> = [];
  const sessionCompletions: KernelSetup['sessionCompletions'] = [];
  const echoTool = defineTool({
    name: 'echo',
    description: 'Echo the given text back.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: [] } as never,
    execute: async () => ({ output: [{ type: 'text' as const, text: 'echo-result' }] }),
  });
  const sessionTool = (name: string) => defineTool({
    name,
    description: 'Session-scoped test tool.',
    parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: [] } as never,
    execute: async () => ({ output: [{ type: 'text' as const, text: 'session-ok' }] }),
  });
  const kernel = new DurableKernel({
    sessionPath: options.sessionPath,
    cwd: options.sessionPath,
    autoCompactWindow: options.autoCompactWindow,
    shellPath: options.shellPath,
    modelsSource: () => options.models ?? faux.models,
    hooks: {
      emitEvent: event => events.push(event as Record<string, unknown>),
      sessionToolCompleted: (toolName, args, isError) => sessionCompletions.push({ toolName, args, isError }),
      prefetchToolCall: () => {},
      isPrefetchableTool: () => false,
      debugLog: () => {},
    },
    toolsExtension: defineExtension({
      name: 'test-tools',
      tools: [
        ...(options.tools ? [echoTool] : []),
        ...(options.sessionTools ? [sessionTool('session__SubmitPlan'), sessionTool('mcp__session__SubmitPlan')] : []),
        ...(options.mcp?.tools ?? []),
      ],
    }),
    extensions: [...(options.codemode ? [createCodemodeExtensionFor(options.mcp?.namespaces)] : []), ...(options.extensions ?? [])],
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

  return { kernel, events, calls: faux.calls, sessionCompletions, waitFor, waitForWhere };
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

  it('marks orphaned tool completions as errors while preserving successful nested results', async () => {
    const { kernel } = createKernel({ sessionPath: scratch(), script: [] });
    const synthesizer = kernel as unknown as { synthesizeEvent(event: Record<string, unknown>): Record<string, unknown>[] };
    const orphan = synthesizer.synthesizeEvent({ type: 'tool_execution_end', toolCallId: 'orphan', toolName: 'read' });
    expect(orphan[0]).toMatchObject({ type: 'tool_execution_end', isError: true });
    const success = synthesizer.synthesizeEvent({ type: 'tool_execution_end', toolCallId: 'nested', toolName: 'read',
      result: { structuredOutput: 'actual instructions', isError: false } });
    expect(success[0]).toMatchObject({ isError: false, result: { content: [{ type: 'text', text: 'actual instructions' }] } });
    await kernel.close();
  });

  it('resolves MiniMax and reports missing models through the JSONL protocol', async () => {
    const dir = scratch();
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'mcp.json'), '{}');
    const codingDir = join(dir, 'pi-agent');
    mkdirSync(codingDir);
    writeFileSync(join(codingDir, 'settings.json'), JSON.stringify({
      extensions: [join(import.meta.dir, '../../pi-durable-coding/test/fixtures/upstream/hello.ts')],
    }));
    const env: NodeJS.ProcessEnv = { HOME: dir, USERPROFILE: dir, CONFIG_DIR: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir, PI_CODING_AGENT_DIR: codingDir, PI_OFFLINE: '1' };
    if (process.env.PATH) env.PATH = process.env.PATH;
    const bootstrap = `
      import { mock } from 'bun:test';
      import { builtinModels as original } from '@earendil-works/pi-ai/providers/all';
      import { createProvider, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
      import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
      const makeBuiltinModels = original;
      mock.module('@earendil-works/pi-ai/providers/all', () => ({ builtinModels: (options) => {
        const models = makeBuiltinModels(options);
        models.setProvider(createProvider({
          id: 'minimax-cn', name: 'Local MiniMax',
          auth: { apiKey: { name: 'Fake', resolve: async () => ({ auth: { apiKey: 'fake' } }) } },
          models: [{ id: 'MiniMax-local', name: 'Local', provider: 'minimax-cn', api: 'faux',
            baseUrl: 'http://local.test', reasoning: false, input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
          api: { faux: { stream() { throw new Error('Unexpected raw stream'); }, streamSimple(model, context) {
            if (model.id !== 'local' || model.contextWindow !== 100000) throw new Error('Incorrect model dispatch');
            process.stderr.write('TEST_MINIMAX_DISPATCH\\n');
            const visibleTools = getCurrentTools(context.messages);
            const stream = createAssistantMessageEventStream();
            const useHello = visibleTools.some(tool => tool.name === 'hello')
              && !context.messages.some(message => message.role === 'toolResult');
            const events = useHello
              ? ${JSON.stringify(toolCallEvents({ type: 'toolCall', id: 'protocol-hello', name: 'hello', arguments: { name: 'protocol' } }))}
              : ${JSON.stringify(textEvents('protocol answer'))};
            queueMicrotask(() => { for (const event of events) stream.push(event); });
            return stream;
          } } },
        }));
        return models;
      } }));
      globalThis.fetch = async () => { throw new Error('OFFLINE_FETCH_BLOCKED'); };
      await import(${JSON.stringify(join(import.meta.dir, 'index.ts'))});
    `;
    const child = spawn(process.execPath, ['--eval', bootstrap], { cwd: import.meta.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const messages: Array<Record<string, any>> = [];
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const message = JSON.parse(line);
        messages.push(message);
        if (message.type === 'native_history_commit') send({
          type: 'native_history_receipt', id: message.id, success: true,
          ownerSessionId: message.ownerSessionId, runtimeGeneration: message.runtimeGeneration,
        });
      }
    });
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    let runtimeGeneration = 0;
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({
      ownerSessionId: 'model-protocol', runtimeGeneration, ...message,
    })}\n`);
    const wait = async (predicate: (message: Record<string, any>) => boolean) => {
      for (let attempt = 0; attempt < 250; attempt++) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        if (child.exitCode !== null) break;
        await Bun.sleep(20);
      }
      throw new Error(`Protocol timeout: ${JSON.stringify(messages)} ${stderr}`);
    };
    const initialize = (model: string) => {
      runtimeGeneration++;
      send({
        type: 'init', model, cwd: dir, thinkingLevel: 'off', workspaceRootPath: dir,
        agentProfile: 'coding',
        sessionId: 'model-protocol', agentDir, sessionPath: dir, workingDirectory: dir,
        plansFolderPath: join(dir, 'plans'), piAuth: { provider: 'minimax-cn', credential: { type: 'api_key', key: 'fake' } },
      });
    };
    try {
      initialize('pi/missing');
      await wait(message => message.type === 'ready');
      send({ type: 'prompt', id: 'missing-init', message: 'hello', systemPrompt: 'test' });
      expect((await wait(message => message.type === 'error' && message.code === 'prompt_error')).message).toContain('Could not resolve model');
      initialize('pi/MiniMax-local');
      await wait(message => message.type === 'ready');
      send({ type: 'ensure_session_ready', id: 'open' });
      await wait(message => message.type === 'ensure_session_ready_result' && message.id === 'open');
      send({ type: 'set_model', model: 'pi/missing' });
      expect((await wait(message => message.type === 'error' && message.code === 'set_model_error')).message).toContain('Could not resolve model');
      send({ type: 'set_model', model: 'pi/MiniMax-local' });
      send({ type: 'llm_query', id: 'after-switch', request: { model: 'pi/MiniMax-local', prompt: 'question' } });
      expect((await wait(message => message.type === 'llm_query_result' && message.id === 'after-switch')).result.text).toBe('protocol answer');
      send({ type: 'update_runtime_config', id: 'missing-update', model: 'pi/missing' });
      expect((await wait(message => message.type === 'update_runtime_config_result' && message.id === 'missing-update')).success).toBe(false);
      send({ type: 'update_runtime_config', id: 'valid-update', model: 'pi/MiniMax-local' });
      expect((await wait(message => message.type === 'update_runtime_config_result' && message.id === 'valid-update')).success).toBe(true);
      messages.length = 0;
      send({ type: 'prompt', id: 'updated-prompt', message: 'hello', systemPrompt: 'test' });
      const approval = await wait(message => message.type === 'pre_tool_use_request' && message.toolName === 'hello');
      expect(approval.input).toEqual({ name: 'protocol' });
      send({ type: 'pre_tool_use_response', requestId: approval.requestId, action: 'modify', input: { name: 'approved-protocol' } });
      const toolEnd = await wait(message => message.type === 'event' && message.event?.type === 'tool_execution_end');
      expect(JSON.stringify(toolEnd.event.result)).toContain('Hello, approved-protocol!');
      await wait(message => message.type === 'event' && message.event?.type === 'agent_end');
      expect(stderr.match(/TEST_MINIMAX_DISPATCH/g)?.length).toBeGreaterThanOrEqual(2);
    } finally {
      send({ type: 'shutdown' });
      if (await Promise.race([exited.then(() => true), Bun.sleep(3_000).then(() => false)]) === false) child.kill('SIGKILL');
      await exited;
    }
  }, 20_000);

  it('uses canonical MiniMax refs across init, setModel, runtime replacement and ephemeral queries', async () => {
    const requests: Model<Api>[] = [];
    const makeModels = () => {
      const { models } = createFauxModels([textEvents('answer'), textEvents('answer'), textEvents('answer')]);
      const faux = models.getProvider('faux')!;
      const model = { ...models.getModel('faux', 'faux-1')!, id: 'MiniMax-local', provider: 'minimax-cn' };
      models.setProvider(withModelRequestCompatibility({
        ...faux, id: 'minimax-cn', getModels: () => [model], getAllModels: () => [model],
        streamSimple(request, context, options) {
          requests.push(request);
          return faux.streamSimple(request, context, options);
        },
      }));
      return models;
    };
    const models = makeModels();
    const ref = () => {
      const model = resolvePiModel(models, 'pi/MiniMax-local', 'minimax-cn')!;
      return { provider: model.provider, modelId: model.id, contextWindow: model.contextWindow };
    };
    const { kernel, events, waitFor } = createKernel({ sessionPath: scratch(), script: [], models });
    try {
      await kernel.open({ model: ref() });
      await kernel.submitPrompt('initial');
      await waitFor('agent_end');
      events.length = 0;
      models.setProvider(makeModels().getProvider('minimax-cn')!);
      await kernel.setModel(ref());
      await kernel.submitPrompt('updated');
      await waitFor('agent_end');
      const controller = new AbortController();
      const result = await queryLlm({ model: 'pi/MiniMax-local', prompt: 'ephemeral' }, {
        signal: controller.signal, throwIfCancelled: () => controller.signal.throwIfAborted(),
        setResource: () => {}, clearResource: () => {},
      }, {
        models, getConfig: () => ({ piAuthProvider: 'minimax-cn', preferCustomEndpoint: false }), debugLog: () => {},
      });
      expect(result.text).toBe('answer');
      expect(requests).toHaveLength(3);
      expect(requests.every(model => model.id === 'local' && model.contextWindow === 100_000 && model.api === 'faux')).toBe(true);
      expect(ref().modelId).toBe('MiniMax-local');
    } finally {
      await kernel.close();
    }
  });

  it('rejects an unavailable model instead of completing an empty turn', async () => {
    const models = createFauxModels([]).models;
    const { kernel } = createKernel({ sessionPath: scratch(), script: [], models });
    try {
      await kernel.open({ model: { provider: 'faux', modelId: 'faux-1' } });
      await expect(kernel.setModel({ provider: 'faux', modelId: 'missing' })).rejects.toThrow('Could not resolve model');
      models.setProvider({ ...models.getProvider('faux')!, getModels: () => [], getAllModels: () => [] });
      await expect(kernel.submitPrompt('hi')).rejects.toThrow('Could not resolve model');
      await expect(kernel.steer('hi')).rejects.toThrow('Could not resolve model');
    } finally {
      await kernel.close();
    }
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
      expect(typeof anchor.sdkTurnAnchor).toBe('string');
      expect(typeof anchor.sdkMessageId).toBe('string');
      const assistantEnd = events.find(event => event.type === 'message_end' && (event.message as { role?: string })?.role === 'assistant');
      expect(assistantEnd?.sdkMessageId).toBe(anchor.sdkMessageId);

      const usage = events.find(e => e.type === 'context_usage') as Record<string, any>;
      expect(usage.contextUsage).toEqual({ tokens: 15, contextWindow: 100_000, percent: 0.015 });
      expect(usage.compactionSettings.enabled).toBe(true);

      // The section-registered system prompt reaches the provider request.
      const systemMessages = calls[0]!.messages.filter(m => m.role === 'system');
      expect(systemMessages.length).toBeGreaterThan(0);
      expect(JSON.stringify(systemMessages)).toContain('SYS-PROMPT');
    } finally {
      await kernel.close();
    }
  });

  it('retains compaction settings when the context usage read fails', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('answer')] });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      const conversation = (setup.kernel as unknown as { conversation: { context: () => Promise<unknown> } }).conversation;
      conversation.context = async () => { throw new Error('usage unavailable'); };
      await setup.kernel.submitPrompt('question');
      await setup.waitFor('agent_end');
      const end = setup.events.find(event => event.type === 'message_end' && JSON.stringify(event).includes('answer'));
      expect(end?.compactionSettings).toEqual({ enabled: true, reserveTokens: DEFAULT_COMPACTION_POLICY.reserveTokens });
      expect(setup.events.filter(event => event.type === 'agent_end')).toHaveLength(1);
    } finally {
      await setup.kernel.close();
    }
  });

  it('uses the bounded provider retry policy for a utility query', async () => {
    const models = createFauxModels([]).models;
    let options: Record<string, unknown> | undefined;
    models.completeSimple = async (_model, _context, streamOptions) => {
      options = streamOptions as Record<string, unknown>;
      return assistantMessage([{ type: 'text', text: 'utility answer' }], 'stop');
    };
    const controller = new AbortController();
    const result = await queryLlm({ model: 'faux-1', prompt: 'question' }, {
      signal: controller.signal,
      throwIfCancelled: () => controller.signal.throwIfAborted(),
      setResource: () => {},
      clearResource: () => {},
    }, {
      models,
      getConfig: () => ({ piAuthProvider: 'faux', preferCustomEndpoint: false }),
      debugLog: () => {},
    });
    expect(result.text).toBe('utility answer');
    expect(options).toMatchObject({ maxRetries: 2, maxRetryDelayMs: 10_000 });
  });

  it('isolates sessions from project and global Pi resources and built-in extensions', async () => {
    const directory = scratch();
    const piDir = join(directory, '.pi');
    const globalDir = scratch();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
    mkdirSync(piDir);
    writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
    writeFileSync(join(piDir, 'SYSTEM.md'), 'project-system-should-not-load');
    writeFileSync(join(globalDir, 'SYSTEM.md'), 'global-system-should-not-load');
    const markers: string[] = [];
    for (const [root, name] of [[piDir, 'project'], [globalDir, 'global']]) {
      const extensions = join(root!, 'extensions');
      const marker = join(directory, `${name}-extension-ran`);
      markers.push(marker);
      mkdirSync(extensions);
      writeFileSync(join(extensions, 'unexpected-extension.ts'),
        `import { writeFileSync } from 'node:fs';\nexport default function () { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }\n`);
    }
    const first = createKernel({ sessionPath: directory, script: [textEvents('first')], systemPrompt: 'host system' });
    const second = createKernel({ sessionPath: scratch(), script: [] });
    try {
      await first.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await second.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await first.kernel.submitPrompt('question');
      await first.waitFor('agent_end');
      const systems = first.calls[0]!.messages.filter(message => message.role === 'system');
      expect(systems.map(message => message.content)).toEqual(['host system']);
      expect(getCurrentTools(first.calls[0]!.messages)).toEqual([]);
      const registry = (first.kernel as unknown as { registry: { snapshot(): { installed(): readonly Extension[] } } }).registry;
      expect(registry.snapshot().installed().map(extension => extension.name)).toEqual([
        'mkagent-system-prompt', 'test-tools', 'mkagent-cache-warmer',
      ]);
      const { existsSync } = await import('node:fs');
      for (const marker of markers) expect(existsSync(marker)).toBe(false);
      expect((await first.kernel.contextUsagePayload()).compactionSettings.enabled).toBe(true);
      first.kernel.setAutoCompaction(false);
      expect((await second.kernel.contextUsagePayload()).compactionSettings.enabled).toBe(true);
    } finally {
      await first.kernel.close();
      await second.kernel.close();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it('leaves extension system sections unchanged until a host system prompt is set', async () => {
    const { section } = await import('@earendil-works/pi-durable');
    const defaultPrompt = '  default extension prompt\nwith preserved whitespace\n';
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('first')], extensions: [defineExtension({
      name: 'default-system-prompt',
      sections: [section('default-system-prompt', () => defaultPrompt, { tag: false })],
    })] });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      expect(setup.kernel.systemPrompt).toBeUndefined();
      await setup.kernel.submitPrompt('question');
      await setup.waitFor('agent_end');
      const systems = setup.calls[0]!.messages.filter(message => message.role === 'system');
      expect(systems).toHaveLength(1);
      expect(systems[0]).toMatchObject({ sections: { 'default-system-prompt': defaultPrompt } });
    } finally {
      await setup.kernel.close();
    }
  });

  it('preserves an extension-only system prompt when tools are registered', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('first')], tools: true });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('question');
      await setup.waitFor('agent_end');
      const systems = setup.calls[0]!.messages.filter(message => message.role === 'system');
      expect(systems).toHaveLength(1);
      expect(getCurrentTools(setup.calls[0]!.messages).map(tool => tool.name)).toEqual(['echo']);
    } finally {
      await setup.kernel.close();
    }
  });

  it('uses the exact current system prompt on every request and retains registered tools', async () => {
    const prompts = ['  first system prompt\n<host>exact text</host>\n', '  first system prompt\n<host>exact text</host>\n', '\tsecond system prompt: 更新\r\n', ''];
    const setup = createKernel({ sessionPath: scratch(), script: prompts.map((_, index) => textEvents(`response ${index}`)), systemPrompt: prompts[0], tools: true });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      for (const [index, prompt] of prompts.entries()) {
        setup.kernel.systemPrompt = prompt;
        await setup.kernel.submitPrompt(`question ${index}`);
        await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_end').length === index + 1);
        expect(setup.calls).toHaveLength(index + 1);
        const systems = setup.calls[index]!.messages.filter(message => message.role === 'system');
        expect(systems.map(message => message.content)).toEqual([prompt]);
        expect(getCurrentTools(setup.calls[index]!.messages).map(tool => tool.name)).toEqual(['echo']);
      }
    } finally {
      await setup.kernel.close();
    }
  });

  it('batches all queued steering messages at the next model boundary', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('first'), textEvents('second'), textEvents('third')] });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('initial');
      await setup.waitForWhere(() => setup.calls.length === 1);
      for (const text of ['steer-A', 'steer-B', 'steer-C']) await setup.kernel.steer(text);
      expect(setup.calls).toHaveLength(1);
      const userMessages = (context: TranscriptContext) => context.messages
        .filter(message => message.role === 'user')
        .map(message => typeof message.content === 'string' ? message.content : message.content
          .filter(block => block.type === 'text').map(block => block.text).join(''));
      expect(userMessages(setup.calls[0]!)).toEqual(['initial']);
      await setup.waitForWhere(() => setup.calls.length === 2);
      expect(userMessages(setup.calls[1]!)).toEqual(['initial', 'steer-A', 'steer-B', 'steer-C']);
      await setup.kernel.steer('steer-D');
      expect(userMessages(setup.calls[1]!)).toEqual(['initial', 'steer-A', 'steer-B', 'steer-C']);
      await setup.waitForWhere(() => setup.calls.length === 3);
      expect(userMessages(setup.calls[2]!)).toEqual(['initial', 'steer-A', 'steer-B', 'steer-C', 'steer-D']);
      await setup.waitFor('agent_end');
      expect(setup.calls).toHaveLength(3);
    } finally {
      await setup.kernel.close();
    }
  }, 10_000);

  for (const mode of ['steer', 'followUp'] as const) for (const response of ['text', 'tool'] as const) for (const ending of ['complete', 'abort'] as const) {
    it(`keeps the host queue open across ${mode} ${response} successors until ${ending}`, async () => {
      let release!: (events: AssistantMessageEvent[]) => void;
      const successor = new Promise<AssistantMessageEvent[]>(resolve => { release = resolve; });
      const setup = createKernel({
        sessionPath: scratch(), tools: response === 'tool',
        script: [response === 'text' ? textEvents('first') : toolCallEvents({ type: 'toolCall', id: 'queued-tool', name: 'echo', arguments: {} }), successor],
      });
      const adapter = new PiEventAdapter();
      adapter.startTurn();
      const queue = new EventQueue();
      let consumed = 0;
      const completions: string[] = [];
      const consume = () => {
        for (const event of setup.events.slice(consumed)) {
          for (const adapted of adapter.adaptEvent(event as never)) queue.enqueue(adapted);
          if (adapter.shouldCompleteQueue(event.type === 'agent_end')) {
            queue.complete();
            completions.push(String(event.type));
          }
        }
        consumed = setup.events.length;
      };
      try {
        await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
        await setup.kernel.submitPrompt('initial');
        await setup.waitForWhere(() => setup.calls.length === 1);
        if (mode === 'steer') await setup.kernel.steer('successor');
        else await setup.kernel.submitPrompt('successor');
        await setup.waitForWhere(() => setup.calls.length === 2);
        consume();
        expect(completions).toEqual([]);
        expect(queue.isComplete).toBe(false);
        if (ending === 'abort') {
          const abort = setup.kernel.abort();
          release([{ type: 'error', reason: 'aborted', error: assistantMessage([], 'aborted') }]);
          await abort;
        } else {
          release(textEvents('final successor'));
          await setup.waitForWhere(event => event.type === 'message_end' && JSON.stringify(event).includes('final successor'));
        }
        await setup.waitFor('agent_end');
        consume();
        expect(completions).toEqual(['agent_end']);
        expect(queue.isComplete).toBe(true);
        const drained = [];
        for await (const event of queue.drain()) drained.push(event);
        if (ending === 'complete') expect(JSON.stringify(drained)).toContain('final successor');
        expect(setup.events.filter(event => event.type === 'agent_start')).toHaveLength(1);
      } finally {
        release(textEvents('final successor'));
        await setup.kernel.close();
      }
    }, 10_000);
  }

  for (const timing of ['committed', 'pending'] as const) it(`keeps a late followUp in the host interaction while predecessor run_end awaits (${timing})`, async () => {
    let releaseEnd!: () => void;
    let reachedEnd!: () => void;
    const endGate = new Promise<void>(resolve => { releaseEnd = resolve; });
    const atEnd = new Promise<void>(resolve => { reachedEnd = resolve; });
    let releaseSuccessor!: (events: AssistantMessageEvent[]) => void;
    const successor = new Promise<AssistantMessageEvent[]>(resolve => { releaseSuccessor = resolve; });
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('predecessor'), successor] });
    const internals = setup.kernel as unknown as { scheduleThresholdCompaction(): Promise<void> };
    const schedule = internals.scheduleThresholdCompaction.bind(setup.kernel);
    let firstEnd = true;
    internals.scheduleThresholdCompaction = async () => {
      if (firstEnd) {
        firstEnd = false;
        reachedEnd();
        await endGate;
      }
      await schedule();
    };
    const adapter = new PiEventAdapter();
    adapter.startTurn();
    const queue = new EventQueue();
    const completions: number[] = [];
    const hooks = (setup.kernel as unknown as { options: { hooks: { emitEvent(event: Record<string, unknown>): void } } }).options.hooks;
    const emit = hooks.emitEvent;
    hooks.emitEvent = event => {
      emit(event);
      for (const adapted of adapter.adaptEvent(event as never)) queue.enqueue(adapted);
      if (adapter.shouldCompleteQueue(event.type === 'agent_end')) {
        queue.complete();
        completions.push(setup.calls.length);
      }
    };
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('initial');
      await atEnd;
      if (timing === 'pending') {
        const conversation = (setup.kernel as unknown as { conversation: { submit(...args: unknown[]): Promise<unknown> } }).conversation;
        const submit = conversation.submit.bind(conversation);
        let releaseSubmit!: () => void;
        const submitGate = new Promise<void>(resolve => { releaseSubmit = resolve; });
        conversation.submit = async (...args) => { await submitGate; return submit(...args); };
        let reachedUsage!: () => void;
        const atUsage = new Promise<void>(resolve => { reachedUsage = resolve; });
        const usage = setup.kernel.contextUsagePayload.bind(setup.kernel);
        setup.kernel.contextUsagePayload = async () => {
          const result = await usage();
          reachedUsage();
          return result;
        };
        const submission = setup.kernel.submitPrompt('late followUp');
        releaseEnd();
        await atUsage;
        expect(queue.isComplete).toBe(false);
        releaseSubmit();
        await submission;
      } else {
        await setup.kernel.submitPrompt('late followUp');
      }
      await setup.waitForWhere(() => setup.calls.length === 2);
      releaseEnd();
      await setup.waitForWhere(() => setup.events.filter(event => event.type === 'message_end' && (event.message as { role?: string })?.role === 'user').length === 2);
      expect(completions).toEqual([]);
      expect(queue.isComplete).toBe(false);
      releaseSuccessor(textEvents('late final'));
      await setup.waitFor('agent_end');
      expect(completions).toEqual([2]);
      expect(queue.isComplete).toBe(true);
      expect(setup.events.filter(event => event.type === 'agent_start')).toHaveLength(1);
    } finally {
      releaseEnd();
      releaseSuccessor(textEvents('late final'));
      await setup.kernel.close();
    }
  }, 10_000);

  it('delivers completion when the host event processor is delayed', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('final answer')] });
    let releaseWatch!: () => void;
    let blockedWatch!: () => void;
    const watchGate = new Promise<void>(resolve => { releaseWatch = resolve; });
    const watchBlocked = new Promise<void>(resolve => { blockedWatch = resolve; });
    const originalUsage = setup.kernel.contextUsagePayload.bind(setup.kernel);
    let blocked = false;
    setup.kernel.contextUsagePayload = async () => {
      if (!blocked) {
        blocked = true;
        blockedWatch();
        await watchGate;
      }
      return originalUsage();
    };
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('delay the host event processor');
      await watchBlocked;
      const harness = (setup.kernel as unknown as { harness: Harness }).harness;
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      const deadline = Date.now() + 2_000;
      while ((await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT))?.run) {
        if (Date.now() > deadline) throw new Error('Test run did not finish while watch was blocked');
        await Bun.sleep(10);
      }
      for (let i = 0; i < 102; i++) {
        await conversation.commit(async tx => {
          const usage = await tx.doc(UsageDoc, conversation.id);
          usage.models[`fixture-${i}`] = USAGE;
        }, BACKGROUND_CONTEXT);
      }
      releaseWatch();
      await setup.waitFor('agent_end', 2_000);
      expect(setup.events.filter(event => event.type === 'agent_end')).toHaveLength(1);
      expect(setup.events.some(event => event.type === 'message_end' && JSON.stringify(event).includes('final answer'))).toBe(true);
    } finally {
      releaseWatch();
      await setup.kernel.close();
    }
  }, 10_000);

  it('delivers a completed assistant message when speculative prefetch fails', async () => {
    const calls: ToolCall[] = [
      { type: 'toolCall', id: 'call-1', name: 'echo', arguments: { text: 'first' } },
      { type: 'toolCall', id: 'call-2', name: 'echo', arguments: { text: 'second' } },
    ];
    const final = assistantMessage(calls, 'toolUse');
    const setup = createKernel({
      sessionPath: scratch(),
      script: [[{ type: 'start', partial: { ...final, content: [] } }, { type: 'done', reason: 'toolUse', message: final }], textEvents('answer')],
      tools: true,
    });
    const hooks = (setup.kernel as unknown as { options: { hooks: { prefetchToolCall(): void; isPrefetchableTool(): boolean } } }).options.hooks;
    let prefetchCalls = 0;
    hooks.isPrefetchableTool = () => true;
    hooks.prefetchToolCall = () => { prefetchCalls++; throw new Error('prefetch unavailable'); };
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('answer');
      await setup.waitFor('agent_end');
      expect(prefetchCalls).toBeGreaterThan(0);
      expect(setup.events.some(event => event.type === 'message_end' && (event.message as { role?: string })?.role === 'assistant' && JSON.stringify(event).includes('call-1'))).toBe(true);
      expect(setup.events.some(event => event.type === 'pi_turn_anchor')).toBe(true);
    } finally {
      await setup.kernel.close();
    }
  });

  it('does not deliver events after the conversation closes', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('late answer')] });
    let releaseWatch!: () => void;
    let blockedWatch!: () => void;
    const watchGate = new Promise<void>(resolve => { releaseWatch = resolve; });
    const watchBlocked = new Promise<void>(resolve => { blockedWatch = resolve; });
    const originalUsage = setup.kernel.contextUsagePayload.bind(setup.kernel);
    let blocked = false;
    setup.kernel.contextUsagePayload = async () => {
      if (!blocked) {
        blocked = true;
        blockedWatch();
        await watchGate;
      }
      return originalUsage();
    };
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('close while delivery is blocked');
      await watchBlocked;
      await setup.kernel.close();
      const count = setup.events.length;
      releaseWatch();
      await Bun.sleep(100);
      expect(setup.events).toHaveLength(count);
    } finally {
      releaseWatch();
      await setup.kernel.close();
    }
  });

  for (const backend of ['sqlite', 'jsonl'] as const) it(`restores ${backend} model attachment paths from a portable bundle`, async () => {
    const workspace = scratch();
    const sessionId = 'model-file-export';
    const source = join(workspace, 'sessions', sessionId);
    mkdirSync(join(source, 'attachments'), { recursive: true });
    const attachment = join(source, 'attachments', 'document.pdf');
    writeFileSync(attachment, Buffer.from([37, 80, 68, 70, 0, 255]));
    mkdirSync(join(source, '.pi-sessions'));
    writeFileSync(join(source, '.pi-sessions', 'legacy.jsonl'), [
      { type: 'session', version: 3, id: 'edit-source' },
      { type: 'message', id: 'before', parentId: null, message: { role: 'user', content: `BEFORE_EDIT ${attachment}`, timestamp: 1 } },
      { type: 'context_edit', id: 'edit', parentId: 'before', targetId: 'before', replacement: { content: `EDIT_PATH ${attachment}` } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    if (backend === 'jsonl') {
      mkdirSync(join(source, 'durable-store'), { recursive: true });
      writeFileSync(join(source, 'durable-store', 'main.jsonl'), '');
    }
    const original = createKernel({ sessionPath: source, script: [textEvents('source answer')] });
    await original.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
    await original.kernel.submitPrompt(`Read [Stored at: ${attachment}]`);
    await original.waitFor('agent_end');
    await original.kernel.close();
    writeSessionJsonl(join(source, 'session.jsonl'), {
      id: sessionId, workspaceRootPath: workspace, createdAt: 1, lastUsedAt: 1,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      messages: [{ id: 'display', type: 'user', content: 'DISPLAY-ONLY', timestamp: 1 }],
    } as StoredSession);
    const bundle = serializeSession(workspace, sessionId)!;
    expect(bundle).not.toBeNull();
    const originalBundle = JSON.stringify(bundle);
    const target = scratch();
    restoreSessionBundleFiles(bundle, target);
    const secondTarget = scratch();
    restoreSessionBundleFiles(bundle, secondTarget);
    expect(JSON.stringify(bundle)).toBe(originalBundle);
    rmSync(source, { recursive: true });
    const resumed = createKernel({ sessionPath: target, script: [textEvents('restored')] });
    try {
      await resumed.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await resumed.kernel.submitPrompt('continue');
      await resumed.waitFor('agent_end');
      const context = JSON.stringify(resumed.calls[0]!.messages);
      expect(context).toContain(join(target, 'attachments', 'document.pdf'));
      expect(context).toContain(`EDIT_PATH ${join(target, 'attachments', 'document.pdf')}`);
      expect(context).not.toContain(attachment);
      expect(readFileSync(join(target, 'attachments', 'document.pdf'))).toEqual(Buffer.from([37, 80, 68, 70, 0, 255]));
    } finally {
      await resumed.kernel.close();
    }
    const second = createKernel({ sessionPath: secondTarget, script: [textEvents('second import')] });
    try {
      await second.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await second.kernel.submitPrompt('continue');
      await second.waitFor('agent_end');
      const context = JSON.stringify(second.calls[0]!.messages);
      expect(context).toContain(`EDIT_PATH ${join(secondTarget, 'attachments', 'document.pdf')}`);
      expect(context).not.toContain(target);
      expect(context).not.toContain(attachment);
    } finally {
      await second.kernel.close();
    }
  });

  for (const backend of ['sqlite', 'jsonl'] as const) it(`preserves ${backend} model attachment paths and files in a branch`, async () => {
    const parent = scratch();
    const childPath = scratch();
    mkdirSync(join(parent, 'attachments'));
    const attachment = join(parent, 'attachments', 'retained.txt');
    writeFileSync(attachment, 'retained bytes');
    if (backend === 'jsonl') {
      mkdirSync(join(parent, 'durable-store'), { recursive: true });
      writeFileSync(join(parent, 'durable-store', 'main.jsonl'), '');
    }
    const source = createKernel({ sessionPath: parent, script: [textEvents('first answer'), textEvents('later answer')] });
    await source.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
    await source.kernel.submitPrompt(`Read [Stored at: ${attachment}]`);
    await source.waitFor('agent_end');
    const anchor = String(source.events.find(event => event.type === 'pi_turn_anchor')!.sdkTurnAnchor);
    writeFileSync(join(parent, 'attachments', 'later.txt'), 'later bytes');
    await source.kernel.submitPrompt(`LATER_ONLY ${join(parent, 'attachments', 'later.txt')}`);
    await source.waitFor('agent_end', 2);
    await source.kernel.close();
    const before = Object.fromEntries(readdirSync(join(parent, 'durable-store')).map(name =>
      [name, readFileSync(join(parent, 'durable-store', name))]));
    let child = createKernel({ sessionPath: childPath, script: [textEvents('branch answer')] });
    try {
      await child.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 },
        branchFromSessionPath: parent, branchFromSdkTurnId: anchor });
      expect(readFileSync(attachment, 'utf8')).toBe('retained bytes');
      expect(Object.fromEntries(readdirSync(join(parent, 'durable-store')).map(name =>
        [name, readFileSync(join(parent, 'durable-store', name))]))).toEqual(before);
      expect(existsSync(join(childPath, 'attachments', 'retained.txt'))).toBe(true);
      expect(existsSync(join(childPath, 'attachments', 'later.txt'))).toBe(false);
      rmSync(parent, { recursive: true });
      await child.kernel.close();
      child = createKernel({ sessionPath: childPath, script: [textEvents('branch answer')] });
      await child.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await child.kernel.submitPrompt('continue branch');
      await child.waitFor('agent_end');
      const context = JSON.stringify(child.calls[0]!.messages);
      expect(context).toContain(join(childPath, 'attachments', 'retained.txt'));
      expect(context).not.toContain(attachment);
      expect(context).not.toContain('LATER_ONLY');
    } finally {
      await child.kernel.close();
    }
  });

  it('restores uninitialized legacy SDK context and branches from a portable bundle', async () => {
    const workspace = scratch();
    const sessionId = 'legacy-export';
    const source = join(workspace, 'sessions', sessionId);
    mkdirSync(join(source, '.pi-sessions'), { recursive: true });
    mkdirSync(join(source, 'attachments'));
    const attachment = join(source, 'attachments', 'legacy.txt');
    writeFileSync(attachment, 'legacy bytes');
    writeSessionJsonl(join(source, 'session.jsonl'), {
      id: sessionId, workspaceRootPath: workspace, createdAt: 1, lastUsedAt: 1, sdkSessionId: 'old-sdk',
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      messages: [{ id: 'display', type: 'user', content: 'DISPLAY-ONLY', timestamp: 1 }],
    } as StoredSession);
    const legacy = [
      { type: 'session', version: 3, id: 'old-sdk' },
      { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: `SDK-ONLY-USER ${attachment}`, timestamp: 1 } },
      { type: 'message', id: 'inactive', parentId: 'user', message: { role: 'user', content: 'INACTIVE-LEGACY-BRANCH', timestamp: 2 } },
      { type: 'message', id: 'answer', parentId: 'user', message: assistantMessage([{ type: 'text', text: 'SDK-ONLY-ANSWER' }], 'stop') },
      { type: 'context_edit', id: 'edit', parentId: 'answer', targetId: 'user',
        replacement: { content: `SDK-ONLY-USER edited ${attachment}` } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n';
    const older = join(source, '.pi-sessions', 'older.jsonl');
    writeFileSync(older, JSON.stringify({ type: 'session', version: 3, id: 'older-sdk' }) + '\n'
      + JSON.stringify({ type: 'message', id: 'old', message: { role: 'user', content: 'NOT-THE-LATEST', timestamp: 1 } }) + '\n');
    utimesSync(older, 1, 1);
    writeFileSync(join(source, '.pi-sessions', 'original.jsonl'), legacy);
    const bundle = serializeSession(workspace, sessionId);
    expect(bundle).not.toBeNull();
    expect(readFileSync(join(source, '.pi-sessions', 'original.jsonl'), 'utf8')).toBe(legacy);
    expect(existsSync(join(source, 'durable-store'))).toBe(false);
    const restoredPath = join(scratch(), 'restored');
    mkdirSync(restoredPath);
    restoreSessionBundleFiles(bundle!, restoredPath);
    rmSync(source, { recursive: true });
    const resumed = createKernel({ sessionPath: restoredPath, script: [textEvents('continued')] });
    try {
      await resumed.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await resumed.kernel.submitPrompt('continue');
      await resumed.waitFor('agent_end');
      const context = JSON.stringify(resumed.calls[0]!.messages);
      expect(context).toContain('SDK-ONLY-USER');
      expect(context).toContain('SDK-ONLY-ANSWER');
      expect(context).toContain(join(restoredPath, 'attachments', 'legacy.txt'));
      expect(context).not.toContain(attachment);
      expect(context.indexOf('SDK-ONLY-USER')).toBeLessThan(context.indexOf('SDK-ONLY-ANSWER'));
      expect(context).not.toContain('DISPLAY-ONLY');
      expect(context).not.toContain('INACTIVE-LEGACY-BRANCH');
      expect(context).not.toContain('NOT-THE-LATEST');
    } finally {
      await resumed.kernel.close();
    }
    const childPath = join(scratch(), 'child');
    const child = createKernel({ sessionPath: childPath, script: [textEvents('branched')] });
    try {
      await child.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 },
        branchFromSessionPath: restoredPath, branchFromSdkTurnId: 'inactive' });
      await child.kernel.submitPrompt('branch');
      await child.waitFor('agent_end');
      const context = JSON.stringify(child.calls[0]!.messages);
      expect(context).toContain('SDK-ONLY-USER');
      expect(context).toContain('INACTIVE-LEGACY-BRANCH');
      expect(context).toContain(join(childPath, 'attachments', 'legacy.txt'));
      expect(context).not.toContain('SDK-ONLY-ANSWER');
    } finally {
      await child.kernel.close();
    }
  }, 10_000);

  for (const storage of ['sqlite', 'jsonl'] as const) it(`does not export a browser password from the durable ${storage} store`, async () => {
    const workspace = scratch();
    const sessionId = 'browser-export';
    const sessionPath = join(workspace, 'sessions', sessionId);
    mkdirSync(sessionPath, { recursive: true });
    if (storage === 'jsonl') {
      mkdirSync(join(sessionPath, 'durable-store'), { recursive: true });
      writeFileSync(join(sessionPath, 'durable-store', 'main.jsonl'), '');
    }
    const secret = 'synthetic-password-value';
    const setup = createKernel({
      sessionPath,
      script: [
        toolCallEvents({ type: 'toolCall', id: 'browser-call', name: 'browser_tool', arguments: { command: `fill @e2 ${secret}` } }),
        textEvents('done'),
      ],
      extensions: [defineExtension({
        name: 'fake-browser',
        tools: [defineTool({
          name: 'browser_tool', description: 'Simulate a password fill.',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } as never,
          execute: async () => ({ output: [{ type: 'text' as const, text: 'Filled password field @e2 (24 characters)' }] }),
        })],
      })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('fill the test password');
      await setup.waitFor('agent_end');
      writeSessionJsonl(join(sessionPath, 'session.jsonl'), {
        id: sessionId, workspaceRootPath: workspace, createdAt: 1, lastUsedAt: 1,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
        messages: [{ id: 'tool', type: 'tool', content: '', timestamp: 1, toolName: 'browser_tool',
          toolUseId: 'browser-call', toolInput: { command: 'fill @e2 [password: 24 characters]' } }],
      } as StoredSession);
      const originalPath = join(sessionPath, 'durable-store', storage === 'sqlite' ? 'store.db-wal' : 'main.jsonl');
      const original = readFileSync(originalPath);
      expect(original.includes(secret)).toBe(true);
      const anchor = String(setup.events.find(event => event.type === 'pi_turn_anchor')!.sdkTurnAnchor);
      const bundle = serializeSession(workspace, sessionId);
      expect(bundle).not.toBeNull();
      if (storage === 'jsonl') {
        const corruptDir = join(scratch(), 'corrupt');
        mkdirSync(corruptDir);
        restoreFiles(corruptDir, bundle!.files);
        const mainPath = join(corruptDir, 'durable-store', 'main.jsonl');
        const lines = readFileSync(mainPath, 'utf8').trimEnd().split('\n');
        lines.push(JSON.stringify({ format: 1, seq: JSON.parse(lines.at(-1)!).seq + 1, type: 'commit', writes: [{ type: 'task.sidecar', id: 999999, ordinal: 0 }] }));
        writeFileSync(mainPath, lines.join('\n') + '\n');
        await expect(openNodeJsonlStorage(join(corruptDir, 'durable-store'), BACKGROUND_CONTEXT)).rejects.toThrow('Missing confirmed sidecar');
      }
      for (const file of bundle!.files) {
        expect(Buffer.from(file.contentBase64, 'base64').includes(secret)).toBe(false);
      }
      expect(readFileSync(originalPath).includes(secret)).toBe(true);

      const restoredPath = join(scratch(), 'restored');
      mkdirSync(restoredPath, { recursive: true });
      restoreFiles(restoredPath, bundle!.files);
      const resumed = createKernel({ sessionPath: restoredPath, script: [textEvents('continued')] });
      try {
        await resumed.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
        await resumed.kernel.submitPrompt('continue');
        await resumed.waitFor('agent_end');
        const context = JSON.stringify(resumed.calls[0]!.messages);
        expect(context).toContain('"id":"browser-call","name":"browser_tool","arguments":{"command":"fill @e2 "}');
        expect(context).toContain('"content":"continue"');
        expect(context).not.toContain(secret);
        expect(resumed.events.some(event => event.type === 'message_end' && JSON.stringify(event).includes('continued'))).toBe(true);
      } finally {
        await resumed.kernel.close();
      }

      const child = createKernel({ sessionPath: join(scratch(), 'child'), script: [textEvents('branched')] });
      try {
        await child.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: restoredPath, branchFromSdkTurnId: anchor });
        await child.kernel.submitPrompt('branch');
        await child.waitFor('agent_end');
        const context = JSON.stringify(child.calls[0]!.messages);
        expect(context).toContain('"id":"browser-call","name":"browser_tool","arguments":{"command":"fill @e2 "}');
        expect(context).toContain('"content":"branch"');
        expect(context).not.toContain(secret);
        expect(child.events.some(event => event.type === 'message_end' && JSON.stringify(event).includes('branched'))).toBe(true);
      } finally {
        await child.kernel.close();
      }
    } finally {
      await setup.kernel.close();
    }
  }, 10_000);

  it('rejects a durable SQLite schema with an unknown column', async () => {
    const workspace = scratch();
    const sessionId = 'unknown-sqlite-column';
    const sessionPath = join(workspace, 'sessions', sessionId);
    mkdirSync(sessionPath, { recursive: true });
    const setup = createKernel({ sessionPath, script: [] });
    await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
    await setup.kernel.close();
    writeSessionJsonl(join(sessionPath, 'session.jsonl'), {
      id: sessionId, workspaceRootPath: workspace, createdAt: 1, lastUsedAt: 1, messages: [],
    } as unknown as StoredSession);
    const db = new Database(join(sessionPath, 'durable-store', 'store.db'));
    try {
      db.exec("ALTER TABLE entries ADD COLUMN extra_secret TEXT DEFAULT 'fixture'");
    } finally {
      db.close();
    }
    expect(serializeSession(workspace, sessionId)).toBeNull();
  });

  for (const storage of ['sqlite', 'jsonl'] as const) for (const nested of [false, true]) it(`exports ordinary ${nested ? 'nested' : 'direct'} proxy browser input and redacts passwords in ${storage}`, async () => {
    const workspace = scratch();
    const sessionId = 'completed-proxy-browser';
    const sessionPath = join(workspace, 'sessions', sessionId);
    mkdirSync(sessionPath, { recursive: true });
    if (storage === 'jsonl') {
      mkdirSync(join(sessionPath, 'durable-store'), { recursive: true });
      writeFileSync(join(sessionPath, 'durable-store', 'main.jsonl'), '');
    }
    const secret = 'nested-password-fragment';
    const ordinary = 'ordinary-user-input';
    const configPath = scratch();
    writeFileSync(join(configPath, 'config.json'), JSON.stringify({ workspaces: [], browserToolEnabled: true }));
    const host = spawn(process.execPath, ['--preload', join(import.meta.dir, 'test-fixtures', 'block-network.ts'),
      join(import.meta.dir, 'test-fixtures', 'browser-proxy-host.ts')], {
      env: { ...process.env, CONFIG_DIR: configPath }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = createInterface({ input: host.stdout })[Symbol.asyncIterator]();
    let rpcId = 0;
    let hostError = '';
    host.stderr.on('data', chunk => { hostError += String(chunk); });
    const browser = createProxyTool({
      name: 'browser_tool', description: 'Browser proxy fixture.',
      inputSchema: { type: 'object', properties: { command: {} }, required: ['command'] },
    }, {
      approve: async (_name, args) => JSON.parse(JSON.stringify(args)),
      execute: async (toolName, args) => {
        const requestId = `browser-rpc-${rpcId++}`;
        host.stdin.write(JSON.stringify({ requestId, toolName, args }) + '\n');
        const response = await responses.next();
        if (response.done) throw new Error(`Browser proxy host exited: ${hostError}`);
        const message = JSON.parse(response.value);
        expect(message.type).toBe('tool_execute_response');
        expect(message.requestId).toBe(requestId);
        return message.result;
      },
    });
    const setup = createKernel({
      sessionPath,
      script: nested ? [toolCallEvents({ type: 'toolCall', id: 'outer-call', name: 'outer', arguments: {} }), textEvents('done')]
        : [toolCallEvents({ type: 'toolCall', id: 'direct-call', name: 'browser_tool', arguments: {
          command: `fill @e1 ${ordinary}; type ${ordinary}; paste ${ordinary}; fill @e2 ${secret}; type ${secret}; paste ${secret}`,
        } }), textEvents('done')],
      extensions: [defineExtension({ name: 'completed-proxy-browser', tools: [browser, defineTool({
        name: 'outer', description: 'Run nested browser input.', parameters: { type: 'object', properties: {} } as never,
        async execute(_args, api, context) {
          await api.executeTool('browser_tool', { command: `fill @e1 ${ordinary}; type ${ordinary}; paste ${ordinary}` }, context);
          await api.executeTool('browser_tool', { command: `fill @e2 ${secret}; type ${secret}; paste ${secret}` }, context);
          return { output: [{ type: 'text' as const, text: 'done' }] };
        },
      })] })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('run proxy browser');
      await setup.waitFor('agent_end');
      writeSessionJsonl(join(sessionPath, 'session.jsonl'), {
        id: sessionId, workspaceRootPath: workspace, createdAt: 1, lastUsedAt: 1, messages: [],
      } as unknown as StoredSession);
      const bundle = serializeSession(workspace, sessionId);
      expect(bundle).not.toBeNull();
      const history = bundle!.files.filter(file => file.relativePath.startsWith('durable-store/'))
        .map(file => Buffer.from(file.contentBase64, 'base64').toString('utf8')).join('\n');
      expect(history).toContain(ordinary);
      expect(history).not.toContain(secret);
    } finally {
      host.stdin.end();
      host.kill();
      await setup.kernel.close();
    }
  }, 15_000);

  for (const storage of ['sqlite', 'jsonl'] as const) for (const mode of [
    'modified', 'failure', 'missing', 'prefetched', 'stopped', 'conflict', 'duplicate', 'commit-failure',
  ] as const) it(`fails closed for nested proxy browser ${mode} in ${storage}`, async () => {
    const workspace = scratch();
    const sessionId = 'proxy-browser-evidence';
    const sessionPath = join(workspace, 'sessions', sessionId);
    mkdirSync(sessionPath, { recursive: true });
    if (storage === 'jsonl') {
      mkdirSync(join(sessionPath, 'durable-store'), { recursive: true });
      writeFileSync(join(sessionPath, 'durable-store', 'main.jsonl'), '');
    }
    const result = { content: 'done', isError: mode === 'failure', browserInput: mode === 'missing' ? undefined : [mode === 'stopped' ? 'unknown' : 'ordinary'] };
    let executions = 0;
    let browser = createProxyTool({
      name: 'browser_tool', description: 'Proxy evidence fixture.',
      inputSchema: { type: 'object', properties: { command: {} }, required: ['command'] },
    }, {
      approve: async (_name, args) => mode === 'modified' ? { command: 'type changed-input' } : args,
      execute: async () => {
        executions++;
        return JSON.parse(JSON.stringify(mode === 'conflict' && executions > 1 ? { ...result, browserInput: ['password'] } : result));
      },
      prefetched: () => mode === 'prefetched' ? Promise.resolve(result) : undefined,
    });
    const execute = browser.execute;
    browser = { ...browser, execute: async (args, api, context) => {
      if (mode === 'commit-failure') return execute(args, { ...api, commit: async () => { throw new Error('fixture evidence commit failed'); } }, context);
      const output = await execute(args, api, context);
      if (mode === 'conflict' || mode === 'duplicate') {
        // Replay uses the same task identity; identical evidence is harmless and a conflict is not.
        await execute(args, api, context);
      }
      return output;
    } };
    const setup = createKernel({
      sessionPath,
      script: [toolCallEvents({ type: 'toolCall', id: 'outer-call', name: 'outer', arguments: {} }), textEvents('done')],
      extensions: [defineExtension({ name: 'proxy-evidence-boundaries', tools: [browser, defineTool({
        name: 'outer', description: 'Run nested input.', parameters: { type: 'object', properties: {} } as never,
        async execute(_args, api, context) {
          await api.executeTool('browser_tool', { command: 'type original-input' }, context);
          return { output: [{ type: 'text' as const, text: 'done' }] };
        },
      })] })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('run proxy browser');
      await setup.waitFor('agent_end');
      writeSessionJsonl(join(sessionPath, 'session.jsonl'), {
        id: sessionId, workspaceRootPath: workspace, createdAt: 1, lastUsedAt: 1, messages: [],
      } as unknown as StoredSession);
      const bundle = serializeSession(workspace, sessionId);
      if (mode === 'duplicate') expect(bundle).not.toBeNull();
      else expect(bundle).toBeNull();
      if (mode === 'commit-failure' && storage === 'sqlite') {
        const db = new Database(join(sessionPath, 'durable-store', 'store.db'), { readonly: true });
        try {
          const tasks = (db.query('SELECT record FROM tasks').all() as Array<{ record: string }>).map(row => JSON.parse(row.record));
          const browserTask = tasks.find(task => task.kind === 'pi.tool' && task.input.kind === 'nested');
          expect(browserTask.state.outcome.status).toBe('failed');
          expect(browserTask.state.outcome.error.message).toContain('Tool browser_tool threw');
        } finally { db.close(); }
      }
      expect(executions).toBe(mode === 'prefetched' ? 0 : mode === 'duplicate' || mode === 'conflict' ? 2 : 1);
    } finally { await setup.kernel.close(); }
  }, 10_000);

  for (const storage of ['sqlite', 'jsonl'] as const) for (const stage of ['before-evidence', 'after-evidence'] as const) it(`rejects nested browser cancellation ${stage} in ${storage}`, async () => {
    const workspace = scratch();
    const sessionId = 'cancelled-browser-evidence';
    const sessionPath = join(workspace, 'sessions', sessionId);
    mkdirSync(sessionPath, { recursive: true });
    if (storage === 'jsonl') {
      mkdirSync(join(sessionPath, 'durable-store'), { recursive: true });
      writeFileSync(join(sessionPath, 'durable-store', 'main.jsonl'), '');
    }
    let release!: () => void;
    let notify!: () => void;
    const reached = new Promise<void>(resolve => { notify = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let executions = 0;
    const original = createProxyTool({ name: 'browser_tool', description: 'Cancellation fixture.',
      inputSchema: { type: 'object', properties: { command: {} }, required: ['command'] } }, {
      approve: async (_name, args) => args,
      execute: async () => {
        executions++;
        if (stage === 'before-evidence') { notify(); await gate; }
        return { content: 'done', isError: false, browserInput: ['ordinary'] };
      },
    });
    const browser = { ...original, execute: async (...args: Parameters<typeof original.execute>) => {
      const result = await original.execute(...args);
      if (stage === 'after-evidence') { notify(); await gate; }
      return result;
    } };
    const setup = createKernel({ sessionPath,
      script: [toolCallEvents({ type: 'toolCall', id: 'outer-call', name: 'outer', arguments: {} })],
      extensions: [defineExtension({ name: 'cancelled-proxy', tools: [browser, defineTool({
        name: 'outer', description: 'Nested call.', parameters: { type: 'object', properties: {} } as never,
        async execute(_args, api, context) {
          await api.executeTool('browser_tool', { command: 'type ordinary-input' }, context);
          return { output: [{ type: 'text' as const, text: 'done' }] };
        },
      })] })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('run proxy browser');
      await reached;
      const abort = setup.kernel.abort();
      release();
      await abort;
      await setup.waitFor('agent_end');
      expect(executions).toBe(1);
      writeSessionJsonl(join(sessionPath, 'session.jsonl'), {
        id: sessionId, workspaceRootPath: workspace, createdAt: 1, lastUsedAt: 1, messages: [],
      } as unknown as StoredSession);
      expect(serializeSession(workspace, sessionId)).toBeNull();
    } finally { release(); await setup.kernel.close(); }
  }, 10_000);

  for (const storage of ['sqlite', 'jsonl'] as const) for (const structured of [false, true]) it(`preserves ordinary nested browser input and removes passwords from the durable ${storage} store (${structured ? 'structured' : 'text'} output)`, async () => {
    const workspace = scratch();
    const sessionId = 'nested-browser-export';
    const sessionPath = join(workspace, 'sessions', sessionId);
    mkdirSync(sessionPath, { recursive: true });
    if (storage === 'jsonl') {
      mkdirSync(join(sessionPath, 'durable-store'), { recursive: true });
      writeFileSync(join(sessionPath, 'durable-store', 'main.jsonl'), '');
    }
    const secret = 'dwxhp-worbxf-frztn';
    const ordinary = 'unrelated-structured-output';
    let nestedStarted!: () => void;
    let finishNested!: () => void;
    const started = new Promise<void>(resolve => { nestedStarted = resolve; });
    const finish = new Promise<void>(resolve => { finishNested = resolve; });
    const setup = createKernel({
      sessionPath,
      script: [toolCallEvents({ type: 'toolCall', id: 'outer-call', name: 'outer', arguments: {} }), textEvents('done')],
      extensions: [defineExtension({
        name: 'nested-browser',
        tools: [
          defineTool({
            name: 'outer', description: 'Run a nested browser action.',
            parameters: { type: 'object', properties: {} } as never,
            async execute(_args, api, context) {
              await Promise.all([
                api.executeTool('browser_tool', { command: `fill @e1 ${ordinary}` }, context),
                api.executeTool('browser_tool', { command: `fill @e2 ${secret}` }, context),
              ]);
              nestedStarted();
              await finish;
              return { output: [{ type: 'text' as const, text: 'done' }] };
            },
          }),
          defineTool({
            name: 'browser_tool', description: 'Simulate ordinary and password fills.',
            parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } as never,
            ...(structured ? { structuredOutputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } as never } : {}),
            execute: async (args) => {
              const text = String((args as { command: string }).command).includes('@e1')
                ? `Filled element @e1 with "${ordinary}"\nValue length: ${ordinary.length} characters`
                : 'Filled password field @e2 (17 characters)';
              return {
                output: [{ type: 'text' as const, text: structured ? 'done' : text }],
                ...(structured ? { structuredOutput: { text } } : {}),
              };
            },
          }),
        ],
      })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('run nested action');
      await started;
      writeSessionJsonl(join(sessionPath, 'session.jsonl'), {
        id: sessionId, workspaceRootPath: workspace, createdAt: 1, lastUsedAt: 1, messages: [],
      } as unknown as StoredSession);
      const activeBundle = serializeSession(workspace, sessionId);
      expect(activeBundle).not.toBeNull();
      for (const file of activeBundle!.files) expect(Buffer.from(file.contentBase64, 'base64').includes(secret)).toBe(false);
      const activePath = join(scratch(), 'active');
      mkdirSync(activePath);
      restoreFiles(activePath, activeBundle!.files);
      if (storage === 'sqlite') {
        const db = new Database(join(activePath, 'durable-store', 'store.db'), { readonly: true });
        try {
          const tasks = db.query('SELECT record FROM tasks').all() as Array<{ record: string }>;
          expect(tasks.some(task => task.record.includes(`fill @e1 ${ordinary}`))).toBe(true);
        } finally {
          db.close();
        }
      } else {
        expect(readFileSync(join(activePath, 'durable-store', 'main.jsonl'), 'utf8').includes(`fill @e1 ${ordinary}`)).toBe(true);
      }
      finishNested();
      await setup.waitFor('agent_end');
      const bundle = serializeSession(workspace, sessionId);
      // The caller's terminal commit retires its nested result documents, leaving no field-type evidence.
      expect(bundle).toBeNull();
    } finally {
      finishNested();
      await setup.kernel.close();
    }
  }, 10_000);

  for (const storage of ['sqlite', 'jsonl'] as const) for (const [command, output, structured, allowed] of [
    ['fill @e1 ordinary-user-input', 'done', true, false],
    ['fill @e1 test-password-fragment', 'Filled password field @e1', true, false],
    ['type ordinary-user-input', 'Typed 19 characters into focused element\nActive element after: input', false, false],
    ['paste ordinary-user-input', 'Pasted 19 characters\nShortcut used: Cmd+V\nLines: 1, tabs: 0', false, false],
    ['type test-password-fragment', 'Entered text into a password field', false, true],
    ['paste test-password-fragment', 'Entered text into a password field', false, true],
    ['type test-password-fragment', 'Entered text into a password field', true, false],
    ['paste test-password-fragment', 'Entered text into a password field', true, false],
  ] as const) it(`${allowed ? 'redacts' : 'rejects'} nested ${command.split(' ')[0]} in ${storage} with ${structured ? 'a discarded output' : 'a persisted result'}: ${output.split('\n')[0]}`, async () => {
    const workspace = scratch();
    const sessionId = 'nested-browser-result-export';
    const sessionPath = join(workspace, 'sessions', sessionId);
    mkdirSync(sessionPath, { recursive: true });
    if (storage === 'jsonl') {
      mkdirSync(join(sessionPath, 'durable-store'), { recursive: true });
      writeFileSync(join(sessionPath, 'durable-store', 'main.jsonl'), '');
    }
    let nestedStarted!: () => void;
    let finishNested!: () => void;
    const started = new Promise<void>(resolve => { nestedStarted = resolve; });
    const finish = new Promise<void>(resolve => { finishNested = resolve; });
    const setup = createKernel({
      sessionPath,
      script: [toolCallEvents({ type: 'toolCall', id: 'outer-call', name: 'outer', arguments: {} }), textEvents('done')],
      extensions: [defineExtension({
        name: 'nested-browser-result',
        tools: [
          defineTool({
            name: 'outer', description: 'Run a nested browser action.',
            parameters: { type: 'object', properties: {} } as never,
            async execute(_args, api, context) {
              await api.executeTool('browser_tool', { command }, context);
              nestedStarted();
              await finish;
              return { output: [{ type: 'text' as const, text: 'done' }] };
            },
          }),
          defineTool({
            name: 'browser_tool', description: 'Simulate text and structured browser results.',
            parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } as never,
            ...(structured ? { structuredOutputSchema: { type: 'string' } as never } : {}),
            execute: async () => ({
              output: [{ type: 'text' as const, text: output }],
              ...(structured ? { structuredOutput: 'done' } : {}),
            }),
          }),
        ],
      })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('run nested action');
      await started;
      writeSessionJsonl(join(sessionPath, 'session.jsonl'), {
        id: sessionId, workspaceRootPath: workspace, createdAt: 1, lastUsedAt: 1, messages: [],
      } as unknown as StoredSession);
      const bundle = serializeSession(workspace, sessionId);
      if (allowed) {
        expect(bundle).not.toBeNull();
        for (const file of bundle!.files) expect(Buffer.from(file.contentBase64, 'base64').includes('test-password-fragment')).toBe(false);
      } else {
        expect(bundle).toBeNull();
      }
    } finally {
      finishNested();
      await setup.kernel.close();
    }
  }, 10_000);

  it('retries a failed cache warm while a tool is running and records successful usage', async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
    let finishWarm!: () => void;
    let notifyWarm!: () => void;
    const warmDone = new Promise<void>(resolve => { finishWarm = resolve; });
    const warmStarted = new Promise<void>(resolve => { notifyWarm = resolve; });
    const calls: Array<{ context: TranscriptContext; options: Record<string, unknown> }> = [];
    const models = createFauxModels([]).models;
    const model: Model<'faux'> = {
      id: 'faux-1', name: 'faux-1', api: 'faux', provider: 'faux',
      baseUrl: 'http://faux.test', reasoning: false, input: ['text'],
      cost: { input: 20, output: 2, cacheRead: 0.1, cacheWrite: 25 },
      promptCache: { short: 10.3, long: 10.3 }, contextWindow: 100_000, maxTokens: 4_096,
    };
    const modelUsage: Usage = {
      input: 20_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 20_001,
      cost: { input: 0.4, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.400002 },
    };
    const warmUsage: Usage = {
      input: 0, output: 1, cacheRead: 20_000, cacheWrite: 0, totalTokens: 20_001,
      cost: { input: 0, output: 0.000002, cacheRead: 0.002, cacheWrite: 0, total: 0.002002 },
    };
    let normalCalls = 0;
    let warmCalls = 0;
    models.setProvider(createProvider({
      id: 'faux', name: 'Faux', baseUrl: 'http://faux.test',
      auth: { apiKey: { name: 'Faux key', resolve: async () => ({ auth: { apiKey: 'test-key' } }) } },
      models: [model],
      api: { faux: {
        stream() { throw new Error('unexpected stream'); },
        streamSimple(_model, context, options) {
          calls.push({ context, options: options as Record<string, unknown> });
          const isWarm = options?.maxTokens === 1;
          const message = isWarm
            ? { ...assistantMessage([{ type: 'text', text: 'warm' }], 'stop'), usage: warmUsage }
            : normalCalls++ === 0
              ? { ...assistantMessage([{ type: 'toolCall', id: 'slow-1', name: 'slow', arguments: {} }], 'toolUse'), usage: modelUsage }
              : { ...assistantMessage([{ type: 'text', text: 'done' }], 'stop'), usage: modelUsage };
          const stream = createAssistantMessageEventStream();
          if (isWarm && warmCalls++ === 0) {
            const error = { ...assistantMessage([], 'error'), errorMessage: 'temporary cache warm failure' };
            queueMicrotask(() => stream.push({ type: 'error', reason: 'error', error }));
          } else if (isWarm) {
            notifyWarm();
            void warmDone.then(() => stream.push({ type: 'done', reason: 'stop', message }));
          } else {
            queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }));
          }
          return stream;
        },
      } },
    }));
    const setup = createKernel({
      sessionPath: scratch(), script: [], models, systemPrompt: 'warm test system prompt',
      extensions: [defineExtension({
        name: 'slow-tool',
        tools: [defineTool({
          name: 'slow', description: 'Wait for the test.',
          parameters: { type: 'object', properties: {} } as never,
          execute: async () => { await toolGate; return { output: [{ type: 'text' as const, text: 'done' }] }; },
        })],
      })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('request');
      await setup.waitFor('tool_execution_start');
      await Promise.race([
        warmStarted,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cache warm was not retried')), 2_000)),
      ]);
      expect(warmCalls).toBe(2);
      const original = calls[0]!;
      const warm = calls.find(call => call.options.maxTokens === 1)!;
      expect(warm.context.messages).toEqual(original.context.messages);
      expect(JSON.stringify(original.context.messages)).toContain('warm test system prompt');
      expect(warm.options.sessionId).toBe(original.options.sessionId);
      expect(warm.options.maxRetries).toBe(0);
      releaseTool();
      await setup.waitFor('agent_end');
      finishWarm();
      const harness = (setup.kernel as unknown as { harness: Harness }).harness;
      let ledger = await harness.usage(BACKGROUND_CONTEXT);
      for (let attempt = 0; attempt < 50 && !ledger.models['faux/faux-1']?.cacheRead; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        ledger = await harness.usage(BACKGROUND_CONTEXT);
      }
      expect(ledger.models['faux/faux-1']?.cacheRead).toBe(20_000);
      const count = calls.length;
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(calls).toHaveLength(count);
    } finally {
      releaseTool();
      finishWarm();
      await setup.kernel.close();
    }
  }, 10_000);

  it('does not warm a changed model when the active request was prepared with another model', async () => {
    let resumeCapture!: () => void;
    let notifyCapture!: () => void;
    let releaseTool!: () => void;
    const captureGate = new Promise<void>(resolve => { resumeCapture = resolve; });
    const captureStarted = new Promise<void>(resolve => { notifyCapture = resolve; });
    const toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
    const calls: Array<{ model: string; warm: boolean }> = [];
    const models = createFauxModels([]).models;
    const first: Model<'faux'> = {
      id: 'faux-1', name: 'faux-1', api: 'faux', provider: 'faux',
      baseUrl: 'http://faux.test', reasoning: false, input: ['text'],
      cost: { input: 20, output: 2, cacheRead: 0.1, cacheWrite: 25 },
      promptCache: { short: 10.3, long: 10.3 }, contextWindow: 100_000, maxTokens: 4_096,
    };
    const usage: Usage = {
      input: 20_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 20_001,
      cost: { input: 0.4, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.400002 },
    };
    models.setProvider(createProvider({
      id: 'faux', name: 'Faux', baseUrl: 'http://faux.test',
      auth: { apiKey: { name: 'Faux key', resolve: async () => ({ auth: { apiKey: 'fake-key' } }) } },
      models: [first, { ...first, id: 'faux-2', name: 'faux-2' }],
      api: { faux: {
        stream() { throw new Error('unexpected stream'); },
        streamSimple(model, _context, options) {
          const warm = options?.maxTokens === 1;
          calls.push({ model: model.id, warm });
          const message = warm
            ? { ...assistantMessage([{ type: 'text', text: 'warm' }], 'stop'), model: model.id, usage }
            : { ...assistantMessage([{ type: 'toolCall', id: 'slow-1', name: 'slow', arguments: {} }], 'toolUse'), model: model.id, usage };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }));
          return stream;
        },
      } },
    }));
    const setup = createKernel({
      sessionPath: scratch(), script: [], models,
      extensions: [defineExtension({
        name: 'slow-tool',
        tools: [defineTool({
          name: 'slow', description: 'Wait for the test.',
          parameters: { type: 'object', properties: {} } as never,
          execute: async () => { await toolGate; return { output: [{ type: 'text' as const, text: 'done' }] }; },
        })],
      })],
    });
    const capture = CacheWarmer.prototype.capture;
    let gated = false;
    CacheWarmer.prototype.capture = async function (...args) {
      if (!gated) {
        gated = true;
        notifyCapture();
        await captureGate;
      }
      return capture.apply(this, args);
    };
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('request');
      await captureStarted;
      await setup.kernel.setModel({ provider: 'faux', modelId: 'faux-2', contextWindow: 100_000 });
      resumeCapture();
      await setup.waitFor('tool_execution_start');
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(calls[0]).toEqual({ model: 'faux-1', warm: false });
      expect(calls.filter(call => call.warm)).toEqual([]);
    } finally {
      CacheWarmer.prototype.capture = capture;
      resumeCapture();
      releaseTool();
      await setup.kernel.abort();
      await setup.kernel.close();
    }
  }, 10_000);

  it('does not compact a short conversation that fits the retained context', async () => {
    const setup = createKernel({
      sessionPath: scratch(),
      script: [textEvents('first'), textEvents('second'), textEvents('third')],
      systemPrompt: 'system '.repeat(12_000),
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 16_384 } });
      for (let turn = 0; turn < 3; turn++) {
        await setup.kernel.submitPrompt(`question ${turn}`);
        await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_end').length === turn + 1);
      }
      expect(setup.calls).toHaveLength(3);
      expect(setup.events.filter(event => event.type === 'compaction_start')).toHaveLength(0);
    } finally {
      await setup.kernel.close();
    }
  }, 20_000);

  it('recomputes compaction reserves and usage for the active model', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('reply')], autoCompactWindow: 100_000 });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 1_000_000 } });
      expect((await setup.kernel.contextUsagePayload()).compactionSettings).toEqual({ enabled: true, reserveTokens: 900_000 });
      await setup.kernel.submitPrompt('measure context');
      await setup.waitFor('agent_end');
      expect((await setup.kernel.contextUsagePayload()).contextUsage).toEqual({ tokens: 15, contextWindow: 1_000_000, percent: 0.0015 });
      await setup.kernel.setModel({ provider: 'faux', modelId: 'faux-1', contextWindow: 131_072 });
      expect((await setup.kernel.contextUsagePayload()).compactionSettings.reserveTokens).toBe(
        Math.max(DEFAULT_COMPACTION_POLICY.reserveTokens, 31_072),
      );
      setup.kernel.setAutoCompaction(false);
      expect((await setup.kernel.contextUsagePayload()).compactionSettings.enabled).toBe(false);
    } finally {
      await setup.kernel.close();
    }
  });

  it('reports an error when manual compaction has nothing to summarize', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('short response')] });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('short question');
      await setup.waitFor('agent_end');
      await expect(setup.kernel.compact()).rejects.toThrow('Nothing to compact');
      const event = await setup.waitFor('compaction_end');
      expect(event.result).toBeUndefined();
    } finally {
      await setup.kernel.close();
    }
  });

  it('accepts a new prompt while an earlier compaction is still running', async () => {
    let releaseSummary!: () => void;
    let notifySummary!: () => void;
    const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
    const summaryStarted = new Promise<void>(resolve => { notifySummary = resolve; });
    const setup = createKernel({
      sessionPath: scratch(),
      script: [textEvents('first'), textEvents('second'), textEvents('third')],
      extensions: [defineExtension({
        name: 'concurrent-compaction',
        hooks: [hook(CompactionTask, {
          beforeCompact: async () => {
            notifySummary();
            await summaryGate;
            return { summary: 'compacted history' };
          },
        })],
      })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      for (let turn = 0; turn < 2; turn++) {
        await setup.kernel.submitPrompt('long input '.repeat(8_000));
        await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_end').length === turn + 1);
      }
      const outcome = setup.kernel.compact().then(result => ({ result }), error => ({ error }));
      await summaryStarted;
      await setup.kernel.submitPrompt('continue while compacting');
      await setup.waitForWhere(() => setup.calls.length === 3);
      await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_end').length === 3);
      releaseSummary();
      expect('result' in await outcome).toBe(true);
    } finally {
      releaseSummary();
      await setup.kernel.close();
    }
  }, 30_000);

  it.each([
    ['abort', 'before-ready'], ['cancel_compact', 'before-ready'],
    ['abort', 'during-open'], ['cancel_compact', 'during-open'],
  ] as const)('cancels a compact request via %s %s', async (type, stage) => {
    const dir = scratch();
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      slow: { command: process.execPath, args: [join(import.meta.dir, 'test-fixtures/mcp-server.ts'), '--slow-initialize'] },
    } }));
    const env: NodeJS.ProcessEnv = { CONFIG_DIR: dir, TMPDIR: dir };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(process.execPath, [
      '--preload', join(import.meta.dir, 'test-fixtures/block-network.ts'), join(import.meta.dir, 'index.ts'),
    ], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const events: Array<Record<string, any>> = [];
    let stdout = '';
    let phase = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const message = JSON.parse(line);
        events.push(message);
        if (message.type === 'ready' && phase === 0 && stage === 'during-open') {
          phase = 1;
          child.stdin.write(`${JSON.stringify({ type: 'compact', id: 'startup-compact' })}\n`);
          setTimeout(() => child.stdin.write(`${JSON.stringify({ type, id: 'startup-compact' })}\n`), 50);
        }
      }
    });
    try {
      child.stdin.write(`${JSON.stringify({
        type: 'init', apiKey: 'test-key', model: 'pi/fake-model', cwd: dir,
        thinkingLevel: 'off', workspaceRootPath: dir, sessionId: 'startup-compaction', agentDir,
        sessionPath: dir, workingDirectory: dir, plansFolderPath: join(dir, 'plans'),
        baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
      })}\n`);
      if (stage === 'before-ready') {
        child.stdin.write(`${JSON.stringify({ type: 'compact', id: 'startup-compact' })}\n`);
        child.stdin.write(`${JSON.stringify({ type, id: 'startup-compact' })}\n`);
      }
      const deadline = Date.now() + 10_000;
      while (!events.some(event => event.type === 'compact_result') && Date.now() < deadline) await Bun.sleep(20);
      const result = events.find(event => event.type === 'compact_result');
      expect(result?.success).toBe(false);
      expect(result?.errorMessage).toContain('aborted');
      expect(events.some(event => event.type === 'event' && event.event?.type === 'compaction_start')).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill();
        await exited;
      }
    }
  }, 15_000);

  it('cancels a queued compaction without aborting the concurrent prompt', async () => {
    let releaseSummary!: () => void;
    let notifySummary!: () => void;
    let releaseTool!: () => void;
    let notifyTool!: () => void;
    const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
    const summaryStarted = new Promise<void>(resolve => { notifySummary = resolve; });
    const toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
    const toolStarted = new Promise<void>(resolve => { notifyTool = resolve; });
    const setup = createKernel({
      sessionPath: scratch(),
      script: [textEvents('first'), textEvents('second'), toolCallEvents({
        type: 'toolCall', id: 'concurrent-tool', name: 'gated_tool', arguments: {},
      }), textEvents('completed after cancellation')],
      extensions: [defineExtension({
        name: 'targeted-compaction-cancel',
        hooks: [hook(CompactionTask, {
          beforeCompact: async () => {
            notifySummary();
            await summaryGate;
            return { summary: 'queued summary' };
          },
        })],
        tools: [defineTool({
          name: 'gated_tool', description: 'Wait until the test releases the tool.',
          parameters: { type: 'object', properties: {} } as never,
          execute: async () => {
            notifyTool();
            await toolGate;
            return { output: [{ type: 'text' as const, text: 'tool complete' }] };
          },
        })],
      })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      for (let turn = 0; turn < 2; turn++) {
        await setup.kernel.submitPrompt('long input '.repeat(8_000));
        await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_end').length === turn + 1);
      }
      const cancellation = new AbortController();
      const compact = setup.kernel.compact(undefined, cancellation.signal).then(() => 'completed', error => String(error));
      await summaryStarted;
      await setup.kernel.submitPrompt('concurrent input');
      await toolStarted;
      releaseSummary();
      const harness = (setup.kernel as unknown as { harness: Harness }).harness;
      let pending;
      for (let attempt = 0; attempt < 100 && !pending; attempt++) {
        pending = (await harness.inspect(BACKGROUND_CONTEXT)).submissions.find(item => item.type === 'write' && item.status === 'queued');
        if (!pending) await Bun.sleep(20);
      }
      expect(pending).toBeDefined();
      cancellation.abort();
      expect(await compact).toContain('aborted');
      const submission = await harness.submission(pending!.id, BACKGROUND_CONTEXT);
      expect((await submission!.status(BACKGROUND_CONTEXT)).status).toBe('unanswered');
      releaseTool();
      await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_end').length === 3);
      expect(setup.calls).toHaveLength(4);
      expect(setup.events.some(event => event.type === 'message_end' && JSON.stringify(event).includes('completed after cancellation'))).toBe(true);
    } finally {
      releaseSummary();
      releaseTool();
      await setup.kernel.close();
    }
  }, 30_000);

  it.each(['reinitialize', 'shutdown', 'EOF', 'SIGTERM'] as const)(
    'rejects old tool approvals while %s waits for compaction', async (action) => {
    const dir = scratch();
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'mcp.json'), '{}');
    const env: NodeJS.ProcessEnv = { CONFIG_DIR: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const bootstrap = `
      import { DurableKernel } from ${JSON.stringify(join(import.meta.dir, 'kernel.ts'))};
      const compact = DurableKernel.prototype.compact;
      DurableKernel.prototype.compact = function (...args) {
        const usage = this.contextUsagePayload.bind(this);
        let held = false;
        this.contextUsagePayload = async () => {
          if (!held) {
            held = true;
            process.stderr.write('TEST_COMPACTION_USAGE_STARTED\\n');
            await Bun.sleep(500);
          }
          return usage();
        };
        return compact.apply(this, args);
      };
      globalThis.WebSocket = class { constructor() { throw new Error('TEST_WEBSOCKET_BLOCKED'); } };
      let calls = 0;
      globalThis.fetch = Object.assign(async () => {
        const call = ++calls;
        const delta = call <= 2
          ? { tool_calls: [{ index: 0, id: 'fixture-' + call, type: 'function', function: { name: 'fixture', arguments: '{}' } }] }
          : { content: 'new session complete' };
        const chunk = { id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: call <= 2 ? 'tool_calls' : 'stop' }] };
        return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
      }, { preconnect() {} });
      await import(${JSON.stringify(join(import.meta.dir, 'index.ts'))});
    `;
    const child = spawn(process.execPath, ['--eval', bootstrap], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const send = (...messages: Array<Record<string, unknown>>): void => {
      child.stdin.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
    };
    const init = (sessionId: string) => ({
      type: 'init', apiKey: 'fixture-key', model: 'pi/fake-model', cwd: dir,
      thinkingLevel: 'off', workspaceRootPath: dir, sessionId, agentDir,
      sessionPath: dir, workingDirectory: dir, plansFolderPath: join(dir, 'plans'),
      baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
    });
    let stdout = '';
    let readyCount = 0;
    let approvals = 0;
    let firstApprovalId: string | undefined;
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    child.stderr.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('TEST_COMPACTION_USAGE_STARTED') && firstApprovalId) {
        const approval = { type: 'pre_tool_use_response', requestId: firstApprovalId, action: 'allow' };
        if (action === 'reinitialize') send(approval, init('replacement'));
        else if (action === 'shutdown') send(approval, { type: 'shutdown' });
        else if (action === 'EOF') child.stdin.end(JSON.stringify(approval) + '\n');
        else {
          send(approval);
          child.kill('SIGTERM');
        }
      }
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.type === 'ready') {
          readyCount++;
          if (readyCount === 1) {
            send({ type: 'register_tools', tools: [{ name: 'fixture', description: 'Test proxy.', inputSchema: { type: 'object', properties: {} } }] },
              { type: 'prompt', id: 'old-prompt', message: 'test', systemPrompt: 'test' });
          } else {
            send({ type: 'prompt', id: 'replacement-prompt', message: 'continue', systemPrompt: 'test' });
          }
        }
        if (message.type === 'pre_tool_use_request') {
          approvals++;
          if (!firstApprovalId) {
            firstApprovalId = message.requestId;
            send({ type: 'compact', id: 'held-compaction' });
          }
        }
        if (readyCount === 2 && message.type === 'event' && message.event?.type === 'message_end'
          && JSON.stringify(message.event).includes('new session complete')) complete();
      }
    });
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    try {
      send(init('original'));
      if (action === 'reinitialize') {
        expect(await Promise.race([completed.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true);
        expect(readyCount).toBe(2);
        send({ type: 'shutdown' });
      }
      expect(await Promise.race([exited, Bun.sleep(3_000).then(() => 'timeout')])).toBe(0);
      // The wrapper and proxy can both request approval before shutdown takes the line.
      expect(approvals).toBeGreaterThan(0);
      expect(approvals).toBeLessThanOrEqual(2);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 15_000);

  it.each(['shutdown', 'EOF', 'SIGTERM'] as const)('closes an opening kernel via %s', async (action) => {
    const dir = scratch();
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'mcp.json'), '{}');
    const env: NodeJS.ProcessEnv = { CONFIG_DIR: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const bootstrap = `
      import { DurableKernel } from ${JSON.stringify(join(import.meta.dir, 'kernel.ts'))};
      const open = DurableKernel.prototype.open;
      DurableKernel.prototype.open = async function (...args) {
        process.stderr.write('TEST_KERNEL_OPEN_STARTED\\n');
        await Bun.sleep(300);
        return open.apply(this, args);
      };
      globalThis.fetch = async () => { throw new Error('OFFLINE_FETCH_BLOCKED'); };
      await import(${JSON.stringify(join(import.meta.dir, 'index.ts'))});
    `;
    const child = spawn(process.execPath, ['--eval', bootstrap], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const send = (message: Record<string, unknown>): void => { child.stdin.write(JSON.stringify(message) + '\n'); };
    let opening = false;
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (!opening && chunk.toString().includes('TEST_KERNEL_OPEN_STARTED')) {
        opening = true;
        if (action === 'shutdown') send({ type: 'shutdown' });
        else if (action === 'EOF') child.stdin.end();
        else child.kill('SIGTERM');
      }
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (JSON.parse(line).type === 'ready') send({ type: 'ensure_session_ready', id: 'opening' });
      }
    });
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    try {
      send({
        type: 'init', apiKey: 'fixture-key', model: 'pi/fake-model', cwd: dir,
        thinkingLevel: 'off', workspaceRootPath: dir, sessionId: 'opening-shutdown', agentDir,
        sessionPath: dir, workingDirectory: dir, plansFolderPath: join(dir, 'plans'),
        baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
      });
      expect(await Promise.race([exited, Bun.sleep(5_000).then(() => 'timeout')])).toBe(0);
      expect(opening).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 10_000);

  it('reinitializes with a pending tool approval without cancelling new compact requests', async () => {
    const dir = scratch();
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      test: { command: process.execPath, args: [join(import.meta.dir, 'test-fixtures/mcp-server.ts')] },
    } }));
    const env: NodeJS.ProcessEnv = { CONFIG_DIR: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(process.execPath, [
      '--preload', join(import.meta.dir, 'test-fixtures/mock-provider.ts'), join(import.meta.dir, 'index.ts'),
    ], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const init = (sessionId: string) => ({
      type: 'init', apiKey: 'fixture-key', model: 'pi/fake-model', cwd: dir,
      thinkingLevel: 'off', workspaceRootPath: dir, sessionId, agentDir,
      sessionPath: dir, workingDirectory: dir, plansFolderPath: join(dir, 'plans'),
      baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
    });
    const send = (...messages: Array<Record<string, unknown>>): void => {
      child.stdin.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
    };
    const compactResults = new Map<string, Record<string, any>>();
    let readyCount = 0;
    let requested = false;
    let stdout = '';
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.type === 'ready') {
          readyCount++;
          if (readyCount === 1) send({ type: 'prompt', id: 'old-prompt', message: 'test', systemPrompt: 'test' });
        }
        if (message.type === 'pre_tool_use_request' && !requested) {
          requested = true;
          send({ type: 'compact', id: 'old-compact' }, init('reinitialized'), { type: 'compact', id: 'new-compact' });
        }
        if (message.type === 'compact_result') {
          compactResults.set(message.id, message);
          if (message.id === 'new-compact') send({ type: 'prompt', id: 'new-prompt', message: 'continue', systemPrompt: 'test' });
        }
        if (readyCount === 2 && message.type === 'event' && message.event?.type === 'message_end'
          && JSON.stringify(message.event).includes('done')) complete();
      }
    });
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    try {
      send(init('original'), { type: 'compact', id: 'cold-compact' });
      expect(await Promise.race([completed.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true);
      expect(requested).toBe(true);
      expect(readyCount).toBe(2);
      expect(compactResults.get('old-compact')?.errorMessage).toContain('aborted');
      for (const id of ['cold-compact', 'new-compact']) {
        expect(compactResults.has(id)).toBe(true);
        expect(compactResults.get(id)?.errorMessage).toContain('Nothing to compact');
      }
      send({ type: 'shutdown' });
      expect(await Promise.race([exited, Bun.sleep(3_000).then(() => 'timeout')])).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        send({ type: 'shutdown' });
        if (await Promise.race([exited.then(() => true), Bun.sleep(3_000).then(() => false)]) === false) child.kill('SIGKILL');
        await exited;
      }
    }
  }, 15_000);

  it('cleans up when signaled while a tool approval is pending', async () => {
    const dir = scratch();
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      test: { command: process.execPath, args: [join(import.meta.dir, 'test-fixtures/mcp-server.ts')] },
    } }));
    const env: NodeJS.ProcessEnv = { CONFIG_DIR: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(process.execPath, [
      '--preload', join(import.meta.dir, 'test-fixtures/mock-provider.ts'), join(import.meta.dir, 'index.ts'),
    ], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let requested = false;
    let blocked!: () => void;
    const approvalRequested = new Promise<void>(resolve => { blocked = resolve; });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.type === 'ready') child.stdin.write(`${JSON.stringify({ type: 'prompt', id: 'blocked-tool', message: 'test', systemPrompt: 'test' })}\n`);
        if (message.type === 'pre_tool_use_request' && !requested) {
          requested = true;
          blocked();
        }
      }
    });
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    try {
      child.stdin.write(`${JSON.stringify({
        type: 'init', apiKey: 'test-key', model: 'pi/fake-model', cwd: dir,
        thinkingLevel: 'off', workspaceRootPath: dir, sessionId: 'shutdown-pending-approval', agentDir,
        sessionPath: dir, workingDirectory: dir, plansFolderPath: join(dir, 'plans'),
        baseUrl: 'http://fake-provider.test/v1', customEndpoint: { api: 'openai-completions' },
      })}\n`);
      expect(await Promise.race([approvalRequested.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true);
      child.kill('SIGTERM');
      const exitCode = await Promise.race([exited, Bun.sleep(5_000).then(() => 'timeout')]);
      expect(requested).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill();
        await exited;
      }
    }
  }, 10_000);

  it('withdraws a queued compaction when the kernel closes and stays withdrawn on reopen', async () => {
    let releaseSummary!: () => void;
    let notifySummary!: () => void;
    let releaseTool!: () => void;
    let notifyTool!: () => void;
    const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
    const summaryStarted = new Promise<void>(resolve => { notifySummary = resolve; });
    const toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
    const toolStarted = new Promise<void>(resolve => { notifyTool = resolve; });
    const sessionPath = scratch();
    const setup = createKernel({
      sessionPath,
      script: [textEvents('first'), textEvents('second'), toolCallEvents({
        type: 'toolCall', id: 'close-tool', name: 'gated_tool', arguments: {},
      }), textEvents('completed')],
      extensions: [defineExtension({
        name: 'close-compaction',
        hooks: [hook(CompactionTask, {
          beforeCompact: async () => {
            notifySummary();
            await summaryGate;
            return { summary: 'withdrawn summary' };
          },
        })],
        tools: [defineTool({
          name: 'gated_tool', description: 'Wait until the test releases the tool.',
          parameters: { type: 'object', properties: {} } as never,
          execute: async () => {
            notifyTool();
            await toolGate;
            return { output: [{ type: 'text' as const, text: 'tool complete' }] };
          },
        })],
      })],
    });
    const model = { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 };
    let reopened: KernelSetup | undefined;
    try {
      await setup.kernel.open({ model });
      for (let turn = 0; turn < 2; turn++) {
        await setup.kernel.submitPrompt('long input '.repeat(8_000));
        await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_end').length === turn + 1);
      }
      const outcome = setup.kernel.compact().then(() => 'completed', error => String(error));
      await summaryStarted;
      await setup.kernel.submitPrompt('concurrent input');
      await toolStarted;
      releaseSummary();
      const harness = (setup.kernel as unknown as { harness: Harness }).harness;
      let pending;
      for (let attempt = 0; attempt < 100 && !pending; attempt++) {
        pending = (await harness.inspect(BACKGROUND_CONTEXT)).submissions.find(item => item.type === 'write' && item.status === 'queued');
        if (!pending) await Bun.sleep(20);
      }
      expect(pending).toBeDefined();
      const close = setup.kernel.close();
      expect(await outcome).toContain('aborted');
      releaseTool();
      await close;
      reopened = createKernel({ sessionPath, script: [] });
      await reopened.kernel.open({ model });
      const resumed = (reopened.kernel as unknown as { harness: Harness }).harness;
      const submission = await resumed.submission(pending!.id, BACKGROUND_CONTEXT);
      expect((await submission!.status(BACKGROUND_CONTEXT)).status).toBe('unanswered');
    } finally {
      releaseSummary();
      releaseTool();
      await reopened?.kernel.close();
      await setup.kernel.close();
    }
  }, 30_000);

  it('cancels manual compaction before closing the kernel', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [] });
    let releaseUsage!: () => void;
    let notifyUsage!: () => void;
    const usageStarted = new Promise<void>(resolve => { notifyUsage = resolve; });
    const usageGate = new Promise<void>(resolve => { releaseUsage = resolve; });
    const originalUsage = setup.kernel.contextUsagePayload.bind(setup.kernel);
    setup.kernel.contextUsagePayload = async () => {
      notifyUsage();
      await usageGate;
      return originalUsage();
    };
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      const outcome = setup.kernel.compact().then(() => 'completed', error => String(error));
      await usageStarted;
      let closeDone = false;
      const close = setup.kernel.close().then(() => { closeDone = true; });
      await Bun.sleep(50);
      expect(closeDone).toBe(false);
      releaseUsage();
      await close;
      expect(await outcome).toContain('Compaction aborted');
    } finally {
      releaseUsage();
      await setup.kernel.close();
    }
  });

  it('cancels manual compaction when abort arrives before task admission', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [] });
    let releaseUsage!: () => void;
    let notifyUsage!: () => void;
    const usageStarted = new Promise<void>(resolve => { notifyUsage = resolve; });
    const usageGate = new Promise<void>(resolve => { releaseUsage = resolve; });
    const originalUsage = setup.kernel.contextUsagePayload.bind(setup.kernel);
    setup.kernel.contextUsagePayload = async () => {
      notifyUsage();
      await usageGate;
      return originalUsage();
    };
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      const outcome = setup.kernel.compact().then(() => 'completed', error => String(error));
      await usageStarted;
      let abortDone = false;
      const abort = setup.kernel.abort().then(() => { abortDone = true; });
      await Bun.sleep(50);
      expect(abortDone).toBe(false);
      releaseUsage();
      await abort;
      expect(await outcome).toContain('Compaction aborted');
      const harness = (setup.kernel as unknown as { harness: Harness }).harness;
      expect((await harness.inspect(BACKGROUND_CONTEXT)).submissions.filter(item => item.requestId?.startsWith('compaction:'))).toHaveLength(0);
    } finally {
      releaseUsage();
      await setup.kernel.close();
    }
  });

  it('cancels a queued summary when abort races with the compaction receipt', async () => {
    let releaseSummary!: () => void;
    let notifySummary!: () => void;
    let releaseReceipt!: () => void;
    let notifyReceipt!: () => void;
    const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
    const summaryStarted = new Promise<void>(resolve => { notifySummary = resolve; });
    const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
    const receiptReady = new Promise<void>(resolve => { notifyReceipt = resolve; });
    const setup = createKernel({
      sessionPath: scratch(),
      script: [textEvents('first'), textEvents('second'), textEvents('concurrent reply')],
      extensions: [defineExtension({
        name: 'delayed-summary-receipt',
        hooks: [hook(CompactionTask, {
          beforeCompact: async () => {
            notifySummary();
            await summaryGate;
            return { summary: 'queued summary' };
          },
        })],
      })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      for (let turn = 0; turn < 2; turn++) {
        await setup.kernel.submitPrompt('long input '.repeat(8_000));
        await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_end').length === turn + 1);
      }
      const harness = (setup.kernel as unknown as { harness: Harness }).harness;
      const waitForTask = harness.waitForTask.bind(harness);
      let holdReceipt = true;
      harness.waitForTask = async (...args) => {
        const task = await waitForTask(...args);
        if (holdReceipt && task.kind === 'pi.compaction') {
          holdReceipt = false;
          notifyReceipt();
          await receiptGate;
        }
        return task;
      };
      const outcome = setup.kernel.compact().then(() => 'completed', error => String(error));
      await summaryStarted;
      await setup.kernel.submitPrompt('concurrent input');
      await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_start').length === 3);
      releaseSummary();
      await receiptReady;
      const pending = (await harness.inspect(BACKGROUND_CONTEXT)).submissions.find(item => item.type === 'write' && item.status === 'queued');
      expect(pending).toBeDefined();
      const abort = setup.kernel.abort();
      await Bun.sleep(100);
      releaseReceipt();
      await abort;
      expect(await outcome).toContain('aborted');
      const submission = await harness.submission(pending!.id, BACKGROUND_CONTEXT);
      expect((await submission!.status(BACKGROUND_CONTEXT)).status).toBe('unanswered');
    } finally {
      releaseSummary();
      releaseReceipt();
      await setup.kernel.close();
    }
  }, 30_000);

  for (const cancel of [false, true]) {
    it(`${cancel ? 'reports cancellation of' : 'waits for'} a queued compaction summary before reporting success`, async () => {
      let releaseSummary!: () => void;
      let notifySummarySelected!: () => void;
      const summarySelected = new Promise<void>(resolve => { notifySummarySelected = resolve; });
      const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
      const setup = createKernel({
        sessionPath: scratch(),
        script: [textEvents('first'), textEvents('second'), textEvents('concurrent reply')],
        extensions: [defineExtension({
          name: 'delayed-summary',
          hooks: [hook(CompactionTask, {
            beforeCompact: async () => {
              notifySummarySelected();
              await summaryGate;
              return { summary: 'queued summary' };
            },
          })],
        })],
      });
      try {
        await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
        for (let turn = 0; turn < 2; turn++) {
          await setup.kernel.submitPrompt('long input '.repeat(8_000));
          await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_end').length === turn + 1);
        }
        const compact = setup.kernel.compact();
        const compactOutcome = compact.then(result => ({ result }), error => ({ error }));
        await summarySelected;
        await setup.kernel.submitPrompt('concurrent input');
        await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_start').length === 3);
        releaseSummary();
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(setup.events.filter(event => event.type === 'compaction_end')).toHaveLength(0);
        if (cancel) {
          const harness = (setup.kernel as unknown as { harness: Harness }).harness;
          const inspection = await harness.inspect(BACKGROUND_CONTEXT);
          const pending = inspection.submissions.find(submission => submission.type === 'write' && submission.status === 'queued');
          expect(pending).toBeDefined();
          await setup.kernel.abort();
          const submission = await harness.submission(pending!.id, BACKGROUND_CONTEXT);
          expect((await submission!.status(BACKGROUND_CONTEXT)).status).toBe('unanswered');
        } else {
          await setup.waitForWhere(() => setup.events.filter(event => event.type === 'agent_end').length === 3);
        }
        const outcome = await compactOutcome;
        const event = await setup.waitFor('compaction_end');
        if (cancel) {
          expect('error' in outcome).toBe(true);
          expect(event.result).toBeUndefined();
          expect(event.errorMessage).toContain('aborted');
        } else {
          expect('result' in outcome).toBe(true);
          expect(event.result).toBeDefined();
        }
      } finally {
        releaseSummary();
        await setup.kernel.close();
      }
    }, 30_000);
  }

  it('invalidates pre-compaction usage until the next response, including after restart', async () => {
    const dir = scratch();
    const first = createKernel({
      sessionPath: dir,
      script: [textEvents('first'), textEvents('second'), textEvents('summary')],
    });
    try {
      await first.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await first.kernel.submitPrompt('first '.repeat(14_000));
      await first.waitFor('agent_end');
      await first.kernel.submitPrompt('second '.repeat(14_000));
      await first.waitForWhere(() => first.events.filter(event => event.type === 'agent_end').length === 2);
      const result = await first.kernel.compact();
      expect(result.summary).toContain('summary');
      expect(result.estimatedTokensAfter).toBeGreaterThan(0);
      const event = await first.waitFor('compaction_end');
      expect(event.result).toBeDefined();
      expect((await first.kernel.contextUsagePayload()).contextUsage?.tokens).toBeNull();
    } finally {
      await first.kernel.close();
    }

    const resumed = createKernel({ sessionPath: dir, script: [textEvents('after compaction')] });
    try {
      await resumed.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      expect((await resumed.kernel.contextUsagePayload()).contextUsage?.tokens).toBeNull();
      await resumed.kernel.submitPrompt('continue');
      await resumed.waitFor('agent_end');
      expect((await resumed.kernel.contextUsagePayload()).contextUsage?.tokens).toBe(15);
    } finally {
      await resumed.kernel.close();
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('executes bash with the configured shell path', async () => {
    const dir = scratch();
    const marker = join(dir, 'selected-shell');
    const shellPath = join(dir, 'custom-shell');
    writeFileSync(shellPath, '#!/bin/sh\nprintf shell-used > selected-shell\nexec /bin/bash "$@"\n', { mode: 0o700 });
    const setup = createKernel({
      sessionPath: dir,
      shellPath,
      script: [toolCallEvents({ type: 'toolCall', id: 'shell', name: 'bash', arguments: { command: 'printf command-executed' } }), textEvents('done')],
      extensions: [defineExtension({ name: 'builtin-shell', tools: createBuiltinTools(dir) })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('run the configured shell');
      await setup.waitFor('agent_end');
      const result = setup.events.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'shell');
      expect(result?.isError).toBe(false);
      expect(JSON.stringify(result?.result)).toContain('command-executed');
      expect(readFileSync(marker, 'utf8')).toBe('shell-used');
    } finally {
      await setup.kernel.close();
    }
  });

  it('offers every registered builtin and web tool to the model', async () => {
    const tools = [
      ...createBuiltinTools(scratch()),
      createSearchTool({ name: 'fixture', async search() { return []; } }),
      createWebFetchTool(() => null),
    ];
    const setup = createKernel({
      sessionPath: scratch(),
      script: [textEvents('answer')],
      extensions: [defineExtension({ name: 'registration-test', tools })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('show tool availability');
      await setup.waitFor('agent_end');
      const names = getCurrentTools(setup.calls[0]!.messages).map(tool => tool.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_search', 'web_fetch']) {
        expect(names).toContain(name);
      }
    } finally {
      await setup.kernel.close();
    }
  });

  it.each(['singleton', 'json-string'] as const)('reports repaired %s edit arguments in the tool start event', async shape => {
    const dir = scratch();
    const path = join(dir, 'repaired.txt');
    const edit = { oldText: 'before', newText: 'after' };
    writeFileSync(path, 'before');
    const setup = createKernel({
      sessionPath: dir,
      script: [toolCallEvents({
        type: 'toolCall', id: 'repair-edit', name: 'edit',
        arguments: { path, edits: shape === 'singleton' ? edit : JSON.stringify([edit]) },
      }), textEvents('done')],
      extensions: [defineExtension({ name: 'repair-tools', tools: createBuiltinTools(dir) })],
    });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('repair the edit arguments');
      await setup.waitFor('agent_end');
      expect(readFileSync(path, 'utf8')).toBe('after');
      const starts = setup.events.filter(event => event.type === 'tool_execution_start' && event.toolCallId === 'repair-edit');
      expect(starts).toHaveLength(1);
      expect(starts[0]?.args).toEqual({ path, edits: [edit] });
      const end = setup.events.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'repair-edit');
      expect(end?.isError).toBe(false);
      expect(setup.events.indexOf(starts[0]!)).toBeLessThan(setup.events.indexOf(end!));
    } finally { await setup.kernel.close(); }
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

  it('reports completion for session tools under both host prefixes', async () => {
    const setup = createKernel({
      sessionPath: scratch(),
      script: [
        toolCallEvents({ type: 'toolCall', id: 's1', name: 'session__SubmitPlan', arguments: { plan: 'first' } }),
        toolCallEvents({ type: 'toolCall', id: 's2', name: 'mcp__session__SubmitPlan', arguments: { plan: 'second' } }),
        textEvents('done'),
      ],
      sessionTools: true,
    });
    const { kernel, sessionCompletions, waitFor } = setup;
    try {
      await kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await kernel.submitPrompt('use the session tools');
      await waitFor('agent_end');

      expect(sessionCompletions.map(c => [c.toolName, c.args.plan, c.isError])).toEqual([
        ['SubmitPlan', 'first', false],
        ['SubmitPlan', 'second', false],
      ]);
    } finally {
      await kernel.close();
    }
  });

  it('runs a code mode script through the durable tool registry', async () => {
    const toolCall: ToolCall = { type: 'toolCall', id: 'code1', name: 'codemode', arguments: { code: 'text(2 + 3)' } };
    const { kernel, events, waitFor } = createKernel({
      sessionPath: scratch(),
      script: [toolCallEvents(toolCall), textEvents('done')],
      codemode: true,
    });
    try {
      await kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await kernel.submitPrompt('run code');
      await waitFor('agent_end');
      const result = events.find(event => event.type === 'tool_execution_end' && event.toolName === 'codemode') as Record<string, any>;
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.result.content)).toContain('5');
    } finally {
      await kernel.close();
    }
  });

  it('calls a local MCP server through code mode', async () => {
    const dir = scratch();
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        test: { command: process.execPath, args: [join(import.meta.dir, 'test-fixtures/mcp-server.ts')] },
      },
    }));
    const mcp = await loadMcpTools({ agentDir, cwd: dir, version: '1.0', debugLog: () => {} });
    const toolCall: ToolCall = {
      type: 'toolCall', id: 'code-mcp', name: 'codemode',
      arguments: { code: 'const result = await tools.mcp__test__hello({}); text(result.content[0].text)' },
    };
    const { kernel, events, waitFor } = createKernel({
      sessionPath: dir,
      script: [toolCallEvents(toolCall), textEvents('done')],
      codemode: true,
      mcp,
    });
    try {
      expect(mcp.errors).toEqual([]);
      expect(mcp.tools.map(tool => tool.name)).toContain('mcp__test__hello');
      await kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await kernel.submitPrompt('call MCP');
      await waitFor('agent_end');
      const result = events.find(event => event.type === 'tool_execution_end' && event.toolName === 'codemode') as Record<string, any>;
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.result.content)).toContain('hello from MCP');
    } finally {
      await kernel.close();
      await closeMcpConnections(mcp.connections);
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
      expect((await kernel.contextUsagePayload()).contextUsage?.tokens).toBe(15);
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
      const retryLifecycle = events.filter(event => ['agent_start', 'agent_end', 'auto_retry_start', 'auto_retry_end'].includes(String(event.type)));
      expect(retryLifecycle.map(event => event.type)).toEqual([
        'agent_start', 'agent_end', 'auto_retry_start', 'agent_start', 'auto_retry_end', 'agent_end',
      ]);
      expect(retryLifecycle.filter(event => event.type === 'agent_end').map(event => event.willRetry)).toEqual([true, false]);
      const messageEnds = events.filter(event => event.type === 'message_end' && (event.message as Message).role === 'assistant');
      expect(messageEnds.map(event => (event.message as AssistantMessage).stopReason)).toEqual(['error', 'stop']);
      // The SDK contract publishes the failed message before announcing retry.
      expect(events.indexOf(messageEnds[0]!)).toBeLessThan(events.indexOf(willRetryEnd!));
      expect(events.indexOf(messageEnds[1]!)).toBeGreaterThan(events.indexOf(retryLifecycle[3]!));
      expect(events.indexOf(messageEnds[1]!)).toBeLessThan(events.indexOf(retryEnds[0]!));

      expect(calls.length).toBe(2);
      const lastAgentEnd = events[events.length - 1]!;
      expect(lastAgentEnd.type).toBe('agent_end');
      expect(lastAgentEnd.willRetry).toBe(false);
    } finally {
      await kernel.close();
    }
  });

  it('discards failed partial text and ends retry after a recovered answer', async () => {
    const { processEvent } = await import('../../../apps/electron/src/renderer/event-processor/processor.ts');
    type RendererState = Parameters<typeof processEvent>[0];
    type RendererEvent = Parameters<typeof processEvent>[1];
    let renderer: RendererState = {
      session: { id: 'retry-order', messages: [], lastMessageAt: 1, isProcessing: true } as RendererState['session'],
      streaming: null,
    };
    const visible: Array<{ event: string; text: string[]; retrying: boolean; streamingTurnId?: string }> = [];
    const setup = createKernel({ sessionPath: scratch(), script: [errorEvents('terminated', 'failed partial '), textEvents('recovered')] });
    const adapter = new PiEventAdapter();
    adapter.startTurn();
    const adapted: Array<Record<string, unknown>> = [];
    const queueCompletions: string[] = [];
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('trigger a retry');
      await setup.waitForWhere(event => event.type === 'agent_end' && event.willRetry === false, 20_000);
      for (const event of setup.events) {
        adapted.push(...adapter.adaptEvent(event as never));
        if (adapter.shouldCompleteQueue(event.type === 'agent_end')) queueCompletions.push(String(event.type));
      }

      expect(setup.calls).toHaveLength(2);
      const deltas = adapted.filter(event => event.type === 'text_delta');
      expect(deltas.map(event => event.text)).toEqual(['failed partial ', 'recovered']);
      const turnIds = deltas.map(event => event.turnId);
      expect(turnIds.every(turnId => typeof turnId === 'string' && turnId.length > 0)).toBe(true);
      expect(new Set(turnIds).size).toBe(2);
      expect(adapted.filter(event => event.type === 'text_discard')).toMatchObject([{ turnId: deltas[0]!.turnId }]);
      expect(adapted.filter(event => event.type === 'text_complete')).toMatchObject([{ text: 'recovered', turnId: deltas[1]!.turnId }]);
      expect(adapted.filter(event => event.type === 'retry').map(event => event.phase)).toEqual(['backoff', 'active', 'end']);
      const lifecycle = adapted.filter(event => ['text_delta', 'text_discard', 'text_complete', 'retry', 'complete'].includes(String(event.type)));
      expect(lifecycle.map(event => event.type === 'retry' ? `retry:${event.phase}` : event.type)).toEqual([
        'text_delta', 'text_discard', 'retry:backoff', 'retry:active', 'text_delta', 'text_complete', 'retry:end', 'complete',
      ]);
      for (const event of lifecycle) {
        const payload = { ...event, sessionId: 'retry-order', ...(event.type === 'text_delta' ? { delta: event.text } : {}) };
        renderer = processEvent(renderer, payload as RendererEvent).state;
        visible.push({
          event: event.type === 'retry' ? `retry:${event.phase}` : String(event.type),
          text: renderer.session.messages.filter(message => message.role === 'assistant').map(message => message.content),
          retrying: renderer.session.currentStatus?.statusType === 'retrying',
          streamingTurnId: renderer.streaming?.turnId,
        });
      }
      expect(visible.map(state => ({ event: state.event, text: state.text, retrying: state.retrying }))).toEqual([
        { event: 'text_delta', text: ['failed partial '], retrying: false },
        { event: 'text_discard', text: [], retrying: false },
        { event: 'retry:backoff', text: [], retrying: true },
        { event: 'retry:active', text: [], retrying: false },
        { event: 'text_delta', text: ['recovered'], retrying: false },
        { event: 'text_complete', text: ['recovered'], retrying: false },
        { event: 'retry:end', text: ['recovered'], retrying: false },
        { event: 'complete', text: ['recovered'], retrying: false },
      ]);
      expect(visible.slice(0, 3).map(state => state.streamingTurnId)).toEqual([turnIds[0], undefined, undefined]);
      expect(visible[4]!.streamingTurnId).toBe(turnIds[1]);
      expect(renderer.session.messages.filter(message => message.role === 'assistant')).toMatchObject([
        { content: 'recovered', turnId: turnIds[1], isStreaming: false, isPending: false },
      ]);
      expect(renderer.session.isProcessing).toBe(false);
      expect(adapted.filter(event => event.type === 'complete')).toHaveLength(1);
      expect(queueCompletions).toEqual(['agent_end']);
      expect(adapter.shouldCompleteQueue(false)).toBe(false);
    } finally {
      await setup.kernel.close();
    }
  }, 25_000);

  it.each(['missing', 'split'] as const)('does not delay retry cancellation when the failed entry is %s from its batch', async (mode) => {
    const durable = await import('./events/watch.ts');
    const { spyOn } = await import('bun:test');
    const watchEvents = durable.watchEvents;
    let transformed = false;
    const watch = spyOn(durable, 'watchEvents').mockImplementation(async (...args) => {
      const stream = await watchEvents(...args);
      return { ...stream, start: listener => stream.start(async (events, context) => {
        if (!events.some(event => event.type === 'auto_retry_start')) return listener(events, context);
        const failure = events.filter(event => {
          const message = event.type === 'message_end' ? event.entry.model?.[0] : event.type === 'message_start' ? event.message : undefined;
          return message?.role === 'assistant' && message.stopReason === 'error';
        });
        expect(failure.length).toBeGreaterThan(0);
        transformed = true;
        await listener(events.filter(event => !failure.includes(event)), context);
        if (mode === 'split') await listener(failure, context);
      }) };
    });
    const setup = createKernel({ sessionPath: scratch(), script: [errorEvents('fetch failed')] });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('cancel retry with no same-batch failure');
      await setup.waitFor('auto_retry_start');
      expect(transformed).toBe(true);
      await setup.kernel.abort();
      await setup.waitFor('auto_retry_end');
      expect(setup.calls).toHaveLength(1);
      expect(setup.events.filter(event => event.type === 'agent_end').map(event => event.willRetry)).toEqual([true, false]);
      expect(setup.events.filter(event => event.type === 'auto_retry_end')).toMatchObject([{ success: false, attempt: 1 }]);
    } finally {
      watch.mockRestore();
      await setup.kernel.close();
    }
  });

  it('discards each failed partial and reports one error after retries are exhausted', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: Array.from({ length: 5 }, (_, index) => errorEvents('terminated', `partial ${index}`)) });
    const adapter = new PiEventAdapter();
    adapter.startTurn();
    const adapted: Array<Record<string, unknown>> = [];
    const queueCompletions: string[] = [];
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('exhaust retries');
      await setup.waitForWhere(event => event.type === 'agent_end' && event.willRetry === false, 60_000);
      for (const event of setup.events) {
        adapted.push(...adapter.adaptEvent(event as never));
        if (adapter.shouldCompleteQueue(event.type === 'agent_end')) queueCompletions.push(String(event.type));
      }

      const deltas = adapted.filter(event => event.type === 'text_delta');
      expect(setup.calls).toHaveLength(5);
      expect(deltas.map(event => event.text)).toEqual(['partial 0', 'partial 1', 'partial 2', 'partial 3', 'partial 4']);
      expect(adapted.filter(event => event.type === 'text_discard').map(event => event.turnId)).toEqual(deltas.map(event => event.turnId));
      expect(adapted.filter(event => event.type === 'text_complete')).toHaveLength(0);
      expect(adapted.filter(event => event.type === 'typed_error')).toHaveLength(1);
      expect(adapted.filter(event => event.type === 'complete')).toHaveLength(1);
      expect(queueCompletions).toEqual(['agent_end']);
      expect(adapter.shouldCompleteQueue(false)).toBe(false);
    } finally {
      await setup.kernel.close();
    }
  }, 65_000);

  it('ends retry and reports the error when backoff is cancelled', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [errorEvents('fetch failed', 'failed partial ')] });
    const adapter = new PiEventAdapter();
    adapter.startTurn();
    const adapted: Array<Record<string, unknown>> = [];
    const queueCompletions: string[] = [];
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('cancel retry');
      await setup.waitFor('auto_retry_start');
      await setup.kernel.abort();
      await setup.waitForWhere(event => event.type === 'agent_end' && event.willRetry === false);
      for (const event of setup.events) {
        adapted.push(...adapter.adaptEvent(event as never));
        if (adapter.shouldCompleteQueue(event.type === 'agent_end')) queueCompletions.push(String(event.type));
      }

      expect(setup.calls).toHaveLength(1);
      expect(adapted.filter(event => event.type === 'text_discard')).toHaveLength(1);
      expect(adapted.filter(event => event.type === 'retry').map(event => event.phase)).toEqual(['backoff', 'end']);
      expect(adapted.filter(event => event.type === 'typed_error')).toHaveLength(1);
      expect(adapted.filter(event => event.type === 'complete')).toHaveLength(1);
      expect(queueCompletions).toEqual(['auto_retry_end']);
      expect(adapter.shouldCompleteQueue(false)).toBe(false);
    } finally {
      await setup.kernel.close();
    }
  });

  function branchTools(onExecute: () => void | Promise<void>): Extension {
    return defineExtension({ name: 'branch-probe', tools: [defineTool({
      name: 'branch_probe', description: 'Count local fixture tool executions.',
      parameters: { type: 'object', properties: {} } as never,
      replay: 'safe', executionMode: 'sequential',
      execute: async () => {
        await onExecute();
        return { output: [{ type: 'text' as const, text: 'branch probe result' }] };
      },
    })] });
  }

  const branchProbe: ToolCall = { type: 'toolCall', id: 'branch-probe', name: 'branch_probe', arguments: {} };
  const branchModel = { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 };

  for (const backend of ['sqlite', 'jsonl'] as const) for (const cutoff of [true, false]) {
    it(cutoff ? `isolates inherited running work and queued submissions in a new ${backend} branch at an anchor` : `rejects an unanchored ${backend} branch before copying running work`, async () => {
      const parentPath = scratch();
      if (backend === 'jsonl') {
        mkdirSync(join(parentPath, 'durable-store'));
        writeFileSync(join(parentPath, 'durable-store', 'main.jsonl'), '');
      }
      const release = Promise.withResolvers<AssistantMessageEvent[]>();
      const parent = createKernel({ sessionPath: parentPath, script: [textEvents('first answer'), release.promise, textEvents('queued answer')], extensions: [branchTools(() => {})] });
      const childPath = scratch();
      let executions = 0;
      const childOptions = () => ({ sessionPath: childPath, script: [toolCallEvents(branchProbe), textEvents('child answer')], extensions: [branchTools(() => { executions++; })] });
      let child: KernelSetup | undefined;
      let reopened: KernelSetup | undefined;
      try {
        await parent.kernel.open({ model: branchModel });
        await parent.kernel.submitPrompt('first parent input');
        await parent.waitFor('agent_end');
        const anchor = String(parent.events.find(event => event.type === 'pi_turn_anchor')!.sdkTurnAnchor);
        await parent.kernel.submitPrompt('parent input after cutoff');
        await parent.waitForWhere(() => parent.calls.length === 2);
        await parent.kernel.submitPrompt('queued parent followup');
        const parentHarness = (parent.kernel as unknown as { harness: Harness }).harness;
        const root = await parentHarness.root(BACKGROUND_CONTEXT);
        const queuedWrite = await root.submit({ type: 'write', entry: { kind: 'pi.user', model: [{ role: 'user', content: 'queued parent write', timestamp: 1 }] } }, BACKGROUND_CONTEXT);
        const inspection = await parentHarness.inspect(BACKGROUND_CONTEXT);
        expect(inspection.tasks.length).toBeGreaterThan(0);
        expect(inspection.submissions.filter(item => item.status === 'queued')).toHaveLength(2);
        expect((await queuedWrite.status(BACKGROUND_CONTEXT)).status).toBe('queued');
        const inbox = await parentHarness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT);
        const branch = { model: branchModel, branchFromSessionPath: parentPath, ...(cutoff ? { branchFromSdkTurnId: anchor } : {}) };
        if (!cutoff) {
          child = createKernel(childOptions());
          await expect(child.kernel.open(branch)).rejects.toThrow('turn anchor is required');
          expect(child.calls).toHaveLength(0);
          expect(executions).toBe(0);
          expect(existsSync(join(childPath, 'durable-store'))).toBe(false);
          expect(existsSync(join(childPath, '.durable-branch-pending'))).toBe(false);
          expect(await parentHarness.inspect(BACKGROUND_CONTEXT)).toEqual(inspection);
          expect(await parentHarness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT)).toEqual(inbox);
          return;
        }
        if (cutoff) {
          const failed = createKernel(childOptions());
          try {
            await expect(failed.kernel.open({ ...branch, branchFromSdkTurnId: 'invalid-active-anchor' })).rejects.toThrow('branch anchor not found');
            expect(failed.calls).toHaveLength(0);
            expect(executions).toBe(0);
            expect(existsSync(join(childPath, 'durable-store'))).toBe(false);
            expect(existsSync(join(childPath, '.durable-branch-pending'))).toBe(false);
          } finally {
            await failed.kernel.close();
          }
        }
        child = createKernel(childOptions());
        await child.kernel.open(branch);
        await Bun.sleep(800);
        expect(child.calls).toHaveLength(0);
        expect(executions).toBe(0);
        const childHarness = (child.kernel as unknown as { harness: Harness }).harness;
        expect((await childHarness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
        expect((await childHarness.inspect(BACKGROUND_CONTEXT)).submissions).toEqual([]);
        expect(await childHarness.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT) ?? {}).toEqual({});
        expect((await childHarness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT))?.items ?? []).toEqual([]);
        expect(await parentHarness.inspect(BACKGROUND_CONTEXT)).toEqual(inspection);
        expect(await parentHarness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT)).toEqual(inbox);
        await child.kernel.close();

        reopened = createKernel(childOptions());
        await reopened.kernel.open(branch);
        await Bun.sleep(800);
        expect(reopened.calls).toHaveLength(0);
        expect(executions).toBe(0);
        await reopened.kernel.submitPrompt('fresh child input');
        await reopened.waitFor('agent_end');
        expect(reopened.calls).toHaveLength(2);
        expect(executions).toBe(1);
        for (const call of reopened.calls) {
          const context = JSON.stringify(call.messages);
          expect(context).toContain('first parent input');
          expect(context.includes('parent input after cutoff')).toBe(!cutoff);
          expect(context).not.toContain('queued parent followup');
          expect(context).not.toContain('queued parent write');
          expect(context).toContain('fresh child input');
        }
        expect(JSON.stringify(reopened.calls[1]!.messages)).toContain('branch probe result');
        release.resolve(textEvents('second parent answer'));
        await parent.waitForWhere(() => parent.events.filter(event => event.type === 'agent_end').length === 2);
        expect(parent.calls).toHaveLength(3);
        expect(JSON.stringify(parent.calls[2]!.messages)).toContain('queued parent followup');
        expect(JSON.stringify(parent.calls[2]!.messages)).toContain('queued parent write');
        expect((await queuedWrite.status(BACKGROUND_CONTEXT)).status).toBe('done');
      } finally {
        release.resolve(textEvents('second parent answer'));
        await reopened?.kernel.close();
        await child?.kernel.close();
        await parent.kernel.close();
      }
    }, 20_000);
  }

  for (const backend of ['sqlite', 'jsonl'] as const) {
    it(`does not replay inherited running or pending tools in a ${backend} branch or on reopen`, async () => {
      const parentPath = scratch();
      if (backend === 'jsonl') {
        mkdirSync(join(parentPath, 'durable-store'));
        writeFileSync(join(parentPath, 'durable-store', 'main.jsonl'), '');
      }
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let parentExecutions = 0;
      let childExecutions = 0;
      const response = assistantMessage([branchProbe, { ...branchProbe, id: 'pending-probe' }], 'toolUse');
      const parent = createKernel({ sessionPath: parentPath, script: [textEvents('first answer'), [{ type: 'done', reason: 'toolUse', message: response }], textEvents('parent tools done')], extensions: [branchTools(async () => {
        parentExecutions++;
        reached.resolve();
        await release.promise;
      })] });
      const childPath = scratch();
      const childOptions = () => ({ sessionPath: childPath, script: [textEvents('unexpected inherited tool continuation')], extensions: [branchTools(() => { childExecutions++; })] });
      let child: KernelSetup | undefined;
      let reopened: KernelSetup | undefined;
      try {
        await parent.kernel.open({ model: branchModel });
        await parent.kernel.submitPrompt('first parent input');
        await parent.waitFor('agent_end');
        const anchor = String(parent.events.find(event => event.type === 'pi_turn_anchor')!.sdkTurnAnchor);
        await parent.kernel.submitPrompt('tool work after cutoff');
        await reached.promise;
        const parentHarness = (parent.kernel as unknown as { harness: Harness }).harness;
        const before = await parentHarness.inspect(BACKGROUND_CONTEXT);
        expect(before.tasks.find(item => item.record.kind === 'pi.generation')?.record.state.checkpoint).toMatchObject({ phase: 'tools', pending: ['pending-probe'] });
        expect(before.tasks.filter(item => item.record.kind === 'pi.tool' && item.record.state.status === 'running')).toHaveLength(1);
        const branch = { model: branchModel, branchFromSessionPath: parentPath, branchFromSdkTurnId: anchor };
        expect(parentExecutions).toBe(1);
        child = createKernel(childOptions());
        await child.kernel.open(branch);
        await Bun.sleep(800);
        expect(childExecutions).toBe(0);
        expect(child.calls).toHaveLength(0);
        expect((await (child.kernel as unknown as { harness: Harness }).harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
        expect(await parentHarness.inspect(BACKGROUND_CONTEXT)).toEqual(before);
        await child.kernel.close();
        reopened = createKernel(childOptions());
        await reopened.kernel.open(branch);
        await Bun.sleep(800);
        expect(childExecutions).toBe(0);
        expect(reopened.calls).toHaveLength(0);
        release.resolve();
        await parent.waitForWhere(() => parent.events.filter(event => event.type === 'agent_end').length === 2);
        expect(parentExecutions).toBe(2);
        expect(parent.calls).toHaveLength(3);
      } finally {
        release.resolve();
        await reopened?.kernel.close();
        await child?.kernel.close();
        await parent.kernel.close();
      }
    }, 20_000);

    it(`settles all inherited task states and paginated queues across ${backend} conversations without handlers`, async () => {
      const parentPath = scratch();
      const parentStore = join(parentPath, 'durable-store');
      if (backend === 'jsonl') {
        mkdirSync(parentStore);
        writeFileSync(join(parentStore, 'main.jsonl'), '');
      }
      let handlers = 0;
      const probe = defineTask({
        name: 'branch-state-probe', version: 1, initial: () => ({ phase: 'run' }),
        phases: { run: async (_task, runtime, context) => {
          handlers++;
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
        } },
        abort: async (_task, runtime, context) => {
          handlers++;
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
        },
      });
      const taskDoc = defineDoc({ kind: 'branch-task-state', version: 1, scope: 'task', initial: () => ({ transient: true }) });
      const extension = defineExtension({ name: 'branch-states', tasks: [probe] });
      const registry = createRegistry<ToolRegistration>();
      registry.install(extension);
      const storage = await openDurableStorage(parentStore, BACKGROUND_CONTEXT);
      const harness = await Harness.open(storage, { models: () => { throw new Error('No fixture models'); }, registry }, BACKGROUND_CONTEXT);
      const ids: TaskId[] = [];
      const submissions: SubmissionId[] = [];
      let anchor = '';
      let completed: Awaited<ReturnType<typeof storage.task>>;
      try {
        const root = await harness.root(BACKGROUND_CONTEXT);
        const other = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
        await harness.commit(async tx => {
          const entry = await tx.appendEntry(root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'retained fixture history', timestamp: 1 }] });
          anchor = String(entry.id);
          for (let index = 0; index < 262; index++) {
            ids.push(await tx.createTask(probe, {}, { ownership: { kind: 'conversation' }, conversationId: index === 260 ? other.id : root.id, background: index % 2 === 0 }));
          }
          await tx.doc(taskDoc, ids[0]!);
          const inbox = await tx.doc(InboxDoc, root.id);
          for (let index = 0; index < 260; index++) {
            const submission = await tx.createSubmission({ type: 'input', conversationId: root.id, status: 'queued' });
            submissions.push(submission.id);
            inbox.items.push({ id: submission.id, mode: 'followUp', content: `queued fixture ${index}` });
          }
          const placed = await tx.createSubmission({ type: 'input', conversationId: root.id, status: 'placed', entry: entry.id });
          submissions.push(placed.id);
          (await tx.doc(LiveDoc, root.id)).run = { taskId: ids[0]!, inputs: [placed.id] };
        }, BACKGROUND_CONTEXT);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
      const seeded = await openDurableStorage(parentStore, BACKGROUND_CONTEXT);
      try {
        const writes: StorageWrite[] = [];
        for (const [index, id] of ids.entries()) {
          const task = (await seeded.task(id, BACKGROUND_CONTEXT))!;
          const checkpoint = { phase: 'run' };
          const states = [
            { status: 'pending' as const, checkpoint },
            { status: 'running' as const, checkpoint },
            { status: 'waiting' as const, checkpoint, on: [ids[3]!], policy: 'allSettled' as const },
            { status: 'sleeping' as const, checkpoint, until: Date.now() + 60_000 },
            { status: 'completing' as const, outcome: { status: 'completed' as const, result: null } },
          ];
          writes.push({ type: 'task', value: { ...task, abortRequested: index === 0, state: index === 261
            ? { status: 'terminal', outcome: { status: 'completed', result: { preserved: true } } }
            : states[index < 257 ? 0 : index - 256]! } });
        }
        await commitWrites(seeded, writes, BACKGROUND_CONTEXT);
        completed = await seeded.task(ids.at(-1)!, BACKGROUND_CONTEXT);
      } finally {
        await seeded.close(BACKGROUND_CONTEXT);
      }
      const before = Object.fromEntries(readdirSync(parentStore).map(name => [name, readFileSync(join(parentStore, name))]));
      const child = createKernel({ sessionPath: scratch(), script: [], extensions: [extension] });
      try {
        await child.kernel.open({ branchFromSessionPath: parentPath, branchFromSdkTurnId: anchor });
        await Bun.sleep(100);
        const inherited = (child.kernel as unknown as { harness: Harness }).harness;
        expect(handlers).toBe(0);
        expect(child.calls).toHaveLength(0);
        expect((await inherited.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
        expect((await inherited.inspect(BACKGROUND_CONTEXT)).submissions).toEqual([]);
        for (const id of ids) expect((await inherited.getTask(id, BACKGROUND_CONTEXT))?.state.status).toBe('terminal');
        expect(await inherited.getTask(ids.at(-1)!, BACKGROUND_CONTEXT)).toEqual(completed);
        expect((await inherited.getTask(ids[260]!, BACKGROUND_CONTEXT))?.state.outcome).toEqual({ status: 'completed', result: null });
        for (const id of submissions) {
          const submission = await inherited.submission(id, BACKGROUND_CONTEXT);
          expect((await submission.status(BACKGROUND_CONTEXT)).status).toBe('unanswered');
        }
        expect(await inherited.snapshot(taskDoc, ids[0]!, BACKGROUND_CONTEXT)).toBeUndefined();
        expect(Object.fromEntries(readdirSync(parentStore).map(name => [name, readFileSync(join(parentStore, name))]))).toEqual(before);
      } finally {
        await child.kernel.close();
      }
    }, 20_000);

    it(`still resumes an interrupted non-branch ${backend} generation`, async () => {
      const parentPath = scratch();
      const parentStore = join(parentPath, 'durable-store');
      if (backend === 'jsonl') {
        mkdirSync(parentStore);
        writeFileSync(join(parentStore, 'main.jsonl'), '');
      }
      const release = Promise.withResolvers<AssistantMessageEvent[]>();
      const parent = createKernel({ sessionPath: parentPath, script: [release.promise], extensions: [branchTools(() => {})] });
      const restoredPath = scratch();
      let executions = 0;
      const restored = createKernel({ sessionPath: restoredPath, script: [toolCallEvents(branchProbe), textEvents('recovered answer')], extensions: [branchTools(() => { executions++; })] });
      try {
        await parent.kernel.open({ model: branchModel });
        await parent.kernel.submitPrompt('interrupted ordinary input');
        await parent.waitForWhere(() => parent.calls.length === 1);
        const restoredStore = join(restoredPath, 'durable-store');
        cpSync(parentStore, restoredStore, { recursive: true, filter: source => !['store.db', 'store.db-wal', 'store.db-shm'].includes(source.split(/[\\/]/).at(-1)!) });
        if (backend === 'sqlite') {
          const database = new Database(join(parentStore, 'store.db'), { readonly: true });
          try { database.query('VACUUM INTO ?').run(join(restoredStore, 'store.db')); }
          finally { database.close(); }
        }
        await restored.kernel.open({ model: branchModel });
        // 1.5 treats a request interrupted by process loss as a retryable failed attempt.
        await restored.waitForWhere(event => event.type === 'agent_end' && event.willRetry === false);
        expect(restored.events.some(event => event.type === 'auto_retry_start')).toBe(true);
        expect(restored.kernel.sessionId).toBe(parent.kernel.sessionId);
        expect(restored.calls).toHaveLength(2);
        expect(executions).toBe(1);
        expect(JSON.stringify(restored.calls[0]!.messages)).toContain('interrupted ordinary input');
      } finally {
        release.resolve(textEvents('original parent answer'));
        await restored.kernel.close();
        await parent.kernel.close();
      }
    }, 15_000);
  }

  it('resumes the existing branch without reapplying the parent cutoff', async () => {
    const parentPath = scratch();
    const childPath = join(scratch(), 'child');
    const parent = createKernel({ sessionPath: parentPath, script: [textEvents('parent answer'), textEvents('later answer')] });
    let anchor = '';
    try {
      await parent.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await parent.kernel.submitPrompt('parent question');
      await parent.waitFor('agent_end');
      anchor = String(parent.events.find(event => event.type === 'pi_turn_anchor')!.sdkTurnAnchor);
      await parent.kernel.submitPrompt('later parent question');
      await parent.waitForWhere(() => parent.events.filter(event => event.type === 'agent_end').length === 2);

      const child = createKernel({ sessionPath: childPath, script: [textEvents('child answer')] });
      try {
        await child.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: parentPath, branchFromSdkTurnId: anchor });
        expect(child.kernel.sessionId).not.toBe(parent.kernel.sessionId);
        await child.kernel.submitPrompt('child question');
        await child.waitFor('agent_end');
        expect(JSON.stringify(child.calls[0]!.messages)).not.toContain('later parent question');
      } finally {
        await child.kernel.close();
      }
      const branchAgainPath = join(scratch(), 'grandchild');
      const parentSessionId = child.kernel.sessionId;
      const childAnchor = String(child.events.find(event => event.type === 'pi_turn_anchor')!.sdkTurnAnchor);
      const grandchild = createKernel({ sessionPath: branchAgainPath, script: [textEvents('grandchild answer')] });
      try {
        await grandchild.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: childPath, branchFromSdkTurnId: childAnchor });
        expect(grandchild.kernel.sessionId).not.toBe(parentSessionId);
        await grandchild.kernel.submitPrompt('grandchild question');
        await grandchild.waitFor('agent_end');
        const context = JSON.stringify(grandchild.calls[0]!.messages);
        expect(context).toContain('child question');
        expect(context).toContain('child answer');
        expect(context).not.toContain('later parent question');
      } finally {
        await grandchild.kernel.close();
      }
      const resumed = createKernel({ sessionPath: childPath, script: [textEvents('resumed answer')] });
      try {
        await resumed.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: parentPath, branchFromSdkTurnId: anchor });
        await resumed.kernel.submitPrompt('resume child');
        await resumed.waitFor('agent_end');
        const context = JSON.stringify(resumed.calls[0]!.messages);
        expect(context).toContain('child question');
        expect(context).toContain('child answer');
        expect(context).not.toContain('later parent question');
      } finally {
        await resumed.kernel.close();
      }
    } finally {
      await parent.kernel.close();
    }
  }, 30_000);

  it('does not create a JSONL branch when the parent snapshot is incomplete', async () => {
    const parentPath = scratch();
    const parentStore = join(parentPath, 'durable-store');
    mkdirSync(parentStore);
    writeFileSync(join(parentStore, 'main.jsonl'), '');
    const parent = createKernel({ sessionPath: parentPath, script: [textEvents('parent answer')] });
    try {
      await parent.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await parent.kernel.submitPrompt('parent question');
      await parent.waitFor('agent_end');
      const anchor = String(parent.events.find(event => event.type === 'pi_turn_anchor')!.sdkTurnAnchor);
      const mainPath = join(parentStore, 'main.jsonl');
      const main = readFileSync(mainPath, 'utf8');
      writeFileSync(mainPath, main + '{"format":1');
      const child = createKernel({ sessionPath: join(scratch(), 'child'), script: [] });
      try {
        await expect(child.kernel.open({ branchFromSessionPath: parentPath, branchFromSdkTurnId: anchor })).rejects.toThrow();
      } finally {
        await child.kernel.close();
      }
      expect(readFileSync(mainPath, 'utf8')).toBe(main + '{"format":1');
    } finally {
      await parent.kernel.close();
    }
  }, 30_000);

  it('retries branch creation after an invalid or invisible anchor', async () => {
    const parentPath = scratch();
    const parent = createKernel({ sessionPath: parentPath, script: [textEvents('first answer'), textEvents('later answer')] });
    try {
      await parent.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await parent.kernel.submitPrompt('first question');
      await parent.waitFor('agent_end');
      const anchor = String(parent.events.find(event => event.type === 'pi_turn_anchor')!.sdkTurnAnchor);
      await parent.kernel.submitPrompt('later question');
      await parent.waitForWhere(() => parent.events.filter(event => event.type === 'agent_end').length === 2);

      for (const invalidAnchor of [undefined, 'missing-anchor', '99999999']) {
        const childPath = join(scratch(), 'child');
        const failed = createKernel({ sessionPath: childPath, script: [] });
        try {
          await expect(failed.kernel.open({ branchFromSessionPath: parentPath, branchFromSdkTurnId: invalidAnchor })).rejects.toThrow();
        } finally {
          await failed.kernel.close();
        }

        const retry = createKernel({ sessionPath: childPath, script: [textEvents('child answer')] });
        try {
          await retry.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: parentPath, branchFromSdkTurnId: anchor });
          await retry.kernel.submitPrompt('child question');
          await retry.waitFor('agent_end');
          const context = JSON.stringify(retry.calls[0]!.messages);
          expect(context).toContain('first question');
          expect(context).not.toContain('later question');
        } finally {
          await retry.kernel.close();
        }
      }
    } finally {
      await parent.kernel.close();
    }
  }, 30_000);

  it('refuses to open an interrupted branch copy', async () => {
    const childPath = scratch();
    mkdirSync(join(childPath, 'durable-store'));
    writeFileSync(join(childPath, '.durable-branch-pending'), 'pending');
    const child = createKernel({ sessionPath: childPath, script: [] });
    try {
      await expect(child.kernel.open({})).rejects.toThrow('incomplete branch store');
    } finally {
      await child.kernel.close();
    }
  });

  it('updates proxy tools on the open conversation', async () => {
    const setup = createKernel({ sessionPath: scratch(), script: [textEvents('updated')] });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      const extension = defineExtension({ name: 'test-tools', tools: [defineTool({
        name: 'replacement', description: 'replacement tool',
        parameters: { type: 'object', properties: {} } as never,
        execute: async () => ({ output: [{ type: 'text' as const, text: 'ok' }] }),
      })] });
      setup.kernel.updateTools(extension);
      await setup.kernel.submitPrompt('question');
      await setup.waitFor('agent_end');
      expect(JSON.stringify(setup.calls[0])).toContain('replacement');
    } finally {
      await setup.kernel.close();
    }
  });

  it('preserves a legacy system message before the first new request', async () => {
    const parent = scratch();
    mkdirSync(join(parent, '.pi-sessions'), { recursive: true });
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'sys', parentId: null, message: { role: 'system', content: 'legacy system message', timestamp: 1 } },
      { type: 'message', id: 'next', parentId: 'sys', message: { role: 'user', content: 'continue', timestamp: 2 } },
    ];
    writeFileSync(join(parent, '.pi-sessions', 'legacy.jsonl'), transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
    const setup = createKernel({ sessionPath: parent, script: [textEvents('reply')], systemPrompt: 'new system message' });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      const harness = (setup.kernel as unknown as { harness: Harness }).harness;
      const context = await (await harness.root(BACKGROUND_CONTEXT)).context(BACKGROUND_CONTEXT);
      expect(JSON.stringify(context.messages)).toContain('legacy system message');
      await setup.kernel.submitPrompt('new question');
      await setup.waitFor('agent_end');
      const systems = setup.calls[0]!.messages.filter(message => message.role === 'system');
      expect(systems).toHaveLength(1);
      expect(JSON.stringify(systems)).not.toContain('legacy system message');
      expect(JSON.stringify(systems)).toContain('new system message');
      expect(setup.calls[0]!.messages.filter(message => message.role === 'user')).toHaveLength(2);
    } finally {
      await setup.kernel.close();
    }
  });

  it('keeps a legacy system message when an extension adds a section', async () => {
    const { section } = await import('@earendil-works/pi-durable');
    const parent = scratch();
    mkdirSync(join(parent, '.pi-sessions'), { recursive: true });
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'sys', parentId: null, message: { role: 'system', content: 'independent legacy instruction', timestamp: 1 } },
      { type: 'message', id: 'next', parentId: 'sys', message: { role: 'user', content: 'continue', timestamp: 2 } },
    ];
    writeFileSync(join(parent, '.pi-sessions', 'legacy.jsonl'), transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
    const setup = createKernel({ sessionPath: parent, script: [textEvents('reply')], extensions: [defineExtension({
      name: 'additional-section', sections: [section('additional-section', () => 'additional instruction', { tag: false })],
    })] });
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
      await setup.kernel.submitPrompt('new question');
      await setup.waitFor('agent_end');
      const messages = JSON.stringify(setup.calls[0]!.messages);
      expect(messages).toContain('independent legacy instruction');
      expect(messages).toContain('additional instruction');
    } finally {
      await setup.kernel.close();
    }
  });

  for (const [label, firstKeptEntryId] of [['a retained entry', 'kept'], ['an unmapped entry', 'missing']] as const) {
    for (const prompt of [undefined, 'current host system']) for (const tools of [false, true]) it(`preserves a legacy compaction system message with ${label}${prompt ? ' and a host prompt' : ''}${tools ? ' and a tool' : ''}`, async () => {
      const parent = scratch();
      mkdirSync(join(parent, '.pi-sessions'), { recursive: true });
      const transcript = [
        { type: 'session', id: 's-1', version: 3 },
        { type: 'message', id: 'old', parentId: null, message: { role: 'user', content: 'old before compaction', timestamp: 1 } },
        { type: 'message', id: 'kept', parentId: 'old', message: { role: 'user', content: 'retained', timestamp: 2 } },
        { type: 'compaction', id: 'compact', parentId: 'kept', firstKeptEntryId, summary: 'summary', systemMessage: { role: 'system', content: 'legacy system baseline', timestamp: 3 } },
        { type: 'message', id: 'next', parentId: 'compact', message: { role: 'user', content: 'continue', timestamp: 4 } },
      ];
      writeFileSync(join(parent, '.pi-sessions', 'legacy.jsonl'), transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
      const setup = createKernel({ sessionPath: parent, script: [textEvents('reply')], systemPrompt: prompt, tools });
      try {
        await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 } });
        const harness = (setup.kernel as unknown as { harness: Harness }).harness;
        const context = await (await harness.root(BACKGROUND_CONTEXT)).context(BACKGROUND_CONTEXT);
        expect(JSON.stringify(context.messages)).toContain('legacy system baseline');
        await setup.kernel.submitPrompt('new question');
        await setup.waitFor('agent_end');
        const systemMessages = setup.calls[0]!.messages.filter(message => message.role === 'system');
        if (prompt) {
          expect(systemMessages).toHaveLength(1);
          expect(systemMessages[0]?.content).toBe(prompt);
        } else {
          expect(systemMessages.map(message => message.content)).toContain('legacy system baseline');
        }
        expect(getCurrentTools(setup.calls[0]!.messages).map(tool => tool.name)).toEqual(tools ? ['echo'] : []);
      } finally {
        await setup.kernel.close();
      }
    });
  }

  for (const backend of ['sqlite', 'jsonl'] as const) for (const partial of [false, true]) for (const missingSidecar of [false, true]) it(`completes a live ${partial ? 'partially' : 'fully'} migrated ${backend} parent in the child (${missingSidecar ? 'missing' : 'present'} id map) before forking an inactive anchor`, async () => {
    const parent = scratch();
    const parentStore = join(parent, 'durable-store');
    mkdirSync(join(parent, 'attachments'));
    const attachment = join(parent, 'attachments', 'inactive.txt');
    writeFileSync(attachment, 'inactive bytes');
    mkdirSync(join(parent, '.pi-sessions'), { recursive: true });
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'shared ancestor', timestamp: 1 } },
      { type: 'message', id: 'old', parentId: 'root', message: { role: 'user', content: `inactive anchor ${attachment}`, timestamp: 2 } },
      { type: 'message', id: 'old-next', parentId: 'old', message: { role: 'user', content: 'past inactive anchor', timestamp: 3 } },
      { type: 'message', id: 'new', parentId: 'root', message: { role: 'user', content: 'active branch', timestamp: 4 } },
    ];
    writeFileSync(join(parent, '.pi-sessions', 'legacy.jsonl'), transcript.map(line => JSON.stringify(line)).join('\n') + '\n');
    const initial = await (backend === 'jsonl'
      ? openNodeJsonlStorage(parentStore, BACKGROUND_CONTEXT)
      : openDurableStorage(parentStore, BACKGROUND_CONTEXT));
    const harness = await Harness.open(initial, {
      models: () => { throw new Error('Model access is not expected during migration'); },
      registry: createRegistry<ToolRegistration>(),
    }, BACKGROUND_CONTEXT);
    try {
      if (partial) {
        await harness.root(BACKGROUND_CONTEXT);
        const commit = harness.commit.bind(harness);
        let commits = 0;
        harness.commit = (async (change, context) => commit(async tx => {
          const result = await change(tx);
          if (++commits === 2) throw new Error('injected branch commit failure');
          return result;
        }, context)) as typeof harness.commit;
        await expect(migrateLegacySession(harness, parent, () => {})).rejects.toThrow('injected branch commit failure');
      } else {
        await migrateLegacySession(harness, parent, () => {});
      }
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
    const expectedMap = readFileSync(join(parentStore, 'id-map.json'), 'utf8');
    expect(Object.hasOwn(JSON.parse(expectedMap), 'old')).toBe(!partial);
    if (missingSidecar) unlinkSync(join(parentStore, 'id-map.json'));
    const storage = await openDurableStorage(parentStore, BACKGROUND_CONTEXT);
    const childPath = scratch();
    const setup = createKernel({ sessionPath: childPath, script: [textEvents('child reply')] });
    try {
      const task: TaskRecord<null, null, null> = {
        id: await storage.mintId<TaskId<null>>(), conversationId: ROOT_CONVERSATION_ID,
        kind: 'migration-preflight-test', version: 1, input: null, background: false,
        abortRequested: false, restarts: 2, state: { status: 'running', checkpoint: null },
      };
      await commitWrites(storage, [{ type: 'task', value: task }], BACKGROUND_CONTEXT);
      const record = await storage.findDocument({ kind: 'mkagent.legacy-id-map', scope: { kind: 'session' } }, 'current', BACKGROUND_CONTEXT);
      const migration = await storage.document(record!.id, 'current', BACKGROUND_CONTEXT);
      const filesBefore = Object.fromEntries(readdirSync(parentStore).sort().map(name => [name, readFileSync(join(parentStore, name))]));

      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: parent, branchFromSdkTurnId: 'old' });
      expect(Object.keys(JSON.parse(readFileSync(join(childPath, 'durable-store', 'id-map.json'), 'utf8'))).sort()).toEqual(['new', 'old', 'old-next', 'root']);
      expect(Object.fromEntries(readdirSync(parentStore).sort().map(name => [name, readFileSync(join(parentStore, name))]))).toEqual(filesBefore);
      await setup.kernel.submitPrompt('child question');
      await setup.waitFor('agent_end');

      const messages = JSON.stringify(setup.calls[0]!.messages);
      expect(messages).toContain('shared ancestor');
      expect(messages).toContain('inactive anchor');
      expect(messages).toContain(join(childPath, 'attachments', 'inactive.txt'));
      expect(messages).not.toContain(attachment);
      expect(readFileSync(join(childPath, 'attachments', 'inactive.txt'), 'utf8')).toBe('inactive bytes');
      expect(messages).not.toContain('past inactive anchor');
      expect(messages).not.toContain('active branch');
      expect(await storage.task(task.id, BACKGROUND_CONTEXT)).toEqual(task);
      expect(await storage.document(record!.id, 'current', BACKGROUND_CONTEXT)).toEqual(migration);
      expect(existsSync(join(parentStore, 'id-map.json'))).toBe(!missingSidecar);
      expect(Object.fromEntries(readdirSync(parentStore).sort().map(name => [name, readFileSync(join(parentStore, name))]))).toEqual(filesBefore);
    } finally {
      await setup.kernel.close();
      await storage.close(BACKGROUND_CONTEXT);
    }
  });

  it('branches from an inactive legacy history node without mixing branches', async () => {
    const parent = scratch();
    const transcript = [
      { type: 'session', id: 's-1', version: 3 },
      { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'shared ancestor', timestamp: 1 } },
      { type: 'message', id: 'old', parentId: 'root', message: { role: 'assistant', content: [{ type: 'text', text: 'old branch' }], api: 'x', provider: 'p', model: 'm', usage: USAGE, stopReason: 'stop', timestamp: 1 } },
      { type: 'thinking_level_change', id: 'old-setting', parentId: 'old', thinkingLevel: 'high' },
      { type: 'message', id: 'old-next', parentId: 'old-setting', message: { role: 'user', content: 'old followup', timestamp: 1 } },
      { type: 'message', id: 'old-answer', parentId: 'old-next', message: { role: 'assistant', content: [{ type: 'text', text: 'old final' }], api: 'x', provider: 'p', model: 'm', usage: USAGE, stopReason: 'stop', timestamp: 1 } },
      { type: 'message', id: 'new', parentId: 'root', message: { role: 'user', content: 'active branch', timestamp: 1 } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n';
    mkdirSync(join(parent, '.pi-sessions'), { recursive: true });
    writeFileSync(join(parent, '.pi-sessions', 'legacy.jsonl'), transcript);
    const childPath = scratch();
    const setup = createKernel({ sessionPath: childPath, script: [textEvents('child reply')] });
    let resumed: KernelSetup | undefined;
    try {
      await setup.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: parent, branchFromSdkTurnId: 'old-answer' });
      await setup.kernel.submitPrompt('child question');
      await setup.waitFor('agent_end');
      const messages = JSON.stringify(setup.calls[0]!.messages);
      expect(messages).toContain('shared ancestor');
      expect(messages).toContain('old branch');
      expect(messages).toContain('old followup');
      expect(messages).toContain('old final');
      expect(messages).not.toContain('active branch');
      await setup.kernel.close();
      resumed = createKernel({ sessionPath: scratch(), script: [textEvents('resumed child')] });
      await resumed.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: parent, branchFromSdkTurnId: 'old-answer' });
      await resumed.kernel.submitPrompt('again');
      await resumed.waitFor('agent_end');
      expect(JSON.stringify(resumed.calls[0]!.messages)).toContain('old followup');
      expect(JSON.stringify(resumed.calls[0]!.messages)).not.toContain('active branch');
      const visibleGrandchild = createKernel({ sessionPath: scratch(), script: [textEvents('grandchild reply')] });
      try {
        await visibleGrandchild.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: childPath, branchFromSdkTurnId: 'old-next' });
        await visibleGrandchild.kernel.submitPrompt('grandchild question');
        await visibleGrandchild.waitFor('agent_end');
        const messages = JSON.stringify(visibleGrandchild.calls[0]!.messages);
        expect(messages).toContain('old branch');
        expect(messages).toContain('old followup');
        expect(messages).not.toContain('old final');
        expect(messages).not.toContain('"content":"child question"');
      } finally {
        await visibleGrandchild.kernel.close();
      }
      const grandchild = createKernel({ sessionPath: scratch(), script: [] });
      try {
        await expect(grandchild.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: childPath, branchFromSdkTurnId: 'new' })).rejects.toThrow();
      } finally {
        await grandchild.kernel.close();
      }
      const rootChildPath = scratch();
      const anotherRoot = createKernel({ sessionPath: rootChildPath, script: [textEvents('root child')] });
      try {
        await anotherRoot.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: parent, branchFromSdkTurnId: 'root' });
        await anotherRoot.kernel.submitPrompt('root child');
        await anotherRoot.waitFor('agent_end');
        const escaped = createKernel({ sessionPath: scratch(), script: [] });
        try {
          await expect(escaped.kernel.open({ model: { provider: 'faux', modelId: 'faux-1', contextWindow: 100_000 }, branchFromSessionPath: rootChildPath, branchFromSdkTurnId: 'old-answer' })).rejects.toThrow();
        } finally {
          await escaped.kernel.close();
        }
      } finally {
        await anotherRoot.kernel.close();
      }
    } finally {
      await setup.kernel.close();
      await resumed?.kernel.close();
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
