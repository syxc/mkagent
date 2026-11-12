/** Session defaults must use host factories without replacing SDK lifecycle behavior. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  AgentSession as SDKSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, createAllToolDefinitions, createEditTool, createWriteTool,
  type AgentSessionConfig, type BashOperations,
} from '@earendil-works/pi-coding-agent';
import { Agent } from '../src/durable-agent.ts';
import { AgentSession as NativeSession } from '../src/native-agent-session.ts';
import { createEditTool as createNativeEditTool } from '../src/native-tools.ts';
import { createLocalBashOperations } from '../src/native-shell-tools.ts';

const fixtures: Array<{ session: SDKSession; cwd: string }> = [];
afterEach(() => {
  for (const { session, cwd } of fixtures.splice(0)) {
    session.dispose();
    const cleanup = Bun.spawnSync(['/usr/bin/trash', cwd]);
    if (cleanup.exitCode !== 0) console.warn(`Temporary fixture retained: ${cwd}`);
  }
});

async function fixture(overrides: Partial<Omit<AgentSessionConfig, 'agent'>> = {}, native = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'coding-session-tool-bindings-'));
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    shellPath: '/bin/bash', shellCommandPrefix: 'export CODING_FIXTURE=bound',
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: join(cwd, 'agent'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const agent = new Agent({ streamFn: () => { throw new Error('No provider call expected'); } });
  const sessionManager = SessionManager.inMemory(cwd);
  const config = { agent, cwd, settingsManager, resourceLoader, modelRuntime, sessionManager, ...overrides };
  const session = native ? new NativeSession(config) : new SDKSession(config);
  fixtures.push({ session, cwd });
  return { session, agent, cwd, sessionManager, settingsManager };
}

test('SDK default tool injection is instance-local and survives runtime reload', async () => {
  const calls: Array<{ cwd: string; options: unknown }> = [];
  const { session, agent, cwd } = await fixture({
    createAllToolDefinitions: (cwd, options) => {
      calls.push({ cwd, options });
      return createAllToolDefinitions(cwd, options);
    },
  });
  expect(calls).toEqual([{ cwd, options: {
    read: { autoResizeImages: true },
    bash: { commandPrefix: 'export CODING_FIXTURE=bound', shellPath: '/bin/bash' },
  } }]);
  expect(agent.state.tools.map(tool => tool.name)).toEqual(['read', 'bash', 'edit', 'write']);
  const defaults = await fixture();
  expect(defaults.agent.state.tools.find(tool => tool.name === 'edit')?.prepareArguments)
    .toBe(createEditTool(cwd).prepareArguments);
  expect(calls).toHaveLength(1);
  await session.reload();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
});

test('explicit base tools bypass default factories during construction and reload', async () => {
  const calls: string[] = [];
  const tool = { ...createWriteTool('/fixture'), execute: async (id: string) => {
    calls.push(id);
    return { content: [{ type: 'text' as const, text: 'explicit tool' }], details: {} };
  } };
  const { session, agent } = await fixture({
    baseToolsOverride: { write: tool },
    createAllToolDefinitions: () => { throw new Error('Default factory must not run'); },
  });
  expect(agent.state.tools.map(tool => tool.name)).toEqual(['write']);
  expect(await agent.state.tools[0].execute('before', { path: 'fixture', content: 'test' }))
    .toMatchObject({ content: [{ type: 'text', text: 'explicit tool' }] });
  await session.reload();
  expect(agent.state.tools.map(tool => tool.name)).toEqual(['write']);
  expect(await agent.state.tools[0].execute('after', { path: 'fixture', content: 'test' }))
    .toMatchObject({ content: [{ type: 'text', text: 'explicit tool' }] });
  expect(calls).toEqual(['before', 'after']);
});

test('injected Bash operations preserve settings, chunks and history; explicit operations take precedence', async () => {
  const factories: unknown[] = [], commands: string[] = [], chunks: string[] = [];
  const operations: BashOperations = { async exec(command, cwd, { onData, signal }) {
    commands.push(command);
    expect(cwd).toBe(value.cwd);
    expect(signal?.aborted).toBe(false);
    onData(Buffer.from('\x1b[31mbound\x1b[0m\n'));
    return { exitCode: 7 };
  } };
  const value = await fixture({ createLocalBashOperations: options => { factories.push(options); return operations; } });
  const events: string[] = [];
  value.session.subscribe(event => events.push(event.type));
  const result = await value.session.executeBash('fixture', chunk => chunks.push(chunk), {
    id: 'bound', excludeFromContext: true,
  });
  expect(factories).toEqual([{ shellPath: '/bin/bash' }]);
  expect(commands).toEqual(['export CODING_FIXTURE=bound\nfixture']);
  expect(result).toMatchObject({ output: 'bound\n', exitCode: 7, cancelled: false });
  expect(chunks.join('')).toBe('bound\n');
  expect(events).toContain('bash_execution_update');
  expect(value.sessionManager.getLeafEntry()).toMatchObject({ type: 'message', message: {
    role: 'bashExecution', command: 'fixture', output: 'bound\n', exitCode: 7, excludeFromContext: true,
  } });
  const custom = await value.session.executeBash('custom', undefined, { operations: {
    async exec(_command, _cwd, { onData }) { onData(Buffer.from('explicit')); return { exitCode: 0 }; },
  } });
  expect(custom.output).toBe('explicit');
  expect(factories).toHaveLength(1);
  expect(value.session.isBashRunning).toBe(false);
});

test('default Bash injection retains cancellation and failure cleanup without a phantom history entry', async () => {
  let cancel = true;
  const failure = new Error('fixture execution failed');
  const { session, sessionManager } = await fixture({ createLocalBashOperations: () => ({
    async exec(_command, _cwd, { onData, signal }) {
      expect(session.isBashRunning).toBe(true);
      if (!cancel) throw failure;
      onData(Buffer.from('partial'));
      session.abortBash();
      expect(signal?.aborted).toBe(true);
      throw new Error('fixture cancellation');
    },
  }) });
  const result = await session.executeBash('cancel');
  expect(result).toMatchObject({ output: 'partial', cancelled: true, exitCode: undefined });
  expect(session.isBashRunning).toBe(false);
  cancel = false;
  const before = sessionManager.getEntries();
  await expect(session.executeBash('failure')).rejects.toBe(failure);
  expect(sessionManager.getEntries()).toEqual(before);
  expect(session.isBashRunning).toBe(false);
});

test('Native session defaults bind durable edit and shell policies while SDK defaults stay separate', async () => {
  const { session, agent, cwd, sessionManager } = await fixture({}, true);
  const edit = agent.state.tools.find(tool => tool.name === 'edit')!;
  expect(edit.prepareArguments).toBe(createNativeEditTool(cwd).prepareArguments);
  expect(edit.prepareArguments).not.toBe(createEditTool(cwd).prepareArguments);
  expect(Reflect.get(session, '_createLocalBashOperations')).toBe(createLocalBashOperations);
  const result = await session.executeBash('printf "%s" "$CODING_FIXTURE"');
  expect(result).toMatchObject({ output: 'bound', exitCode: 0, cancelled: false });
  expect(sessionManager.getLeafEntry()).toMatchObject({ type: 'message', message: {
    role: 'bashExecution', command: 'printf "%s" "$CODING_FIXTURE"', output: 'bound',
  } });
  await session.reload();
  expect(agent.state.tools.find(tool => tool.name === 'edit')?.prepareArguments).toBe(edit.prepareArguments);
});
