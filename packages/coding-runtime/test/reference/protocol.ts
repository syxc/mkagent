// JSON-only contract shared by isolated native and durable behavior workers.
export const PROTOCOL_VERSION = 1;
export const PINNED_PI_VERSION = "1.5.0";
export const PINNED_PI_COMMIT = "f9a26365568127461c47a07a37dcb42c140a3ac5";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface ModelReply {
  content: (TextBlock | ToolCallBlock)[];
  stopReason?: "stop" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
}

export interface ScenarioTool {
  name: string;
  executionMode?: "parallel" | "sequential";
  progress?: boolean;
  terminate?: boolean;
}

export interface OracleScenario {
  version: 1;
  id: string;
  prompt: string;
  replies: ModelReply[];
  tools: ScenarioTool[];
  toolExecution?: "parallel" | "sequential";
  /** Tool call IDs released only after all these calls have entered execute(). */
  completionOrder?: string[];
  /** Abort from the real extension tool_call hook for this tool call ID. */
  abortPreflight?: string;
  transform?: { appendText: string; costTotal: number };
  loadout?: { at: "agent_start" | "before_agent_start"; tools: string[] };
  queues?: {
    atRequest: number;
    steering: string[];
    followUp: string[];
    mode?: "all" | "one-at-a-time";
  };
  boundary?: {
    at: "turn_end" | "agent_before_settle";
    summary: string;
  };
  /** Queue once from the real extension agent_end event. */
  endFollowUp?: string;
  /** Two settled actions, with a nested action, must run in native depth-first order. */
  settledActions?: boolean;
}

export interface TraceRecord {
  seq: number;
  source: "model" | "agent" | "session" | "extension" | "tool" | "harness";
  type: string;
  data: JsonObject;
}

export interface OracleSnapshot {
  messages: Json[];
  entries: Json[];
  context: Json;
  queues: { steering: string[]; followUp: string[] };
  isStreaming: boolean;
}

export interface OracleTrace {
  version: 1;
  scenarioId: string;
  timeline: TraceRecord[];
  /** Actual append-only file records, in side-effect order. */
  effects: { toolCallId: string; toolName: string; value: string }[];
  final: OracleSnapshot;
  consumedReplies: number;
  pendingReplies: number;
}

export interface ReferenceProvenance {
  version: string;
  /** HEAD of the explicitly supplied, clean source checkout. */
  sourceCommit: string;
  /** Digest of installed worker inputs; version alone does not attest npm bytes to a commit. */
  installedFilesSha256: Record<string, string>;
}

export interface OracleRequest {
  version: 1;
  scenario: OracleScenario;
  referenceNodeModules: string;
  provenance: ReferenceProvenance;
}

export interface OracleResponse {
  version: 1;
  provenance: ReferenceProvenance;
  trace: OracleTrace;
}

export type ScenarioRunner = (scenario: OracleScenario) => Promise<OracleTrace>;
