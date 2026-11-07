import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRegistry, defineExtension, Harness, type JsonObject } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import type { NativeSessionJournal } from '@mkagent/pi-durable-coding/durable';
import { durableFixture } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { DurableKernel } from './kernel.ts';
import { CodingHost } from './coding-host.ts';
import { nativeSessionPaths, readNativeSessionDescriptor } from './storage/native-session-projection.ts';
import { openDurableStorage } from './storage/durable-storage.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });
const journal = (kernel: DurableKernel) =>
  (kernel as unknown as { coding: { journal: NativeSessionJournal } }).coding.journal;
const model = { provider: 'faux', modelId: 'local', contextWindow: 100_000 };

async function setup(backend: string) {
  const fixture = await durableFixture([]);
  await fixture.harness.close(BACKGROUND_CONTEXT);
  cleanup.push(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const sourcePath = join(fixture.directory, 'source');
  const targetPath = join(fixture.directory, 'target');
  const agentDir = join(fixture.directory, 'agent');
  mkdirSync(agentDir);
  if (backend === 'jsonl') {
    const storage = await openNodeJsonlStorage(join(sourcePath, 'durable-store'), BACKGROUND_CONTEXT);
    const harness = await Harness.open(storage, { registry: createRegistry(), models: fixture.models }, BACKGROUND_CONTEXT);
    await harness.root(BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT);
  }
  const create = (sessionPath: string) => {
    const kernel = new DurableKernel({
      sessionPath, cwd: fixture.directory, modelsSource: () => fixture.models,
      toolsExtension: defineExtension({ name: 'empty' }),
      coding: { agentDir, projectTrusted: true, resourcePolicy: 'host-only' },
      wrapCodingTool: tool => tool,
      hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
        isPrefetchableTool: () => false, debugLog: () => {} },
    });
    cleanup.push(() => kernel.close());
    return kernel;
  };
  const source = create(sourcePath);
  await source.open({ model });
  return { fixture, sourcePath, targetPath, agentDir, source, create };
}

