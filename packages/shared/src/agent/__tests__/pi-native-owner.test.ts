import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import type { AgentEvent } from '@mkagent/core/types';
import { PiAgent } from '../pi-agent.ts';
import type { PiNativeOwnerEvent, PiNativeOwnerHostPort } from '../backend/pi/native-owner-protocol.ts';
import type { PiWorkerScope } from '../backend/pi/protocol.ts';
import type { PiWorkerLease } from '../backend/pi/worker-connection.ts';

const agents: PiAgent[] = [];
const children = new Set<ChildProcess>();
const directories: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
  }
  children.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function deadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local fixture deadline exceeded')), 2_000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

const script = `
  const reader = require('node:readline').createInterface({ input: process.stdin });
  let owner, pendingPrompt, releaseMode = 'ack';
  const stops = [];
  const send = (value, scope = owner) => console.log(JSON.stringify({ ...value, ...scope }));
  reader.on('close', () => process.exit(0));
  reader.on('line', line => {
    const command = JSON.parse(line);
    const scope = { ownerSessionId: command.ownerSessionId, runtimeGeneration: command.runtimeGeneration };
    if (command.type === 'fixture') {
      for (const frame of command.frames || []) console.log(JSON.stringify(frame));
      send({ type: 'fixture_barrier', id: command.id }, scope);
    } else if (command.type === 'init') {
      owner = scope;
      if (process.env.FIXTURE_PROJECTION === '1') send({ type: 'event', event: {
        type: 'native_session_projection', descriptor: {
          version: 1, sessionId: command.sessionId, nativeSessionId: 'native-' + command.sessionId,
          conversationId: 1, revision: 1, sessionFile: command.sessionPath + '/native-session/session.jsonl',
          leaf: null, name: null, digest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), entryIds: [],
        },
      } });
      send({ type: 'ready', sessionId: 'native-' + command.sessionId });
    } else if (command.type === 'set_auto_compaction') {
      if (process.env.FIXTURE_STARTUP_OWNER === '1') {
        send({ type: 'session_id_update', sessionId: 'native-source' });
        send({ type: 'owner_prepare', transactionId: 'startup-tx',
          sourceNativeSessionId: 'native-source', operation: { type: 'new' } });
      } else {
        send({ type: 'set_auto_compaction_result', id: command.id, success: true, enabled: true });
      }
    } else if (command.type === 'mini_completion') {
      send({ type: 'mini_completion_result', id: command.id, text: String(process.pid) }, scope);
    } else if (command.type === 'prompt') {
      pendingPrompt = command;
      if (command.message.includes('owner-source')) {
        send({ type: 'owner_prepare', transactionId: 'tx', inputId: command.inputId,
          sourceNativeSessionId: 'native-source', operation: { type: 'new' } });
      } else {
        send({ type: 'prompt_result', id: command.id, handled: false, completed: false });
        send({ type: 'event', event: { type: 'agent_start' } });
        send({ type: 'event', event: { type: 'message_end', sdkMessageId: 'normal',
          message: { role: 'assistant', content: [{ type: 'text', text: 'normal answer' }], stopReason: 'stop',
            usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } } });
        send({ type: 'event', event: { type: 'agent_end', messages: [] } });
      }
    } else if (command.type === 'owner_prepared') {
      send({ type: 'owner_source_closed', transactionId: command.transactionId });
    } else if (command.type === 'owner_activate') {
      owner = scope;
      send({ type: 'callback_port', callbackPort: 43210 });
      send({ type: 'owner_target_bound', transactionId: command.transactionId, nativeSessionId: 'native-target' });
    } else if (command.type === 'release_owner') {
      if (releaseMode === 'error') send({ type: 'error', id: command.id, message: 'fixture release rejected' }, scope);
      if (releaseMode === 'ack') send({ type: 'owner_released', id: command.id, released: true }, scope);
      if (releaseMode === 'projection-error') send({ type: 'owner_released', id: command.id, released: true,
        error: 'fixture closed writer projection failed' }, scope);
      if (releaseMode === 'rejected') send({ type: 'owner_released', id: command.id, released: false,
        error: 'fixture writer still active' }, scope);
    } else if (command.type === 'fixture_release_mode') {
      releaseMode = command.mode;
    } else if (command.type === 'stop_background_task') {
      if (command.taskId.startsWith('held')) stops.push({ command, scope });
      else {
        send({ type: 'background_task_event', event: { type: 'task_completed', taskId: command.taskId, status: 'stopped' } }, scope);
        send({ type: 'stop_background_task_result', id: command.id, stopped: true }, scope);
      }
    } else if (command.type === 'fixture_reply_stops') {
      for (const { command, scope } of stops.splice(0)) {
        send({ type: 'background_task_event', event: { type: 'task_completed', taskId: command.taskId, status: 'stopped' } }, scope);
        send({ type: 'stop_background_task_result', id: command.id, stopped: true }, scope);
      }
    }
  });
`;

