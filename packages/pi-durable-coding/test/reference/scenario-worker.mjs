// The scenario driver is shared; each worker injects its independent coding implementation.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeTrace } from "./trace.ts";
import { PINNED_PI_COMMIT, PINNED_PI_VERSION, PROTOCOL_VERSION } from "./protocol.ts";

export async function readRequest() {
if (process.env.PI_ORACLE_WORKER !== "1") throw new Error("Launch native-worker through the isolated harness");
const request = JSON.parse(await Bun.stdin.text());
if (request.version !== PROTOCOL_VERSION || request.scenario?.version !== PROTOCOL_VERSION ||
    request.provenance?.sourceCommit !== PINNED_PI_COMMIT || request.provenance?.version !== PINNED_PI_VERSION) {
  throw new Error("Unsupported oracle request or reference pin");
}
return request;
}

export async function runScenario(request, { coding, core, ai, auth, loader, stores, schema, persistence }) {

// A failed accidental network attempt becomes a test failure before any request leaves the worker.
globalThis.fetch = async () => { throw new Error("Network is disabled in the Pi behavior oracle"); };

const scenario = request.scenario;
const cwd = process.cwd();
const timeline = [];
const record = (source, type, data = {}) => timeline.push({
  seq: timeline.length, source, type, data: structuredClone(data),
});
const effectPath = join(cwd, "effects.jsonl");
const faux = ai.registerFauxProvider({
  provider: "pi-oracle", api: "pi-oracle-faux",
  models: [{ id: "oracle-model", name: "Oracle model", contextWindow: 1_000_000, maxTokens: 4096 }],
  tokenSize: { min: 4096, max: 4096 },
});
const model = faux.getModel();
const credentials = auth.AuthStorage.inMemory();
await credentials.modify(model.provider, async () => ({ type: "api_key", key: "synthetic-oracle-key" }));
const modelRuntime = await coding.ModelRuntime.create({
  credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  modelsStore: new stores.InMemoryCodingAgentModelsStore(),
});
modelRuntime.registerProvider(model.provider, {
  baseUrl: model.baseUrl, apiKey: "synthetic-oracle-key", api: faux.api, models: faux.models,
});
const settingsManager = coding.SettingsManager.inMemory({
  compaction: { enabled: false }, retry: { enabled: false },
});
const persisted = await persistence?.(cwd);
const sessionManager = persisted?.manager ?? coding.SessionManager.inMemory(cwd);
const completionOrder = scenario.completionOrder ?? [];
const gates = new Map(completionOrder.map((id) => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return [id, { promise, release }];
}));
const started = new Set();
let released = 0;
let session;
let boundaryHandled = false;
let endFollowUpHandled = false;
let settledPass = 0;
const extensionRuntime = loader.createExtensionRuntime();
const extension = await loader.loadExtensionFromFactory((pi) => {
  if (scenario.loadout) pi.on(scenario.loadout.at, () => {
    pi.setActiveTools(scenario.loadout.tools);
    record("extension", "loadout_changed", { active: pi.getActiveTools() });
  });
  for (const definition of scenario.tools) {
    pi.registerTool({
      name: definition.name, label: definition.name, description: "Append a synthetic record to the oracle effect file.",
      parameters: schema.obj({ value: schema.str() }),
      executionMode: definition.executionMode,
      execute: async (toolCallId, { value }, signal, onUpdate) => {
        record("tool", "execute_start", { toolCallId, toolName: definition.name, value });
        if (definition.progress) onUpdate?.({ content: [{ type: "text", text: `working:${value}` }], details: { phase: "working" } });
        started.add(toolCallId);
        if (gates.has(toolCallId)) {
          if (completionOrder.every((id) => started.has(id))) gates.get(completionOrder[released++]).release();
          await gates.get(toolCallId).promise;
        }
        if (signal?.aborted) throw new Error("Operation aborted before effect");
        const effect = { toolCallId, toolName: definition.name, value };
        appendFileSync(effectPath, `${JSON.stringify(effect)}\n`);
        record("tool", "effect", effect);
        record("tool", "execute_end", effect);
        return {
          content: [{ type: "text", text: `recorded:${value}` }],
          details: { value }, ...(definition.terminate ? { terminate: true } : {}),
        };
      },
    });
  }
  pi.on("message_end", async (event) => {
    record("extension", "message_end", { message: event.message });
    if (event.message.role !== "assistant" || !scenario.transform) return;
    // Yield so that a missing awaited message_end barrier is observable before preflight.
    await Promise.resolve();
    const message = {
      ...event.message,
      content: event.message.content.map((part) => part.type === "text"
        ? { ...part, text: part.text + scenario.transform.appendText } : part),
      usage: { ...event.message.usage, cost: { ...event.message.usage.cost, total: scenario.transform.costTotal } },
    };
    record("extension", "message_transformed", { message });
    return { message };
  });
  pi.on("tool_call", (event, ctx) => {
    record("extension", "tool_call", {
      toolCallId: event.toolCallId, toolName: event.toolName, input: event.input,
      messages: session.messages, entries: sessionManager.getEntries(),
    });
    if (event.toolCallId === scenario.abortPreflight) {
      record("extension", "abort_preflight", { toolCallId: event.toolCallId });
      ctx.abort();
    }
  });
  pi.on("tool_result", (event) => { record("extension", "tool_result", { ...event }); });
  for (const boundary of ["turn_end", "agent_before_settle"]) {
    pi.on(boundary, (event, ctx) => {
      record("extension", boundary, { ...event, idle: ctx.isIdle() });
      if (scenario.boundary?.at !== boundary || boundaryHandled) return;
      boundaryHandled = true;
      const result = {
        entries: [{ type: "compaction", summary: scenario.boundary.summary, firstKeptEntryId: null }],
        continue: true,
      };
      record("extension", "boundary_result", { boundary, result });
      return result;
    });
  }
  pi.on("agent_end", (event, ctx) => {
    record("extension", "agent_end", { ...event, idle: ctx.isIdle() });
    if (!scenario.endFollowUp || endFollowUpHandled) return;
    endFollowUpHandled = true;
    pi.sendUserMessage(scenario.endFollowUp, { deliverAs: "followUp" });
    record("extension", "end_follow_up_queued", { text: scenario.endFollowUp });
  });
  pi.on("agent_settled", async (event, ctx) => {
    record("extension", "agent_settled", { ...event, idle: ctx.isIdle() });
    if (!scenario.settledActions) return;
    if (settledPass++ === 0) {
      await session.prompt("settled A", { expandPromptTemplates: false });
      await session.sendCustomMessage({ customType: "settled B", content: "settled B", display: true },
        { triggerTurn: true });
      record("extension", "settled_accepted", { batch: ["A", "B"] });
    } else if (settledPass === 2) {
      await session.prompt("settled C", { expandPromptTemplates: false });
      record("extension", "settled_accepted", { batch: ["C"] });
    }
  });
  if (scenario.settledActions) pi.on("agent_settled", (_event, ctx) => {
    record("extension", "settled_second_handler", { idle: ctx.isIdle() });
  });
}, cwd, coding.createEventBus(), extensionRuntime, "<inline:oracle>");

