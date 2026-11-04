import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createBashTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import type { AgentEvent } from '@mkagent/core/types';
import { BackgroundShells } from '../background-shell';
import { wrapToolForKernel } from './wrap';
import { createCodemodeExtensionFor } from './codemode';

const directories: string[] = [];
const registries: BackgroundShells[] = [];

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const context: Context = {
  abortSignal: new AbortController().signal,
  telemetry: BACKGROUND_CONTEXT.telemetry,
  value: () => undefined,
  toString: () => 'background-timeout-test',
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mkagent background timeout '));
  directories.push(directory);
  const events: AgentEvent[] = [];
  const shells = new BackgroundShells(event => events.push(event));
  registries.push(shells);
  const bash = wrapToolForKernel(createBashTool(), {
    requestApproval: async (_toolName, input) => input,
    backgroundShells: shells,
    tasksDirectory: directory,
    shellEnv: new NodeExecutionEnv({ cwd: directory }),
    getContextWindow: () => undefined,
    summarize: async () => null,
    getUserRequest: () => '',
    getSessionPath: () => null,
    debugLog: () => {},
  });
  return { bash, events };
}

async function eventually(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Background shell condition timed out');
    await Bun.sleep(20);
  }
}

describe('codemode model permissions', () => {
  for (const name of ['pi.codemode.models.classify', 'pi.codemode.models.generateImages']) {
    it(`applies approval changes and blocks denied ${name} calls`, async () => {
      const model = { provider: 'fixture', id: 'model' };
      let calls = 0;
      const models = {
        getModelOfType: () => model,
        classify: async (_model: unknown, input: unknown) => { calls++; return { stopReason: 'stop', answers: {}, received: input }; },
        generateImages: async (_model: unknown, input: unknown) => { calls++; return { stopReason: 'stop', output: [], received: input }; },
      };
      const api = { callId: 'model-call', models } as unknown as ToolExecutionApi;
      const initial = name.endsWith('classify')
        ? { state: { value: 'original' }, questions: { q: { type: 'bool', instructions: 'test', criteria: { true: 'yes', false: 'no' } } } }
        : { input: [{ type: 'text', text: 'original' }] };
      const updated = name.endsWith('classify')
        ? { ...initial, state: { value: 'approved' } }
        : { input: [{ type: 'text', text: 'approved' }] };
      let approvals = 0;
      const allowed = createCodemodeExtensionFor([], async (toolName, args, callId) => {
        expect(toolName).toBe(name);
        expect(callId).toBe('model-call');
        approvals++;
        return { ...args, context: updated };
      }).tools?.find(tool => tool.name === name);
      expect(allowed).toBeDefined();
      const result = await allowed!.execute({ model, context: initial }, api, context);
      expect(approvals).toBe(1);
      expect((result.structuredOutput as { received: unknown }).received).toEqual(updated);

      const denied = createCodemodeExtensionFor([], async () => { throw new Error('denied'); })
        .tools?.find(tool => tool.name === name);
      expect(denied).toBeDefined();
      await expect(denied!.execute({ model, context: initial }, api, context)).rejects.toThrow('denied');
      expect(calls).toBe(1);
    });
  }
});

describe('file tool permissions', () => {
  it('executes a path changed by approval without a stale file_path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mkagent-modified-write-'));
    directories.push(directory);
    const originalPath = join(directory, 'original.txt');
    const approvedPath = join(directory, 'approved.txt');
    const shells = new BackgroundShells(() => {});
    registries.push(shells);
    const env = new NodeExecutionEnv({ cwd: directory });
    const write = wrapToolForKernel(createWriteTool(), {
      requestApproval: async (_toolName, input) => ({ ...input, path: approvedPath }),
      backgroundShells: shells,
      tasksDirectory: directory,
      shellEnv: env,
      getContextWindow: () => undefined,
      summarize: async () => null,
      getUserRequest: () => '',
      getSessionPath: () => null,
      debugLog: () => {},
    });

    const approved = new Map<string, unknown>();
    await write.execute({ path: originalPath, content: 'approved' }, {
      callId: 'write-1', env,
      memo: async (key: string, value: unknown) => { approved.set(key, value); return value; },
    } as unknown as ToolExecutionApi, context);
    expect(readFileSync(approvedPath, 'utf8')).toBe('approved');
    expect(existsSync(originalPath)).toBe(false);
    expect(approved.get('mkagent.tool.approved-arguments')).toEqual({
      path: approvedPath, file_path: originalPath, content: 'approved',
    });
  });

  it('rejects conflicting paths returned by approval', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mkagent-conflicting-write-'));
    directories.push(directory);
    const shells = new BackgroundShells(() => {});
    registries.push(shells);
    const env = new NodeExecutionEnv({ cwd: directory });
    const write = wrapToolForKernel(createWriteTool(), {
      requestApproval: async (_toolName, input) => ({ ...input, path: join(directory, 'first.txt'), file_path: join(directory, 'second.txt') }),
      backgroundShells: shells,
      tasksDirectory: directory,
      shellEnv: env,
      getContextWindow: () => undefined,
      summarize: async () => null,
      getUserRequest: () => '',
      getSessionPath: () => null,
      debugLog: () => {},
    });

    await expect(write.execute({ path: 'original.txt', content: 'approved' }, { callId: 'write-1', env } as unknown as ToolExecutionApi, context))
      .rejects.toThrow('Conflicting approved file paths');
    expect(existsSync(join(directory, 'first.txt'))).toBe(false);
    expect(existsSync(join(directory, 'second.txt'))).toBe(false);
  });

  it('writes the approved path when the host modifies file_path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mkagent-approved-write-'));
    directories.push(directory);
    const originalPath = join(directory, 'original.txt');
    const approvedPath = join(directory, 'approved.txt');
    const shells = new BackgroundShells(() => {});
    registries.push(shells);
    const env = new NodeExecutionEnv({ cwd: directory });
    let checkedPath = '';
    const write = wrapToolForKernel(createWriteTool(), {
      requestApproval: async (_toolName, input) => {
        checkedPath = String(input.file_path);
        return { ...input, file_path: approvedPath };
      },
      backgroundShells: shells,
      tasksDirectory: directory,
      shellEnv: env,
      getContextWindow: () => undefined,
      summarize: async () => null,
      getUserRequest: () => '',
      getSessionPath: () => null,
      debugLog: () => {},
    });

    await write.execute({ path: '@original.txt', content: 'approved' }, { callId: 'write-1', env, memo: async () => undefined } as unknown as ToolExecutionApi, context);
    expect(checkedPath).toBe(originalPath);
    expect(readFileSync(approvedPath, 'utf8')).toBe('approved');
    expect(existsSync(originalPath)).toBe(false);
  });
});

describe('background bash timeout', () => {
  it('honors the timeout instead of running until the command exits', async () => {
    const { bash, events } = fixture();
    await bash.execute(
      { command: 'sleep 30', timeout: 0.2, run_in_background: true },
      { callId: 'call-1', memo: async () => undefined } as unknown as ToolExecutionApi,
      context,
    );

    await eventually(() => events.some(event => event.type === 'task_completed'), 2000);
    const completed = events.find(event => event.type === 'task_completed');
    if (!completed || completed.type !== 'task_completed') throw new Error('No task completion');

    expect(completed.status).toBe('failed');
    expect(readFileSync(completed.outputFile, 'utf8')).toContain('timeout');
  });
});
