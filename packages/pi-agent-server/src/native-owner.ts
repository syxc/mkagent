import { randomUUID } from 'node:crypto';
import type { PiWorkerScope } from '../../shared/src/agent/backend/pi/protocol.ts';
import type {
  PiNativeOwnerActivation, PiNativeOwnerControl, PiNativeOwnerEvent, PiNativeOwnerEventBody,
  PiNativeOwnerPhase, PiNativeOwnerRequest,
} from '../../shared/src/agent/backend/pi/native-owner-protocol.ts';

interface Activation {
  scope: PiWorkerScope;
  value: PiNativeOwnerActivation;
}

type Gate<T> = ReturnType<typeof Promise.withResolvers<T>>;

interface Transaction {
  id: string;
  request: PiNativeOwnerRequest;
  source: PiWorkerScope;
  targetId?: string;
  target?: PiWorkerScope;
  phase: PiNativeOwnerPhase;
  sourceClosed: boolean;
  controller: AbortController;
  prepared: Gate<string>;
  activated: Gate<Activation>;
  committed: Gate<void>;
}

export interface NativeOwnerWork {
  closeSource(signal: AbortSignal): Promise<void>;
  bindTarget(activation: PiNativeOwnerActivation, signal: AbortSignal): Promise<string>;
  runTarget(activation: PiNativeOwnerActivation, signal: AbortSignal): Promise<void>;
}

export interface NativeOwnerTransport {
  send(event: PiNativeOwnerEvent): void;
  withTargetScope(scope: PiWorkerScope, work: () => Promise<void>): Promise<void>;
}

function sameScope(a: PiWorkerScope | undefined, b: PiWorkerScope | undefined): boolean {
  return !!a && !!b && a.ownerSessionId === b.ownerSessionId && a.runtimeGeneration === b.runtimeGeneration;
}

function validScope(scope: PiWorkerScope | undefined): scope is PiWorkerScope {
  return !!scope && typeof scope.ownerSessionId === 'string' && scope.ownerSessionId.length > 0
    && Number.isSafeInteger(scope.runtimeGeneration) && scope.runtimeGeneration > 0;
}

function gate<T>(): Gate<T> {
  const value = Promise.withResolvers<T>();
  // Abort can precede the coroutine reaching a later handshake barrier.
  void value.promise.catch(() => {});
  return value;
}

/** Control handlers release barriers; only the original command coroutine runs lifecycle work. */
export class NativeOwnerExchange {
  private active?: Transaction;

  constructor(private readonly transport: NativeOwnerTransport) {}

  async replace(source: PiWorkerScope | undefined, request: PiNativeOwnerRequest, work: NativeOwnerWork): Promise<void> {
    if (!validScope(source)) throw new Error('Native replacement requires an owned worker scope');
    if (this.active) throw new Error('Native session replacement is already in progress');
    const tx: Transaction = {
      id: randomUUID(), request, source: { ...source }, phase: 'preparing', sourceClosed: false,
      controller: new AbortController(), prepared: gate(), activated: gate(), committed: gate(),
    };
    this.active = tx;
    const signal = tx.controller.signal;
    try {
      this.send(tx, { type: 'owner_prepare', transactionId: tx.id, ...request });
      await tx.prepared.promise;
      signal.throwIfAborted();
      await work.closeSource(signal);
      tx.sourceClosed = true;
      signal.throwIfAborted();
      tx.phase = 'source_closed';
      this.send(tx, { type: 'owner_source_closed', transactionId: tx.id });
      const activated = await tx.activated.promise;
      signal.throwIfAborted();
      await this.transport.withTargetScope(activated.scope, async () => {
        const nativeSessionId = await work.bindTarget(activated.value, signal);
        signal.throwIfAborted();
        tx.phase = 'target_bound';
        this.send(tx, { type: 'owner_target_bound', transactionId: tx.id, nativeSessionId });
        await tx.committed.promise;
        signal.throwIfAborted();
        await work.runTarget(activated.value, signal);
        signal.throwIfAborted();
        tx.phase = 'finished';
        this.send(tx, { type: 'owner_finished', transactionId: tx.id, outcome: 'complete' });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (tx.phase === 'committed') {
          this.send(tx, {
            type: 'owner_finished', transactionId: tx.id,
            outcome: signal.aborted ? 'cancelled' : 'error', error: message,
          });
        } else if (tx.phase !== 'finished') {
          this.send(tx, {
            type: 'owner_failed', transactionId: tx.id, phase: tx.phase,
            sourceClosed: tx.sourceClosed, error: message,
          });
        }
      } catch {
        // A broken transport cannot report failure; the product observes process loss.
      }
      throw error;
    } finally {
      if (this.active === tx) this.active = undefined;
    }
  }

  /** Called directly from the transport, outside initialization and input admission queues. */
  receive(message: PiNativeOwnerControl, scope: PiWorkerScope | undefined): boolean {
    const tx = this.active;
    if (!tx || message.transactionId !== tx.id || !validScope(scope)) return false;
    if (message.type === 'owner_prepared') {
      if (!sameScope(scope, tx.source) || !message.targetSessionId) return false;
      if (tx.targetId !== undefined) return tx.targetId === message.targetSessionId;
      if (tx.phase !== 'preparing') return false;
      if (message.targetSessionId === tx.source.ownerSessionId && tx.request.operation.type !== 'switch') return false;
      tx.targetId = message.targetSessionId;
      tx.phase = 'prepared';
      tx.prepared.resolve(message.targetSessionId);
      return true;
    }
    if (message.type === 'owner_activate') {
      if (!tx.targetId || scope.ownerSessionId !== tx.targetId
        || scope.runtimeGeneration <= tx.source.runtimeGeneration
        || message.activation.config.sessionId !== tx.targetId) return false;
      if (tx.target) return sameScope(scope, tx.target);
      if (tx.phase !== 'source_closed') return false;
      tx.target = { ...scope };
      tx.phase = 'activating';
      tx.activated.resolve({ scope: tx.target, value: message.activation });
      return true;
    }
    const current = tx.target ?? tx.source;
    if (!sameScope(scope, current)) return false;
    if (message.type === 'owner_committed') {
      if (tx.phase === 'committed' || tx.phase === 'finished') return true;
      if (tx.phase !== 'target_bound') return false;
      tx.phase = 'committed';
      tx.committed.resolve();
      return true;
    }
    this.cancel(message.error);
    return true;
  }

  cancel(message = 'Native session replacement cancelled'): void {
    const tx = this.active;
    if (!tx || tx.controller.signal.aborted || tx.phase === 'finished') return;
    const error = new Error(message);
    tx.controller.abort(error);
    tx.prepared.reject(error);
    tx.activated.reject(error);
    tx.committed.reject(error);
  }

  private send(tx: Transaction, message: PiNativeOwnerEventBody): void {
    this.transport.send({ ...message, ...(tx.target ?? tx.source) });
  }
}
