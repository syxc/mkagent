// Native Pi request and tool preparation operations; scheduling belongs to pi-durable tasks.
import { streamAssistantResponse as streamCoreResponse, type AgentEventSink } from "@earendil-works/pi-coding-agent";
import { PI_ATTRIBUTION, type AssistantMessage } from "@earendil-works/pi-coding-agent";
import type { AgentContext, AgentLoopConfig, StreamFn } from "./agent-runtime.ts";
export type { AgentEventSink } from "@earendil-works/pi-coding-agent";
// Keep Native defaults separate from the mutable public core identity.
export const DEFAULT_AGENT_IDENTITY: { attribution: typeof PI_ATTRIBUTION } = { attribution: PI_ATTRIBUTION };
export {
  declareToolChanges,
  shouldTerminateToolBatch,
  prepareToolCall,
  createErrorToolResult,
  emitToolExecutionEnd,
  createToolResultMessage,
  emitToolResultMessage,
} from "@earendil-works/pi-coding-agent";
export function streamAssistantResponse(
  context: AgentContext, config: AgentLoopConfig, signal: AbortSignal | undefined,
  emit: AgentEventSink, streamFunction: StreamFn,
): Promise<AssistantMessage> {
  return streamCoreResponse(context, config, signal, emit, streamFunction, DEFAULT_AGENT_IDENTITY);
}
