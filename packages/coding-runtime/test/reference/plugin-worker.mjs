// Run the shared contract plugin against the independent pinned native runtime.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizeTrace } from "./trace.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

export async function runPluginScenario(request, { coding, core, ai, auth, loader, stores }) {
  globalThis.fetch = async () => { throw new Error("Network is disabled in the native plugin oracle"); };
  const cwd = process.cwd();
  const agentDir = join(process.env.HOME, ".pi", "agent");
  const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
  const paths = ["rpc-demo.ts", "confirm-destructive.ts", "session-name.ts"]
    .map(name => join(fixtures, "upstream", name));
  paths.push(join(fixtures, "session-contract.ts"));
  const faux = ai.registerFauxProvider({
    provider: "plugin-oracle", api: "plugin-oracle-faux",
    models: [{ id: "plugin-model", name: "Plugin model", contextWindow: 100_000, maxTokens: 4096 }],
  });
  // Native reload resets global providers; the fixture owns its explicit local transport.
  const fauxApi = ai.getApiProvider(faux.api);
  assert(fauxApi);
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
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const timeline = [];
  let allow = false;
  let editorText = "";
  let requests = 0;
  const record = (type, data) => timeline.push({ seq: timeline.length, source: "harness", type, data });
  const create = async ({ sessionManager, sessionStartEvent }) => {
    let extensions = await loader.loadExtensions(paths, cwd, coding.createEventBus());
    assert.deepEqual(extensions.errors, []);
    const resourceLoader = {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "You are a native plugin oracle.", getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {},
      reload: async () => { extensions = await loader.loadExtensions(paths, cwd, coding.createEventBus()); },
    };
    const agent = new core.Agent({
      getApiKey: () => "synthetic-oracle-key", convertToLlm: coding.convertToLlm,
      initialState: { model, systemPrompt: "", tools: [] },
      streamFn: (...args) => { requests++; return fauxApi.streamSimple(...args); },
    });
    const session = new coding.AgentSession({
      agent, cwd, sessionManager, settingsManager, modelRuntime, resourceLoader, sessionStartEvent,
      baseToolsOverride: {}, initialActiveToolNames: [],
    });
    return { session, services: { cwd, agentDir, settingsManager, modelRuntime, resourceLoader, diagnostics: [] },
      diagnostics: [] };
  };
  const runtime = await coding.createAgentSessionRuntime(create, {
    cwd, agentDir, sessionManager: coding.SessionManager.create(cwd, join(cwd, "native-sessions")),
  });
  const bind = async () => {
    const session = runtime.session;
    await session.bindExtensions({
      mode: "rpc",
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        input: async () => "native response", editor: async () => "native\neditor",
        confirm: async title => { record("confirm", { title, confirmed: allow }); return allow; },
        select: async (title, options) => {
          const value = title.startsWith("Dangerous command:") ? "Block" : options[allow ? 0 : 1];
          record("select", { title, value }); return value;
        },
        notify: (message, level) => record("notify", { message, level }),
        setTitle: title => record("title", { title }), setWidget: (key, content) => record("widget", { key, content }),
        setEditorText: text => { editorText = text; record("editor", { text }); },
      },
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: options => runtime.newSession(options),
        fork: (id, options) => runtime.fork(id, options),
        switchSession: (path, options) => runtime.switchSession(path, options),
        navigateTree: (id, options) => session.navigateTree(id, options),
        reload: () => session.reload(),
      },
      onError: error => { throw new Error(`Native plugin error: ${error.error}`); },
    });
  };
  runtime.setRebindSession(bind);
  const run = async command => {
    await runtime.session.prompt(command);
    await runtime.session.waitForIdle();
    const failure = runtime.session.messages.find(message => message.role === "assistant"
      && message.stopReason === "error");
    assert.equal(failure?.errorMessage, undefined, `Native model failed during ${command}`);
  };
  const reply = () => faux.setResponses([() => ai.fauxAssistantMessage([{ type: "text", text: "local plugin reply" }])]);
  const hasUser = text => runtime.session.messages.some(message => message.role === "user"
    && JSON.stringify(message.content).includes(text));
  const sourceId = runtime.session.sessionId;
  try {
    await bind();
    await run("/session-name Upstream product name");
    assert.equal(runtime.session.sessionManager.getSessionName(), "Upstream product name");
    for (const command of ["/rpc-input", "/rpc-editor", "/rpc-prefill"]) await run(command);
    assert(timeline.some(event => event.data.message === "You entered: native response"));
    assert(timeline.some(event => event.data.message === "Editor submitted (2 lines)"));
    assert.equal(editorText, "This text was set by the rpc-demo extension.");
    assert.equal(requests, 0);
    reply(); await run("source plugin marker");
    const sourceFile = runtime.session.sessionFile;
    const user = runtime.session.sessionManager.getEntries().find(entry => entry.type === "message"
      && entry.message.role === "user");
    assert(user);
    await run("/contract-new");
    await run(`/contract-fork ${user.id}`);
    assert.equal(runtime.session.sessionId, sourceId);
    assert(timeline.some(event => event.data.message === "Clear cancelled"));
    assert(timeline.some(event => event.data.message === "Fork cancelled"));
    await run(`/contract-tree ${user.id}`);
    assert.equal(editorText, "source plugin marker");
    await run("/contract-reload");
    await run("/session-name Reloaded upstream name");
    assert.equal(runtime.session.sessionManager.getSessionName(), "Reloaded upstream name");
    allow = true;
    reply(); await run("/contract-new");
    assert.notEqual(runtime.session.sessionId, sourceId);
    assert(hasUser("contract new callback"));
    assert(!hasUser("source plugin marker"));
    allow = false;
    await run(`/contract-switch ${sourceFile}`);
    assert(timeline.some(event => event.data.message === "Switch cancelled"));
    allow = true;
    reply(); await run(`/contract-switch ${sourceFile}`);
    assert.equal(runtime.session.sessionId, sourceId);
    assert(hasUser("contract switch callback"));
    reply(); await run(`/contract-fork ${user.id}`);
    assert.notEqual(runtime.session.sessionId, sourceId);
    assert(hasUser("contract fork callback"));
    assert(hasUser("source plugin marker"));
    await run("/session-name Forked upstream target");
    assert.equal(runtime.session.sessionManager.getSessionName(), "Forked upstream target");
    // Native print mode skips interactive confirmation, while the destructive tool hook still blocks.
    runtime.session.extensionRunner.setUIContext(undefined, "print");
    const blocked = await runtime.session.extensionRunner.emitToolCall({
      type: "tool_call", toolCallId: "oracle-blocked", toolName: "bash", input: { command: "rm -r fixture-only" },
    });
    assert.equal(blocked?.block, true);
    const trace = normalizeTrace({
      version: PROTOCOL_VERSION, scenarioId: request.scenario.id, timeline, effects: [],
      final: { messages: structuredClone(runtime.session.messages),
        entries: structuredClone(runtime.session.sessionManager.getEntries()),
        context: structuredClone(runtime.session.sessionManager.buildSessionContext()),
        queues: { steering: [], followUp: [] }, isStreaming: runtime.session.isStreaming },
      consumedReplies: requests, pendingReplies: faux.getPendingResponseCount(),
    }, { cwd, home: process.env.HOME });
    return { version: PROTOCOL_VERSION, provenance: request.provenance, trace };
  } finally {
    await runtime.dispose();
    faux.unregister();
  }
}