function host() {
  const events: Array<{ event: PiNativeOwnerEvent; transport: object }> = [];
  const projections: unknown[] = [];
  const exits: Array<{ transport: object; error: Error }> = [];
  const waits = new Map<string, ReturnType<typeof Promise.withResolvers<PiNativeOwnerEvent>>>();
  const port: PiNativeOwnerHostPort = {
    deferStartup: true,
    async onProjection(reference) { projections.push(reference); },
    async onEvent(event, _backend, transport) {
      events.push({ event, transport });
      waits.get(event.type)?.resolve(event);
    },
    async onExit(_backend, transport, error) { exits.push({ transport, error }); },
  };
  return {
    port, events, exits, projections,
    wait(type: PiNativeOwnerEvent['type']) {
      const existing = events.find(item => item.event.type === type)?.event;
      if (existing) return Promise.resolve(existing);
      const gate = Promise.withResolvers<PiNativeOwnerEvent>();
      waits.set(type, gate);
      return deadline(gate.promise);
    },
  };
}

function agent(id: string, port = host().port): any {
  const directory = mkdtempSync(join(tmpdir(), 'mkagent-owner-'));
  directories.push(directory);
  const instance: any = new PiAgent({
    provider: 'pi', isHeadless: true, skipConfigWatcher: true, agentProfile: 'coding',
    model: 'local-model', miniModel: 'local-mini', authType: 'none',
    workspace: { id: `workspace-${id}`, name: id, slug: id, rootPath: directory, createdAt: 0 },
    session: { id, workspaceRootPath: directory, createdAt: 0, lastUsedAt: 0, permissionMode: 'allow-all' },
    codingResources: { resourcePolicy: 'host-only', projectTrusted: false, extensionPaths: [] },
    nativeSessionOwner: port,
    runtime: { paths: { node: process.execPath, piServer: '--eval=' + script }, customEndpoint: { api: 'openai-completions' } },
  });
  instance.getPiAuth = async () => undefined;
  instance.getApiKey = async () => { throw new Error('Custom local endpoint must not use legacy credentials'); };
  agents.push(instance);
  return instance;
}

function observe(instance: any) {
  const child: ChildProcess = instance.subprocess;
  children.add(child);
  const reader = createInterface({ input: child.stdout! });
  const waiters = new Map<string, () => void>();
  reader.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'fixture_barrier') waiters.get(frame.id)?.();
  });
  child.once('close', () => reader.close());
  return {
    child,
    async inject(frames: Record<string, unknown>[]) {
      const id = crypto.randomUUID();
      const done = new Promise<void>(resolve => waiters.set(id, resolve));
      child.stdin!.write(JSON.stringify({ type: 'fixture', id, frames }) + '\n');
      await deadline(done);
      waiters.delete(id);
    },
    command(command: Record<string, unknown>) {
      child.stdin!.write(JSON.stringify(command) + '\n');
    },
  };
}

