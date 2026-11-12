import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  AgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';

const scenario = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), 'case-'));
const settingsManager = SettingsManager.inMemory();
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
});
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir: join(cwd, 'agent'), settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await resourceLoader.reload();
const manager = SessionManager.inMemory(cwd);
const agent = new Agent({ streamFn: () => { throw new Error('No provider call expected'); } });
const session = new AgentSession({ agent, sessionManager: manager, settingsManager,
  cwd, resourceLoader, modelRuntime, baseToolsOverride: {}, initialActiveToolNames: [] });
const output = 'fixture output\n'.repeat(12_000);
const failure = new Error('synthetic execution failure');
const fileError = scenario === 'file-error' || scenario === 'execution-error';
process.env.TMPDIR = fileError ? join(cwd, 'missing') : cwd;
const before = manager.getEntries();
try {
  const run = session.executeBash('fixture', undefined, { operations: {
    async exec(_command, _cwd, { onData, signal }) {
      onData(Buffer.from(output));
      if (scenario === 'execution-error') throw failure;
      if (scenario === 'cancel') {
        session.abortBash();
        assert.equal(signal?.aborted, true);
        throw new Error('synthetic cancellation');
      }
      return { exitCode: 7 };
    },
  } });
  if (fileError) {
    await assert.rejects(run, error => scenario === 'execution-error'
      ? error === failure : (error as NodeJS.ErrnoException).code === 'ENOENT');
    assert.deepEqual(manager.getEntries(), before);
  } else {
    const result = await run;
    assert.equal(result.cancelled, scenario === 'cancel');
    assert.equal(result.exitCode, scenario === 'cancel' ? undefined : 7);
    assert.equal(result.truncated, true);
    assert.equal(readFileSync(result.fullOutputPath!, 'utf8'), output);
    assert.equal(statSync(result.fullOutputPath!).mode & 0o777, 0o600);
    const entry = manager.getLeafEntry();
    assert.equal(entry?.type, 'message');
    assert.equal(entry?.type === 'message' && entry.message.role === 'bashExecution' && entry.message.fullOutputPath, result.fullOutputPath);
  }
  assert.equal(session.isBashRunning, false);
  console.log(JSON.stringify({ scenario, passed: true }));
} finally {
  session.dispose();
}
