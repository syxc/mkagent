import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { obj, str, type Schema } from '@earendil-works/pi-schema';
import { resolveReadPath, resolveToCwd } from '@mkagent/pi-durable-coding/compat';
import { BackgroundShells } from '../background-shell.ts';
import { wrapToolForKernel } from './wrap.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'mkagent-path-sdk-'));
  directories.push(cwd);
  const env = new NodeExecutionEnv({ cwd });
  const observed = { checked: undefined as Record<string, unknown> | undefined, memo: undefined as unknown, calls: 0 };
  const api = {
    callId: 'file-fixture', env,
    memo: async (_key: string, value: unknown) => { observed.memo = value; },
  } as unknown as ToolExecutionApi;
  function tool(name: 'read' | 'write' | 'edit', approve = (input: Record<string, unknown>) => input) {
    const registration: ToolRegistration<Schema<{ path: string }>> = {
      name, description: 'Fixture file tool', parameters: obj({ path: str() }),
      execute: async args => {
        observed.calls++;
        return { output: [{ type: 'text', text: String(args.path) }] };
      },
    };
    return wrapToolForKernel(registration, {
      requestApproval: async (_name, input, id) => {
        expect(id).toBe('file-fixture');
        observed.checked = input;
        return approve(input);
      },
      backgroundShells: new BackgroundShells(() => {}), tasksDirectory: cwd, shellEnv: env,
      getContextWindow: () => undefined, summarize: async () => null,
      getUserRequest: () => '', getSessionPath: () => null, debugLog: () => {},
    });
  }
  return { cwd, api, observed, tool };
}

for (const name of ['read', 'write', 'edit'] as const) {
  test(`${name} resolves SDK paths before approval and records the executed path`, async () => {
    const { cwd, api, observed, tool } = fixture();
    const cases = [
      ['@folder/file.txt', join(cwd, 'folder/file.txt')],
      ['@@file.txt', join(cwd, '@file.txt')],
      ['子目录/文件.txt', join(cwd, '子目录/文件.txt')],
      ['folder/../file.txt', join(cwd, 'file.txt')],
      [' file.txt ', join(cwd, ' file.txt ')],
      ['', cwd], ['~', homedir()], ['~/file.txt', join(homedir(), 'file.txt')],
      [pathToFileURL(join(cwd, 'file #1.txt')).href, join(cwd, 'file #1.txt')],
      ...Array.from('              　', space =>
        [`file${space}name.txt`, join(cwd, 'file name.txt')]),
    ];
    for (const [input, expected] of cases) {
      const result = await tool(name).execute({ path: input }, api, BACKGROUND_CONTEXT);
      expect(observed.checked).toEqual({ path: expected, file_path: expected });
      expect(observed.memo).toEqual(observed.checked);
      expect(result.output).toEqual([{ type: 'text', text: expected }]);
    }
    expect(observed.calls).toBe(cases.length);
  });
}

test('read uses macOS filename fallbacks while write and edit keep the requested name', async () => {
  const { cwd, api, observed, tool } = fixture();
  const cases = [
    ['Screenshot 1 PM.png', 'Screenshot 1 PM.png'],
    ["Capture d'écran.txt", 'Capture d’écran.txt'],
    ['café.txt', 'café.txt'],
    ["l'été.txt", 'l’été.txt'],
  ];
  for (const [requested, stored] of cases) {
    const exact = join(cwd, requested!);
    const fallback = join(cwd, stored!);
    writeFileSync(fallback, 'fixture');
    // Some filesystems treat NFC and NFD as the same filename.
    const expected = existsSync(exact) ? exact : existsSync(join(cwd, requested!.replaceAll("'", '’')))
      ? join(cwd, requested!.replaceAll("'", '’')) : fallback;
    expect(resolveReadPath(requested!, cwd)).toBe(expected);
    expect(resolveToCwd(requested!, cwd)).toBe(exact);
    for (const name of ['read', 'write', 'edit'] as const) {
      await tool(name).execute({ path: requested }, api, BACKGROUND_CONTEXT);
      expect(observed.checked?.path).toBe(name === 'read' ? expected : exact);
    }
  }
  const exact = join(cwd, 'Screenshot 1 PM.png');
  writeFileSync(exact, 'exact');
  expect(resolveReadPath('Screenshot 1 PM.png', cwd)).toBe(exact);
  unlinkSync(exact);
  expect(resolveReadPath('Screenshot 1 PM.png', cwd)).toBe(join(cwd, 'Screenshot 1 PM.png'));
});

test('approved path aliases control execution and denied calls have no execution or memo', async () => {
  const { cwd, api, observed, tool } = fixture();
  const approved = join(cwd, 'approved.txt');
  for (const alias of ['path', 'file_path']) {
    const result = await tool('read', input => ({ ...input, [alias]: approved }))
      .execute({ path: '@original.txt' }, api, BACKGROUND_CONTEXT);
    expect(result.output).toEqual([{ type: 'text', text: approved }]);
    expect(observed.memo).toMatchObject({ path: approved });
  }
  observed.memo = undefined;
  await expect(tool('read', () => { throw new Error('denied'); })
    .execute({ path: 'original.txt' }, api, BACKGROUND_CONTEXT)).rejects.toThrow('denied');
  expect(observed.calls).toBe(2);
  expect(observed.memo).toBeUndefined();
});
