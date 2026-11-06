/** Reuse the public agent protocol while keeping execution owned by pi-durable. */
import type { AgentLoopConfig as CoreAgentLoopConfig } from '@earendil-works/pi-agent-core';
import type { DurableLoopBinding } from './durable-coding/engine.ts';

export type {
  AfterToolCallContext, AfterToolCallResult, AgentContext, AgentEvent, AgentLoopTurnUpdate,
  AgentMessage, AgentRequestUpdate, AgentState, AgentTool, AgentToolCall, AgentToolCallOutcome,
  AgentToolParams, AgentToolResult, AgentToolUpdateCallback, AgentTurnContext, AgentTurnDecision,
  BeforeToolCallContext, BeforeToolCallResult, CustomAgentMessages, FinishTurn, PrepareNextTurnContext,
  PrepareRequest, PrepareRequestContext, QueueMode, StreamFn, ThinkingLevel, ToolExecutionMode,
} from '@earendil-works/pi-agent-core';

export interface AgentLoopConfig extends CoreAgentLoopConfig {
  durable?: DurableLoopBinding;
}

export * from './durable-agent.ts';
export * from './durable-loop.ts';
export * from './stream-proxy.ts';
export { setDefaultStreamFn } from './stream-fn.ts';