function event(scope: PiWorkerScope, value: Record<string, unknown>) {
  return { ...scope, type: 'event', event: value };
}

function message(id: string, output: number, error?: string) {
  return {
    type: 'message_end', sdkMessageId: id,
    message: {
      role: 'assistant', content: [{ type: 'text', text: id }], stopReason: error ? 'error' : 'stop', errorMessage: error,
      usage: { input: 2, output, cacheRead: 0, cacheWrite: 0, totalTokens: 2 + output, cost: { total: 0.1 } },
    },
  };
}

function projection(id: string) {
  return {
    type: 'native_session_projection', descriptor: {
      version: 1, sessionId: id, nativeSessionId: `native-${id}`, conversationId: 1, revision: 1,
      sessionFile: `/fixture/${id}/native-session/session.jsonl`, leaf: null, name: null,
      digest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), entryIds: [{ nativeId: 'large-mapping' }],
    },
  };
}

test('native projection received before ready waits for the worker native identity', async () => {
  const sourceHost = host();
  const source = agent('source', sourceHost.port);
  source.config.envOverrides = { FIXTURE_PROJECTION: '1' };
  const registered: unknown[] = [];
  sourceHost.port.onProjection = async reference => {
    expect(source.getSessionId()).toBe(reference.nativeSessionId);
    registered.push(reference);
  };
  await source.ensureSubprocess();
  expect(registered).toHaveLength(1);
  expect(registered[0]).not.toHaveProperty('entryIds');
});

test('native projection routes only from the active owner generation and matching native identity', async () => {
  const f = await adopted();
  await f.wire.inject([
    event(f.oldScope, projection('source')),
    event(f.scope, projection('source')),
    event(f.scope, { ...projection('target'), descriptor: { ...projection('target').descriptor, digest: 'bad' } }),
    event(f.scope, { ...projection('target'), descriptor: { ...projection('target').descriptor, nativeSessionId: 'foreign' } }),
    event(f.scope, projection('target')),
  ]);
  expect(f.sourceHost.projections).toHaveLength(0);
  expect(f.targetHost.projections).toHaveLength(1);
  expect(f.targetHost.projections[0]).toMatchObject({ sessionId: 'target', nativeSessionId: 'native-target' });
  expect(f.targetHost.projections[0]).not.toHaveProperty('entryIds');
});

async function adopted() {
  const sourceHost = host();
  const targetHost = host();
  const source = agent('source', sourceHost.port);
  const target = agent('target', targetHost.port);
  const contexts = { consumed: 0 };
  source.config.getTransferredSessionSummary = () => 'source context seed';
  source.config.markTransferredSessionSummaryApplied = () => { contexts.consumed++; };
  const activation = await target.nativeSessionOwner.prepareActivation();
  expect(target.subprocess).toBeNull();
  await source.ensureSubprocess();
  const wire = observe(source);
  const sourceEvents: AgentEvent[] = [];
  const sourceRunning = (async () => {
    for await (const item of source.chat('owner-source', undefined, { messageId: 'input-source' })) sourceEvents.push(item);
  })();
  await sourceHost.wait('owner_prepare');
  const oldScope = { ownerSessionId: source.workerLease.ownerSessionId, runtimeGeneration: source.workerLease.generation };
  await wire.inject([
    { ...oldScope, type: 'background_task_event', event: { type: 'shell_backgrounded', shellId: 'held-source' } },
    { ...oldScope, type: 'background_task_event', event: { type: 'shell_backgrounded', shellId: 'dispose-source' } },
    event(oldScope, message('source-before-transfer', 2)),
    event(oldScope, { type: 'agent_end', messages: [] }),
  ]);
  expect(source.nativeSessionOwner.sendOwnerControl({ type: 'owner_prepared', transactionId: 'tx', targetSessionId: 'target' })).toBe(true);
  await sourceHost.wait('owner_source_closed');
  const transfer = await source.nativeSessionOwner.detachForOwner();
  await deadline(sourceRunning);
  expect(contexts.consumed).toBe(0);
  const targetEvents: AgentEvent[] = [];
  target.setBackgroundEventSink((item: AgentEvent) => targetEvents.push(item));
  const scope = target.nativeSessionOwner.adoptForOwner(transfer, 'tx');
  expect(target.nativeSessionOwner.sendOwnerControl({ type: 'owner_activate', transactionId: 'tx', activation })).toBe(true);
  await targetHost.wait('owner_target_bound');
  await target.subprocessReady;
  expect(target.callbackPort).toBe(43210);
  transfer.release();
  transfer.release();
  return { source, target, sourceHost, targetHost, activation, transfer, scope, oldScope, wire, sourceEvents, targetEvents, contexts };
}

