import type { PiNativeOwnerControl, PiNativeOwnerEvent, PiNativeWorkerTransfer } from './native-owner-protocol.ts';
import type { PiWorkerScope } from './protocol.ts';
import type { PiWorkerConnection, PiWorkerLease } from './worker-connection.ts';

interface LiveTransfer {
  connection: PiWorkerConnection;
  lease: PiWorkerLease;
  released: boolean;
  adopted: boolean;
}

// Object identity is the authority. A serialized or structurally identical token is invalid.
const transfers = new WeakMap<PiNativeWorkerTransfer, LiveTransfer>();
const sharedConnections = new WeakSet<PiWorkerConnection>();

export function isOwnerTransferConnection(connection: PiWorkerConnection): boolean {
  return sharedConnections.has(connection);
}

export function workerScope(lease: PiWorkerLease): PiWorkerScope {
  return { ownerSessionId: lease.ownerSessionId, runtimeGeneration: lease.generation };
}

export function createOwnerTransfer(
  connection: PiWorkerConnection, lease: PiWorkerLease, onRelease: () => void,
): PiNativeWorkerTransfer {
  const unpin = connection.holdTransfer(lease);
  sharedConnections.add(connection);
  const state: LiveTransfer = { connection, lease, released: false, adopted: false };
  const token: PiNativeWorkerTransfer = Object.freeze({
    sourceScope: Object.freeze(workerScope(lease)),
    transport: connection,
    send: (control: PiNativeOwnerControl) => !state.released && !state.adopted && lease.send({ ...control }),
    release: () => {
      if (state.released) return;
      state.released = true;
      // This lease can never release the target binding.
      lease.release();
      unpin();
      onRelease();
    },
  });
  transfers.set(token, state);
  return token;
}

export function ownerTransferState(token: PiNativeWorkerTransfer): LiveTransfer {
  const state = transfers.get(token);
  if (!state || state.released || state.adopted) throw new Error('Invalid or consumed Pi worker transfer');
  return state;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate owner frames at the JSONL boundary, before any product callback. */
export function parseOwnerEvent(message: Record<string, unknown>, scope: PiWorkerScope): PiNativeOwnerEvent | null {
  if (message.ownerSessionId !== scope.ownerSessionId || message.runtimeGeneration !== scope.runtimeGeneration
    || typeof message.transactionId !== 'string' || !message.transactionId) return null;
  const base = { ...scope, transactionId: message.transactionId };
  switch (message.type) {
    case 'owner_source_closed':
      return { ...base, type: message.type };
    case 'owner_target_bound':
      return typeof message.nativeSessionId === 'string' && message.nativeSessionId
        ? { ...base, type: message.type, nativeSessionId: message.nativeSessionId } : null;
    case 'owner_finished':
      if (message.outcome !== 'complete' && message.outcome !== 'error' && message.outcome !== 'cancelled') return null;
      if (message.error !== undefined && typeof message.error !== 'string') return null;
      return { ...base, type: message.type, outcome: message.outcome, error: message.error };
    case 'owner_failed': {
      const phases = ['preparing', 'prepared', 'source_closed', 'activating', 'target_bound', 'committed', 'finished', 'aborted', 'failed'] as const;
      const phase = phases.find(phase => phase === message.phase);
      return phase && typeof message.sourceClosed === 'boolean' && typeof message.error === 'string'
        ? { ...base, type: message.type, phase, sourceClosed: message.sourceClosed, error: message.error } : null;
    }
    case 'owner_prepare': {
      if (typeof message.sourceNativeSessionId !== 'string' || !message.sourceNativeSessionId
        || (message.inputId !== undefined && typeof message.inputId !== 'string') || !record(message.operation)) return null;
      const op = message.operation;
      let operation: Extract<PiNativeOwnerEvent, { type: 'owner_prepare' }>['operation'];
      if (op.type === 'new' && (op.parentSession === undefined || typeof op.parentSession === 'string')) {
        operation = { type: 'new', parentSession: op.parentSession };
      } else if (op.type === 'fork' && typeof op.entryId === 'string' && op.entryId && (op.position === 'before' || op.position === 'at')) {
        operation = { type: 'fork', entryId: op.entryId, position: op.position };
      } else if (op.type === 'switch' && typeof op.sessionPath === 'string' && op.sessionPath) {
        operation = { type: 'switch', sessionPath: op.sessionPath };
      } else return null;
      let fork: Extract<PiNativeOwnerEvent, { type: 'owner_prepare' }>['fork'];
      if (message.fork !== undefined) {
        const value = message.fork;
        if (!record(value) || (value.nativeLeafId !== null && typeof value.nativeLeafId !== 'string')
          || (value.durableEntryId !== null && !(typeof value.durableEntryId === 'number' && Number.isSafeInteger(value.durableEntryId) && value.durableEntryId >= 0))
          || (value.selectedText !== undefined && typeof value.selectedText !== 'string')) return null;
        fork = { nativeLeafId: value.nativeLeafId, durableEntryId: value.durableEntryId, selectedText: value.selectedText };
      }
      return { ...base, type: message.type, operation, fork, inputId: message.inputId, sourceNativeSessionId: message.sourceNativeSessionId };
    }
    default:
      return null;
  }
}
