/** Fence supported legacy coding checkpoints before any Harness scheduler can resume them. */
import { copyJson, type JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  defineDoc, type ConversationId, type Cursor, type EntryId, type GenerationCheckpoint,
  type InboxItem, type JsonObject, type Page, type Storage, type StorageWrite,
  type StoredDocument, type SubmissionId, type SubmissionRecord, type TaskId, type TaskRecord, type Tx,
} from '@earendil-works/pi-durable';

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

export interface LegacyCodingRecovery {
  conversationId: ConversationId;
  /** These submissions already have transcript entries. Continue without prompting them again. */
  continuation: { taskId: TaskId; inputs: SubmissionId[]; checkpoint: GenerationCheckpoint } | null;
  /** A committed answer needs no new generation. */
  answer: EntryId | null;
  /** Original admission order and modes; do not run the input/command hooks again. */
  queued: InboxItem[];
  /** Original IDs and request IDs remain valid and must be settled by their native successor. */
  submissions: SubmissionRecord[];
  /** Audit/recovery evidence, including checkpoints, memos, partials and terminal tool receipts. */
  tasks: StoredTask[];
  taskDocuments: StoredDocument[];
  live: JsonObject;
  inbox: JsonObject;
}

type MigrationState = {
  status: 'empty' | 'staged' | 'adopted';
  recovery: JsonValue;
  receipt: JsonValue;
};

export const CodingMigrationDoc = defineDoc<MigrationState>({
  kind: 'mkagent.coding.legacy-work', version: 1, scope: 'conversation',
  history: 'latest', fork: 'initial',
  initial: () => ({ status: 'empty', recovery: null, receipt: null }),
  checkpointWhen: () => true,
});

/** An unsupported operation leaves every record untouched, including the old execution queue. */
export class CodingMigrationError extends Error {
  constructor(readonly code: string, conversationId: ConversationId, detail: string) {
    super(`Legacy coding migration blocked [${code}] in conversation ${conversationId}: ${detail}. ` +
      'The store was not migrated. Reopen with the previous runtime to finish or explicitly reconcile this operation before retrying.');
    this.name = 'CodingMigrationError';
  }
}

/**
 * Call with exclusive, paused Storage, for the explicitly selected coding conversation, before Harness.open.
 * One atomic batch fences only its conversation-owned pi.generation v4 and owned pi.tool v3 records.
 * Programmatic/background tasks and other conversations are preserved. No task/hook/model is invoked.
 *
 * After NativeSessionJournal.open, use adoptLegacyCodingWork in the SAME transaction that persists the
 * native continuation/queue and their original submission-ID mappings. A plain session.prompt followed
 * by an acknowledgement is not crash-safe. Keep placed inputs in the journal; admit queued items once,
 * without repeating input/command callbacks, and settle their original SubmissionRecords on completion.
 * Honor the saved checkpoint's request settings and completed preparation; do not replay preparation
 * callbacks already represented by codingPreparation/memos in the archived live/task records.
 * A tools checkpoint resumes the native post-tools boundary: its results are already in the journal,
 * so neither tool execution nor result delivery runs again. A retry keeps its saved backoff deadline.
 */
