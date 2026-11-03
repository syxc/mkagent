/** Discard a copied execution queue without invoking task code or enabling a Harness scheduler. */
import { InboxDoc, LiveDoc, type Cursor, type Page, type Storage, type StorageWrite } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await scan(cursor);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

export async function discardInheritedWork(storage: Storage): Promise<void> {
  const writes: StorageWrite[] = [];
  const endedAt = Date.now();
  for (const status of ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const) {
    const tasks = await scanAll(cursor => storage.scanTasks({ status }, 256, cursor, BACKGROUND_CONTEXT));
    for (const task of tasks) {
      // Match SDK terminal settlement: drop live-only fields and retire task-scoped documents.
      const { memos: _memos, restarts: _restarts, abortReason: _abortReason, ...record } = task;
      writes.push({
        type: 'task',
        value: {
          ...record, endedAt,
          state: { status: 'terminal', outcome: task.state.status === 'completing'
            ? task.state.outcome : { status: 'aborted', reason: 'branch' } },
        },
      });
      const documents = await scanAll(cursor => storage.scanDocuments({ scope: { kind: 'task', taskId: task.id }, at: 'current' }, 256, cursor, BACKGROUND_CONTEXT));
      for (const document of documents) writes.push({ type: 'document.retire', id: document.id });
    }
  }
  for (const status of ['queued', 'placed'] as const) {
    const submissions = await scanAll(cursor => storage.scanSubmissions({ status }, 256, cursor, BACKGROUND_CONTEXT));
    for (const submission of submissions) {
      if (submission.status === 'queued' || submission.status === 'placed') {
        writes.push({ type: 'submission', value: { ...submission, status: 'unanswered', reason: 'branch' } });
      }
    }
  }
  const conversations = await scanAll(cursor => storage.scanConversations({}, 256, cursor, BACKGROUND_CONTEXT));
  for (const conversation of conversations) {
    // These latest-only documents contain execution state, not inherited history or usage.
    for (const token of [LiveDoc, InboxDoc]) {
      const document = await storage.findDocument({ kind: token.definition.kind, scope: { kind: 'conversation', conversationId: conversation.id } }, 'current', BACKGROUND_CONTEXT);
      if (document) writes.push({ type: 'document.retire', id: document.id });
    }
  }
  if (writes.length > 0) {
    const result = await storage.commit([writes], () => {}, BACKGROUND_CONTEXT);
    if (result.stored !== 1) throw result.refused ?? new Error('Could not discard inherited work');
  }
}