test('startup replacement settles its old RPC without letting stale recovery stop the fresh source worker', async () => {
  const sourceHost = host();
  const source = agent('source', sourceHost.port);
  source.config.envOverrides = { FIXTURE_STARTUP_OWNER: '1' };
  const events: AgentEvent[] = [];
  const running = (async () => {
    for await (const item of source.chat('startup original input')) events.push(item);
  })();
  await sourceHost.wait('owner_prepare');
  const wire = observe(source);
  const pending = source.pendingAutoCompactionToggles.values().next().value;
  expect(pending).toBeDefined();
  source.nativeSessionOwner.sendOwnerControl({ type: 'owner_prepared', transactionId: 'startup-tx', targetSessionId: 'target' });
  await sourceHost.wait('owner_source_closed');
  const transfer = await source.nativeSessionOwner.detachForOwner();
  source.config.envOverrides = { FIXTURE_STARTUP_OWNER: '0' };
  for await (const _item of source.chat('fresh source input')) { /* Drain the new foreground. */ }
  const fresh = observe(source);
  expect(fresh.child.pid).not.toBe(wire.child.pid);
  const recovery = spyOn(source, 'killSubprocessGracefully');
  try {
    // Force the captured old timeout without waiting fifteen seconds.
    pending.reject(new Error('fixture old startup timeout'));
    await deadline(running);
    expect(recovery).not.toHaveBeenCalled();
    expect(source.subprocess).toBe(fresh.child);
    expect(source.getSessionId()).toBe('native-source');
    expect(events.filter(item => item.type === 'complete')).toHaveLength(1);
  } finally {
    recovery.mockRestore();
    transfer.release();
  }
});

test('adopts the same physical worker, retains source task replies across a fresh source worker, and isolates disposal', async () => {
  const f = await adopted();
  expect(f.scope.runtimeGeneration).toBeGreaterThan(f.oldScope.runtimeGeneration);
  expect(f.target.workerConnection).toBe(f.transfer.transport);
  expect(f.target.subprocess).toBe(f.wire.child);
  expect(f.sourceEvents.filter(item => item.type === 'complete')).toHaveLength(1);
  const sourceComplete = f.sourceEvents.find(item => item.type === 'complete');
  expect(sourceComplete?.type === 'complete' && sourceComplete.usage?.outputTokens).toBe(2);
  expect(f.sourceHost.events.every(item => item.transport === f.transfer.transport)).toBe(true);
  expect(f.transfer.send({ type: 'owner_abort', transactionId: 'tx', error: 'late' })).toBe(false);
  const sourceBackground: AgentEvent[] = [];
  f.source.setBackgroundEventSink((item: AgentEvent) => sourceBackground.push(item));
  const stopped: Promise<boolean> = f.source.stopBackgroundTask('held-source');
  const normal: AgentEvent[] = [];
  for await (const item of f.source.chat('fresh worker')) normal.push(item);
  const fresh = observe(f.source);
  expect(fresh.child.pid).not.toBe(f.wire.child.pid);
  expect(f.source.workerLease.generation).toBe(f.oldScope.runtimeGeneration);
  f.wire.command({ type: 'fixture_reply_stops' });
  expect(await deadline(stopped)).toBe(true);
  expect(sourceBackground.filter(item => item.type === 'task_completed')).toEqual([{ type: 'task_completed', taskId: 'held-source', status: 'stopped' }]);
  expect(f.targetEvents.some(item => item.type === 'task_completed')).toBe(false);
  expect(normal.some(item => item.type === 'text_complete')).toBe(true);
  expect(f.contexts.consumed).toBe(1);
  const close = spyOn(f.target.workerConnection, 'close');
  f.source.destroy();
  expect(await f.target.runMiniCompletion('still alive')).toBe(String(f.wire.child.pid));
  expect(sourceBackground.some(item => item.type === 'task_completed' && item.taskId === 'dispose-source')).toBe(true);
  expect(f.targetEvents.some(item => item.type === 'task_completed')).toBe(false);
  expect(close).not.toHaveBeenCalled();
  expect(f.wire.child.exitCode).toBeNull();
  await f.wire.inject([{ ...f.scope, type: 'owner_finished', transactionId: 'tx', outcome: 'complete' }]);
  expect(f.targetEvents.filter(item => item.type === 'complete')).toHaveLength(1);
  expect(f.targetEvents.find(item => item.type === 'complete')).toEqual({ type: 'complete' });
  await f.target.disposeForRestart();
  expect(f.target.subprocess).toBeNull();
  close.mockRestore();
});

