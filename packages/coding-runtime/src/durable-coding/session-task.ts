/** Coordinates native session settlement outside the owned pi.coding.run task. */
import { copyJson, type Context } from '@earendil-works/chord';
import {
  defineDoc, defineTask, type ConversationId, type NextTaskState, type PhaseHandler,
  type TaskId, type TaskRuntime, type Tx,
} from '@earendil-works/pi-durable';
import type { AgentSession } from '../native-agent-session.ts';
import type { LoopInput } from './run-task.ts';

export type CodingSessionAction =
  | { type: 'prompt'; text: string; options?: Omit<NonNullable<Parameters<AgentSession['prompt']>[1]>, 'preflightResult'> }
  | { type: 'custom'; message: Parameters<AgentSession['sendCustomMessage']>[0];
    options?: Parameters<AgentSession['sendCustomMessage']>[1] };
export type CodingSessionOperation = 'start' | 'continue' | 'prepared';
export interface CodingSessionTaskInput { operation?: CodingSessionOperation; prepared?: LoopInput }
export type CodingSessionStage = 'run' | 'post' | 'before-settle' | 'finalize' | 'action';
export type CodingSessionCompletion =
  | { status: 'completed' }
  | { status: 'aborted' }
  | { status: 'failed'; stage: CodingSessionStage; message: string; uncertain?: true };
interface Actions {
  frames?: CodingSessionAction[][];
  collected?: CodingSessionAction[];
  action?: CodingSessionAction;
}
export type CodingSessionTaskCheckpoint = Actions & (
  | { phase: 'run'; operation: CodingSessionOperation }
  | { phase: 'running'; operation: CodingSessionOperation; child?: TaskId }
  | { phase: 'post' | 'posting' | 'before-settle' | 'settling' }
  | { phase: 'finalize' | 'finalizing'; completion: CodingSessionCompletion }
  | { phase: 'actions' }
  | { phase: 'action-preparing'; action: CodingSessionAction });

/** Failed hooks never cause accepted actions to disappear or run in a later, unrelated batch. */
export const BlockedSessionActions = defineDoc({
  kind: 'pi.coding.blocked-session-actions', version: 1, scope: 'conversation',
  history: 'latest', fork: 'initial',
  initial: () => ({ batches: [] as import('@earendil-works/chord').JsonValue[] }),
  checkpointWhen: () => false,
});

type Result = Record<string, never>;
type Runtime = TaskRuntime<CodingSessionTaskInput, CodingSessionTaskCheckpoint, Result, object>;

export interface CodingSessionTaskRuntime extends Runtime {
  /**
   * Called by run() before it waits for its child. The callback must only create/reuse
   * one pi.coding.run owned by owner, using tx; never wait or call the Harness here.
   * Its ID, the root checkpoint, and commit(tx)'s native state are stored atomically.
   * A second admission returns the committed child without invoking create again.
   */
  admitChild(create: (tx: Tx, owner: TaskId) => Promise<TaskId>): Promise<TaskId>;
  admitAction(action: CodingSessionAction): Promise<void>;
  hasActions(): boolean;
  preparedInput(): LoopInput | undefined;
}

export interface CodingSessionTaskBindings {
  /**
   * Without child, perform native prompt/continue and admit its run via the phase
   * runtime. With child, only rebind and join that exact run, even if already terminal:
   * do not repeat prompt hooks, enqueue prompts, or create another model request.
   * Waits must honor the phase runtime.signal (including Harness close).
   */
  run(operation: CodingSessionOperation, child?: TaskId): Promise<void>;
  post(): Promise<boolean>;
  beforeSettle(): Promise<boolean>;
  action?(action: CodingSessionAction): Promise<boolean>;
  /** Preserve accepted queues/transcript on failed completion; report uncertain effects. */
  finalize(completion: CodingSessionCompletion): Promise<void>;
  /** Reconcile transaction-bound host state even when recovery skips an uncertain finalizer. */
  complete?(completion: CodingSessionCompletion): void;
  aborted(): boolean;
  /** Flush native staged writes and session state using only this transaction. */
  commit(tx: Tx): Promise<void>;
  /** Bind the supplied runtime through the host's async invocation scope. */
  phase<T>(runtime: CodingSessionTaskRuntime, work: () => Promise<T>): Promise<T>;
}

interface Scope {
  state: CodingSessionTaskCheckpoint;
  host: CodingSessionTaskBindings;
  runtime: CodingSessionTaskRuntime;
  context: Context;
}

