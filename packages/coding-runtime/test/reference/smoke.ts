// Explicit opt-in smoke runner: bun run test/reference/smoke.ts <reference-node_modules> <upstream> [scenario-id].
import assert from "node:assert/strict";
import { createReferenceRunner } from "./harness.ts";
import type { Json, JsonObject, OracleScenario, OracleTrace } from "./protocol.ts";
import { getScenario, scenarios } from "./scenarios.ts";
import { assertTraceParity, firstTraceDifference, records } from "./trace.ts";

export function validateNativeTrace(scenario: OracleScenario, trace: OracleTrace): void {
  assert.equal(trace.scenarioId, scenario.id);
  assert.equal(trace.consumedReplies, scenario.replies.length, "Every scripted response must be consumed");
  assert.equal(trace.pendingReplies, 0);
  assert.equal(trace.final.isStreaming, false);
  assert.deepEqual(trace.final.queues, { steering: [], followUp: [] });
  const settled = records(trace, "session", "agent_settled");
  assert.equal(settled.length, 1, "The session must settle exactly once");
  assert.equal(settled[0].data.aborted, Boolean(scenario.abortPreflight));
  const idle = records(trace, "extension", "agent_settled");
  assert.equal(idle[0].data.idle, true, "Extensions observe idle only after final settlement");
  assert.ok(settled[0].seq < records(trace, "harness", "idle_resolved")[0].seq);
  for (const [index, record] of trace.timeline.entries()) assert.equal(record.seq, index);
  const ids = trace.final.entries.map((entry) => object(entry).id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => typeof id === "string" && /^entry-\d+$/.test(id)));
  const agentEnds = records(trace, "agent", "agent_end");
  assert.ok(agentEnds.length > 0);
  assert.ok(agentEnds.at(-1)!.seq < settled[0].seq, "agent_end is distinct from session settlement");

  const requestedCalls = scenario.replies.flatMap((reply) => reply.content.filter((part) => part.type === "toolCall"));
  const results = trace.final.messages.filter((message) => object(message).role === "toolResult").map(object);
  assert.deepEqual(results.map((result) => result.toolCallId), requestedCalls.map((call) => call.id),
    "Tool result transcript order follows assistant source order");
  if (scenario.abortPreflight) {
    assert.deepEqual(trace.effects, [], "A later preflight abort must prevent every file effect");
    assert.equal(records(trace, "tool", "execute_start").length, 0);
    assert.equal(records(trace, "extension", "tool_result").length, 0);
    assert.deepEqual(records(trace, "extension", "tool_call").map((record) => record.data.toolCallId),
      ["call-first", "call-second"]);
    assert.ok(results.every((result) => result.isError === true && JSON.stringify(result.content).includes("Operation aborted")));
    assert.equal(records(trace, "model", "request").at(-1)!.data.signalAborted, true);
    assert.equal(object(trace.final.messages.at(-1)!).stopReason, "aborted");
  } else {
    assert.equal(trace.effects.length, requestedCalls.length);
    assert.deepEqual(
      records(trace, "session", "tool_execution_start").map((event) => event.data.toolCallId),
      requestedCalls.map((call) => call.id),
    );
  }
  if (scenario.completionOrder) {
    assert.deepEqual(trace.effects.map((effect) => effect.toolCallId), scenario.completionOrder);
    assert.deepEqual(records(trace, "session", "tool_execution_end").map((event) => event.data.toolCallId), scenario.completionOrder);
    const starts = records(trace, "tool", "execute_start");
    assert.ok(starts.at(-1)!.seq < records(trace, "tool", "effect")[0].seq, "All tools start before a controlled completion");
  }
  if (scenario.toolExecution === "sequential" || scenario.tools.some((tool) => tool.executionMode === "sequential")) {
    const lifecycle = trace.timeline.filter((record) => record.source === "tool" && ["execute_start", "execute_end"].includes(record.type));
    assert.deepEqual(lifecycle.map((record) => `${record.type}:${record.data.toolCallId}`), requestedCalls.flatMap((call) => [
      `execute_start:${call.id}`, `execute_end:${call.id}`,
    ]), "A sequential tool makes the complete assistant batch sequential");
  }
  if (scenario.transform) {
    const transformed = trace.final.messages.filter((message) => object(message).role === "assistant").map(object);
    assert.ok(transformed.every((message) => JSON.stringify(message.content).includes(scenario.transform!.appendText)));
    assert.ok(transformed.every((message) => object(object(message.usage).cost).total === scenario.transform!.costTotal));
    for (const preflight of records(trace, "extension", "tool_call")) {
      assert.ok(JSON.stringify(preflight.data.messages).includes(scenario.transform.appendText));
      assert.ok(JSON.stringify(preflight.data.entries).includes(scenario.transform.appendText));
    }
    assert.ok(JSON.stringify(records(trace, "model", "request")[1].data.messages).includes(scenario.transform.appendText));
  }
  if (scenario.queues) {
    const users = trace.final.messages.filter((message) => object(message).role === "user").map((message) => messageText(object(message)));
    assert.deepEqual(users, [scenario.prompt, ...scenario.queues.steering, ...scenario.queues.followUp]);
    const queueEvents = records(trace, "session", "queue_update");
    assert.ok(queueEvents.length >= 4);
    assert.deepEqual(queueEvents.at(-1)!.data, { type: "queue_update", steering: [], followUp: [] });
    const requests = records(trace, "model", "request");
    assert.ok(JSON.stringify(requests[1].data.messages).includes("steer one"));
    assert.ok(!JSON.stringify(requests[1].data.messages).includes("follow one"), "Steering drains before follow-up");
  }
  if (scenario.boundary) {
    const compaction = trace.final.entries.map(object).find((entry) => entry.type === "compaction");
    assert.ok(compaction);
    assert.equal(compaction.summary, scenario.boundary.summary);
    assert.equal(compaction.firstKeptEntryId, compaction.id);
    const nextRequest = JSON.stringify(records(trace, "model", "request")[1].data.messages);
    assert.ok(nextRequest.includes(scenario.boundary.summary));
    assert.ok(!nextRequest.includes("discarded answer"));
    assert.ok(!nextRequest.includes(scenario.prompt));
  }
  if (scenario.endFollowUp) {
    assert.equal(records(trace, "session", "agent_end").length, 2);
    assert.equal(agentEnds.length, 2);
    assert.ok(JSON.stringify(trace.final.messages).includes(scenario.endFollowUp));
  }
  if (scenario.id === "plain-text") {
    assert.equal(messageText(object(trace.final.messages.at(-1)!)), "hello oracle");
  }
  if (scenario.tools.some((tool) => tool.progress)) assert.ok(records(trace, "session", "tool_execution_update").length > 0);
}

