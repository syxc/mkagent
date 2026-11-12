import type { ToolControl } from '@earendil-works/pi-durable';
import type { AgentToolResult } from './agent-runtime.ts';

/** Carry host controls to the owning run, outside the native model-facing tool result. */
export interface HostControlledToolResult extends AgentToolResult<unknown> {
  durableHostControl?: ToolControl;
}