/** Fixed-size checkpoints; the durable scheduler remains the only task executor. */
export function createCodingSessionTask(
  resolve: (id: ConversationId) => CodingSessionTaskBindings | Promise<CodingSessionTaskBindings>,
) {
  const scoped = (
    work: (scope: Scope) => Promise<void>,
  ): PhaseHandler<CodingSessionTaskInput, CodingSessionTaskCheckpoint, CodingSessionTaskCheckpoint, Result, object> =>
    async (task, runtime, context) => {
      const host = await resolve(runtime.conversationId);
      const scope: Scope = {
        state: structuredClone(task.state.checkpoint), host, context,
        runtime: {
          ...runtime,
          admitChild: async create => {
            let child: TaskId | undefined;
            await runtime.commit(async (tx, current) => {
              const state = current.state.checkpoint;
              if (state.phase !== 'running') throw new Error('A session child can only be admitted inside run()');
              if (state.child) {
                const record = await tx.task(state.child);
                if (!record || record.kind !== 'pi.coding.run' || record.owner !== runtime.taskId
                  || record.conversationId !== runtime.conversationId || record.background) {
                  throw new Error('Session child must be a foreground pi.coding.run owned by this session task');
                }
              }
              // Tx forbids table reads after createTask(); creation obeys the host contract above.
              child = state.child ?? await create(tx, runtime.taskId);
              const checkpoint = { ...state, child };
              await host.commit(tx);
              return { status: 'running', checkpoint };
            }, context);
            if (!child) throw new Error('Session child admission did not return a task ID');
            const state = scope.state;
            if (state.phase === 'running') scope.state = { ...state, child };
            return child;
          },
          admitAction: async action => {
            await runtime.commit(async (tx, current) => {
              const state = current.state.checkpoint;
              if (state.phase !== 'finalizing') throw new Error('Settled actions require an active finalizer');
              scope.state = { ...state, collected: [...state.collected ?? [], action] };
              await host.commit(tx);
              return { status: 'running', checkpoint: scope.state };
            }, context);
          },
          hasActions: () => Boolean(scope.state.collected?.length || scope.state.frames?.some(frame => frame.length)),
          preparedInput: () => scope.state.phase === 'running' && scope.state.operation === 'prepared'
            && !scope.state.action ? task.input.prepared : undefined,
        },
      };
      await host.phase(scope.runtime, () => work(scope));
    };

  const run = async (scope: Scope, operation: CodingSessionOperation, child?: TaskId) => {
    if (scope.host.aborted()) return finish(scope, { status: 'aborted' });
    if (child) {
      const record = await scope.runtime.getTask(child, scope.context);
      if (!record || record.kind !== 'pi.coding.run' || record.owner !== scope.runtime.taskId
        || record.conversationId !== scope.runtime.conversationId) {
        return finish(scope, failure('run', `Committed session child ${child} is missing or has a different owner`));
      }
    }
    try {
      await scope.host.run(operation, child);
    } catch (error) {
      scope.runtime.signal.throwIfAborted();
      return finish(scope, failure('run', message(error)));
    }
    scope.runtime.signal.throwIfAborted();
    const state = scope.state;
    if (state.phase !== 'running' || !state.child) {
      return finish(scope, failure('run', 'Native run returned without admitting its durable child'));
    }
    const receipt = await scope.runtime.waitForTask(state.child, scope.context);
    if (scope.host.aborted() || receipt.state.outcome.status === 'aborted') {
      return finish(scope, { status: 'aborted' });
    }
    if (receipt.state.outcome.status !== 'completed') {
      const outcome = receipt.state.outcome;
      return finish(scope, failure('run', outcome.error?.message ?? `Session child ${outcome.status}`));
    }
    await advance(scope, { phase: 'post' });
  };

  const callback = async (
    scope: Scope, stage: 'post' | 'before-settle', work: () => Promise<boolean>,
  ) => {
    if (scope.host.aborted()) return finish(scope, { status: 'aborted' });
    await advance(scope, { phase: stage === 'post' ? 'posting' : 'settling' });
    let more: boolean;
    try { more = await work(); } catch (error) {
      scope.runtime.signal.throwIfAborted();
      return finish(scope, failure(stage, message(error)));
    }
    scope.runtime.signal.throwIfAborted();
    // The result and all native queue/transcript changes cross one atomic boundary.
    if (scope.host.aborted()) await finish(scope, { status: 'aborted' });
    else if (more) await advance(scope, { phase: 'run', operation: 'continue' });
    else if (stage === 'post') await advance(scope, { phase: 'before-settle' });
    else await finish(scope, { status: 'completed' });
  };

  const finalize = async (scope: Scope, completion: CodingSessionCompletion) => {
    await advance(scope, { phase: 'finalizing', completion });
    try {
      await scope.host.finalize(completion);
    } catch (error) {
      scope.runtime.signal.throwIfAborted();
      await terminal(scope, failure('finalize', message(error)));
      return;
    }
    if (completion.status === 'completed') {
      const frames = [...scope.state.frames ?? []];
      if (scope.state.collected?.length) frames.push(scope.state.collected);
      if (frames.some(frame => frame.length)) {
        await advance(scope, { phase: 'actions', frames, collected: [], action: undefined });
        return;
      }
    }
    await terminal(scope, completion);
  };

  return defineTask<CodingSessionTaskInput, CodingSessionTaskCheckpoint, Result>({
    name: 'pi.coding.session',
    version: 1,
    initial: input => ({ phase: 'run', operation: input.operation ?? 'start' }),
    phases: {
      run: scoped(async scope => {
        const state = scope.state;
        if (state.phase !== 'run') return;
        if (scope.host.aborted()) return finish(scope, { status: 'aborted' });
        await advance(scope, { phase: 'running', operation: state.operation });
        await run(scope, state.operation);
      }),
      running: scoped(async scope => {
        const state = scope.state;
        if (state.phase !== 'running') return;
        if (!state.child) return finish(scope, interrupted('run'));
        await run(scope, state.operation, state.child);
      }),
      post: scoped(scope => callback(scope, 'post', () => scope.host.post())),
      posting: scoped(scope => finish(scope, interrupted('post'))),
      'before-settle': scoped(scope => callback(scope, 'before-settle', () => scope.host.beforeSettle())),
      settling: scoped(scope => finish(scope, interrupted('before-settle'))),
      finalize: scoped(async scope => {
        if (scope.state.phase !== 'finalize') return;
        const completion = scope.host.aborted() && scope.state.completion.status === 'completed'
          ? { status: 'aborted' as const } : scope.state.completion;
        await finalize(scope, completion);
      }),
      finalizing: scoped(scope => terminal(scope, interrupted('finalize'))),
      actions: scoped(async scope => {
        const frames = structuredClone(scope.state.frames ?? []);
        while (frames.length && !frames.at(-1)!.length) frames.pop();
        const action = frames.at(-1)?.shift();
        if (!action) return terminal(scope, { status: 'completed' });
        await advance(scope, { phase: 'action-preparing', action, frames, collected: [] });
        try {
          if (!scope.host.action) throw new Error('Native session action callbacks have not been bound');
          const prepared = await scope.host.action(action);
          await advance(scope, prepared ? { phase: 'run', operation: 'prepared' }
            : { phase: 'actions', action: undefined });
        } catch (error) {
          scope.runtime.signal.throwIfAborted();
          await finish(scope, failure('action', message(error)));
        }
      }),
      'action-preparing': scoped(scope => finish(scope, interrupted('action'))),
    },
    abort: scoped(async scope => {
      const state = scope.state;
      if (state.phase === 'finalizing') {
        // Cancellation joins the callback but cannot make external delivery transactional.
        await terminal(scope, interrupted('finalize'));
      } else {
        const completion = state.phase === 'posting' ? interrupted('post')
          : state.phase === 'settling' ? interrupted('before-settle')
          : state.phase === 'action-preparing' ? interrupted('action')
          : state.phase === 'running' && !state.child ? interrupted('run')
          : { status: 'aborted' as const };
        await finalize(scope, completion);
      }
    }),
  });
}

