/**
 * Regenerate with an isolated checkout of MkAgent 81c7c55 and its 1.4.0 dependencies:
 * bun generate.ts /absolute/path/to/old-checkout
 * All output contains synthetic data; no model or scheduler is started.
 * The sqlite and jsonl output directories must be empty before regeneration.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass an absolute path to a 1.4.0 checkout');
for (const backend of ['sqlite', 'jsonl']) {
  const target = join(import.meta.dir, backend);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`Fixture output must be empty: ${target}`);
}
const oldRoot = resolve(process.argv[2]);
const load = (name: string) => import(pathToFileURL(Bun.resolveSync(name, join(oldRoot, 'packages/pi-agent-server'))).href);
const { version } = await load('@earendil-works/pi-durable/package.json');
if (version !== '1.4.0') throw new Error(`Expected pi-durable 1.4.0, got ${version}`);
const { Harness, createRegistry, GenerationTask, ToolTask, CompactionTask, LiveDoc } = await load('@earendil-works/pi-durable');
const { BACKGROUND_CONTEXT: context } = await load('@earendil-works/chord/context');
const { openNodeJsonlStorage } = await load('@earendil-works/pi-durable/storage/jsonl/node');
const { openDurableStorage } = await import(pathToFileURL(join(oldRoot, 'packages/pi-agent-server/src/storage/durable-storage.ts')).href);
const { migrateLegacySession } = await import(pathToFileURL(join(oldRoot, 'packages/pi-agent-server/src/migrate.ts')).href);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: unknown[]) => ({
  role: 'assistant', content, api: 'faux', provider: 'faux', model: 'old-fixture',
  usage, stopReason: 'stop', timestamp: 1,
});
const legacy = [
  { type: 'session', version: 3, id: 'synthetic-upgrade' },
  { type: 'message', id: 'm1', message: { role: 'user', content: 'old prompt', timestamp: 1 } },
  { type: 'message', id: 'm2', message: assistant([{ type: 'text', text: 'old answer' }]) },
  { type: 'message', id: 'm3', message: { role: 'user', content: 'before edit', timestamp: 2 } },
  { type: 'context_edit', id: 'e1', targetId: 'm3', replacement: { content: 'after edit' } },
  { type: 'compaction', id: 'c1', summary: '1.4.0 summary', firstKeptEntryId: 'm2' },
  { type: 'message', id: 'm4', message: { role: 'user', content: 'retained root', timestamp: 3 } },
];
writeFileSync(join(import.meta.dir, 'legacy.jsonl'), legacy.map(line => JSON.stringify(line)).join('\n') + '\n');

for (const backend of ['sqlite', 'jsonl']) {
  const session = mkdtempSync(join(tmpdir(), 'durable-140-generator-'));
  const target = join(import.meta.dir, backend);
  mkdirSync(target, { recursive: true });
  mkdirSync(join(session, '.pi-sessions'));
  writeFileSync(join(session, '.pi-sessions', 'fixture.jsonl'), legacy.map(line => JSON.stringify(line)).join('\n') + '\n');
  const storage = await (backend === 'jsonl' ? openNodeJsonlStorage(target, context) : openDurableStorage(target, context));
  // Migration writes its id-map sidecar next to the session; the store itself is the fixture target.
  mkdirSync(join(session, 'durable-store'));
  const harness = await Harness.open(storage, {
    models: () => { throw new Error('Fixture must not call a model'); }, registry: createRegistry(),
  }, context);
  try {
    await migrateLegacySession(harness, session, () => {});
    const root = await harness.root(context);
    const idMap = JSON.parse(readFileSync(join(session, 'durable-store', 'id-map.json'), 'utf8'));
    const ids = await root.commit(async (tx: any) => {
      const child = await tx.forkConversation(root.id, idMap.m4, { ownership: { kind: 'ownerless' } });
      const childEntry = await tx.appendEntry(child.id, { kind: 'pi.user', model: [{ role: 'user', content: 'child history', timestamp: 4 }] });
      const call = await tx.appendEntry(root.id, { kind: 'pi.assistant', model: [assistant([{ type: 'toolCall', id: 'old-call', name: 'fixture-tool', arguments: {} }])] });
      const generation = await tx.createTask(GenerationTask, {}, { conversationId: root.id, ownership: { kind: 'conversation' } });
      const tool = await tx.createTask(ToolTask, { kind: 'model', assistant: call.id, callId: 'old-call' }, { conversationId: root.id, ownership: { kind: 'conversation' } });
      const compaction = await tx.createTask(CompactionTask, { reason: 'threshold' }, { conversationId: root.id, ownership: { kind: 'conversation' }, background: true });
      const live = await tx.doc(LiveDoc, root.id);
      live.run = { taskId: generation, inputs: [] };
      live.compactions = [{ taskId: compaction, reason: 'threshold', blocking: false, attempt: 1 }];
      live.compactionFailure = { taskId: compaction, reason: 'manual', error: 'old fixture failure' };
      return { root: root.id, child: child.id, childEntry: childEntry.id, generation, tool, compaction };
    }, context);
    const grandchild = await harness.commit(async (tx: any) => {
      const conversation = await tx.forkConversation(ids.child, ids.childEntry, { ownership: { kind: 'ownerless' } });
      await tx.appendEntry(conversation.id, { kind: 'pi.user', model: [{ role: 'user', content: 'grandchild history', timestamp: 5 }] });
      return conversation.id;
    }, context);
    const rootContext = await root.context(context);
    writeFileSync(join(target, 'expected.json'), JSON.stringify({ sdk: version, mkagent: '81c7c55359eb4b8e56625da845ea24d7dfce8a3d', ids: { ...ids, grandchild }, idMap, rootMessages: rootContext.messages }, null, 2) + '\n');
  } finally {
    await harness.close(context);
    rmSync(session, { recursive: true, force: true });
  }
}
