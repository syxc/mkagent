/** Each process owns one side of a host ToolTask crash boundary. */
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import { defineDoc, defineExtension, defineTask, ToolTask, type TaskId } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { Agent, type AgentTool } from '../../src/agent-runtime.ts';
import { currentCodingToolInvocation, DurableLoopBinding } from '../../src/durable-coding/engine.ts';
import { agentToolToHost, hostToolToAgent } from '../../src/host-tools.ts';
import { response } from './durable-harness.ts';

const [directory, phase, replay, boundary, nativeReplay = replay] = process.argv.slice(2);
assert(directory && (phase === 'begin' || phase === 'resume'));
assert(replay === 'safe' || replay === 'never');
assert(nativeReplay === 'safe' || nativeReplay === 'never');
assert(['intent', 'completed', 'removed', 'legacy-policy', 'failed', 'failed-removed',
  'plain-completed', 'plain-removed', 'plain-legacy', 'abort-completed', 'plain-abort-completed'].includes(boundary!));
const plain = boundary!.startsWith('plain-');
const aborting = boundary!.includes('abort-completed');
const failed = boundary === 'failed' || boundary === 'failed-removed';
const removed = boundary === 'removed' || boundary === 'failed-removed' || boundary === 'plain-removed';
const Child = defineTask<{}, { phase: 'sleep' }, null>({
  name: 'host-sdk-recovery-child', version: 1, initial: () => ({ phase: 'sleep' }),
  phases: { sleep: async (task, runtime, ctx) => {
    await runtime.commit(() => ({ status: 'sleeping', until: runtime.now() + 60_000, checkpoint: task.state.checkpoint }), ctx);
  } },
  abort: async (_task, runtime, ctx) => {
    appendFileSync(join(directory, 'cleanup.txt'), `${runtime.taskId}\n`);
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx);
  },
});
const ExecutionDoc = defineDoc({
  kind: 'mkagent.coding.host-tool-execution', version: 1, scope: 'task',
  initial: () => ({} as { execution?: {
    checkpoint: { phase: string; replay?: string }; result?: { executionArguments?: unknown };
  } }), checkpointWhen: () => false,
});
const model: Model<'faux'> = {
  id: 'local', name: 'Local', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const content = [
  { type: 'text' as const, text: 'native result '.repeat(5_000) },
  { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' },
];
const block = async () => {
  process.stdout.write('CRASH_BOUNDARY\n');
  await new Promise(() => {});
};
const native: AgentTool = {
  name: 'fixture', label: 'Fixture', description: 'Record attempted effects', parameters: { type: 'object' }, replay,
  prepareArguments: plain ? () => ({ prepared: true }) : undefined,
  execute: async (_id, args) => {
    if (plain) args.changed = true;
    const { runtime } = currentCodingToolInvocation();
    writeFileSync(join(directory, 'tool-id.txt'), JSON.stringify(runtime.taskId));
    appendFileSync(join(directory, 'effects.txt'), `${phase}\n`);
    if (failed) {
      const children: TaskId[] = [];
      await runtime.commit(async tx => {
        children.push(await tx.createTask(Child, {}, { ownership: { kind: 'task', taskId: runtime.taskId } }));
        const conversation = await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } });
        children.push(await tx.createTask(Child, {}, { conversationId: conversation.id, ownership: { kind: 'conversation' } }));
      }, BACKGROUND_CONTEXT);
      writeFileSync(join(directory, 'children.txt'), JSON.stringify(children));
      throw new Error('Host execution failed');
    }
    if (phase === 'begin' && boundary === 'legacy-policy') {
      // Reproduce a receipt written before Native replay restrictions reached the SDK.
      await runtime.commit(async tx => {
        const doc = await tx.doc(ExecutionDoc, runtime.taskId);
        assert(doc.execution);
        doc.execution.checkpoint.replay = 'safe';
      }, BACKGROUND_CONTEXT);
    }
    if (phase === 'begin' && (boundary === 'intent' || boundary === 'legacy-policy')) await block();
    return { content, details: { source: 'native' }, structuredContent: { complete: true },
      ...(aborting ? { usage: response('').usage, terminate: true } : {}) };
  },
};
const wrapped = hostToolToAgent(agentToolToHost(native));
const target: AgentTool = plain ? { ...native, replay: nativeReplay } : {
  ...wrapped,
  replay: nativeReplay,
  execute: async (...args) => {
    const result = await wrapped.execute(...args);
    assert(failed || !result.isError, JSON.stringify(result));
    // The SDK receipt is durable, but the native owner still holds its execute checkpoint.
    if (phase === 'begin' && boundary !== 'intent') await block();
    return result;
  },
};
let requests = 0;
const agent = new Agent({
  durable: new DurableLoopBinding({ storage: await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT) }),
  initialState: { model, tools: phase === 'resume' && removed ? [] : [target] },
  afterToolCall: plain ? async call => {
    writeFileSync(join(directory, 'final-arguments.json'), JSON.stringify(call.args));
    return undefined;
  } : undefined,
  streamFn: () => {
    const message = response('recovered');
    if (phase === 'begin' && requests++ === 0) {
      message.content = [{ type: 'toolCall', id: 'call-1', name: 'fixture', arguments: {} }];
      message.stopReason = 'toolUse';
    }
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({
      type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message,
    }));
    return stream;
  },
});
const events: unknown[] = [];
agent.subscribe(event => { if (event.type === 'tool_execution_end') events.push(event); });
const backend = await agent.durable.backend();
backend.registry.install(defineExtension({ name: 'host-sdk-recovery', tasks: [Child] }));
if (phase === 'begin') {
  if (plain) {
    const call = ToolTask.definition.phases.call;
    ToolTask.definition.phases.call = async (...args) => {
      await call(...args);
      if (boundary === 'plain-legacy') {
        // Old receipts have a completed result without the new optional argument snapshot.
        const { runtime } = currentCodingToolInvocation();
        await runtime.commit(async tx => {
          delete (await tx.doc(ExecutionDoc, runtime.taskId)).execution?.result?.executionArguments;
          return undefined;
        }, BACKGROUND_CONTEXT);
      }
      await block();
    };
  }
  backend.harness.resume();
  await agent.prompt('run the fixture');
  throw new Error(`Expected a crash at the tool boundary: ${JSON.stringify({ messages: agent.state.messages, reports: backend.reports })}`);
}
try {
  const id = JSON.parse(readFileSync(join(directory, 'tool-id.txt'), 'utf8')) as TaskId;
  const checkpoint = (await backend.harness.getTask(id, backend.context))?.state;
  const execution = await backend.harness.snapshot(ExecutionDoc, id, backend.context);
  if (aborting) await backend.harness.abortTask(id, backend.context);
  const resumed = await agent.resumeDurable(() => backend.harness.resume());
  const children = failed ? await Promise.all((JSON.parse(readFileSync(join(directory, 'children.txt'), 'utf8')) as TaskId[])
    .map(id => backend.harness.getTask(id, backend.context))) : [];
  const output = JSON.stringify({ resumed, checkpoint, execution, children,
    owner: await backend.harness.getTask(id, backend.context),
    messages: agent.state.messages, events, reports: backend.reports });
  // Await the stream write so the full receipt survives pipe backpressure before shutdown.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${output}\n`, error => { if (error) reject(error); else resolve(); });
  });
} finally {
  await agent.durable.close();
}
