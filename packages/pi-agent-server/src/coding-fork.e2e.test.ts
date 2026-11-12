import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRegistry, defineExtension, Harness, type Conversation } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import type { NativeSessionJournal } from '@mkagent/coding-runtime/durable';
import { remapSessionFileReferences } from '@mkagent/shared/sessions';
import { durableFixture } from '../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { DurableKernel } from './kernel.ts';
import { nativeSessionPaths, readNativeSessionDescriptor } from './storage/native-session-projection.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

function native(kernel: DurableKernel) {
  return kernel as unknown as { coding: { journal: NativeSessionJournal }; conversation: Conversation };
}

for (const backend of ['sqlite', 'jsonl']) for (const selection of ['left', 'label', 'empty'] as const) {
  test(`native kernel fork retains the complete tree and files at ${selection} on ${backend}`, async () => {
    const fixture = await durableFixture([]);
    await fixture.harness.close(BACKGROUND_CONTEXT);
    cleanup.push(() => rmSync(fixture.directory, { recursive: true, force: true }));
    const sourcePath = join(fixture.directory, 'source');
    const targetPath = join(fixture.directory, 'target');
    const agentDir = join(fixture.directory, 'agent');
    mkdirSync(agentDir);
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
    const model = { provider: 'faux', modelId: 'local', contextWindow: 100_000 };
    const source = create(sourcePath);
    if (backend === 'jsonl') {
      const storage = await openNodeJsonlStorage(join(sourcePath, 'durable-store'), BACKGROUND_CONTEXT);
      const harness = await Harness.open(storage, { registry: createRegistry(), models: fixture.models }, BACKGROUND_CONTEXT);
      await harness.root(BACKGROUND_CONTEXT);
      await harness.close(BACKGROUND_CONTEXT);
    }
    await source.open({ model });
    mkdirSync(join(sourcePath, 'attachments'));
    const leftFile = join(sourcePath, 'attachments', 'left.txt');
    const rightFile = join(sourcePath, 'attachments', 'right.txt');
    writeFileSync(leftFile, 'left attachment');
    writeFileSync(rightFile, 'right attachment');
    const journal = native(source).coding.journal;
    const manager = journal.manager;
    const user = (content: string) => ({ role: 'user' as const, content, timestamp: 100 });
    const root = manager.appendMessage(user('root'));
    journal.linkMessage(root, 'product-root');
    const left = manager.appendMessage(user(`left ${leftFile}`));
    journal.linkMessage(left, 'product-left');
    const label = manager.appendLabelChange(left, 'left branch');
    manager.branch(root);
    const right = manager.appendMessage(user(`right ${rightFile}`));
    journal.linkMessage(right, 'product-right');
    manager.appendSessionInfo('source name');
    await journal.flush();
    journal.linkMessage(label, 'product-label-after-entry-receipt');
    await journal.flush();
    const before = journal.committedSnapshot();
    const leaf = selection === 'empty' ? null : selection === 'label' ? label : left;
    expect(JSON.stringify((await native(source).conversation.context(BACKGROUND_CONTEXT)).messages)).toContain(rightFile);
    await source.close();
    const sourceStoreFile = join(sourcePath, 'durable-store', backend === 'sqlite' ? 'store.db' : 'main.jsonl');
    const sourceStore = readFileSync(sourceStoreFile);
    const sourceNative = readFileSync(nativeSessionPaths(sourcePath).sessionFile);

    const target = create(targetPath);
    const config = { model, branchFromSessionPath: sourcePath,
      nativeFork: { leaf, source: await readNativeSessionDescriptor(sourcePath) } };
    await target.open(config);
    const fork = native(target).coding.journal;
    const snapshot = fork.committedSnapshot();
    expect(target.sessionId).not.toBe(source.sessionId);
    expect(snapshot.header.id).toBe(target.sessionId);
    expect(snapshot.header.parentSession).toBe(nativeSessionPaths(sourcePath).sessionFile);
    expect(snapshot.leaf).toBe(leaf);
    expect(snapshot.entries).toEqual(remapSessionFileReferences(before.entries, sourcePath, targetPath));
    expect(snapshot.entryIds).toEqual(before.entryIds);
    expect(snapshot.name).toBe('source name');
    expect(fork.manager.getLabel(left)).toBe('left branch');
    expect(readFileSync(join(targetPath, 'attachments', 'left.txt'), 'utf8')).toBe('left attachment');
    expect(readFileSync(join(targetPath, 'attachments', 'right.txt'), 'utf8')).toBe('right attachment');
    const messages = (await native(target).conversation.context(BACKGROUND_CONTEXT)).messages;
    expect(messages).toEqual(fork.manager.buildSessionContext().messages);
    if (leaf === null) expect(messages).toEqual([]);
    else {
      expect(JSON.stringify(messages)).toContain(join(targetPath, 'attachments', 'left.txt'));
      expect(JSON.stringify(messages)).not.toContain('right.txt');
    }
    const targetId = target.sessionId;
    await target.close();
    const reopened = create(targetPath);
    await reopened.open({ model });
    expect(reopened.sessionId).toBe(targetId);
    expect(native(reopened).coding.journal.committedSnapshot()).toEqual(snapshot);
    await reopened.close();
    const nextPath = join(fixture.directory, 'next-target');
    const next = create(nextPath);
    await next.open({ model, branchFromSessionPath: targetPath,
      nativeFork: { leaf: right, source: await readNativeSessionDescriptor(targetPath) } });
    const continued = native(next).coding.journal.committedSnapshot();
    expect(continued.leaf).toBe(right);
    expect(continued.entries).toEqual(remapSessionFileReferences(snapshot.entries, targetPath, nextPath));
    expect(continued.entryIds).toEqual(snapshot.entryIds);
    expect(readFileSync(join(nextPath, 'attachments', 'right.txt'), 'utf8')).toBe('right attachment');
    expect(readFileSync(sourceStoreFile)).toEqual(sourceStore);
    expect(readFileSync(nativeSessionPaths(sourcePath).sessionFile)).toEqual(sourceNative);
    expect(fixture.calls).toHaveLength(0);
  });
}