test('keeps detached delivery open across callbacks, retry and overflow, with one cumulative completion before the host callback', async () => {
  const f = await adopted();
  const order: string[] = [];
  f.target.setBackgroundEventSink((item: AgentEvent) => { f.targetEvents.push(item); order.push(item.type); });
  f.targetHost.port.onEvent = async item => {
    if (item.type === 'owner_finished') {
      expect(f.target.isProcessing()).toBe(false);
      expect(f.targetEvents.filter(item => item.type === 'complete')).toHaveLength(1);
      order.push('host-finished');
    }
  };
  await f.wire.inject([
    { ...f.scope, type: 'background_task_event', event: { type: 'shell_backgrounded', shellId: 'target-shell', toolUseId: 'target-call' } },
    { ...f.scope, type: 'background_task_event', event: { type: 'task_completed', taskId: 'target-shell', status: 'completed' } },
    event(f.scope, { type: 'agent_start' }),
    event(f.scope, message('first-callback', 3)),
    event(f.scope, { type: 'agent_end', messages: [] }),
    event(f.scope, { type: 'agent_start' }),
    event(f.scope, message('retry-failure', 4, 'fetch failed')),
    event(f.scope, { type: 'agent_end', messages: [], willRetry: true }),
    event(f.scope, { type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 0, errorMessage: 'fetch failed' }),
    event(f.scope, { type: 'agent_start' }),
    event(f.scope, message('overflow-failure', 5, 'context_length_exceeded')),
    event(f.scope, { type: 'agent_end', messages: [] }),
    event(f.scope, { type: 'compaction_start', reason: 'overflow' }),
    event(f.scope, { type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true }),
    event(f.scope, { type: 'agent_start' }),
    event(f.scope, message('recovered', 6)),
    event(f.scope, message('recovered', 6)),
    event(f.scope, { type: 'agent_end', messages: [] }),
    event(f.scope, { type: 'tool_execution_start', toolName: 'read', toolCallId: 'read-1', args: { path: 'file' } }),
    event(f.scope, { type: 'tool_execution_end', toolName: 'read', toolCallId: 'read-1', result: { content: [{ type: 'text', text: 'read' }] }, isError: false }),
  ]);
  expect(f.target.isProcessing()).toBe(true);
  expect(f.target.eventQueue.isComplete).toBe(false);
  expect(f.targetEvents.some(item => item.type === 'tool_start')).toBe(true);
  expect(f.targetEvents.some(item => item.type === 'task_completed' && item.taskId === 'target-shell')).toBe(true);
  expect(f.targetEvents.filter(item => item.type === 'complete')).toHaveLength(0);
  await f.wire.inject([
    { ...f.scope, type: 'owner_finished', transactionId: 'wrong', outcome: 'complete' },
    { ...f.scope, type: 'owner_finished', transactionId: 'tx', outcome: 'invalid' },
  ]);
  expect(f.target.isProcessing()).toBe(true);
  await f.wire.inject([
    { ...f.scope, type: 'owner_finished', transactionId: 'tx', outcome: 'complete' },
    { ...f.scope, type: 'owner_finished', transactionId: 'tx', outcome: 'complete' },
  ]);
  const complete = f.targetEvents.find(item => item.type === 'complete');
  expect(complete?.type === 'complete' && complete.usage?.outputTokens).toBe(18);
  expect(order.slice(-2)).toEqual(['complete', 'host-finished']);
  expect(f.targetEvents.filter(item => item.type === 'complete')).toHaveLength(1);
});