// No project discovery, package loading, skills, context files, or user's default extensions.
const extensionsResult = { extensions: [extension], errors: [], runtime: extensionRuntime };
const resourceLoader = {
  getExtensions: () => extensionsResult,
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are an oracle test assistant.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {}, reload: async () => {},
};
let requests = 0;
const agent = new core.Agent({
  ...(persisted?.binding ? { durable: persisted.binding } : {}),
  getApiKey: () => "synthetic-oracle-key",
  streamFn: (requestModel, context, options) => {
    requests++;
    record("model", "request", {
      index: requests, model: { provider: requestModel.provider, id: requestModel.id },
      signalAborted: options?.signal?.aborted ?? false, messages: context.messages,
    });
    return ai.streamSimple(requestModel, context, options);
  },
  convertToLlm: coding.convertToLlm,
  initialState: { model, systemPrompt: "", tools: [] },
  toolExecution: scenario.toolExecution ?? "parallel",
});
session = new coding.AgentSession({
  agent, sessionManager, settingsManager, modelRuntime, resourceLoader, cwd,
  baseToolsOverride: {}, initialActiveToolNames: scenario.tools.map((tool) => tool.name),
});
session.subscribe((event) => record("session", event.type, { ...event }));
agent.subscribe((event) => {
  record("agent", event.type, { ...event });
  if (event.type === "tool_execution_end" && completionOrder.includes(event.toolCallId) && released < completionOrder.length) {
    gates.get(completionOrder[released++]).release();
  }
});

faux.setResponses(scenario.replies.map((reply) => async () => {
  if (scenario.queues?.atRequest === requests) {
    for (const text of scenario.queues.steering) await session.steer(text);
    for (const text of scenario.queues.followUp) await session.followUp(text);
    record("harness", "queues_enqueued", { steering: session.getSteeringMessages(), followUp: session.getFollowUpMessages() });
  }
  return ai.fauxAssistantMessage(reply.content, {
    stopReason: reply.stopReason ?? "stop", errorMessage: reply.errorMessage,
    timestamp: 1000 + requests, responseId: `oracle-response-${requests}`,
  });
}));

try {
  await session.bindExtensions({ onError: (error) => { throw new Error(`Oracle extension failed: ${error.stack ?? error.error ?? error.message ?? String(error)}`); } });
  if (scenario.queues?.mode) {
    session.setSteeringMode(scenario.queues.mode);
    session.setFollowUpMode(scenario.queues.mode);
  }
  record("harness", "ready", { activeTools: session.getActiveToolNames(), steering: session.getSteeringMessages(), followUp: session.getFollowUpMessages() });
  await session.prompt(scenario.prompt, { expandPromptTemplates: false });
  record("harness", "prompt_resolved", { isStreaming: session.isStreaming });
  await session.waitForIdle();
  await persisted?.flush();
  record("harness", "idle_resolved", { isStreaming: session.isStreaming });
  if (requests > scenario.replies.length) throw new Error(`Unscripted oracle model request: ${requests}`);
  const effects = existsSync(effectPath) ? readFileSync(effectPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const trace = normalizeTrace({
    version: PROTOCOL_VERSION, scenarioId: scenario.id, timeline, effects,
    final: {
      messages: structuredClone(session.messages), entries: structuredClone(sessionManager.getEntries()),
      context: structuredClone(sessionManager.buildSessionContext()),
      queues: { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] },
      isStreaming: session.isStreaming,
    },
    consumedReplies: requests, pendingReplies: faux.getPendingResponseCount(),
  }, { cwd, home: process.env.HOME });
  return { version: PROTOCOL_VERSION, provenance: request.provenance, trace };
} finally {
  session.dispose();
  await agent.durable?.close();
  await persisted?.close();
  faux.unregister();
}
}
