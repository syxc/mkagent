/** OSC payload must not enter streamed text, history, or output files. */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  AgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  truncateTail,
} from '@earendil-works/pi-coding-agent';

// Inspect the patched internal helper without adding a production SDK export.
const { splitIncompleteAnsiSuffix, stripAnsi } = await import(
  new URL('./utils/ansi.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);

const directory = await mkdtemp(join(tmpdir(), 'coding-bash-ansi-'));
afterAll(() => rm(directory, { recursive: true, force: true }));

async function execute(chunks: string[], expected: string, cancel = false) {
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory, agentDir: join(directory, 'agent'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const manager = SessionManager.inMemory(directory);
  const agent = new Agent({ streamFn: () => { throw new Error('No provider call expected'); } });
  const session = new AgentSession({ agent, sessionManager: manager, settingsManager,
    cwd: directory, resourceLoader, modelRuntime, baseToolsOverride: {}, initialActiveToolNames: [] });
  const streamed: string[] = [];
  try {
    const result = await session.executeBash('fixture', text => streamed.push(text), { operations: {
      async exec(_command, _cwd, { onData }) {
        for (const chunk of chunks) onData(Buffer.from(chunk));
        if (cancel) {
          session.abortBash();
          throw new Error('synthetic cancellation');
        }
        return { exitCode: 3 };
      },
    } });
    expect(streamed.join('')).toBe(expected);
    const truncated = truncateTail(expected);
    expect(result.output).toBe(truncated.content);
    expect(result.truncated).toBe(truncated.truncated);
    expect(result.cancelled).toBe(cancel);
    expect(result.exitCode).toBe(cancel ? undefined : 3);
    const entry = manager.getLeafEntry();
    expect(entry?.type === 'message' && entry.message.role === 'bashExecution' && entry.message.output).toBe(result.output);
    if (truncated.truncated) expect(result.fullOutputPath).toBeString();
    if (result.fullOutputPath) {
      expect(await readFile(result.fullOutputPath, 'utf8')).toBe(expected);
      await rm(result.fullOutputPath);
    }
    expect(session.isBashRunning).toBe(false);
  } finally {
    session.dispose();
  }
}

for (const [name, terminator] of [['BEL', '\x07'], ['ST', '\x1b\\'], ['C1 ST', '\x9c']]) {
  test(`SDK Bash strips long split OSC terminated by ${name}`, async () => {
    for (const length of [256, 257, 4096]) {
      await execute(['A\x1b]8;;' + 'x'.repeat(length - 5), terminator + 'Z'], 'AZ');
    }
  });
}

test('SDK Bash preserves a split ST and adjacent OSC sequences', async () => {
  await execute(['A\x1b]8;;' + 'x'.repeat(4096) + '\x1b', '\\Z\x1b]0;title\x07!'], 'AZ!');
});

test('SDK Bash strips nested OSC text and saves only visible spill output', async () => {
  const visible = 'visible\n'.repeat(10_000);
  await execute([visible + '\x1b]8;;' + 'x'.repeat(300) + '\x1b]nested', 'payload\x07Z'], visible + 'Z');
});

for (const cancel of [false, true]) {
  test(`SDK Bash discards unfinished OSC on ${cancel ? 'cancellation' : 'completion'}`, async () => {
    for (const length of [32, 4096]) {
      await execute(['A\x1b]8;;' + 'x'.repeat(length), 'still metadata'], 'A', cancel);
    }
  });
}

test('SDK Bash preserves visible Unicode and split CSI stripping', async () => {
  await execute(['A\x1b[3', '1m中文\x1b[0m\r\nZ'], 'A中文\nZ');
});

test('SDK ANSI keeps bounded pending state for multi-chunk OSC payload', () => {
  let pending = '';
  let complete = '';
  for (const chunk of ['A\x1b]8;;', ...Array<string>(64).fill('x'.repeat(16_384)), '\x1b', '\\Z']) {
    const next = splitIncompleteAnsiSuffix(pending + chunk);
    pending = next.pending;
    complete += next.complete;
    expect(pending.length).toBeLessThanOrEqual(256);
    expect(next.complete).not.toContain('x');
  }
  expect(pending).toBe('');
  expect(stripAnsi(complete)).toBe('AZ');
});