export async function migrateLegacyCodingWork(
  storage: Storage, conversationId: ConversationId,
): Promise<LegacyCodingRecovery | undefined> {
  const fail: (code: string, detail: string) => never = (code, detail) => {
    throw new CodingMigrationError(code, conversationId, detail);
  };
  const scope = { kind: 'conversation', conversationId } as const;
  const marker = await readDocument(storage, CodingMigrationDoc.definition.kind, conversationId);
  const tasks = await scanAll(cursor => storage.scanTasks({ conversationId }, 256, cursor, BACKGROUND_CONTEXT), fail);
  const generations = tasks.filter(task =>
    task.kind === 'pi.generation' && task.owner === undefined && !task.background && task.state.status !== 'terminal');
  for (const task of tasks) if (task.kind === 'pi.tool' && task.state.status !== 'terminal') {
    const owner = tasks.find(parent => parent.id === task.owner);
    if (owner?.kind === 'pi.generation' && owner.owner === undefined && !owner.background && owner.state.status === 'terminal') {
      fail('detached-tool', `tool task ${task.id} is live below ended generation ${owner.id}`);
    }
  }
  const liveDoc = await readDocument(storage, 'pi.live', conversationId);
  const inboxDoc = await readDocument(storage, 'pi.inbox', conversationId);
  const live = liveDoc?.value ?? {};
  const inbox = inboxDoc?.value ?? { items: [] };
  const queued = inbox.items;
  if (!Array.isArray(queued)) fail('inbox-shape', 'pi.inbox.items is not a queue');
  if (marker) {
    if (marker.version !== 1 || !['empty', 'staged', 'adopted'].includes(String(marker.value.status))) {
      fail('marker-version', 'the migration marker has an unsupported version or state');
    }
    if (marker.value.status !== 'empty') {
      if (generations.length || queued.length || live.run !== undefined) {
        fail('legacy-after-marker', 'new legacy work appeared after the migration fence');
      }
      return marker.value.status === 'staged' ? decodeRecovery(marker.value.recovery, conversationId) : undefined;
    }
  }
  if (liveDoc && liveDoc.version !== 3) fail('live-version', `pi.live version ${liveDoc.version} is unsupported`);
  if (inboxDoc && inboxDoc.version !== 1) fail('inbox-version', `pi.inbox version ${inboxDoc.version} is unsupported`);
  if (generations.length > 1) fail('multiple-runs', 'more than one conversation-owned legacy generation is live');

  const run = object(live.run);
  const generation = generations[0];
  if (generation?.version !== undefined && generation.version !== 4) {
    fail('generation-version', `task ${generation.id} uses pi.generation v${generation.version}, expected v4`);
  }
  if (generation && generation.state.status !== 'completing' && run?.taskId !== generation.id) {
    fail('run-owner', `task ${generation.id} does not own pi.live.run`);
  }
  if (run && run.taskId !== generation?.id) fail('run-owner', 'pi.live.run belongs to another or already terminal task');
  const inputs = run?.inputs ?? [];
  if (!Array.isArray(inputs) || !inputs.every(id => typeof id === 'number')) fail('run-inputs', 'run inputs are invalid');
  const selected = new Set<TaskId>(generation ? [generation.id] : []);
  // Ownership must be followed, including children not named in a waiting checkpoint.
  for (let changed = true; changed;) {
    changed = false;
    for (const task of tasks) if (task.owner !== undefined && selected.has(task.owner) && !selected.has(task.id)) {
      selected.add(task.id);
      changed = true;
    }
  }
  const owned = tasks.filter(task => selected.has(task.id));
  for (const task of owned) {
    if (task !== generation && (task.kind !== 'pi.tool' || task.version !== 3 || task.owner !== generation?.id)) {
      fail('owned-work', `task ${task.id} (${task.kind} v${task.version}) needs its original owner/callback semantics`);
    }
    const children = await storage.scanConversations({ ownerTaskId: task.id }, 1, undefined, BACKGROUND_CONTEXT);
    if (children.items.length) fail('owned-conversation', `task ${task.id} owns a conversation whose result cannot be transferred`);
  }
  let continuation: LegacyCodingRecovery['continuation'] = null;
  let answer: EntryId | null = null;
  if (generation) {
    const state = generation.state;
    if (generation.abortRequested) fail('abort-requested', `task ${generation.id} has an unfinished abort protocol`);
    if (object(live.generation)?.message !== undefined) {
      fail('partial-response', `task ${generation.id} has a committed partial response that needs explicit native conversion`);
    }
    if (state.status === 'completing') {
      if (owned.length > 1 || inputs.length) fail('ending-run', `task ${generation.id} still owns work or unsettled inputs`);
      if (state.outcome.status !== 'completed') fail('ending-run', `task ${generation.id} is completing a non-success outcome`);
      const result = object(state.outcome.result);
      if (typeof result?.entryId !== 'number') fail('answer-receipt', `task ${generation.id} has no committed answer receipt`);
      answer = result.entryId as EntryId;
    } else if (state.status !== 'terminal') {
      const checkpoint = object(state.checkpoint);
      if (!checkpoint) fail('checkpoint-shape', `task ${generation.id} has no checkpoint object`);
      const phase = checkpoint?.phase;
      if (phase === 'finish' || phase === 'drain') {
        fail('after-run', `task ${generation.id} still has afterRun callbacks or owned work to finish`);
      }
      if (phase !== 'prepare' && phase !== 'request' && phase !== 'retry' && phase !== 'tools') {
        fail('checkpoint-phase', `task ${generation.id} is at ${String(phase)}, which requires the previous coding callback decisions`);
      }
      if (checkpoint.poll !== undefined) fail('deferred-response', `task ${generation.id} owns a deferred provider response`);
      if (checkpoint.compacted !== undefined) fail('blocking-compaction', `task ${generation.id} is waiting for a compaction decision`);
      if (phase === 'tools') await checkToolRound(storage, conversationId, checkpoint, owned, fail);
      else if (owned.length > 1) fail('owned-work', `task ${generation.id} has child work outside a tool checkpoint`);
      // Decisions are recorded before their entries. Ignoring one would silently discard accepted callback output.
      const prepared = object(run?.codingPreparation);
      if (Object.keys(generation.memos ?? {}).some(key => {
        if (!key.startsWith('mkagent.coding.')) return false;
        const attempt = /^mkagent\.coding\.prepare\.v1:(\d+)$/.exec(key)?.[1];
        return !attempt || prepared?.taskId !== generation.id || typeof prepared.attempt !== 'number' ||
          Number(attempt) > prepared.attempt;
      })) {
        fail('callback-memo', `task ${generation.id} retains a coding callback decision that needs its original application protocol`);
      }
      // Storage is a schema boundary; phase checks above restrict the supported installed v4 checkpoint union.
      continuation = { taskId: generation.id, inputs: inputs as SubmissionId[], checkpoint: state.checkpoint as GenerationCheckpoint };
    }
  }
  if (answer !== null && !(await storage.entry(conversationId, answer, BACKGROUND_CONTEXT))) {
    fail('answer-receipt', `answer entry ${answer} is not visible`);
  }
  const submissions = await scanAll(cursor =>
    storage.scanSubmissions({ conversationId }, 256, cursor, BACKGROUND_CONTEXT), fail);
  const waiting = submissions.filter(submission => submission.status === 'queued' || submission.status === 'placed');
  const expected = new Map<number, 'queued' | 'placed'>();
  for (const id of inputs) {
    if (expected.has(id)) fail('duplicate-input', `submission ${id} occurs twice in the run`);
    expected.set(id, 'placed');
  }
  for (const raw of queued) {
    const item = object(raw);
    if (!item || typeof item.id !== 'number' || (item.mode !== 'steer' && item.mode !== 'followUp') || item.content === undefined) {
      fail('queued-operation', 'the inbox contains a passive write, reset, or unsupported input; apply it with the previous runtime');
    }
    if (item.entry !== undefined) fail('custom-input', `queued submission ${item.id} uses a custom entry that needs explicit native conversion`);
    if (expected.has(item.id)) fail('duplicate-input', `submission ${item.id} occurs more than once in run/inbox`);
    expected.set(item.id, 'queued');
  }
  if (waiting.length !== expected.size || waiting.some(submission =>
    expected.get(submission.id) !== submission.status || (submission.status === 'queued' && submission.type !== 'input'))) {
    fail('submission-ownership', 'queued/placed submissions do not exactly match pi.live.run and pi.inbox');
  }
  if (!generations.length && !queued.length) return undefined;
  for (const submission of waiting) {
    if (submission.status === 'placed' && submission.type === 'input') {
      const entry = await storage.entry(conversationId, submission.entry, BACKGROUND_CONTEXT);
      if (!entry?.entry.model?.some(message => message.role === 'user')) {
        fail('placed-input', `submission ${submission.id} has no visible user entry`);
      }
    }
  }
  // Match NativeSessionJournal's import precondition before fencing anything. An existing journal already owns its history.
  const journal = await readDocument(storage, 'mkagent.coding.native-journal', conversationId);
  if (!journal || journal.value.header === null || journal.value.owner !== conversationId) {
    const entries = await scanAll(cursor =>
      storage.scanEntries({ conversationId, order: 'ascending' }, 256, cursor, BACKGROUND_CONTEXT), fail);
    for (const entry of entries) {
      if (entry.kind === 'mkagent.coding.entry.v1') {
        const envelope = object(entry.data);
        if (typeof envelope?.id !== 'string' || typeof envelope.type !== 'string') {
          fail('native-history', `entry ${entry.id} has an invalid native envelope`);
        }
      }
    }
  }
  const taskDocuments: StoredDocument[] = [];
  for (const task of owned) if (task.state.status !== 'terminal') {
    const records = await scanAll(cursor =>
      storage.scanDocuments({ scope: { kind: 'task', taskId: task.id }, at: 'current' }, 256, cursor, BACKGROUND_CONTEXT), fail);
    for (const record of records) {
      const document = await storage.document(record.id, 'current', BACKGROUND_CONTEXT);
      if (!document) fail('task-document', `task document ${record.id} disappeared while storage should be paused`);
      taskDocuments.push(document);
    }
  }
  const recovery: LegacyCodingRecovery = {
    conversationId, continuation, answer, queued: queued as InboxItem[], submissions: waiting,
    tasks: owned, taskDocuments, live, inbox,
  };
  const writes: StorageWrite[] = [];
  const endedAt = Date.now();
  for (const task of owned) if (task.state.status !== 'terminal') {
    const { memos: _memos, restarts: _restarts, abortReason: _reason, ...record } = task;
    writes.push({ type: 'task', value: {
      ...record, endedAt,
      state: { status: 'terminal', outcome: task.state.status === 'completing'
        ? task.state.outcome : { status: 'aborted', reason: 'native-coding-migration' } },
    } });
  }
  for (const document of taskDocuments) writes.push({ type: 'document.retire', id: document.record.id });
  if (generation && liveDoc) {
    const { run: _run, generation: _generation, tools: _tools, nestedTools: _nested, ...remaining } = live;
    writes.push({ type: 'document.change', id: liveDoc.record.id, content: { kind: 'base', version: 3, value: remaining } });
  }
  if (queued.length && inboxDoc) writes.push({
    type: 'document.change', id: inboxDoc.record.id,
    content: { kind: 'base', version: 1, value: { ...inbox, items: [] } },
  });
  const content = { kind: 'base', version: 1, value: { status: 'staged', recovery: copyJson(recovery), receipt: null } } as const;
  writes.push(marker ? { type: 'document.change', id: marker.record.id, content } : {
    type: 'document.create',
    record: { id: await storage.mintId(), kind: CodingMigrationDoc.definition.kind, scope, history: 'latest', fork: 'initial' },
    content,
  });
  const result = await storage.commit([writes], () => {}, BACKGROUND_CONTEXT);
  if (result.stored !== 1) throw result.refused ?? new Error('Could not atomically fence legacy coding work');
  return recovery;
}

