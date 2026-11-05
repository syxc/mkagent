import type { PiProxyToolDefinition, PiWorkerInitConfig, PiWorkerScope } from './protocol.ts';
import type { NativeSessionReference } from '../../../sessions/native-session-reference.ts';

export type PiNativeOwnerOperation =
  | { type: 'new'; parentSession?: string }
  | { type: 'fork'; entryId: string; position: 'before' | 'at' }
  | { type: 'switch'; sessionPath: string };

export interface PiNativeForkPlan {
  nativeLeafId: string | null;
  durableEntryId: number | null;
  selectedText?: string;
}

export type PiNativeOwnerPhase =
  | 'preparing' | 'prepared' | 'source_closed' | 'activating' | 'target_bound'
  | 'committed' | 'finished' | 'aborted' | 'failed';

export interface PiNativeOwnerRequest {
  inputId?: string;
  sourceNativeSessionId: string;
  sourceReference?: NativeSessionReference;
  operation: PiNativeOwnerOperation;
  fork?: PiNativeForkPlan;
}

/** Credentials and tools belong only to the live activation frame. */
export interface PiNativeOwnerActivation {
  config: PiWorkerInitConfig;
  tools: PiProxyToolDefinition[];
  systemPrompt: string;
  reason: 'new' | 'fork' | 'resume';
}

export type PiNativeOwnerControl =
  | { type: 'owner_prepared'; transactionId: string; targetSessionId: string }
  | { type: 'owner_activate'; transactionId: string; activation: PiNativeOwnerActivation }
  | { type: 'owner_committed'; transactionId: string }
  | { type: 'owner_abort'; transactionId: string; error: string };

export type PiNativeOwnerEventBody =
  | ({ type: 'owner_prepare'; transactionId: string } & PiNativeOwnerRequest)
  | { type: 'owner_source_closed'; transactionId: string; reference?: NativeSessionReference }
  | { type: 'owner_target_bound'; transactionId: string; nativeSessionId: string; reference?: NativeSessionReference }
  | { type: 'owner_finished'; transactionId: string; outcome: 'complete' | 'error' | 'cancelled'; error?: string }
  | { type: 'owner_failed'; transactionId: string; phase: PiNativeOwnerPhase; sourceClosed: boolean; error: string };

export type PiNativeOwnerEvent = PiNativeOwnerEventBody & PiWorkerScope;

/** Live transfer token. Its transport identity and callbacks must never be persisted. */
export interface PiNativeWorkerTransfer {
  readonly sourceScope: PiWorkerScope;
  readonly transport: object;
  send(control: PiNativeOwnerControl): boolean;
  release(): void;
}

/** Product-facing operations; physical process ownership remains inside the backend. */
export interface PiNativeOwnerBackend {
  assertAvailable?(): void;
  prepareActivation(): Promise<PiNativeOwnerActivation>;
  detachForOwner(): Promise<PiNativeWorkerTransfer>;
  adoptForOwner(transfer: PiNativeWorkerTransfer, transactionId: string): PiWorkerScope;
  sendOwnerControl(control: PiNativeOwnerControl): boolean;
  releaseForOwner(): Promise<void>;
}

export interface PiNativeOwnerHostPort {
  /** Suppress automatic UI startup while an unpublished target is being prepared. */
  readonly deferStartup?: boolean;
  onProjection?(reference: NativeSessionReference, backend: PiNativeOwnerBackend, transport: object): Promise<void>;
  onEvent(event: PiNativeOwnerEvent, backend: PiNativeOwnerBackend, transport: object): Promise<void>;
  onExit(backend: PiNativeOwnerBackend, transport: object, error: Error): Promise<void>;
}
