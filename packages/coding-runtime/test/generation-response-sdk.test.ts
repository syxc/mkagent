/** Exercise SDK generation through real native owners, streams, journals, and transactions. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import {
  createRegistry, GenerationResponseTask, GenerationTask, Harness, LiveDoc, MemoryStorage,
  type CommitResult, type Seq, type StorageWrite, type TaskId,
} from '@earendil-works/pi-durable';
import * as s from '@earendil-works/pi-schema';
import { Agent, type AgentOptions, type AgentTool } from '../src/agent-runtime.ts';
import { DurableLoopBinding, type DurableLoopOptions } from '../src/durable-coding/engine.ts';
import { GenerationResponseDoc } from '../src/durable-coding/generation-response.ts';
import { NativeSessionJournal } from '../src/durable-coding/session-journal.ts';
import { response } from './fixtures/durable-harness.ts';

const context = BACKGROUND_CONTEXT;
const opened: Array<{ harness: Harness; binding: DurableLoopBinding; journal: NativeSessionJournal }> = [];
afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.binding.close();
    item.journal.close();
    await item.harness.close(context);
  }
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const model: Model<'faux'> = {
  id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
class RecordingStorage extends MemoryStorage {
  batches: Array<readonly StorageWrite[]> = [];
  pause?: { text: string; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> };
  override async commit(batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, ctx: Context): Promise<CommitResult> {
    if (this.pause && JSON.stringify(batches).includes(this.pause.text)) {
      const pause = this.pause;
      this.pause = undefined;
      pause.entered.resolve();
      await pause.release.promise;
    }
    return super.commit(batches, (index, seq) => { this.batches.push(batches[index]!); receive(index, seq); }, ctx);
  }
}
async function open(answers: AssistantMessage[], options: Partial<AgentOptions> = {}, commitState?: DurableLoopOptions['commitState']) {
  const registry = createRegistry();
  const storage = new RecordingStorage();
  const reports: unknown[] = [];
  const harness = await Harness.open(storage, {
    registry, models: createModels(), onReport: report => { reports.push(report); },
    settings: { retry: { enabled: false }, compaction: { enabled: false }, progress: { partialIntervalMs: 1 } },
  }, context);
  const conversation = await harness.root(context);
  const journal = await NativeSessionJournal.open({ harness, conversation, context, cwd: '/tmp/generation-response-test' });
  const binding = new DurableLoopBinding({ kernel: { harness, conversation, registry }, journal, commitState });
  opened.push({ harness, journal, binding });
  let requests = 0;
  let owner!: TaskId;
  const agent = new Agent({
    durable: binding, initialState: { model },
    streamFn: async () => {
      requests++;
      owner = (await binding.pendingRun())!;
      const message = answers.shift();
      if (!message) throw new Error('Unexpected model request');
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push(message.stopReason === 'error' || message.stopReason === 'aborted'
        ? { type: 'error', reason: message.stopReason, error: message }
        : { type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message }));
      return stream;
    }, ...options,
  });
  const prompt = (text: string) => {
    agent.subscribe(event => { if (event.type === 'message_end') journal.manager.appendMessage(event.message); });
    return agent.prompt(text);
  };
  return { agent, prompt, harness, journal, binding, conversation, storage, reports, requests: () => requests,
    receipt: () => harness.snapshot(GenerationResponseDoc, owner, context), owner: () => owner };
}
function call(id: string, name = 'fixture') {
  return { type: 'toolCall' as const, id, name, arguments: {} };
}
function tool(effects: string[], name = 'fixture'): AgentTool {
  return { name, label: name, description: 'Local test effect', parameters: s.obj({}), replay: 'never',
    execute: async id => { effects.push(id); return { content: [{ type: 'text', text: id }], details: {} }; } };
}

for (const mutation of ['remove', 'replace', 'add'] as const) test(`only admits calls after message_end ${mutation}`, async () => {
  const phase = spyOn(GenerationResponseTask.definition.phases, 'request');
  try {
    const effects: string[] = [];
    const first = response('');
    first.content = [call('original')];
    first.stopReason = 'toolUse';
    const fixture = await open([first, response('complete')], { initialState: { model, tools: [tool(effects)] } });
    fixture.agent.subscribe(event => {
      if (event.type !== 'message_end' || event.message.role !== 'assistant' || event.message.stopReason !== 'toolUse') return;
      event.message.content = mutation === 'remove' ? [] : mutation === 'replace' ? [call('replacement')] : [call('original'), call('added')];
    });
    await fixture.prompt('mutate final calls');
    expect(fixture.agent.state.errorMessage).toBeUndefined();
    expect(effects).toEqual(mutation === 'remove' ? [] : mutation === 'replace' ? ['replacement'] : ['original', 'added']);
    expect(phase).toHaveBeenCalledTimes(mutation === 'remove' ? 1 : 2);
    expect(fixture.requests()).toBe(mutation === 'remove' ? 1 : 2);
    const history = await fixture.conversation.context(context);
    expect(history.messages).toEqual(fixture.agent.state.messages);
    expect(fixture.storage.batches.some(batch => batch.some(write => write.type.startsWith('document.') && JSON.stringify(write).includes('result')))).toBe(true);
    expect(fixture.reports).toEqual([]);
  } finally { phase.mockRestore(); }
});

test('keeps length calls as native errors without running tool effects', async () => {
  const effects: string[] = [];
  const first = response('', 'length');
  first.content = [call('truncated-1'), call('truncated-2')];
  const fixture = await open([first, response('complete')], { initialState: { model, tools: [tool(effects)] } });
  await fixture.prompt('truncated call');
  expect(fixture.agent.state.errorMessage).toBeUndefined();
  expect(effects).toEqual([]);
  const results = fixture.agent.state.messages.filter(message => message.role === 'toolResult');
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('arguments may be truncated') });
  }
  expect(fixture.reports).toEqual([]);
});

test('commits SDK receipt, the only assistant entry, and native checkpoint together', async () => {
  const fixture = await open([response('SDK atomic answer')]);
  await fixture.prompt('atomic request');
  expect(fixture.agent.state.errorMessage).toBeUndefined();
  const batches = fixture.storage.batches.filter(batch => batch.some(write => write.type === 'entry' && write.value.model?.some(message => message.role === 'assistant')));
  expect(batches).toHaveLength(1);
  const batch = batches[0]!;
  expect(batch.some(write => write.type === 'task' && write.value.kind === 'pi.coding.run' &&
    write.value.state.status === 'running' && (write.value.state.checkpoint as any).phase === 'finish')).toBe(true);
  expect(batch.some(write => write.type.startsWith('document.') && JSON.stringify(write).includes('SDK atomic answer') && JSON.stringify(write).includes('result'))).toBe(true);
  const entries = await fixture.conversation.entries({}, 100, undefined, context);
  const assistants = entries.items.filter(entry => entry.model?.some(message => message.role === 'assistant'));
  expect(assistants).toHaveLength(1);
  expect(assistants[0]!.kind).toBe('mkagent.coding.entry.v1');
  expect((await fixture.harness.snapshot(LiveDoc, fixture.conversation.id, context))?.generation).toBeUndefined();
  expect(GenerationTask.definition.version).toBe(4);
  expect(GenerationResponseTask.definition.version).toBe(1);
  expect(fixture.reports).toEqual([]);
});

test('a refused native transaction publishes neither assistant nor SDK result', async () => {
  let delivered = false;
  const fixture = await open([response('refused answer')], {}, async () => {
    if (delivered) throw new Error('Refuse native response transaction');
  });
  fixture.agent.subscribe(event => { if (event.type === 'message_end' && event.message.role === 'assistant') delivered = true; });
  await fixture.prompt('refuse final transaction');
  expect(fixture.agent.state.errorMessage).toContain('Refuse native response transaction');
  expect((await fixture.conversation.context(context)).messages.map(message => message.role)).toEqual(['user']);
  expect((await fixture.receipt())?.execution?.result).toBeUndefined();
  expect((await fixture.harness.snapshot(LiveDoc, fixture.conversation.id, context))?.generation).toBeUndefined();
  const task = await fixture.harness.getTask(fixture.owner(), context);
  expect(task?.state).toMatchObject({ status: 'terminal', outcome: { status: 'faulted' } });
});

test('keeps core context conversion, asynchronous streams, and ephemeral request options', async () => {
  let requests = 0;
  const onPayload = () => {};
  const fixture = await open([], {
    transformContext: async messages => [...messages, { role: 'user', content: 'transformed context', timestamp: 2 }],
    getApiKey: () => 'synthetic-fixture-credential', onPayload,
    streamFn: async (_model, transcript, options) => {
      requests++;
      expect(transcript.messages.at(-1)?.content).toBe('transformed context');
      expect(options?.apiKey).toBe('synthetic-fixture-credential');
      expect(options?.onPayload).toBe(onPayload);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: response('converted') });
      return stream;
    },
  });
  await fixture.prompt('original');
  expect(fixture.agent.state.errorMessage).toBeUndefined();
  expect(requests).toBe(1);
  expect(fixture.storage.batches.map(batch => JSON.stringify(batch)).join('')).not.toContain('synthetic-fixture-credential');
  expect((await fixture.conversation.context(context)).messages.map(message => message.role)).toEqual(['user', 'assistant']);
  expect(fixture.reports).toEqual([]);
});

test('joins the final SDK partial commit before delivering message_end', async () => {
  const source = createAssistantMessageEventStream();
  const entered = gate();
  const progress = { text: 'SDK partial before final', entered: gate(), release: gate() };
  const fixture = await open([], { streamFn: () => { entered.resolve(); return source; } });
  fixture.storage.pause = progress;
  let delivered = false;
  fixture.agent.subscribe(event => { if (event.type === 'message_end' && event.message.role === 'assistant') delivered = true; });
  const running = fixture.prompt('drain progress');
  await entered.promise;
  const partial = response(progress.text);
  source.push({ type: 'start', partial });
  source.push({ type: 'text_start', contentIndex: 0, partial });
  source.push({ type: 'text_delta', contentIndex: 0, delta: progress.text, partial });
  const first = await Promise.race([progress.entered.promise.then(() => 'progress'), running.then(() => 'returned')]);
  expect(first).toBe('progress');
  source.push({ type: 'done', reason: 'stop', message: response('drained answer') });
  try {
    expect(delivered).toBe(false);
  } finally { progress.release.resolve(); }
  await running;
  expect(delivered).toBe(true);
  expect(fixture.agent.state.errorMessage).toBeUndefined();
  expect((await fixture.harness.snapshot(LiveDoc, fixture.conversation.id, context))?.generation).toBeUndefined();
  const final = fixture.storage.batches.findIndex(batch => batch.some(write => write.type === 'entry' && JSON.stringify(write).includes('drained answer')));
  expect(final).toBeGreaterThan(-1);
  expect(JSON.stringify(fixture.storage.batches.slice(final + 1))).not.toContain(progress.text);
  expect(fixture.reports).toEqual([]);
});

for (const mode of ['external', 'scheduler'] as const) test(`${mode} cancellation joins SDK streaming and clears its partial`, async () => {
  const entered = gate();
  const cleanup = gate();
  const release = gate();
  let owner!: TaskId;
  const fixture = await open([], { streamFn: async (_model, _transcript, options) => {
    owner = (await fixture.binding.pendingRun())!;
    const stream = createAssistantMessageEventStream();
    const settle = async () => {
      cleanup.resolve();
      await release.promise;
      const message = response('cancelled', 'aborted');
      stream.push({ type: 'error', reason: 'aborted', error: message });
    };
    options?.signal?.addEventListener('abort', () => { void settle(); }, { once: true });
    entered.resolve();
    return stream;
  } });
  let settled = false;
  const running = fixture.prompt('cancel request').finally(() => { settled = true; });
  await entered.promise;
  const aborting = mode === 'scheduler' ? fixture.harness.abortTask(owner, context) : undefined;
  if (mode === 'external') fixture.agent.abort();
  try { await cleanup.promise; expect(settled).toBe(false); } finally { release.resolve(); }
  await running;
  await aborting;
  expect((await fixture.harness.snapshot(LiveDoc, fixture.conversation.id, context))?.generation).toBeUndefined();
  const entries = await fixture.conversation.entries({}, 100, undefined, context);
  expect(entries.items.filter(entry => entry.model?.some(message => message.role === 'assistant'))).toHaveLength(mode === 'external' ? 1 : 0);
  expect((await fixture.harness.snapshot(GenerationResponseDoc, owner, context))?.execution).toBeUndefined();
  expect(fixture.storage.batches.some(batch => batch.some(write => write.type.startsWith('document.') &&
    JSON.stringify(write).includes(mode === 'external' ? 'result' : 'aborted')))).toBe(true);
});

const crashFixture = fileURLToPath(new URL('./fixtures/generation-response-recovery-process.ts', import.meta.url));
async function runCrash(directory: string, phase: 'begin' | 'resume', boundary: string) {
  return new Promise<string>((resolve, reject) => {
    const args = typeof Bun === 'undefined' ? ['--experimental-transform-types'] : ['--no-env-file'];
    const child = spawn(process.execPath, [...args, crashFixture, directory, phase, boundary], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let killed = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 8_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (phase === 'begin' && !killed && output.includes('CRASH_BOUNDARY\n')) killed = child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (phase === 'begin' ? killed && signal === 'SIGKILL' : code === 0) resolve(output);
      else reject(new Error(`Generation recovery failed: ${phase}, ${boundary}, ${code}, ${signal}\n${output}\n${errors}`));
    });
  });
}
for (const boundary of ['request', 'message_end', 'accepted']) test(`SIGKILL recovery does not repeat ${boundary}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'generation-response-crash-'));
  try {
    await runCrash(directory, 'begin', boundary);
    const restored = JSON.parse(await runCrash(directory, 'resume', boundary));
    expect(restored.resumed).toBe(true);
    expect(restored.error).toContain('hook and event delivery is uncertain and was not repeated');
    expect(restored.assistants).toBe(boundary === 'accepted' ? 1 : 0);
    expect(restored.checkpoint.checkpoint.phase).toBe(boundary === 'accepted' ? 'finish' : 'request');
    expect(restored.receipt.execution).toMatchObject({ version: 1, checkpoint: { phase: 'request', started: true } });
    expect(restored.receipt.execution.result !== undefined).toBe(boundary === 'accepted');
    expect(await readFile(join(directory, 'requests.txt'), 'utf8')).toBe('begin\n');
    expect(restored.pending).toBeUndefined();
    expect(restored.generation).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20_000);
