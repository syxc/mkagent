import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Storage and runners stay independent of the full runtime; the loader maps the Coding SDK.
const sourceRoot = resolve(import.meta.dir, '../src');
const pending = [
  'upstream/core/session-manager.js', 'upstream/core/extensions/runner.js',
  'session-view.ts', 'durable-session-store.ts',
].map(path => resolve(sourceRoot, path));
const checked = new Set<string>();
while (pending.length) {
  const file = pending.pop()!;
  if (checked.has(file)) continue;
  if (!file.startsWith(`${sourceRoot}/`) || /\/(?:runtime-credentials|model-runtime|native|sdk)\.[jt]s$/.test(file)) {
    throw new Error(`Blocked runtime dependency before reading: ${file}`);
  }
  checked.add(file);
  const javascript = new Bun.Transpiler({ loader: file.endsWith('.ts') ? 'ts' : 'js' })
    .transformSync(readFileSync(file, 'utf8'));
  for (const dependency of new Bun.Transpiler({ loader: 'js' }).scanImports(javascript)) {
    if (dependency.path.startsWith('.')) pending.push(resolve(dirname(file), dependency.path));
  }
}

const native = await import('@earendil-works/pi-coding-agent');
const legacy = await import('../src/upstream/core/session-manager.js');
const nativeRunner = await import('../src/pi/core/extensions/runner.ts');
const legacyRunner = await import('../src/upstream/core/extensions/runner.js');
const { createExtensionRuntime } = await import('../src/legacy/extension-loader.ts');
const nativePrompt = await import('../src/pi/core/system-prompt.ts');
const hostPrompt = await import('../src/host-system-prompt.ts');
const { theme: nativeTheme } = await import('@earendil-works/pi-coding-agent');
const { theme: headlessTheme } = await import('../src/headless-ui.ts');

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'shared-sessions-runner-'));
  temporary.push(path);
  return path;
}
const timestamp = '2026-01-01T00:00:00Z';
const user = (content: string) => ({ role: 'user' as const, content, timestamp: 1 });

