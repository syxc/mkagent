import { isDeepStrictEqual } from 'node:util';
import type { AgentToolCallOutcome, AgentToolResult } from './agent-runtime.ts';

const hostUsageAccounted = Symbol('mkagent.host-usage-accounted');

/** Preserve display usage through wrapper spreads without charging its official children again. */
export function markHostUsageAccounted<T extends AgentToolResult<unknown>>(result: T): T {
  return Object.assign(result, { [hostUsageAccounted]: structuredClone(result.usage ?? true) });
}

export function isHostUsageAccounted(result: AgentToolResult<unknown>): boolean {
  return isDeepStrictEqual(Object.getOwnPropertyDescriptor(result, hostUsageAccounted)?.value, result.usage ?? true);
}

export function withoutHostUsageMarker(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
  if (!Object.hasOwn(result, hostUsageAccounted)) return result;
  const descriptors = Object.getOwnPropertyDescriptors(result);
  Reflect.deleteProperty(descriptors, hostUsageAccounted);
  return Object.create(Object.getPrototypeOf(result), descriptors);
}

/** The persisted flag belongs to the receipt; the Native result retains its original public shape. */
export function restoreHostUsageOutcome(
  outcome: AgentToolCallOutcome & { hostUsageAccounted?: true },
): AgentToolCallOutcome {
  if (!outcome.hostUsageAccounted) return outcome;
  const native = { ...outcome, result: markHostUsageAccounted({ ...outcome.result }) };
  delete native.hostUsageAccounted;
  return native;
}