for (const backend of ['sqlite', 'jsonl']) {
  for (const fault of ['stale-store', 'forged-reference', 'conversation-marker', 'reference-path',
    'legacy-target', 'legacy-target-forged-reference']) {
    test(`closed source proof rejects ${fault} before native fork activation on ${backend}`, async () => {
      const { fixture, sourcePath, targetPath, source, create } = await setup(backend);
      const store = journal(source);
      const leaf = store.manager.appendMessage({ role: 'user', content: 'original source', timestamp: 100 });
      await store.flush();
      const conversationId = store.committedSnapshot().conversationId;
      await source.close();
      const reference = await readNativeSessionDescriptor(sourcePath);
      if (fault === 'forged-reference' || fault === 'legacy-target-forged-reference') reference.manifestDigest = '0'.repeat(64);
      else if (fault === 'conversation-marker') {
        writeFileSync(join(sourcePath, 'durable-store', 'conversation-id.txt'), String(conversationId + 1));
      } else if (fault === 'reference-path') {
        reference.sessionFile = nativeSessionPaths(join(fixture.directory, 'different-source')).sessionFile;
      } else if (fault === 'stale-store') {
        const storage = await openDurableStorage(join(sourcePath, 'durable-store'), BACKGROUND_CONTEXT);
        try {
          const record = (await storage.findDocument({ kind: 'mkagent.coding.native-journal',
            scope: { kind: 'conversation', conversationId } }, 'current', BACKGROUND_CONTEXT))!;
          const document = (await storage.document(record.id, 'current', BACKGROUND_CONTEXT))!;
          const value = structuredClone(document.value);
          (value.header as JsonObject).id = 'replaced-native-store';
          await storage.commit([[{ type: 'document.change', id: record.id,
            content: { kind: 'base', version: document.version, value } }]], () => {}, BACKGROUND_CONTEXT);
        } finally { await storage.close(BACKGROUND_CONTEXT); }
      }
      const file = join(sourcePath, 'durable-store', backend === 'sqlite' ? 'store.db' : 'main.jsonl');
      const bytes = readFileSync(file);
      const nativeBytes = readFileSync(nativeSessionPaths(sourcePath).sessionFile);
      const legacyTarget = fault.startsWith('legacy-target');
      const legacyFile = join(targetPath, '.pi-sessions', 'old.jsonl');
      const legacyBytes = JSON.stringify({ type: 'session', version: 3, id: 'legacy-target-native',
        timestamp: new Date(0).toISOString(), cwd: fixture.directory }) + '\n';
      if (legacyTarget) {
        mkdirSync(join(targetPath, '.pi-sessions'), { recursive: true });
        writeFileSync(legacyFile, legacyBytes);
      }
      const startup = spyOn(CodingHost.prototype, 'start');
      cleanup.push(() => { startup.mockRestore(); });
      const target = create(targetPath);
      const config = { model, branchFromSessionPath: sourcePath, nativeFork: { leaf, source: reference } };
      await expect(target.open(config)).rejects.toThrow(legacyTarget ? 'empty target' : 'closed native source');
      expect(existsSync(join(targetPath, 'durable-store'))).toBe(false);
      expect(existsSync(join(targetPath, '.durable-branch-pending'))).toBe(false);
      expect(readFileSync(file)).toEqual(bytes);
      expect(readFileSync(nativeSessionPaths(sourcePath).sessionFile)).toEqual(nativeBytes);
      expect(fixture.calls).toHaveLength(0);
      expect(startup).not.toHaveBeenCalled();
      if (legacyTarget) expect(readFileSync(legacyFile, 'utf8')).toBe(legacyBytes);
    });
  }

  test(`empty native fork survives a cold process SIGKILL on ${backend}`, async () => {
    const { fixture, sourcePath, targetPath, agentDir, source, create } = await setup(backend);
    // A committed empty tree must remain empty, including after the SDK reloads it.
    journal(source).manager.newSession({ id: source.sessionId });
    await journal(source).flush();
    await source.close();
    const target = create(targetPath);
    await target.open({ model, branchFromSessionPath: sourcePath,
      nativeFork: { leaf: null, source: await readNativeSessionDescriptor(sourcePath) } });
    const snapshot = journal(target).committedSnapshot();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.leaf).toBeNull();
    const id = target.sessionId;
    await target.close();
    const spawn = (mode: string) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'fixtures/native-fork-reopen.ts'),
        targetPath, fixture.directory, agentDir, mode], {
        cwd: resolve(import.meta.dir, '../../..'),
        env: { ...process.env, TMPDIR: fixture.directory, TMP: fixture.directory, TEMP: fixture.directory },
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      cleanup.push(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; });
      return child;
    };
    const crashed = spawn('hold');
    const reader = crashed.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('\n')) {
      const part = await reader.read();
      if (part.done) throw new Error(`Cold native fork exited before publishing: ${output}`);
      output += decoder.decode(part.value, { stream: true });
    }
    const expected = { id, snapshot, calls: 0 };
    expect(JSON.parse(output)).toEqual(expected);
    crashed.kill('SIGKILL');
    await crashed.exited;
    reader.releaseLock();
    expect(crashed.signalCode).toBe('SIGKILL');
    expect(await new Response(crashed.stderr).text()).toBe('');
    const recovered = spawn('inspect');
    const [code, stdout, stderr] = await Promise.all([
      recovered.exited, new Response(recovered.stdout).text(), new Response(recovered.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual(expected);
    expect(fixture.calls).toHaveLength(0);
  }, 15_000);

  for (const fault of ['missing-leaf', 'dormant-symlink']) {
    test(`native fork rejects ${fault} without changing its source on ${backend}`, async () => {
      const { fixture, sourcePath, targetPath, source, create } = await setup(backend);
      const store = journal(source);
      const root = store.manager.appendMessage({ role: 'user', content: 'root', timestamp: 100 });
      mkdirSync(join(sourcePath, 'attachments'));
      const dormant = join(sourcePath, 'attachments', 'dormant.txt');
      const outside = join(fixture.directory, 'outside.txt');
      writeFileSync(outside, 'outside session');
      symlinkSync(outside, dormant);
      store.manager.appendMessage({ role: 'user', content: `dormant ${dormant}`, timestamp: 101 });
      store.manager.branch(root);
      await store.flush();
      await source.close();
      const storeFile = join(sourcePath, 'durable-store', backend === 'sqlite' ? 'store.db' : 'main.jsonl');
      const sourceBytes = readFileSync(storeFile);
      const nativeBytes = readFileSync(nativeSessionPaths(sourcePath).sessionFile);
      const target = create(targetPath);
      await expect(target.open({
        model, branchFromSessionPath: sourcePath, nativeFork: { leaf: fault === 'missing-leaf' ? 'absent' : root,
          source: await readNativeSessionDescriptor(sourcePath) },
      })).rejects.toThrow(fault === 'missing-leaf' ? 'not found' : 'symbolic link');
      expect(existsSync(join(targetPath, 'durable-store'))).toBe(false);
      expect(existsSync(join(targetPath, '.durable-branch-pending'))).toBe(false);
      expect(readFileSync(storeFile)).toEqual(sourceBytes);
      expect(readFileSync(nativeSessionPaths(sourcePath).sessionFile)).toEqual(nativeBytes);
      expect(readFileSync(outside, 'utf8')).toBe('outside session');
      expect(fixture.calls).toHaveLength(0);
    });
  }
}