function failure(stage: CodingSessionStage, text: string): CodingSessionCompletion {
  return { status: 'failed', stage, message: text };
}

function interrupted(stage: CodingSessionStage): CodingSessionCompletion {
  return {
    status: 'failed', stage, uncertain: true,
    message: `Native session ${stage} was interrupted; its effects are uncertain and were not replayed. Inspect the transcript and accepted queues before retrying.`,
  };
}

function message(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); } catch { return 'Native session callback failed'; }
}

async function commit(scope: Scope, next: NextTaskState<CodingSessionTaskCheckpoint, Result>) {
  await scope.runtime.commit(async tx => {
    await scope.host.commit(tx);
    return next;
  }, scope.context);
}

async function advance(scope: Scope, checkpoint: CodingSessionTaskCheckpoint) {
  const { frames, collected, action } = scope.state;
  const next = copyJson({ frames, collected, action, ...checkpoint },
    { omitUndefinedProperties: true }) as unknown as CodingSessionTaskCheckpoint;
  await commit(scope, { status: 'running', checkpoint: next });
  scope.state = next;
}

async function finish(scope: Scope, completion: CodingSessionCompletion) {
  await advance(scope, { phase: 'finalize', completion });
}

async function terminal(scope: Scope, completion: CodingSessionCompletion) {
  const next: NextTaskState<CodingSessionTaskCheckpoint, Result> = {
    status: 'terminal',
    outcome: completion.status === 'completed' ? { status: 'completed', result: {} }
      : completion.status === 'aborted' ? { status: 'aborted' }
      : {
        status: 'failed',
        error: {
          message: completion.message,
          detail: { code: completion.uncertain ? 'native_session_interrupted' : 'native_session_failed', stage: completion.stage },
        },
      },
  };
  await scope.runtime.commit(async tx => {
    scope.host.complete?.(completion);
    if (completion.status !== 'completed' && (scope.state.action || scope.runtime.hasActions())) {
      const blocked = await tx.doc(BlockedSessionActions, scope.runtime.conversationId);
      blocked.batches.push(copyJson({ taskId: scope.runtime.taskId, completion,
        action: scope.state.action, frames: scope.state.frames, collected: scope.state.collected },
      { omitUndefinedProperties: true }));
    }
    await scope.host.commit(tx);
    return next;
  }, scope.context);
}
