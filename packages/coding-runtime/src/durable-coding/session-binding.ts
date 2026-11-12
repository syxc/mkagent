/** Bind a native session's outer lifecycle and queues to its durable root task. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { copyJson, type JsonValue } from '@earendil-works/chord';
import { defineDoc, type TaskId, type Tx } from '@earendil-works/pi-durable';
import type { LoopBackend } from './engine.ts';
import type { CodingTasks } from './task-registry.ts';
import type {
  CodingSessionAction, CodingSessionCompletion, CodingSessionTaskBindings, CodingSessionTaskRuntime,
  CodingSessionTaskInput,
} from './session-task.ts';

const State = defineDoc<{ owner: number; state: JsonValue | null }>({
  kind: 'pi.coding.session-state', version: 1, scope: 'conversation',
  history: 'rewindable', fork: 'asOf',
  initial: () => ({ owner: 0, state: null }), checkpointWhen: () => false,
});

export interface NativeSessionLifecycle {
  start(): Promise<void>;
  continue(): Promise<void>;
  prepared?(): Promise<void>;
  recover(child: TaskId, onBound: () => void): Promise<unknown>;
  post(): Promise<boolean>;
  beforeSettle(): Promise<boolean>;
  finalize(completion: CodingSessionCompletion): Promise<void>;
  aborted(): boolean;
  action?(action: CodingSessionAction): Promise<boolean>;
}

export interface NativeSessionBindingOptions {
  backend(): Promise<LoopBackend>;
  tasks(): CodingTasks;
  commit(tx: Tx): Promise<void>;
  phase<T>(work: () => Promise<T>): Promise<T>;
  complete?(completion: CodingSessionCompletion): void;
}

export class NativeSessionBinding {
  private readonly local = new AsyncLocalStorage<CodingSessionTaskRuntime>();
  private capture?: () => unknown;
  private restore?: (state: unknown) => void;
  private callbacks?: NativeSessionLifecycle;
  private joining?: { child: TaskId; job: Promise<unknown> };
  private readonly admissions = new Map<TaskId, Promise<void>[]>();
  private readonly phases = new Set<Promise<unknown>>();
  private restored = false;

  constructor(private readonly options: NativeSessionBindingOptions) {}

  bindState(capture: () => unknown, restore: (state: unknown) => void): void {
    this.capture = capture;
    this.restore = restore;
  }

  async persistState(tx: Tx): Promise<void> {
    if (!this.capture) return;
    const backend = await this.options.backend();
    const state = await tx.doc(State, backend.conversation.id);
    state.owner = backend.conversation.id;
    state.state = copyJson(this.capture(), { omitUndefinedProperties: true });
  }

  async restoreState(): Promise<void> {
    if (this.restored) return;
    const backend = await this.options.backend();
    const state = await backend.harness.snapshot(State, backend.conversation.id, backend.context);
    if (state?.owner === backend.conversation.id && state.state) this.restore?.(state.state);
    this.restored = true;
  }

  async pending(): Promise<TaskId | undefined> {
    const backend = await this.options.backend();
    const tasks = (await backend.harness.inspect(backend.context)).tasks.filter(({ record }) =>
      record.conversationId === backend.conversation.id && record.kind === 'pi.coding.session');
    if (tasks.length > 1) throw new Error('Several lifecycle tasks cannot own the same native session');
    return tasks[0]?.record.id;
  }

  current(): CodingSessionTaskRuntime | undefined { return this.local.getStore(); }
  isRunning(): boolean { return this.callbacks !== undefined; }

  async admit(tx: Tx, input: CodingSessionTaskInput): Promise<TaskId> {
    const stored = copyJson(input, { omitUndefinedProperties: true }) as unknown as CodingSessionTaskInput;
    return tx.createTask(this.options.tasks().session, stored, { ownership: { kind: 'conversation' } });
  }

  async defer(action: CodingSessionAction): Promise<boolean> {
    const runtime = this.local.getStore();
    if (!runtime) return false;
    const stored = copyJson(action, { omitUndefinedProperties: true }) as unknown as CodingSessionAction;
    const job = runtime.admitAction(stored);
    const jobs = this.admissions.get(runtime.taskId) ?? [];
    jobs.push(job);
    this.admissions.set(runtime.taskId, jobs);
    await job;
    return true;
  }

  bindings(): CodingSessionTaskBindings {
    const callbacks = this.callbacks;
    if (!callbacks) throw new Error('Native session lifecycle callbacks have not been bound');
    return {
      run: async (operation, child) => {
        if (child !== undefined) {
          if (this.joining?.child === child) await this.joining.job;
          else await callbacks.recover(child, () => {});
        } else if (operation === 'start') await callbacks.start();
        else if (operation === 'prepared') await (callbacks.prepared ?? callbacks.start)();
        else await callbacks.continue();
      },
      post: callbacks.post,
      beforeSettle: callbacks.beforeSettle,
      action: callbacks.action,
      finalize: async completion => {
        try {
          await callbacks.finalize(completion);
          const runtime = this.local.getStore()!;
          const jobs = this.admissions.get(runtime.taskId);
          if (jobs) for (let index = 0; index < jobs.length; index++) await jobs[index];
        } finally {
          const runtime = this.local.getStore();
          if (runtime) this.admissions.delete(runtime.taskId);
        }
      },
      aborted: callbacks.aborted,
      complete: this.options.complete,
      commit: tx => this.options.commit(tx),
      phase: (runtime, work) => {
        const phase = this.options.phase(() => this.local.run(runtime, work));
        this.phases.add(phase);
        void phase.finally(() => this.phases.delete(phase)).catch(() => {});
        return phase;
      },
    };
  }

  async settle(callbacks: NativeSessionLifecycle, onBound?: () => void): Promise<void> {
    if (this.callbacks) throw new Error('Native session lifecycle is already running');
    const backend = await this.options.backend();
    let task = await this.pending();
    this.callbacks = callbacks;
    try {
      if (task === undefined) {
        task = await this.options.phase(() => backend.conversation.commit(async tx => {
          await this.options.commit(tx);
          return tx.createTask(this.options.tasks().session, {}, { ownership: { kind: 'conversation' } });
        }, backend.context));
      } else {
        const record = await backend.harness.getTask(task, backend.context);
        const checkpoint = record && 'checkpoint' in record.state ? record.state.checkpoint : undefined;
        if (checkpoint && typeof checkpoint === 'object' && 'phase' in checkpoint &&
          checkpoint.phase === 'running' && 'child' in checkpoint && typeof checkpoint.child === 'number') {
          const child = checkpoint.child as TaskId;
          const bound = Promise.withResolvers<void>();
          const job = callbacks.recover(child, bound.resolve);
          this.joining = { child, job };
          void job.catch(bound.reject);
          await bound.promise;
        }
      }
      onBound?.();
      const receipt = await backend.harness.waitForTask(task, backend.context);
      await Promise.allSettled([...this.phases]);
      const outcome = receipt.state.outcome;
      if (outcome.status !== 'completed' && outcome.status !== 'aborted') {
        throw new Error(outcome.error?.message ?? `Native session ${outcome.status}`);
      }
    } finally {
      this.callbacks = undefined;
      this.joining = undefined;
    }
  }
}