describe('shared session storage with separate context policies', () => {
  test('shares migration and parsing helpers without loading the model runtime', () => {
    expect(checked.has(resolve(sourceRoot, 'pi/core/session-manager.ts'))).toBe(false);
    expect(checked.has(resolve(sourceRoot, 'pi/core/extensions/runner.ts'))).toBe(true);
    expect(legacy.migrateSessionEntries).toBe(native.migrateSessionEntries);
    expect(legacy.parseSessionEntries).toBe(native.parseSessionEntries);
    expect(legacy.loadEntriesFromFile).toBe(native.loadEntriesFromFile);
    expect(legacy.parseSessionEntries('\ninvalid\n{"type":"session","id":"fixture"}\n')).toHaveLength(1);
  });

  test('keeps native and legacy plain projections and message identities', () => {
    const message = { ...user('original'), hostMessageId: 'fixture', hostUserInput: { content: 'display' } };
    const manager = legacy.SessionManager.inMemory('/isolated');
    const id = manager.appendMessage(message);
    expect(manager).toBeInstanceOf(legacy.SessionManager);
    expect(manager).toBeInstanceOf(native.SessionManager);
    expect(manager.buildSessionContext().messages[0]).toBe(message);
    expect(manager.buildContextEntries()[0]).toBe(manager.getEntry(id));
    expect(legacy.buildSessionProjection(manager.getEntries())).toEqual(native.buildSessionProjection(manager.getEntries()));
    manager.appendContextEdit(id, { content: 'edited' });
    expect(manager.buildSessionContext().messages[0]).toEqual({ ...message, content: 'edited' });
    expect(message.content).toBe('original');
    expect(message.hostUserInput.content).toBe('display');
  });

  test('keeps durable heads separate from the native compaction policy', () => {
    const old = user('old native history');
    const checkpoint = user('durable checkpoint');
    const latest = user('latest');
    const entries = [
      { type: 'message', id: 'old', parentId: null, timestamp, message: old, durableEntryOrder: 1 },
      { type: 'custom', id: 'head', parentId: 'old', timestamp, customType: 'checkpoint',
        durableHead: 3, durableEntryOrder: 2, durableModelMessages: [checkpoint] },
      { type: 'message', id: 'latest', parentId: 'head', timestamp, message: latest, durableEntryOrder: 3 },
    ];
    expect(legacy.buildContextEntries(entries).map(entry => entry.id)).toEqual(['head', 'latest']);
    const projection = legacy.buildSessionProjection(entries);
    expect(projection.messages).toEqual([checkpoint, latest]);
    expect(projection.messages[0]).toBe(checkpoint);
    expect(projection.messages[1]).toBe(latest);
    expect(projection.entries[0].sourceEntry).toBe(entries[1]);
    expect(native.buildSessionProjection(entries).messages).toEqual([old, latest]);
    const manager = legacy.SessionManager.inMemory('/isolated', undefined, entries);
    expect(manager.buildSessionProjection().messages[0]).toBe(checkpoint);
    expect(manager.buildSessionContext()).toEqual(legacy.buildSessionContext(entries));
  });

  test('does not apply folded durable edits twice and previews newer edits from base messages', () => {
    const original = user('original');
    const folded = user('already folded');
    const messages = [folded];
    const entry = { type: 'message', id: 'target', parentId: null, timestamp, message: original,
      durableEntryOrder: 1, durableModelOrder: 5, durableModelMessages: messages, durableBaseMessages: [original] };
    const edit = { type: 'context_edit', id: 'edit', parentId: 'target', timestamp, targetId: 'target',
      durableEntryOrder: 3, replacement: { content: 'stale edit' } };
    expect(legacy.projectContextEntry(entry, edit)).toBe(messages);
    expect(legacy.projectContextEntry(entry, { ...edit, replacement: null })).toBe(messages);
    expect(legacy.projectContextEntry(entry, { ...edit, durableEntryOrder: 6, replacement: { content: 'preview' } }))
      .toEqual([{ ...original, content: 'preview' }]);
    expect(legacy.projectContextEntry(entry, { ...edit, durableEntryOrder: 6, replacement: null })).toEqual([]);
    expect(folded.content).toBe('already folded');
    expect(original.content).toBe('original');
  });

  test('preserves all factory instance types, persisted metadata and native storage defaults', async () => {
    const root = directory();
    const sessionDir = join(root, 'sessions');
    const created = legacy.SessionManager.create(root, sessionDir, { id: 'factory-fixture' });
    created.appendMessage({ ...user('persisted'), hostUserInput: { content: 'display' } });
    const opened = legacy.SessionManager.open(created.getSessionFile());
    const forked = legacy.SessionManager.forkFrom(created.getSessionFile(), root, sessionDir, { id: 'fork-fixture' });
    const direct = new legacy.SessionManager(root, '', undefined, false);
    for (const manager of [created, opened, forked, direct, legacy.SessionManager.inMemory(root)]) {
      expect(manager).toBeInstanceOf(legacy.SessionManager);
      expect(manager).toBeInstanceOf(native.SessionManager);
    }
    expect(opened.getEntries()[0].message.hostUserInput).toEqual({ content: 'display' });
    expect(forked.getHeader().parentSession).toBe(created.getSessionFile());
    expect((await legacy.SessionManager.listAll(sessionDir)).map(session => session.id).sort())
      .toEqual(['factory-fixture', 'fork-fixture']);

    // Exercise inherited factories with a fixture-only explicit directory resolver.
    class FixtureManager extends legacy.SessionManager {
      static getDefaultAgentDir() { return root; }
    }
    const recent = FixtureManager.continueRecent(root, sessionDir);
    expect(recent).toBeInstanceOf(FixtureManager);
    expect(recent).toBeInstanceOf(legacy.SessionManager);
    expect(FixtureManager.findById(root, 'factory-fixture', sessionDir)).toBe(created.getSessionFile());
    expect(await FixtureManager.list(root, sessionDir)).toHaveLength(2);
    expect(native.SessionManager.continueRecent(root, sessionDir)).toBeInstanceOf(native.SessionManager);
    expect(native.SessionManager.create(root, sessionDir)).toBeInstanceOf(native.SessionManager);
    expect(native.SessionManager.open(created.getSessionFile())).toBeInstanceOf(native.SessionManager);
    expect(native.SessionManager.inMemory(root)).toBeInstanceOf(native.SessionManager);
    expect(native.SessionManager.forkFrom(created.getSessionFile(), root, sessionDir)).toBeInstanceOf(native.SessionManager);
  });

  test('retains legacy directory guards and malformed-session error naming', async () => {
    const root = directory();
    const guard = 'The durable coding host must provide agentDir explicitly.';
    expect(() => legacy.SessionManager.create(root)).toThrow(guard);
    expect(() => legacy.getDefaultSessionDir(root)).toThrow(guard);
    expect(() => legacy.SessionManager.continueRecent(root, root)).toThrow(guard);
    expect(() => legacy.SessionManager.findById(root, 'fixture', root)).toThrow(guard);
    expect(() => legacy.SessionManager.inMemory(root).usesDefaultSessionDir()).toThrow(guard);
    await expect(legacy.SessionManager.list(root, root)).rejects.toThrow(guard);
    await expect(legacy.SessionManager.listAll()).rejects.toThrow('Durable owns session storage.');
    const invalid = join(root, 'invalid.jsonl');
    writeFileSync(invalid, '{"type":"invalid"}\n');
    expect(() => legacy.SessionManager.open(invalid)).toThrow('not a valid mkagent session');
    expect(readFileSync(invalid, 'utf8')).toBe('{"type":"invalid"}\n');
    expect(legacy.getDefaultSessionDir(root, root)).toBe(native.getDefaultSessionDir(root, root));
  });

  test('keeps detached factories working and retains the legacy directory guards', async () => {
    const root = directory();
    const { create, open, inMemory, forkFrom, continueRecent, findById, list, listAll } = legacy.SessionManager;
    const created = create(root, root, { id: 'detached' });
    created.appendMessage(user('detached'));
    for (const manager of [created, open(created.getSessionFile()), inMemory(root),
      forkFrom(created.getSessionFile(), root, root)]) {
      expect(manager).toBeInstanceOf(legacy.SessionManager);
    }
    expect(() => continueRecent(root, root)).toThrow('provide agentDir explicitly');
    expect(() => findById(root, 'detached', root)).toThrow('provide agentDir explicitly');
    await expect(list(root, root)).rejects.toThrow('provide agentDir explicitly');
    expect(await listAll(root)).toHaveLength(2);
    await expect(listAll()).rejects.toThrow('Durable owns session storage.');
    const detachedNative = native.SessionManager.inMemory;
    expect(detachedNative(root)).toBeInstanceOf(native.SessionManager);
    const detachedRecent = native.SessionManager.continueRecent;
    expect(detachedRecent(root, root)).toBeInstanceOf(native.SessionManager);
    const detachedListAll = native.SessionManager.listAll;
    expect(await detachedListAll(root)).toHaveLength(2);
  });

  test('migrates historical JSONL through the shared implementation', () => {
    for (const Manager of [native.SessionManager, legacy.SessionManager]) {
      const root = directory();
      const path = join(root, 'v1.jsonl');
      writeFileSync(path, [
        { type: 'session', id: 'old-session', cwd: root, timestamp },
        { type: 'message', timestamp, message: { role: 'hookMessage', customType: 'old', content: 'old hook', display: false, timestamp: 1 } },
        { type: 'message', timestamp, message: { ...user('retained'), hostUserInput: { content: 'display' } } },
        { type: 'compaction', timestamp, summary: 'summary', firstKeptEntryIndex: 2, tokensBefore: 10 },
      ].map(entry => JSON.stringify(entry)).join('\n'));
      const manager = Manager.open(path);
      expect(manager).toBeInstanceOf(Manager);
      expect(manager.getHeader().version).toBe(3);
      const entries = manager.getEntries();
      expect(entries[0].message.role).toBe('custom');
      expect(entries[1].parentId).toBe(entries[0].id);
      expect(entries[2].firstKeptEntryId).toBe(entries[1].id);
      expect(manager.buildSessionContext().messages.at(-1)).toBe(entries[1].message);
      expect(entries[1].message.hostUserInput).toEqual({ content: 'display' });
      expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    }
  });
});

