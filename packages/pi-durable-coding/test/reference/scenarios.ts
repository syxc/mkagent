// Reusable deterministic inputs; these contain no native or durable implementation imports.
import type { ModelReply, OracleScenario, ToolCallBlock } from "./protocol.ts";

const text = (value: string): ModelReply => ({ content: [{ type: "text", text: value }] });
const call = (id: string, value: string, name = "record"): ToolCallBlock => ({
  type: "toolCall", id, name, arguments: { value },
});
const toolReply = (...content: ToolCallBlock[]): ModelReply => ({ content, stopReason: "toolUse" });
const base = { version: 1, prompt: "Run the scripted scenario.", tools: [] } satisfies Partial<OracleScenario>;
const pair = toolReply(call("call-first", "first"), call("call-second", "second"));

export const scenarios: readonly OracleScenario[] = [
  { ...base, id: "plain-text", replies: [text("hello oracle")] },
  { ...base, id: "settled-actions-nested", settledActions: true,
    replies: [text("initial"), text("A"), text("C"), text("B")] },
  ...(["agent_start", "before_agent_start"] as const).map((at): OracleScenario => ({
    ...base, id: `${at}-loadout`, tools: [{ name: "record" }],
    loadout: { at, tools: [] }, replies: [text("loadout selected")],
  })),
  {
    ...base, id: "tool-round-trip", tools: [{ name: "record", progress: true }],
    replies: [toolReply(call("call-one", "one")), text("recorded one")],
  },
  {
    ...base, id: "message-end-transform", tools: [{ name: "record" }],
    transform: { appendText: " [transformed]", costTotal: 0.125 },
    replies: [
      { content: [{ type: "text", text: "before tool" }, call("call-one", "one")], stopReason: "toolUse" },
      text("after tool"),
    ],
  },
  ...[
    { id: "parallel-second-first", order: ["call-second", "call-first"] },
    { id: "parallel-first-second", order: ["call-first", "call-second"] },
  ].map(({ id, order }): OracleScenario => ({
    ...base, id, tools: [{ name: "record", progress: true }],
    completionOrder: order, replies: [pair, text("both recorded")],
  })),
  {
    ...base, id: "whole-batch-sequential",
    tools: [{ name: "record", progress: true }, { name: "serial_record", executionMode: "sequential" }],
    replies: [
      toolReply(call("call-first", "first"), call("call-second", "second", "serial_record"), call("call-third", "third")),
      text("three recorded"),
    ],
  },
  {
    ...base, id: "global-sequential", toolExecution: "sequential",
    tools: [{ name: "record" }], replies: [pair, text("both recorded")],
  },
  {
    ...base, id: "abort-later-preflight", abortPreflight: "call-second",
    tools: [{ name: "record" }],
    // Pi opens one more stream with the already-aborted signal after cancelling the batch.
    replies: [pair, { content: [], stopReason: "aborted", errorMessage: "Operation aborted" }],
  },
  {
    ...base, id: "queued-steer-follow-up",
    queues: { atRequest: 1, steering: ["steer one", "steer two"], followUp: ["follow one", "follow two"] },
    replies: [text("initial"), text("steered one"), text("steered two"), text("followed one"), text("followed two")],
  },
  {
    ...base, id: "queued-all",
    queues: { atRequest: 1, mode: "all", steering: ["steer one", "steer two"], followUp: ["follow one", "follow two"] },
    replies: [text("initial"), text("steered both"), text("followed both")],
  },
  {
    ...base, id: "turn-boundary-continuation",
    boundary: { at: "turn_end", summary: "exact oracle handoff" },
    replies: [text("discarded answer"), text("continued from handoff")],
  },
  {
    ...base, id: "before-settle-continuation",
    boundary: { at: "agent_before_settle", summary: "exact oracle handoff" },
    replies: [text("discarded answer"), text("continued from handoff")],
  },
  {
    ...base, id: "agent-end-follow-up", endFollowUp: "follow-up from agent_end",
    replies: [text("first run"), text("second run")],
  },
  {
    ...base, id: "terminating-tool-batch", tools: [{ name: "record", terminate: true }],
    replies: [pair],
  },
];

export function getScenario(id: string): OracleScenario {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Unknown oracle scenario: ${id}`);
  return structuredClone(scenario);
}
