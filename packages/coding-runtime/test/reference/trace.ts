// Normalize unstable metadata without discarding observed behavior or reordering events.
import { isDeepStrictEqual } from "node:util";
import type { Json, OracleTrace, TraceRecord } from "./protocol.ts";

export function normalizeTrace(trace: OracleTrace, paths: { cwd: string; home: string }): OracleTrace {
  const ids = new Map<string, string>();
  for (const entry of trace.final.entries) {
    if (entry && !Array.isArray(entry) && typeof entry === "object" && typeof entry.id === "string") {
      ids.set(entry.id, `entry-${ids.size + 1}`);
    }
  }
  const visit = (value: unknown, key = ""): unknown => {
    if (key === "timestamp" || key === "durationMs") return 0;
    if (typeof value === "string") {
      if (ids.has(value)) return ids.get(value);
      return value.replaceAll(paths.cwd, "<cwd>").replaceAll(paths.home, "<home>");
    }
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined).map(([name, item]) => [name, visit(item, name)]),
    );
  };
  // The visitor preserves the JSON contract and only replaces scalar metadata.
  return visit(trace) as OracleTrace;
}

export function records(trace: OracleTrace, source: TraceRecord["source"], type: string): TraceRecord[] {
  return trace.timeline.filter((record) => record.source === source && record.type === type);
}

/** Return the first structural difference, including the array index of an ordering mismatch. */
export function firstTraceDifference(expected: Json | OracleTrace, actual: Json | OracleTrace, path = "$"): string | undefined {
  if (isDeepStrictEqual(expected, actual)) return undefined;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return `${path}.length: expected ${expected.length}, received ${actual.length}`;
    for (let index = 0; index < expected.length; index++) {
      const difference = firstTraceDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
  } else if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const left: Record<string, unknown> = { ...expected };
    const right: Record<string, unknown> = { ...actual };
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (!(key in left)) return `${path}.${key}: unexpected field`;
      if (!(key in right)) return `${path}.${key}: missing field`;
      // Both values are descendants of the JSON-only trace boundary.
      const difference = firstTraceDifference(left[key] as Json, right[key] as Json, `${path}.${key}`);
      if (difference) return difference;
    }
  }
  return `${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`;
}

/** Compare the complete contract; callers must opt into any narrower projection themselves. */
export function assertTraceParity(expected: OracleTrace, actual: OracleTrace): void {
  const difference = firstTraceDifference(expected, actual);
  if (difference) throw new Error(`Oracle mismatch for ${expected.scenarioId}: ${difference}`);
}