describe('shared extension runner with host dependencies', () => {
  function runnerFor(Runner = Reflect.get(legacyRunner, 'ExtensionRunner'), handlers = new Map()) {
    const runtime = createExtensionRuntime();
    const runner = new Runner([{ path: 'fixture', handlers }], runtime, '/isolated',
      legacy.SessionManager.inMemory('/isolated'), {});
    return { runner, runtime };
  }

  test('keeps headless theme identity and resets UI availability', () => {
    const { runner } = runnerFor();
    expect(runner).toBeInstanceOf(nativeRunner.ExtensionRunner);
    expect(runner).toBeInstanceOf(legacyRunner.ExtensionRunner);
    expect(legacyRunner.emitSessionShutdownEvent).toBe(nativeRunner.emitSessionShutdownEvent);
    expect(runner.hasUI()).toBe(false);
    expect(runner.getUIContext().theme).toBe(headlessTheme);
    expect(() => runner.getUIContext().theme.fg('accent', 'fixture')).toThrow('Pi terminal rendering needs a TUI host.');
    runner.setUIContext({ ...runner.getUIContext(), notify: () => {} });
    expect(runner.hasUI()).toBe(true);
    runner.setUIContext();
    expect(runner.hasUI()).toBe(false);
    expect(runner.getUIContext().theme).toBe(headlessTheme);
    expect(runnerFor(Reflect.get(nativeRunner, 'ExtensionRunner')).runner.getUIContext().theme).toBe(nativeTheme);
  });

  test('keeps host documentation URLs and native prompt defaults distinct', async () => {
    const hostPrompts: string[] = [];
    const nativePrompts: string[] = [];
    const capture = (prompts: string[]) => new Map([['before_agent_start', [
      (event: { systemPrompt: string }, context: { getSystemPrompt(): string }) => {
        prompts.push(event.systemPrompt);
        expect(context.getSystemPrompt()).toBe(event.systemPrompt);
      },
    ]]]);
    const host = runnerFor(undefined, capture(hostPrompts)).runner;
    const original = runnerFor(Reflect.get(nativeRunner, 'ExtensionRunner'), capture(nativePrompts)).runner;
    const options = { cwd: '/isolated', selectedTools: [] };
    await host.emitBeforeAgentStart({ messageType: 'user', prompt: 'fixture' }, options);
    await original.emitBeforeAgentStart({ messageType: 'user', prompt: 'fixture' }, options);
    expect(hostPrompts).toEqual([hostPrompt.buildSystemPrompt(options)]);
    expect(nativePrompts).toEqual([nativePrompt.buildSystemPrompt(options)]);
    expect(hostPrompts[0]).toContain('https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent');
    expect(hostPrompts[0]).not.toBe(nativePrompts[0]);
  });
});
