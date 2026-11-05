import type { BoundPr, PrMonitorState } from '../protocol/pr-watch'
import type {
  ContextUsageSnapshot,
  MessageRole,
  StoredAttachment,
  StoredMessage,
  ToolStatus,
} from '@mkagent/core/types';
import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { NativeSessionReference } from './native-session-reference.ts';

export const SESSION_PERSISTENT_FIELDS = [
  'id', 'workspaceRootPath', 'sdkSessionId', 'sdkCwd',
  'createdAt', 'lastUsedAt', 'lastMessageAt',
  'name', 'isFlagged', 'hidden',
  'lastReadMessageId', 'hasUnread',
  'permissionMode', 'previousPermissionMode', 'workingDirectory',
  'model', 'llmConnection', 'connectionLocked', 'thinkingLevel',
  'pendingPlanExecution', 'nativeSessionOwner', 'nativeSessionProjection',
  'isArchived', 'archivedAt',
  'branchFromMessageId', 'branchFromSdkSessionId', 'branchFromSessionPath',
  'branchFromSdkCwd', 'branchFromSdkTurnId',
  'parentSessionId', 'codingMode', 'boundPrs', 'prMonitors', 'transferredSessionSummary', 'transferredSessionSummaryApplied',
] as const;

export type SessionPersistentField = (typeof SESSION_PERSISTENT_FIELDS)[number];

export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextWindow?: number;
  contextUsage?: ContextUsageSnapshot;
}

export type { StoredMessage } from '@mkagent/core/types';

export interface PendingPlanExecution {
  planPath: string;
  draftInputSnapshot?: string;
  awaitingCompaction: boolean;
  executionDispatched?: boolean;
}

/** Recovery evidence only. Live workers, callers and callbacks never enter this record. */
export interface NativeSessionOwnerRecord {
  transactionId: string;
  role: 'source' | 'target';
  sourceSessionId: string;
  targetSessionId?: string;
  sourceNativeSessionId: string;
  targetNativeSessionId?: string;
  operation: 'new' | 'fork' | 'switch';
  targetReference?: NativeSessionReference;
  fork?: {
    entryId: string;
    position: 'before' | 'at';
    nativeLeafId: string | null;
    durableEntryId: number | null;
    source: NativeSessionReference;
    inputId?: string;
  };
  phase: 'preparing' | 'prepared' | 'source_closed' | 'activating' | 'target_bound' | 'committed' | 'finished' | 'aborted' | 'failed';
  committed: boolean;
  callbacks: 'blocked' | 'authorized' | 'finished' | 'interrupted';
  unpublished?: boolean;
  error?: string;
}

export interface SessionConfig {
  id: string;
  sdkSessionId?: string;
  workspaceRootPath: string;
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  lastMessageAt?: number;
  isFlagged?: boolean;
  permissionMode?: PermissionMode;
  previousPermissionMode?: PermissionMode;
  lastReadMessageId?: string;
  hasUnread?: boolean;
  workingDirectory?: string;
  sdkCwd?: string;
  model?: string;
  llmConnection?: string;
  connectionLocked?: boolean;
  thinkingLevel?: ThinkingLevel;
  codingMode?: boolean;
  boundPrs?: BoundPr[];
  prMonitors?: Record<string, PrMonitorState>;
  transferredSessionSummary?: string;
  transferredSessionSummaryApplied?: boolean;
  pendingPlanExecution?: PendingPlanExecution;
  hidden?: boolean;
  isArchived?: boolean;
  archivedAt?: number;
  branchFromMessageId?: string;
  branchFromSdkSessionId?: string;
  branchFromSessionPath?: string;
  branchFromSdkCwd?: string;
  branchFromSdkTurnId?: string;
  parentSessionId?: string;
  nativeSessionOwner?: NativeSessionOwnerRecord;
  nativeSessionProjection?: NativeSessionReference;
}

export interface StoredSession extends SessionConfig {
  messages: StoredMessage[];
  /** Inactive product rows stay outside header metadata and the active transcript. */
  nativeArchivedMessages?: StoredMessage[];
  tokenUsage: SessionTokenUsage;
}

export interface SessionHeader extends SessionConfig {
  messageCount: number;
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  preview?: string;
  tokenUsage: SessionTokenUsage;
  lastFinalMessageId?: string;
}

export interface SessionMetadata extends SessionConfig {
  messageCount: number;
  preview?: string;
  planCount?: number;
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  lastFinalMessageId?: string;
  tokenUsage?: SessionTokenUsage;
}

export interface AuthRequestMessage {
  id: string;
  role: 'error';
  content: string;
  timestamp: number;
}

export interface SessionRuntimeMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  attachments?: StoredAttachment[];
  toolStatus?: ToolStatus;
}