test('delivers adapter async fallback errors through the detached sink without ending the owner barrier', async () => {
  const f = await adopted();
  const armRetry = f.target.adapter.armRetryFallbackTimer.bind(f.target.adapter);
  f.target.adapter.armRetryFallbackTimer = (_delay: number, reason: string) => armRetry(5, reason);
  await f.wire.inject([
    event(f.scope, message('fallback-failure', 4, 'fetch failed')),
    event(f.scope, { type: 'agent_end', messages: [], willRetry: true }),
  ]);
  await deadline(new Promise<void>(resolve => {
    const prior = f.targetEvents.length;
    const sink = (item: AgentEvent) => {
      f.targetEvents.push(item);
      if (f.targetEvents.length > prior && (item.type === 'error' || item.type === 'typed_error')) resolve();
    };
    f.target.setBackgroundEventSink(sink);
  }));
  expect(f.target.isProcessing()).toBe(true);
  expect(f.target.eventQueue.isComplete).toBe(false);
  await f.wire.inject([{ ...f.scope, type: 'owner_finished', transactionId: 'tx', outcome: 'error', error: 'callback failed' }]);
  expect(f.targetEvents.filter(item => item.type === 'complete')).toHaveLength(1);
});

test('builds only the target activation config and cancels preparation during credential loading', async () => {
  const target = agent('own-settings');
  target.setThinkingLevel('max');
  const activation = await target.nativeSessionOwner.prepareActivation();
  expect(activation.config.sessionId).toBe('own-settings');
  expect(activation.config.model).toBe('local-model');
  expect(activation.config.thinkingLevel).toBe('max');
  expect(activation.config.codingResources.resourcePolicy).toBe('host-only');
  expect(activation.config.workingDirectory).toBe(target.config.workspace.rootPath);
  expect(activation.systemPrompt).toContain(`<workspace_root>${target.config.workspace.rootPath}</workspace_root>`);
  expect(activation.systemPrompt).toContain('Coding mode');
  expect(activation.tools.some((tool: { name: string }) => tool.name === 'mcp__session__SubmitPlan')).toBe(true);
  expect(target.subprocess).toBeNull();
  const credentials = Promise.withResolvers<undefined>();
  target.getPiAuth = () => credentials.promise;
  const preparing = target.nativeSessionOwner.prepareActivation();
  target.destroy();
  credentials.resolve(undefined);
  await expect(preparing).rejects.toThrow('aborted');
  expect(target.subprocess).toBeNull();
});

test('releases an idle target writer with an acknowledged scoped RPC and rejects busy targets', async () => {
  const target = agent('idle-target');
  await target.ensureSubprocess();
  const wire = observe(target);
  const oldLease: PiWorkerLease = target.workerLease;
  const sent = spyOn(oldLease, 'send');
  await target.nativeSessionOwner.prepareActivation();
  expect(sent.mock.calls.some(([frame]) => frame.type === 'release_owner')).toBe(true);
  expect(target.subprocess).toBeNull();
  expect(oldLease.send({ type: 'abort' })).toBe(false);
  target._isProcessing = true;
  await expect(target.nativeSessionOwner.prepareActivation()).rejects.toThrow('busy');
  target._isProcessing = false;
  expect(wire.child.killed).toBe(false);
});

