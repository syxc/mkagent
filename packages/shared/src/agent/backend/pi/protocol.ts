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
