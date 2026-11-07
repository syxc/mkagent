/** A plugin continuation waits for product history persistence in its original worker scope. */
import { randomUUID } from 'node:crypto';
import type { PiWorkerScope } from '../../shared/src/agent/backend/pi/protocol.ts';
import type { NativeSessionReference } from '../../shared/src/sessions/native-session-reference.ts';

export interface NativeHistoryRequest {
  type: 'native_history_commit';
  id: string;
  reference: NativeSessionReference;
  hasName: boolean;
}
export interface NativeHistoryReceipt {
  type: 'native_history_receipt';
  id: string;
  success: boolean;
  error?: string;
}

function same(a: PiWorkerScope, b?: PiWorkerScope): boolean {
  return !!b && a.ownerSessionId === b.ownerSessionId && a.runtimeGeneration === b.runtimeGeneration;
}

export class NativeHistoryReceipts {
  private readonly pending = new Map<string, {
    scope: PiWorkerScope; resolve(): void; reject(error: Error): void;
  }>();

  constructor(private readonly send: (request: NativeHistoryRequest, scope: PiWorkerScope) => void) {}

  async commit(scope: PiWorkerScope | undefined, reference: NativeSessionReference, hasName: boolean): Promise<void> {
    if (!scope || scope.ownerSessionId !== reference.sessionId) throw new Error('Native history requires its active product owner');
    const id = randomUUID();
    const gate = Promise.withResolvers<void>();
    this.pending.set(id, { scope: { ...scope }, resolve: gate.resolve, reject: gate.reject });
    try {
      this.send({ type: 'native_history_commit', id, reference, hasName }, scope);
      await gate.promise;
    } finally { this.pending.delete(id); }
  }

  receive(receipt: NativeHistoryReceipt, scope?: PiWorkerScope): boolean {
    const pending = this.pending.get(receipt.id);
    if (!pending || !same(pending.scope, scope)) return false;
    this.pending.delete(receipt.id);
    if (receipt.success === true) pending.resolve();
    else pending.reject(new Error(receipt.error || 'Product native history persistence failed'));
    return true;
  }

  cancel(scope: PiWorkerScope | undefined, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (scope && !same(pending.scope, scope)) continue;
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
  }
}
