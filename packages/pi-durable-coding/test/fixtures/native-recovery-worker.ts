/** Synthetic process boundary for kill/reopen tests; no user resources or model network. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createAssistantMessageEventStream, createModels, createProvider, InMemoryCredentialStore,
  type AssistantMessage, type Model,
} from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import * as s from '@earendil-works/pi-schema';
import { DurableLoopBinding } from '../../src/durable-coding/engine.ts';
import { NativeSessionJournal } from '../../src/durable-coding/session-journal.ts';
import { BlockedSessionActions } from '../../src/durable-coding/session-task.ts';
import { createHostResources } from '../../src/host-resources.ts';
import { ModelRuntime } from '../../src/pi/core/model-runtime.ts';
import { createAgentSession } from '../../src/pi/core/sdk.ts';

const [mode, directory, replay, crash] = process.argv.slice(2);
if (!directory || !['initial', 'resume'].includes(mode!)) throw new Error('Invalid synthetic recovery worker input');
globalThis.fetch = async () => { throw new Error('Recovery test forbids network'); };
const context = BACKGROUND_CONTEXT;
const effect = (value: string) => appendFileSync(join(directory, 'effects.jsonl'), JSON.stringify(value) + '\n');
const terminate = (point: string) => {
  writeFileSync(join(directory, 'crash'), point);
  process.kill(process.pid, 'SIGKILL');
};
const model: Model<'fixture'> = {
  id: 'local', name: 'Local', provider: 'local', api: 'fixture', baseUrl: 'http://unused.invalid',
  input: ['text'], reasoning: false, contextWindow: 100_000, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const credentials = ModelRuntime.createCredentials(new InMemoryCredentialStore());
const models = createModels({ credentials });
models.setProvider(createProvider({
  id: 'local', models: [model],
  auth: { apiKey: { name: 'Synthetic', resolve: async () => ({ auth: {} }) } },
  api: {
    stream: stream, streamSimple: stream,
  },
}));
function stream(_model: Model<'fixture'>, request: { messages: { role: string }[] }) {
  const called = request.messages.some(message => message.role === 'toolResult');
  effect(`request:${called ? 'final' : 'tool'}`);
  const message: AssistantMessage = {
    role: 'assistant', provider: 'local', model: 'local', api: 'fixture',
    timestamp: called ? 3 : 2, stopReason: called ? 'stop' : 'toolUse',
    content: called ? [{ type: 'text', text: 'Recovered answer' }]
      : [{ type: 'toolCall', id: 'effect-call', name: 'effect', arguments: { value: 'full output' } }],
    usage: {
      input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => events.push({ type: 'done', reason: called ? 'stop' : 'toolUse', message }));
  return events;
}
const registry = createRegistry();
const harness = await Harness.open(await openNodeJsonlStorage(join(directory, 'store'), context), {
  registry, models, settings: { retry: { enabled: false }, compaction: { enabled: false } },
}, context);
const conversation = await harness.root(context);
const journal = await NativeSessionJournal.open({ harness, conversation, context, cwd: directory });
const durable = new DurableLoopBinding({ kernel: { harness, conversation, registry }, journal });
let actionsScheduled = journal.manager.getEntries().some(entry =>
  entry.type === 'custom' && entry.customType === 'fixture.actions');
const agentDir = join(directory, 'agent');
mkdirSync(agentDir, { recursive: true });
const resources = createHostResources({
  cwd: directory, agentDir,
  globalSettings: { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' },
  disabledBuiltinExtensions: ['codemode', 'tool-search', 'mcp'],
  extensionFactories: [pi => {
    pi.on('context', () => {
      if (crash !== 'request-context') return;
      effect(crash);
      if (mode === 'initial') terminate(crash);
    });
    pi.on('message_start', event => {
      if (crash !== 'request-message-start' || event.message.role !== 'assistant') return;
      if (event.message.stopReason === 'error') { effect('recovery-error-notification'); return; }
      effect(crash);
      if (mode === 'initial') terminate(crash);
    });
    pi.registerTool({
      name: 'effect', label: 'effect', description: 'Synthetic local effect',
      parameters: s.obj({ value: s.str() }),
      execute: async (_id, args) => {
        effect('execute');
        if (mode === 'initial' && crash === 'effect') terminate('effect');
        return { content: [{ type: 'text', text: args.value }], details: { complete: ['all', 3] } };
      },
    });
    pi.on('tool_result', () => { effect('tool_result'); });
    pi.on('turn_end', event => {
      effect('turn_end');
      return { entries: [{ type: 'custom', customType: 'boundary', data: { role: event.message.role } }] };
    });
    pi.on('agent_before_settle', () => { effect('before_settle'); });
    pi.on('agent_settled', async () => {
      effect('settled');
      if (!crash.includes('action') || actionsScheduled) return;
      actionsScheduled = true;
      pi.appendEntry('fixture.actions', { accepted: true });
      await session.prompt('deferred A', { expandPromptTemplates: false });
      if (mode === 'initial' && crash === 'accepted-action') terminate(crash);
      await session.prompt('deferred B', { expandPromptTemplates: false });
    });
  }],
});
await resources.resourceLoader.reload();
const runtime = await ModelRuntime.bind({ models: () => models, credentials });
const { session } = await createAgentSession({
  ...resources, cwd: directory, agentDir, modelRuntime: runtime, model,
  sessionManager: journal.manager, durable,
  baseToolsOverride: {}, tools: ['effect'],
  wrapTool: tool => ({ ...tool, replay: replay === 'safe' ? 'safe' : 'never' }),
});
await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
await journal.flush();
if (mode === 'initial' && crash !== 'effect') harness.observeCommits({
  advance: publication => {
    for (const change of publication.changes) {
      if (change.type !== 'task') continue;
      const state = change.value.state;
      if (state.status === 'terminal') {
        if (crash === 'root-terminal-action' && change.value.kind === 'pi.coding.session') terminate(crash);
        continue;
      }
      const checkpoint = state.checkpoint;
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) continue;
      if (`${change.value.kind}:${checkpoint.phase}` === crash) terminate(crash);
    }
  },
});
try {
  let recoveryError: string | undefined;
  if (mode === 'initial') await session.prompt('Exercise recovery');
  else {
    try {
      if (!await session.recoverDurable() && crash !== 'root-terminal-action') throw new Error('No coding run to recover');
    } catch (error) { recoveryError = error instanceof Error ? error.message : String(error); }
  }
  await session.waitForIdle();
  await journal.flush();
  const result = {
    messages: session.messages,
    entries: journal.manager.getEntries(),
    context: (await conversation.context(context)).messages,
    pending: (await harness.inspect(context)).tasks.length,
    error: session.agent.state.errorMessage,
    recoveryError,
    isIdle: session.isIdle,
    blocked: await harness.snapshot(BlockedSessionActions, conversation.id, context),
  };
  process.stdout.write(JSON.stringify(result));
} finally {
  session.dispose();
  await durable.close();
  journal.close();
  await harness.close(context);
}