function object(value: Json): JsonObject {
  assert.ok(value && !Array.isArray(value) && typeof value === "object", "Expected an object in the JSON trace");
  return value;
}

function messageText(message: JsonObject): string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content) ? message.content.map((part) => object(part).text ?? "").join("") : "";
}

if (import.meta.main) {
  const [referenceNodeModules, upstreamRoot, scenarioId] = process.argv.slice(2);
  if (!referenceNodeModules || !upstreamRoot) {
    throw new Error("Usage: bun run test/reference/smoke.ts <isolated-reference-node_modules> <pinned-upstream> [scenario-id]");
  }
  const run = await createReferenceRunner({ referenceNodeModules, upstreamRoot });
  const selected = scenarioId ? [getScenario(scenarioId)] : scenarios;
  const captured = new Map<string, OracleTrace>();
  for (const scenario of selected) {
    const trace = await run(scenario);
    validateNativeTrace(scenario, trace);
    // Fresh processes and sandboxes must produce byte-equivalent normalized behavior.
    assertTraceParity(trace, await run(scenario));
    captured.set(scenario.id, trace);
    console.log(`PASS ${scenario.id}: ${trace.consumedReplies} requests, ${trace.timeline.length} records, ${trace.effects.length} effects; repeat deterministic`);
  }
  const first = captured.get("parallel-first-second");
  const second = captured.get("parallel-second-first");
  if (first && second) {
    assert.deepEqual(first.final.messages, second.final.messages, "Opposite completions must yield the same ordered transcript");
    assert.deepEqual(first.final.context, second.final.context);
  }
  const sample = captured.values().next().value;
  if (sample) {
    const altered = structuredClone(sample);
    altered.final.isStreaming = true;
    assert.ok(firstTraceDifference(sample, altered)?.includes("isStreaming"), "Parity reports a changed public state");
    assert.throws(() => assertTraceParity(sample, altered), /Oracle mismatch/);
  }
  console.log(`PASS ${selected.length} native oracle scenarios`);
}
