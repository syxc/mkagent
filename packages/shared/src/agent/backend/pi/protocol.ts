import type { CustomEndpointConfig } from '../../../config/llm-connections.ts';
import type { NativeSessionReference } from '../../../sessions/native-session-reference.ts';

export type PiWorkerCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string };

/** Configuration is sent only over the live worker transport, never a transition record. */
export interface PiWorkerInitConfig {
  agentProfile?: 'default' | 'coding';
  codingResources?: PiCodingResources;
  extensionUIAvailable?: boolean;
  apiKey: string;
  model: string;
  cwd: string;
  thinkingLevel: string;
  workspaceRootPath: string;
  sessionId: string;
  sessionPath: string;
  workingDirectory: string;
  plansFolderPath: string;
  miniModel?: string;
  agentDir?: string;
  providerType?: string;
  authType?: string;
  workspaceId?: string;
  baseUrl?: string;
  branchFromSdkSessionId?: string;
  branchFromSessionPath?: string;
  branchFromSdkTurnId?: string;
  nativeFork?: { leaf: string | null; source: NativeSessionReference };
  nativeResume?: NativeSessionReference;
  nativeParent?: NativeSessionReference;
  customEndpoint?: CustomEndpointConfig;
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
  autoCompactWindow?: number;
  piAuth?: { provider: string; credential: PiWorkerCredential };
}

export interface PiProxyToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Product ownership is independent of the native coding session ID. */
export interface PiWorkerScope {
  readonly ownerSessionId: string;
  readonly runtimeGeneration: number;
}

/** Raw Pi SDK context metadata on JSONL events/responses. No runtime imports. */
export interface PiCodingResources {
  agentDir?: string;
  /** Native session execution does not require automatic Pi resource discovery. */
  resourcePolicy?: 'native' | 'host-only';
  projectTrusted?: boolean;
  extensionPaths?: string[];
  skillPaths?: string[];
  promptPaths?: string[];
}

export interface PiContextUsagePayload {
  contextUsage?: { tokens: number | null; contextWindow: number; percent?: number | null };
  compactionSettings?: { enabled: boolean; reserveTokens: number };
}

export interface PiCompactResult extends PiContextUsagePayload {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  /** Fresh local estimate supplied by the SDK, not pre-compaction API usage. */
  estimatedTokensAfter?: number;
}
