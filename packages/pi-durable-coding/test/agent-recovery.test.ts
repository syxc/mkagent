/** Public Agent recovery must work after the owning process is killed. */
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { TaskId } from '@earendil-works/pi-durable';
import { Agent } from '../src/agent-runtime.ts';
import { response } from './fixtures/durable-harness.ts';

const fixture = fileURLToPath(new URL('./fixtures/agent-recovery-process.ts', import.meta.url));

test('an unknown recovery task does not suppress initial transcript persistence', async () => {
  const agent = new Agent({
    initialState: { messages: [{ role: 'user', content: 'initial history', timestamp: 1 }] },
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: response('next answer') }));
      return stream;
    },
  });
  try {
    await agent.resumeDurable(undefined, 999_999 as TaskId);
    assert(agent.state.errorMessage);
    const initialMessage = agent.state.messages[0];
    await agent.prompt('next prompt');
    assert.equal(agent.state.messages[0], initialMessage);
    const backend = await agent.durable.backend();
    const history = await backend.conversation.context(backend.context);
    assert.deepEqual(history.messages.map(message => message.role), ['user', 'user', 'assistant']);
    assert.equal(history.messages[0]?.content, 'initial history');
  } finally { await agent.durable.close(); }
});

async function run(directory: string, phase: 'begin' | 'resume', replay: 'safe' | 'never') {
  return new Promise<string>((resolve, reject) => {
    const runtimeOptions = typeof Bun === 'undefined' ? ['--experimental-transform-types'] : ['--no-env-file'];
    const child = spawn(process.execPath, [...runtimeOptions, fixture, directory, phase, replay], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    let killed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 8_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (phase === 'begin' && !killed && output.includes('TOOL_ENTERED\n')) {
        killed = child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Recovery process timed out: ${phase}\n${output}\n${errors}`));
      else if (phase === 'begin' ? killed && signal === 'SIGKILL' : code === 0) resolve(output);
      else reject(new Error(`Recovery process failed: ${phase}, ${code}, ${signal}\n${output}\n${errors}`));
    });
  });
}

for (const replay of ['safe', 'never'] as const) for (const currentReplay of ['safe', 'never'] as const) {
  test(`reopens a killed Agent with ${replay} intent and ${currentReplay} binding`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-crash-'));
    try {
      await run(directory, 'begin', replay);
      const restored = JSON.parse(await run(directory, 'resume', currentReplay));
      const safe = replay === 'safe' && currentReplay === 'safe';
      expect(restored.resumed).toBe(true);
      expect(restored.secondResume).toBe(false);
      expect(restored.checkpoint).toMatchObject({ status: 'waiting', checkpoint: { phase: 'wait-tools' } });
      expect(restored.requests).toEqual([['system', 'user', 'assistant', 'toolResult']]);
      expect(restored.history.map((message: { role: string }) => message.role))
        .toEqual(['system', 'user', 'assistant', 'toolResult', 'assistant']);
      expect(restored.messages).toEqual(restored.history);
      expect(restored.streaming).toBe(false);
      expect(restored.pending).toBeUndefined();
      expect(restored.reports).toEqual([]);
      expect(restored.events.filter((type: string) => type === 'agent_start')).toEqual(['agent_start']);
      expect(restored.events.filter((type: string) => type === 'agent_end')).toEqual(['agent_end', 'agent_end']);
      expect(await readFile(join(directory, 'effects.txt'), 'utf8'))
        .toBe(safe ? 'begin\nresume\n' : 'begin\n');
      expect(await readFile(join(directory, 'requests.txt'), 'utf8')).toBe('begin\nresume\nresume\n');
      const toolResult = restored.messages.find((message: { role: string }) => message.role === 'toolResult');
      expect(toolResult.isError).toBe(!safe);
      expect(toolResult.content).toEqual([{
        type: 'text', text: safe ? 'safe result'
          : 'Tool fixture was interrupted and may have partially run; it was not executed again',
      }]);
      expect(restored.continued.messages.map((message: { role: string }) => message.role))
        .toEqual(['system', 'user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant']);
      expect(restored.continued.messages).toEqual(restored.continued.history);
      expect(restored.continued.requests).toEqual([
        ['system', 'user', 'assistant', 'toolResult'],
        ['system', 'user', 'assistant', 'toolResult', 'assistant', 'user'],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
}