/**
 * Persist the successor's work and this acknowledgement in one Harness transaction.
 * `adopt` may only stage durable writes through tx; external effects or session.prompt are forbidden here.
 * A retry returns the saved receipt without invoking adopt again. Original submissions stay valid.
 */
export async function adoptLegacyCodingWork(
  tx: Tx, conversationId: ConversationId,
  adopt: (recovery: LegacyCodingRecovery, tx: Tx) => Promise<JsonValue>,
): Promise<JsonValue> {
  const marker = await tx.doc(CodingMigrationDoc, conversationId);
  if (marker.status !== 'staged') return marker.receipt;
  const receipt = await adopt(decodeRecovery(marker.recovery, conversationId), tx);
  marker.status = 'adopted';
  marker.receipt = receipt;
  return receipt;
}

async function checkToolRound(
  storage: Storage, conversationId: ConversationId, checkpoint: JsonObject, tasks: StoredTask[],
  fail: (code: string, detail: string) => never,
): Promise<void> {
  if (!Array.isArray(checkpoint.tools) || !Array.isArray(checkpoint.pending) || typeof checkpoint.assistant !== 'number') {
    fail('tool-round', 'the tools checkpoint is invalid');
  }
  if (checkpoint.pending.length) fail('unstarted-tool', `calls ${checkpoint.pending.join(', ')} have not run; native tool preflight must be transferred explicitly`);
  const assistant = await storage.entry(conversationId, checkpoint.assistant as EntryId, BACKGROUND_CONTEXT);
  const message = assistant?.entry.model?.[0];
  if (message?.role !== 'assistant') fail('tool-assistant', `assistant entry ${checkpoint.assistant} is missing`);
  const calls = message.content.filter(content => content.type === 'toolCall');
  const ids = checkpoint.tools;
  if (new Set(ids).size !== ids.length || calls.length !== ids.length || tasks.length !== ids.length + 1) {
    fail('tool-round', 'the assistant calls and owned tool tasks do not match exactly');
  }
  const seen = new Set<string>();
  for (const id of ids) {
    const task = tasks.find(task => task.id === id && task.kind === 'pi.tool');
    const input = object(task?.input);
    const call = calls.find(call => call.id === input?.callId);
    if (!task || input?.kind !== 'model' || input.assistant !== checkpoint.assistant || !call || seen.has(call.id)) {
      fail('tool-receipt', `task ${id} is not a unique model call in this round`);
    }
    seen.add(call.id);
    if (task.state.status !== 'terminal' && task.state.status !== 'completing') {
      const intent = object(task.state.checkpoint);
      const unsafe = intent?.phase === 'execute' && intent.replay === 'unsafe';
      fail(unsafe ? 'uncertain-tool-effect' : 'unfinished-tool',
        `tool task ${id} (${call.name}) ${unsafe ? 'may have partially run; inspect its side effects and reconcile its result without rerunning it' : 'has no committed result; finish or explicitly transfer its execution'}`);
    }
    const outcome = task.state.outcome;
    const result = object(outcome.result);
    if (typeof result?.entryId !== 'number' || result.kind === 'nested') fail('tool-receipt', `task ${id} has no model result receipt`);
    const control = object(result.control);
    if (control && Object.keys(control).length) fail('tool-control', `task ${id} has unapplied tool control (handoff/terminate/addTools)`);
    const receipt = await storage.entry(conversationId, result.entryId as EntryId, BACKGROUND_CONTEXT);
    const output = receipt?.entry.model?.[0];
    if (output?.role !== 'toolResult' || output.toolCallId !== call.id || output.toolName !== call.name) {
      fail('tool-receipt', `task ${id} points to a missing or mismatched tool result`);
    }
  }
}

async function readDocument(storage: Storage, kind: string, conversationId: ConversationId): Promise<StoredDocument | undefined> {
  const record = await storage.findDocument({ kind, scope: { kind: 'conversation', conversationId } }, 'current', BACKGROUND_CONTEXT);
  return record ? storage.document(record.id, 'current', BACKGROUND_CONTEXT) : undefined;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function decodeRecovery(value: JsonValue | undefined, conversationId: ConversationId): LegacyCodingRecovery {
  const record = object(value);
  if (!record || record.conversationId !== conversationId || !Array.isArray(record.tasks) || !Array.isArray(record.queued)) {
    throw new CodingMigrationError('marker-shape', conversationId, 'the staged recovery descriptor is invalid');
  }
  // This versioned document is produced only by the paused migration's validated snapshot.
  return record as unknown as LegacyCodingRecovery;
}

async function scanAll<T>(
  scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>,
  fail: (code: string, detail: string) => never,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await scan(cursor);
    items.push(...page.items);
    if (items.length > 100_000) fail('scan-limit', 'the migration scan exceeds 100000 records; use a dedicated offline migration');
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}
