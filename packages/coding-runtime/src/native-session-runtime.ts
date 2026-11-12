/** Bind public runtime types to the durable session without wrapping SDK execution. */
import {
  AgentSessionRuntime as SDKRuntime,
  createAgentSessionRuntime as createSDKRuntime,
  type CreateAgentSessionRuntimeFactory as SDKFactory,
  type CreateAgentSessionRuntimeResult as SDKResult,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession } from './native-agent-session.ts';

export const AgentSessionRuntime = SDKRuntime<AgentSession>;
export type AgentSessionRuntime = SDKRuntime<AgentSession>;
export const createAgentSessionRuntime = createSDKRuntime<AgentSession>;
export type CreateAgentSessionRuntimeFactory = SDKFactory<AgentSession>;
export type CreateAgentSessionRuntimeResult = SDKResult<AgentSession>;
export * from './native-session-services.ts';