for (const mode of ['error', 'timeout', 'exit']) test(`rejects owner release on ${mode} and clears pending control timers`, async () => {
  const target = agent('release-' + mode);
  await target.ensureSubprocess();
  const wire = observe(target);
  target.ownerReleaseTimeoutMs = 15;
  wire.command({ type: 'fixture_release_mode', mode });
  const release = target.nativeSessionOwner.releaseForOwner();
  if (mode === 'exit') wire.child.kill('SIGTERM');
  await expect(release).rejects.toThrow(mode === 'error' ? 'fixture release rejected' : mode === 'timeout' ? 'timed out' : 'exited');
  expect(target.pendingOwnerReleases.size).toBe(0);
});

test('acknowledged writer release waits for its final projection receipt', async () => {
  const owner = host();
  const gate = Promise.withResolvers<void>();
  owner.port.onProjection = () => gate.promise;
  const target = agent('projection-gate', owner.port);
  target.config.envOverrides = { FIXTURE_PROJECTION: '1' };
  await target.ensureSubprocess();
  const wire = observe(target);
  let released = false;
  const release = target.nativeSessionOwner.releaseForOwner().then(() => { released = true; });
  await wire.inject([]);
  expect(released).toBe(false);
  gate.resolve();
  await deadline(release);
  expect(target.subprocess).toBeNull();
});

test('acknowledged writer release detaches even when its final projection receipt failed', async () => {
  const owner = host();
  owner.port.onProjection = async () => { throw new Error('fixture projection receipt failed'); };
  const target = agent('projection-failure', owner.port);
  target.config.envOverrides = { FIXTURE_PROJECTION: '1' };
  await target.ensureSubprocess();
  observe(target);
  await expect(target.nativeSessionOwner.releaseForOwner()).rejects.toThrow('fixture projection receipt failed');
  expect(target.subprocess).toBeNull();
});

test('closed writer errors detach the lease while rejected release keeps it available', async () => {
  const target = agent('release-projection-error');
  await target.ensureSubprocess();
  const wire = observe(target);
  const lease: PiWorkerLease = target.workerLease;
  wire.command({ type: 'fixture_release_mode', mode: 'rejected' });
  await expect(target.nativeSessionOwner.releaseForOwner()).rejects.toThrow('fixture writer still active');
  expect(target.subprocess).toBe(wire.child);
  wire.command({ type: 'fixture_release_mode', mode: 'projection-error' });
  await expect(target.nativeSessionOwner.releaseForOwner()).rejects.toThrow('fixture closed writer projection failed');
  expect(target.subprocess).toBeNull();
  expect(lease.send({ type: 'abort' })).toBe(false);
});

test('rejects fabricated tokens and preserves source control until adoption', async () => {
  const source = agent('unbound-source');
  const target = agent('unbound-target');
  await source.ensureSubprocess();
  const wire = observe(source);
  const transfer = await source.nativeSessionOwner.detachForOwner();
  expect(transfer.send({ type: 'owner_abort', transactionId: 'tx', error: 'test' })).toBe(true);
  expect(() => target.nativeSessionOwner.adoptForOwner({ ...transfer }, 'tx')).toThrow('Invalid');
  target.nativeSessionOwner.adoptForOwner(transfer, 'tx');
  expect(transfer.send({ type: 'owner_abort', transactionId: 'tx', error: 'late' })).toBe(false);
  expect(() => target.nativeSessionOwner.adoptForOwner(transfer, 'tx')).toThrow();
  transfer.release();
  expect(wire.child.killed).toBe(false);
});

