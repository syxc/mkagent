import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { AbortReason } from '../backend/types.ts';
import * as configStorage from '../../config/storage.ts';
import * as preToolUse from '../core/pre-tool-use.ts';

const agents: PiAgent[] = [];
function makeAgent(): any {
  const agent = new PiAgent({
    provider: 'pi', isHeadless: true,
    workspace: { id: 'pi-compact-test', name: 'Test', rootPath: '/tmp/pi-compact-test' } as any,
  });
  agents.push(agent);
  (agent as any).ensureSubprocess = async () => {};
  return agent;
}
afterEach(() => { for (const agent of agents.splice(0)) agent.destroy(); });
async function collect(stream: AsyncIterable<any>) {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
const result = {
  summary: 'summary', firstKeptEntryId: 'kept', tokensBefore: 419_000,
  estimatedTokensAfter: 12_000,
  contextUsage: { tokens: null, contextWindow: 500_000 },
  compactionSettings: { enabled: true, reserveTokens: 31_000 },
};

describe('Pi manual compaction RPC', () => {
  it('waits for real completion then emits fresh occupancy, one manual success, complete', async () => {
    const agent = makeAgent();
    let finish!: () => void;
    const ready = new Promise<void>(resolve => {
      agent.send = (msg: any) => {
        if (msg.type !== 'compact') return;
        // SDK emits its manual end first; the RPC generator owns notification.
        agent.handleSubprocessEvent({ type: 'compaction_end', reason: 'manual', result, aborted: false });
        finish = () => agent.handleCompactResult({ type: 'compact_result', id: msg.id, success: true, result });
        resolve();
      };
    });
    const events: any[] = [];
    const done = (async () => { for await (const e of agent.chatImpl('/compact')) events.push(e); })();
    await ready;
    expect(events.some(e => e.type === 'info')).toBe(false);
    finish();
    await done;
    expect(events.map(e => e.type)).toEqual(['context_usage', 'info', 'complete']);
    expect(events[0].contextUsage).toMatchObject({ usedTokens: 12_000, limitTokens: 469_000 });
    expect(events[1].compactionTrigger).toBe('manual');
  });

  it('treats an empty successful response as failure, not successful plan acceptance', async () => {
    const agent = makeAgent();
    agent.send = (msg: any) => {
      if (msg.type === 'compact') agent.handleCompactResult({ id: msg.id, success: true });
    };
    const events = await collect(agent.chatImpl('/compact'));
    expect(events[0].type).toBe('compaction_failed');
    expect(events.some(e => e.type === 'info')).toBe(false);
    expect(events.at(-1).type).toBe('complete');
  });

  it('emits compaction_failed before an RPC error and completion', async () => {
    const agent = makeAgent();
    agent.send = (msg: any) => {
      if (msg.type === 'compact') agent.handleCompactResult({ id: msg.id, success: false, errorMessage: 'Summary failed' });
    };
    const events = await collect(agent.chatImpl('/compact'));
    expect(events.map(e => e.type)).toEqual(['compaction_failed', 'error', 'complete']);
  });

  it('host timeout cancels the child compaction and reports the failure (#1060)', async () => {
    const agent = makeAgent();
    agent.compactTimeoutMs = 20;
    const sent: any[] = [];
    agent.send = (msg: any) => { sent.push(msg); };
    const events = await collect(agent.chatImpl('/compact'));
    // The deadline cancels only this compaction, preserving concurrent work.
    expect(sent.map((m) => m.type)).toEqual(['compact', 'cancel_compact']);
    expect(sent[1].id).toBe(sent[0].id);
    expect(agent.pendingCompactions.size).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['compaction_failed', 'error', 'complete']);
    expect(events[1].message).toContain('timed out');
    expect(events[1].message).toContain('cancelled');
    // A late success from the child no longer has a pending request to land on.
    agent.handleCompactResult({ id: sent[0].id, success: true, result });
    expect(agent.pendingCompactions.size).toBe(0);
  });

  it('refuses to steer while a manual compaction owns the turn and reports it in flight (#1058)', async () => {
    const agent = makeAgent();
    const sent: any[] = [];
    let requestId!: string;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    agent.send = (msg: any) => { sent.push(msg); if (msg.type === 'compact') { requestId = msg.id; ready(); } };
    expect(agent.isCompactionInFlight()).toBe(false);
    const done = collect(agent.chatImpl('/compact'));
    await started;
    expect(agent.isCompactionInFlight()).toBe(true);

    expect(agent.redirect('follow-up question')).toBe(false);
    // No steer was sent into a turn with no agent loop, and the compaction was not aborted.
    expect(sent.map((m) => m.type)).toEqual(['compact']);
    expect(agent.pendingCompactions.size).toBe(1);

    agent.handleSubprocessEvent({ type: 'compaction_end', reason: 'manual', result, aborted: false });
    agent.handleCompactResult({ id: requestId, success: true, result });
    const events = await done;
    expect(events.at(-1).type).toBe('complete');
    expect(agent.isCompactionInFlight()).toBe(false);
  });

  it('waits for a stopped subprocess before starting another', async () => {
    const agent = makeAgent();
    const signals: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, pid: 123,
      kill: (signal: string) => { signals.push(signal); return true; },
    });
    const messages: any[] = [];
    agent.subprocess = child;
    agent.send = (message: any) => { messages.push(message); };
    let spawned = false;
    agent.spawnSubprocess = async () => { spawned = true; };
    delete agent.ensureSubprocess;

    await agent.reconnect();
    const starting = agent.ensureSubprocess();
    await Promise.resolve();
    expect(messages).toEqual([{ type: 'shutdown' }]);
    expect(signals).toEqual([]);
    expect(spawned).toBe(false);
    child.emit('exit', 0, null);
    await starting;
    expect(spawned).toBe(true);
  });

  it('shares initialization while credentials are still loading', async () => {
    const agent = makeAgent();
    delete agent.ensureSubprocess;
    let ready!: () => void;
    let spawns = 0;
    agent.spawnSubprocess = async () => {
      spawns++;
      agent.subprocessReady = new Promise<void>((resolve) => { ready = resolve; });
      await agent.subprocessReady;
    };

    const first = agent.ensureSubprocess();
    const second = agent.ensureSubprocess();
    expect(spawns).toBe(1);
    ready();
    await Promise.all([first, second]);
  });

  it.each(['destroy', 'disposeForRestart'])('refuses new requests during %s', async (method) => {
    const agent = makeAgent();
    delete agent.ensureSubprocess;
    const child = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, pid: 123,
      kill: () => true,
    });
    agent.subprocess = child;
    agent.send = () => {};
    let spawns = 0;
    agent.spawnSubprocess = async () => { spawns++; };

    const closing = agent[method]();
    const request = agent.ensureSubprocess().then(() => 'started', (error: Error) => error.message);
    child.emit('exit', 0, null);
    await closing;
    expect(await request).toContain('disposed');
    expect(spawns).toBe(0);
  });

  it('clears pending session requests when reconnect detaches the child', async () => {
    const agent = makeAgent();
    agent.subprocess = Object.assign(new EventEmitter(), {
      exitCode: 0, signalCode: null, pid: 123, kill: () => true,
    });
    const errors: string[] = [];
    for (const name of ['pendingEnsureSessionReady', 'pendingAutoCompactionToggles', 'pendingRuntimeConfigUpdates', 'pendingToolExecutions']) {
      agent[name].set('request', { reject: (error: Error) => { errors.push(error.message); } });
    }
    await agent.reconnect();
    expect(errors).toEqual(Array(4).fill('Pi subprocess stopped'));
  });

  it.each(['success', 'error'])('does not forward an old tool %s response to a replacement child', async (outcome) => {
    const agent = makeAgent();
    const oldChild = Object.assign(new EventEmitter(), {
      exitCode: 0, signalCode: null, pid: 123, kill: () => true,
    });
    const replacement = Object.assign(new EventEmitter(), {
      exitCode: 0, signalCode: null, pid: 456, kill: () => true,
    });
    agent.subprocess = oldChild;
    agent.prerequisiteManager.checkPrerequisites = () => ({ allowed: true });
    let finish!: () => void;
    agent.routeToolCall = () => new Promise((resolve, reject) => {
      finish = () => outcome === 'success'
        ? resolve({ content: 'old tool result', isError: false })
        : reject(new Error('old tool failed'));
    });
    const delivered: any[] = [];
    agent.send = (message: any) => { delivered.push({ child: agent.subprocess, message }); };
    const request = agent.handleToolExecuteRequest({ requestId: 'tool-1', toolName: 'call_llm', args: {} });
    await agent.reconnect();
    agent.subprocess = replacement;
    finish();
    await request;
    expect(delivered).toEqual([]);
  });

  it.each([false, true])('does not forward an old permission response to a replacement child (approved=%s)', async (approved) => {
    const agent = makeAgent();
    const oldChild = Object.assign(new EventEmitter(), {
      exitCode: 0, signalCode: null, pid: 123, kill: () => true,
    });
    const replacement = Object.assign(new EventEmitter(), {
      exitCode: 0, signalCode: null, pid: 456, kill: () => true,
    });
    agent.subprocess = oldChild;
    const delivered: any[] = [];
    agent.send = (message: any) => { delivered.push({ child: agent.subprocess, message }); };
    let permissionId!: string;
    agent.onPermissionRequest = (request: any) => { permissionId = request.requestId; };
    const rtkEnabled = spyOn(configStorage, 'getRtkEnabled').mockReturnValue(false);
    const checks = spyOn(preToolUse, 'runPreToolUseChecks').mockReturnValue({ type: 'prompt', description: 'Approval required' } as any);
    try {
      const request = agent.handlePreToolUseRequest({ requestId: 'pre-tool-1', toolName: 'Bash', input: { command: 'test command' } });
      expect(permissionId).toBeDefined();
      agent.pendingPermissions.get(permissionId).resolve(approved);
      const reconnecting = agent.reconnect();
      agent.subprocess = replacement;
      await reconnecting;
      await request;
      expect(delivered).toEqual([]);
      expect(agent.pendingPermissions.size).toBe(0);
    } finally {
      checks.mockRestore();
      rtkEnabled.mockRestore();
    }
  });

  it('streams delayed responses after failed resume recovery without dropping replacement events', async () => {
    const browserTools = spyOn(configStorage, 'getBrowserToolEnabled').mockReturnValue(false);
    try {
      const agent = makeAgent();
      delete agent.ensureSubprocess;
      agent.piSessionId = 'durable-session';
      agent.clearSessionForRecovery = () => {};
      agent.buildRecoveryContext = () => 'Recovered context\n';
      const oldChild = Object.assign(new EventEmitter(), {
        exitCode: null, signalCode: null, pid: 123, kill: () => true,
      });
      const replacement = Object.assign(new EventEmitter(), {
        exitCode: 0, signalCode: null, pid: 456, kill: () => true,
      });
      let spawns = 0;
      agent.spawnSubprocess = async () => {
        if (++spawns === 1) {
          agent.subprocess = oldChild;
          agent.eventQueue.enqueue({ type: 'error', message: 'Resume failed' });
          throw new Error('Resume failed');
        }
        agent.subprocess = replacement;
        agent.subprocessReady = Promise.resolve();
        agent.eventQueue.enqueue({ type: 'info', message: 'Replacement ready' });
      };
      let shutdown!: () => void;
      const stopping = new Promise<void>((resolve) => { shutdown = resolve; });
      let prompt!: (message: any) => void;
      const prompted = new Promise<any>((resolve) => { prompt = resolve; });
      let concurrentStartup!: Promise<void>;
      agent.send = (message: any) => {
        if (message.type === 'shutdown') {
          concurrentStartup = agent.ensureSubprocess();
          shutdown();
        }
        if (message.type === 'prompt') prompt(message);
      };
      let finished = false;
      const done = collect(agent.chatImpl('Continue')).then((events) => { finished = true; return events; });
      await stopping;
      expect(spawns).toBe(1);
      oldChild.emit('exit', 0, null);
      const sent = await Promise.race([prompted, done]);
      expect(sent).toMatchObject({ type: 'prompt' });
      expect(sent.message).toContain('Recovered context\nContinue');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(finished).toBe(false);

      agent.handleSubprocessEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Recovered reply' } });
      agent.handleSubprocessEvent({ type: 'agent_end' });
      const events = await done;
      await concurrentStartup;
      expect(spawns).toBe(2);
      expect(events.map((event) => event.type)).toEqual(['info', 'text_delta', 'complete']);
      expect(events[0].message).toBe('Replacement ready');
      expect(events[1].text).toBe('Recovered reply');
    } finally {
      browserTools.mockRestore();
    }
  });

  it.each([
    ['stopTurn', 'shutdown'], ['stopTurn', 'startup'],
    ['destroy', 'shutdown'], ['destroy', 'startup'],
  ])('keeps resume recovery cancelled after %s during %s', async (method, phase) => {
    const agent = makeAgent();
    delete agent.ensureSubprocess;
    agent.piSessionId = 'durable-session';
    agent.clearSessionForRecovery = () => {};
    agent.buildRecoveryContext = () => '';
    const oldChild = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, pid: 123, kill: () => true,
    });
    const replacement = Object.assign(new EventEmitter(), {
      exitCode: 0, signalCode: null, pid: 456, kill: () => true,
    });
    let shutdown!: () => void;
    const stopping = new Promise<void>((resolve) => { shutdown = resolve; });
    let started!: () => void;
    const starting = new Promise<void>((resolve) => { started = resolve; });
    let ready!: () => void;
    let spawns = 0;
    agent.spawnSubprocess = async () => {
      if (++spawns === 1) {
        agent.subprocess = oldChild;
        throw new Error('Resume failed');
      }
      agent.subprocess = replacement;
      await new Promise<void>((resolve) => { ready = resolve; started(); });
    };
    const prompts: any[] = [];
    agent.send = (message: any) => {
      if (message.type === 'shutdown') shutdown();
      if (message.type === 'prompt') prompts.push(message);
    };
    const done = collect(agent.chatImpl('Continue'));
    await stopping;
    if (phase === 'startup') {
      oldChild.emit('exit', 0, null);
      await starting;
    }
    agent[method]();
    if (phase === 'shutdown') oldChild.emit('exit', 0, null);
    else ready();
    await done;
    expect(spawns).toBe(phase === 'shutdown' ? 1 : 2);
    expect(prompts).toEqual([]);
    expect(agent.eventQueue.isComplete).toBe(true);
  });

  it('preserves the session when shutdown interrupts resume initialization', async () => {
    const agent = makeAgent();
    agent.piSessionId = 'durable-session';
    let fail!: () => void;
    agent.ensureSubprocess = () => new Promise((_, reject) => { fail = () => reject(new Error('Pi subprocess stopped')); });
    let recovered = false;
    agent.clearSessionForRecovery = () => { recovered = true; };
    agent.buildRecoveryContext = () => '';
    const done = collect(agent.chatImpl('/compact'));
    agent.destroy();
    fail();
    await done;
    expect(recovered).toBe(false);
    expect(agent.piSessionId).toBe('durable-session');
  });

  it('does not spawn after cancellation interrupts credential loading', async () => {
    const agent = makeAgent();
    delete agent.ensureSubprocess;
    agent.config.runtime = { paths: { piServer: '/unused/pi-agent-server.js' } };
    let release!: () => void;
    agent.getPiAuth = () => new Promise((resolve) => { release = () => resolve(null); });
    let legacyLookups = 0;
    agent.getApiKey = async () => { legacyLookups++; return null; };
    const starting = agent.ensureSubprocess().then(() => 'started', (error: Error) => error.message);
    agent.destroy();
    release();
    expect(await starting).toContain('aborted');
    expect(agent.subprocess).toBeNull();
    expect(legacyLookups).toBe(0);
  });

  it.each(['exit', 'close'])('handles a synchronous shutdown %s before releasing restart requests', async (event) => {
    const agent = makeAgent();
    delete agent.ensureSubprocess;
    const child = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, pid: 123, kill: () => true,
    });
    agent.subprocess = child;
    agent.send = () => { child.emit(event, 0, null); };
    let spawned = false;
    agent.spawnSubprocess = async () => { spawned = true; };
    await agent.reconnect();
    await agent.ensureSubprocess();
    expect(spawned).toBe(true);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('continues shutdown escalation when SIGTERM throws', async () => {
    const agent = makeAgent();
    const signals: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, pid: 123,
      kill: (signal: string) => {
        signals.push(signal);
        if (signal === 'SIGTERM') throw new Error('signal denied');
        child.emit('exit', null, signal);
        return true;
      },
    });
    agent.subprocess = child;
    agent.send = () => {};
    const nativeSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void) => nativeSetTimeout(callback, 1)) as typeof setTimeout);
    try {
      await agent.killSubprocessGracefully(1);
    } finally {
      timer.mockRestore();
    }
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(agent.subprocessStopping).toBeNull();
  });

  it('keeps restart blocked after signals fail until the child actually exits', async () => {
    const agent = makeAgent();
    delete agent.ensureSubprocess;
    const child = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, pid: 123, kill: () => false,
    });
    agent.subprocess = child;
    agent.send = () => {};
    agent.spawnSubprocess = async () => {};
    const nativeSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void) => nativeSetTimeout(callback, 1)) as typeof setTimeout);
    try {
      await expect(agent.killSubprocessGracefully(1)).rejects.toThrow('timed out');
      await expect(agent.ensureSubprocess()).rejects.toThrow('did not exit');
      child.emit('exit', 0, null);
      await agent.ensureSubprocess();
    } finally {
      timer.mockRestore();
    }
  });

  it.each(['runMiniCompletion', 'queryLlm'])('does not send a late %s request after reconnect during OAuth refresh', async (method) => {
    const agent = makeAgent();
    const oldChild = Object.assign(new EventEmitter(), {
      exitCode: 0, signalCode: null, pid: 123, kill: () => true,
    });
    agent.subprocess = oldChild;
    let refreshing!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { refreshing = resolve; });
    let finish!: () => void;
    agent.pushLatestOAuthCredential = () => new Promise<void>((resolve) => { finish = resolve; refreshing(); });
    const messages: any[] = [];
    agent.send = (message: any) => { messages.push(message); };
    const request = agent[method](method === 'queryLlm' ? { prompt: 'test' } : 'test').then(() => 'sent', (error: Error) => error.message);
    await refreshStarted;
    await agent.reconnect();
    agent.subprocess = Object.assign(new EventEmitter(), {
      exitCode: 0, signalCode: null, pid: 456, kill: () => true,
    });
    finish();
    expect(await request).toContain('stopped');
    expect(messages).toEqual([]);
    expect(agent.pendingMiniCompletions.size).toBe(0);
    expect(agent.pendingLlmQueries.size).toBe(0);
  });

  it('shares a real startup until session tools are registered', async () => {
    const agent = makeAgent();
    delete agent.ensureSubprocess;
    const root = mkdtempSync(join(tmpdir(), 'pi-startup-wire-'));
    const receivedPath = join(root, 'received.json');
    const script = `
      const readline = require('node:readline').createInterface({ input: process.stdin });
      const received = [];
      readline.on('line', (line) => {
        const message = JSON.parse(line);
        received.push(message.type);
        require('node:fs').writeFileSync(${JSON.stringify(receivedPath)}, JSON.stringify(received));
        if (message.type === 'init') console.log(JSON.stringify({ type: 'ready' }));
        if (message.type === 'set_auto_compaction') console.log(JSON.stringify({ type: 'set_auto_compaction_result', id: message.id, success: true, enabled: true }));
        if (message.type === 'shutdown') process.exit(0);
      });
    `;
    agent.config.runtime = { paths: { piServer: `--eval=${script}`, node: process.execPath } };
    agent.resolvedCwd = () => '/tmp';
    let release!: () => void;
    let lookups = 0;
    agent.getPiAuth = () => { lookups++; return new Promise((resolve) => { release = () => resolve(null); }); };
    agent.getApiKey = async () => null;
    const first = agent.ensureSubprocess();
    const second = agent.ensureSubprocess();
    expect(lookups).toBe(1);
    const browserEnabled = spyOn(configStorage, 'getBrowserToolEnabled').mockReturnValue(false);
    try {
      release();
      await Promise.all([first, second]);
      // Scoped startup controls use their captured lease; inspect the actual wire.
      expect(JSON.parse(readFileSync(receivedPath, 'utf8'))).toEqual(['init', 'register_tools', 'set_auto_compaction']);
    } finally {
      browserEnabled.mockRestore();
      await agent.disposeForRestart();
      rmSync(root, { recursive: true, force: true });
    }
    expect(agent.subprocessStopping).toBeNull();
  });

  it('rejects readiness when a real child fails to spawn', async () => {
    const agent = makeAgent();
    delete agent.ensureSubprocess;
    agent.config.runtime = { paths: { piServer: '/unused/pi-agent-server.js', node: '/nonexistent/pi-agent-node' } };
    agent.resolvedCwd = () => '/tmp';
    agent.getPiAuth = async () => null;
    agent.getApiKey = async () => null;
    agent.send = () => {};
    await expect(agent.ensureSubprocess()).rejects.toThrow();
    if (agent.subprocessStopping) expect(await agent.subprocessStopping).toBe(true);
    expect(agent.subprocess).toBeNull();
  });

  it('rejects readiness when a real child exits before initialization', async () => {
    const agent = makeAgent();
    delete agent.ensureSubprocess;
    agent.config.runtime = { paths: { piServer: '--eval', node: process.execPath } };
    agent.resolvedCwd = () => '/tmp';
    agent.getPiAuth = async () => null;
    agent.getApiKey = async () => null;
    agent.send = () => {};
    await expect(agent.ensureSubprocess()).rejects.toThrow('exited before ready');
    expect(agent.subprocess).toBeNull();
  });

  it('lets the subprocess finish shutdown before escalating a runtime restart', async () => {
    const agent = makeAgent();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, pid: 123,
      kill: (signal: string) => { signals.push(signal); return true; },
    });
    const signals: string[] = [];
    const messages: any[] = [];
    agent.subprocess = child;
    agent.send = (message: any) => {
      messages.push(message);
      if (message.type === 'shutdown') setTimeout(() => child.emit('exit', 0, null), 10);
    };

    await agent.disposeForRestart();
    expect(messages).toEqual([{ type: 'shutdown' }]);
    expect(signals).toEqual([]);
  });

  it.each(['abort', 'forceAbort', 'destroy'])('cancels pending manual RPC on %s and ignores its late success', async (method) => {
    const agent = makeAgent();
    let requestId!: string;
    let ready!: () => void;
    const sent = new Promise<void>(resolve => { ready = resolve; });
    agent.send = (msg: any) => { if (msg.type === 'compact') { requestId = msg.id; ready(); } };
    const done = collect(agent.chatImpl('/compact'));
    await sent;
    if (method === 'forceAbort') agent.forceAbort(AbortReason.UserStop);
    else await agent[method]();
    expect(agent.pendingCompactions.size).toBe(0);
    agent.handleCompactResult({ id: requestId, success: true, result });
    const events = await done;
    expect(events[0].type).toBe('compaction_failed');
    expect(events.some(e => e.type === 'info' || e.type === 'context_usage')).toBe(false);
  });
});
