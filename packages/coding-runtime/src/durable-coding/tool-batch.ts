/** Start a prepared parallel batch before delivering its synchronous progress callbacks. */
import type { TaskId } from '@earendil-works/pi-durable';

interface Batch {
  expected: Set<string>;
  arrived: Set<string>;
  ready: Promise<void>;
  release(): void;
}

interface CompletionGroup {
  finalized: Set<string>;
  delivered: Set<string>;
  pending: Map<string, { deliver(): Promise<void>; resolve(): void; reject(error: unknown): void }>;
  group?: Set<string>;
  count: number;
}

export class ToolBatchStarts {
  private readonly batches = new Map<TaskId, Batch>();
  private readonly completions = new Map<TaskId, CompletionGroup>();

  prepare(owner: TaskId, callIds: string[]): void {
    this.release(owner);
    if (callIds.length < 2) return;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    this.batches.set(owner, { expected: new Set(callIds), arrived: new Set(), ready, release });
    this.completions.set(owner, {
      finalized: new Set(), delivered: new Set(), pending: new Map(), count: callIds.length,
    });
  }

  /** A failed or cancelled sibling must not hold the remaining tools behind a volatile gate. */
  release(owner: TaskId): void {
    const batch = this.batches.get(owner);
    this.batches.delete(owner);
    batch?.release();
    const state = this.completions.get(owner);
    this.completions.delete(owner);
    for (const pending of state?.pending.values() ?? []) {
      void pending.deliver().then(pending.resolve, pending.reject);
    }
    state?.pending.clear();
  }

  async arrive(owner: TaskId, callId: string, signal?: AbortSignal): Promise<void> {
    const batch = this.batches.get(owner);
    if (!batch || !batch.expected.has(callId)) return;
    batch.arrived.add(callId);
    if (batch.arrived.size === batch.expected.size || signal?.aborted) {
      this.batches.delete(owner);
      batch.release();
    }
    const abort = () => {
      this.release(owner);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await batch.ready;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  finalized(owner: TaskId, callId: string): void {
    this.completions.get(owner)?.finalized.add(callId);
  }

  async deliver(owner: TaskId, callId: string, deliver: () => Promise<void>): Promise<void> {
    const state = this.completions.get(owner);
    if (!state) return deliver();
    await new Promise<void>((resolve, reject) => {
      state.pending.set(callId, { deliver, resolve, reject });
      state.group ??= new Set([...state.finalized, callId].filter(id => !state.delivered.has(id)));
      if (![...state.group].every(id => state.pending.has(id))) return;
      const group = [...state.group];
      state.group = undefined;
      // Native concurrent finalizations enter their sinks before awaiting any individual listener.
      // Durability receipts may arrive on separate turns, so release the already-finalized group together.
      for (const id of group) {
        const pending = state.pending.get(id)!;
        state.pending.delete(id);
        state.delivered.add(id);
        void pending.deliver().then(pending.resolve, pending.reject);
      }
      if (state.delivered.size === state.count) this.completions.delete(owner);
    });
  }
}