test('cancels an adopted startup without waiting for target callbacks or killing source retained work', async () => {
  const source = agent('startup-source');
  const target = agent('startup-target');
  await source.ensureSubprocess();
  const wire = observe(source);
  const oldScope = { ownerSessionId: source.workerLease.ownerSessionId, runtimeGeneration: source.workerLease.generation };
  await wire.inject([{ ...oldScope, type: 'background_task_event', event: { type: 'shell_backgrounded', shellId: 'startup-shell' } }]);
  const transfer = await source.nativeSessionOwner.detachForOwner();
  const events: AgentEvent[] = [];
  target.setBackgroundEventSink((item: AgentEvent) => events.push(item));
  target.nativeSessionOwner.adoptForOwner(transfer, 'startup-tx');
  const ready: Promise<void> = target.subprocessReady;
  transfer.release();
  const stopping = target.disposeForRestart();
  await expect(ready).rejects.toThrow('stopped');
  await deadline(stopping);
  expect(events.filter(item => item.type === 'complete')).toHaveLength(1);
  expect(wire.child.exitCode).toBeNull();
  expect(wire.child.killed).toBe(false);
  expect(await source.stopBackgroundTask('startup-shell')).toBe(true);
});

test('cancels a retained stop timeout on its originating lease after the source has a new same-generation worker', async () => {
  const f = await adopted();
  const retainedLease: PiWorkerLease = [...f.source.retainedWorkers.keys()][0];
  f.source.backgroundStopTimeoutMs = 10;
  const oldCancel = spyOn(retainedLease, 'cancelBackgroundStop');
  await f.source.runMiniCompletion('fresh source');
  observe(f.source);
  const currentCancel = spyOn(f.source.workerLease, 'cancelBackgroundStop');
  await expect(f.source.stopBackgroundTask('held-source')).rejects.toThrow('timed out');
  expect(oldCancel).toHaveBeenCalledTimes(1);
  expect(currentCancel).not.toHaveBeenCalled();
  expect(f.source.pendingBackgroundStops.size).toBe(0);
});

test('old physical process loss completes the detached target once and leaves the source replacement worker usable', async () => {
  const f = await adopted();
  await f.source.runMiniCompletion('replacement source');
  const fresh = observe(f.source);
  const pid = fresh.child.pid;
  const exited = new Promise<void>(resolve => f.wire.child.once('close', () => resolve()));
  f.wire.child.kill('SIGTERM');
  await deadline(exited);
  expect(f.targetEvents.filter(item => item.type === 'complete')).toHaveLength(1);
  expect(f.targetHost.exits[0]?.transport).toBe(f.transfer.transport);
  expect(f.sourceHost.exits[0]?.transport).toBe(f.transfer.transport);
  expect(await f.source.runMiniCompletion('source still alive')).toBe(String(pid));
  expect(f.source.subprocess).toBe(fresh.child);
});

test('delivers target permission requests through the detached sink and uses the target permission mode', async () => {
  const f = await adopted();
  f.target.setPermissionMode('ask');
  const legacy = spyOn(f.target, 'onPermissionRequest');
  const send = spyOn(f.target, 'send');
  f.target.setBackgroundEventSink((item: AgentEvent) => {
    f.targetEvents.push(item);
    if (item.type === 'permission_request') f.target.respondToPermission(item.requestId, false);
  });
  await f.wire.inject([{
    ...f.scope, type: 'pre_tool_use_request', requestId: 'target-permission', toolName: 'Bash',
    input: { command: 'git commit -m fixture' },
  }]);
  expect(f.targetEvents.filter(item => item.type === 'permission_request')).toHaveLength(1);
  expect(send.mock.calls.some(([frame]) => !!frame && typeof frame === 'object' && 'type' in frame
    && frame.type === 'pre_tool_use_response' && 'action' in frame && frame.action === 'block')).toBe(true);
  expect(legacy).not.toHaveBeenCalled();
  expect(f.target.pendingPermissions.size).toBe(0);
});
