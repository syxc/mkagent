/** Keep the host's durable state and tool boundaries reproducible from pinned native sources. */
function edit(source: string, before: string, after: string): string {
  if (!source.includes(before)) throw new Error('Pinned native session boundary changed: ' + before);
  return source.replace(before, after);
}

export function portAgentFacade(source: string): string {
  let body = edit('import type { TaskId } from "@earendil-works/pi-durable";\n' + source,
    'this.durable = runtimeOptions.durable ?? new DurableLoopBinding();',
    'this.durable = runtimeOptions.durable ?? new DurableLoopBinding();\n\t\tthis.durable.setMessageRestorer(messages => { this._state.messages = messages; });');
  body = edit(body, '\thasItems(): boolean {',
    '\tsnapshot(): AgentMessage[] { return this.messages.slice(); }\n\n\thasItems(): boolean {');
  for (const method of ['steer', 'followUp']) body = edit(body,
    `\t${method}(message: AgentMessage): void {`,
    `\t${method}(message: AgentMessage): void {\n\t\tthis.durable.identifyQueuedMessage(message);`);
  for (const [method, queue] of [['clearSteeringQueue', 'steeringQueue'], ['clearFollowUpQueue', 'followUpQueue']]) {
    body = edit(body, `\t${method}(): void {`,
      `\t${method}(): void {\n\t\tthis.durable.discardQueuedInputs(this.${queue}.snapshot());`);
  }
  body = edit(body, '\tprivate normalizePromptInput(', `\t/** Serialize pending inputs without draining their native queue modes. */
\texportDurableQueues() {
\t\treturn { steering: this.steeringQueue.snapshot(), followUp: this.followUpQueue.snapshot(),
\t\t\tsteeringMode: this.steeringMode, followUpMode: this.followUpMode };
\t}

\trestoreDurableQueues(state: ReturnType<Agent["exportDurableQueues"]>): void {
\t\tthis.steeringQueue.clear();
\t\tthis.followUpQueue.clear();
\t\tthis.steeringMode = state.steeringMode;
\t\tthis.followUpMode = state.followUpMode;
\t\tfor (const message of state.steering) this.steer(message);
\t\tfor (const message of state.followUp) this.followUp(message);
\t}

\t/** Resume a persisted durable run after the session has rebound its resources and listeners. */
\tasync resumeDurable(onBound?: () => void, taskId?: TaskId): Promise<boolean> {
\t\tif (this.activeRun) throw new Error("Agent is already processing.");
\t\tif (taskId === undefined && await this.durable.pendingRun() === undefined) return false;
\t\tawait this.runWithLifecycle(signal => this.durable.recover(
\t\t\tthis.createContextSnapshot(), this.createLoopConfig(), event => this.processEvents(event),
\t\t\tsignal, this.streamFunction, onBound, taskId,
\t\t));
\t\treturn true;
\t}

\tprivate normalizePromptInput(`);
  return body;
}

export function portAgentSession(source: string): string {
  let body = edit(source, '\tbaseToolsOverride?: Record<string, AgentTool>;',
    '\tbaseToolsOverride?: Record<string, AgentTool>;\n\t/** Host execution policy applies after native tool registration and before declarations. */\n\twrapTool?: (tool: AgentTool, source?: SourceInfo) => AgentTool;\n\tonAction?: (work: () => Promise<void>) => Promise<void>;\n\tonToolsChanged?: (tools: AgentTool[]) => void;');
  body = edit(body, '\tprivate _baseToolsOverride?: Record<string, AgentTool>;',
    '\tprivate _baseToolsOverride?: Record<string, AgentTool>;\n\tprivate _wrapTool?: AgentSessionConfig["wrapTool"];\n\tprivate _onAction?: AgentSessionConfig["onAction"];\n\tprivate _onToolsChanged?: AgentSessionConfig["onToolsChanged"];');
  body = edit(body, '\t\tthis._baseToolsOverride = config.baseToolsOverride;',
    '\t\tthis._baseToolsOverride = config.baseToolsOverride;\n\t\tthis._wrapTool = config.wrapTool;\n\t\tthis._onAction = config.onAction;\n\t\tthis._onToolsChanged = config.onToolsChanged;');
  body = edit(body, '\t\tthis._installAgentRequestProjection();',
    `\t\tthis.agent.durable.bindSessionState(() => this.exportDurableState(), state =>
\t\t\tthis.restoreDurableState(state as ReturnType<AgentSession["exportDurableState"]>));
\t\tthis.agent.durable.bindInputQueues((inputs, cancelled) => {
\t\t\tconst queues = this.agent.exportDurableQueues();
\t\t\tconst dropped = new Set(cancelled);
\t\t\tfor (const kind of ["steering", "followUp"] as const) {
\t\t\t\tqueues[kind] = queues[kind].filter(message => {
\t\t\t\t\tif (!dropped.has(this.agent.durable.messageTag(message) ?? "")) return true;
\t\t\t\t\tif (message.role === "user") {
\t\t\t\t\t\tconst text = contentText(message.content, "");
\t\t\t\t\t\tconst pending = kind === "steering" ? this._steeringMessages : this._followUpMessages;
\t\t\t\t\t\tconst index = pending.indexOf(text);
\t\t\t\t\t\tif (index !== -1) pending.splice(index, 1);
\t\t\t\t\t}
\t\t\t\t\treturn false;
\t\t\t\t});
\t\t\t}
\t\t\tthis.agent.restoreDurableQueues(queues);
\t\t\tconst present = new Set([...queues.steering, ...queues.followUp, ...this._pendingNextTurnMessages,
\t\t\t\t...this._pendingCustomMessages].map(message => this.agent.durable.messageTag(message)));
\t\t\tfor (const input of inputs) {
\t\t\t\tif (present.has(input.tag)) continue;
\t\t\t\tthis.agent.durable.tagMessage(input.message, input.tag);
\t\t\t\tif (input.kind === "steering") {
\t\t\t\t\tthis.agent.steer(input.message);
\t\t\t\t\tif (input.text !== undefined) this._steeringMessages.push(input.text);
\t\t\t\t} else if (input.kind === "followUp") {
\t\t\t\t\tthis.agent.followUp(input.message);
\t\t\t\t\tif (input.text !== undefined) this._followUpMessages.push(input.text);
\t\t\t\t} else {
\t\t\t\t\tif (input.message.role !== "custom") throw new Error("Invalid durable custom input");
\t\t\t\t\t(input.kind === "nextTurn" ? this._pendingNextTurnMessages : this._pendingCustomMessages).push(input.message);
\t\t\t\t}
\t\t\t\tpresent.add(input.tag);
\t\t\t}
\t\t});
\t\tthis._installAgentRequestProjection();`);
  body = edit(body, '\tprivate _baseToolsOverride?: Record<string, AgentTool>;',
    '\tprivate _durableStartingMessages?: AgentMessage[];\n\tprivate _durablePreparingAction = false;\n\tprivate _durableQueueAdmissions = new Set<Promise<void>>();\n\tprivate _baseToolsOverride?: Record<string, AgentTool>;');
  body = edit(body, '\t\tthis._toolRegistry = toolRegistry;',
    '\t\tthis._toolRegistry = this._wrapTool ? new Map([...toolRegistry].map(([name, tool]) =>\n\t\t\t[name, this._wrapTool!(tool, definitionRegistry.get(name)?.sourceInfo)])) : toolRegistry;\n\t\tthis._onToolsChanged?.([...this._toolRegistry.values()]);');
  body = edit(body, '\t\ttry {\n\t\t\tawait this.agent.prompt(messages);\n\t\t\twhile (!this._agentRunAbortRequested) {',
    '\t\tawait this._runToSettlement(() => this.agent.prompt(messages));\n\t}\n\n\t/** Rebind before scheduling so recovered tool tasks see the actual native session. */\n\tasync recoverDurable(onBound?: () => void): Promise<boolean> {\n\t\tif (await this.agent.durable.pendingRun() === undefined) return false;\n\t\tthis._isAgentRunActive = true;\n\t\tthis._agentRunAbortRequested = false;\n\t\tawait this._runToSettlement(async () => { await this.agent.resumeDurable(onBound); });\n\t\treturn true;\n\t}\n\n\tprivate async _runToSettlement(start: () => Promise<void>): Promise<void> {\n\t\ttry {\n\t\t\tawait start();\n\t\t\twhile (!this._agentRunAbortRequested) {');
  body = edit(body, '\tasync recoverDurable(onBound?: () => void): Promise<boolean> {', `\texportDurableState() {
\t\treturn { queues: this.agent.exportDurableQueues(), steering: this._steeringMessages,
\t\t\tactiveTools: this.getActiveToolNames(),
\t\t\tprepared: this._durableStartingMessages,
\t\t\tqueueTags: { steering: this.agent.exportDurableQueues().steering.map(message => this.agent.durable.messageTag(message) ?? null),
\t\t\t\tfollowUp: this.agent.exportDurableQueues().followUp.map(message => this.agent.durable.messageTag(message) ?? null),
\t\t\t\tnextTurn: this._pendingNextTurnMessages.map(message => this.agent.durable.messageTag(message) ?? null),
\t\t\t\tpendingCustom: this._pendingCustomMessages.map(message => this.agent.durable.messageTag(message) ?? null) },
\t\t\tfollowUp: this._followUpMessages, nextTurn: this._pendingNextTurnMessages,
\t\t\tpendingCustom: this._pendingCustomMessages, pendingBash: this._pendingBashMessages,
\t\t\tturnIndex: this._turnIndex, retryAttempt: this._retryAttempt,
\t\t\tfailedResponse: this._failedResponse, runPrompt: this._runSystemPromptOptions,
\t\t\toverflowAttempted: this._overflowRecoveryAttempted, systemPrompt: this.agent.state.systemPrompt,
\t\t\tlastAssistant: this._lastAssistantMessage,
\t\t\tlastAssistantEntry: this._lastAssistantMessage && this._findPersistedMessageEntryId(this._lastAssistantMessage),
\t\t\tlastOutcome: this._lastActivityOutcome };
\t}

\trestoreDurableState(state: ReturnType<AgentSession["exportDurableState"]>): void {
\t\tif (state.activeTools) this.setActiveToolsByName(state.activeTools);
\t\tthis._durableStartingMessages = state.prepared;
\t\tthis.agent.restoreDurableQueues(state.queues);
\t\tfor (const kind of ["steering", "followUp"] as const) state.queues[kind].forEach((message, index) => {
\t\t\tconst tag = state.queueTags?.[kind][index];
\t\t\tif (tag) this.agent.durable.tagMessage(message, tag);
\t\t});
\t\tthis._steeringMessages = state.steering;
\t\tthis._followUpMessages = state.followUp;
\t\tthis._pendingNextTurnMessages = state.nextTurn;
\t\tthis._pendingCustomMessages = state.pendingCustom;
\t\tfor (const kind of ["nextTurn", "pendingCustom"] as const) state[kind].forEach((message, index) => {
\t\t\tconst tag = state.queueTags?.[kind]?.[index];
\t\t\tif (tag) this.agent.durable.tagMessage(message, tag);
\t\t});
\t\tthis._pendingBashMessages = state.pendingBash;
\t\tthis._turnIndex = state.turnIndex;
\t\tthis._retryAttempt = state.retryAttempt;
\t\tthis._failedResponse = state.failedResponse;
\t\tthis._runSystemPromptOptions = state.runPrompt;
\t\tthis._overflowRecoveryAttempted = state.overflowAttempted;
\t\tthis._lastAssistantMessage = state.lastAssistant;
\t\tif (state.lastAssistant && state.lastAssistantEntry)
\t\t\tthis._entryIdsByMessage.set(state.lastAssistant, state.lastAssistantEntry);
\t\tthis._lastActivityOutcome = state.lastOutcome;
\t}

\tasync recoverDurable(onBound?: () => void): Promise<boolean> {`);
  body = edit(body, '\texportDurableState() {', `\t/** Replace the host tool catalog without reloading native extensions or their state. */
\tsetBaseTools(tools: Record<string, AgentTool>): void {
\t\tconst previous = new Set(this._baseToolDefinitions.keys());
\t\tconst active = this.getActiveToolNames();
\t\tthis._baseToolsOverride = tools;
\t\tthis._baseToolDefinitions = new Map(Object.values(tools).map(tool =>
\t\t\t[tool.name, createToolDefinitionFromAgentTool(tool)]));
\t\tconst added = [...this._baseToolDefinitions].filter(([name, definition]) =>
\t\t\t!previous.has(name) && definition.defaultActive !== false &&
\t\t\t(definition.exposure === undefined || definition.exposure === "direct" || definition.exposure === "model-only"))
\t\t\t.map(([name]) => name);
\t\tthis._refreshToolRegistry({ activeToolNames: [...new Set([...active,
\t\t\t...added])] });
\t}

\texportDurableState() {`);
  for (const action of ['sendCustomMessage(message, options)', 'sendUserMessage(content, options)']) {
    body = edit(body, `this.${action}.catch((err) => {`, `this._trackHostAction(() => this.${action}).catch((err) => {`);
  }
  body = edit(body, '\tprivate _bindExtensionCore(', `\tprivate _acceptQueuedInput(kind: "steering" | "followUp" | "nextTurn" | "pendingCustom", message: AgentMessage, text?: string): Promise<void> {
\t\tconst admission = this.agent.durable.persistQueuedInputs({
\t\t\tsteering: kind === "steering" ? [message] : [], followUp: kind === "followUp" ? [message] : [],
\t\t\tnextTurn: kind === "nextTurn" ? [message] : [], pendingCustom: kind === "pendingCustom" ? [message] : [],
\t\t\tsteeringText: text === undefined ? [] : [text], followUpText: text === undefined ? [] : [text],
\t\t});
\t\tthis._durableQueueAdmissions.add(admission);
\t\tvoid admission.finally(() => this._durableQueueAdmissions.delete(admission)).catch(() => {});
\t\treturn admission;
\t}

\tprivate async _drainQueuedAdmissions(): Promise<void> {
\t\twhile (this._durableQueueAdmissions.size) await Promise.all([...this._durableQueueAdmissions]);
\t}

\tprivate _bindExtensionCore(`);
  for (const [method, kind, textQueue] of [
    ['steer', 'steering', '_steeringMessages'], ['followUp', 'followUp', '_followUpMessages'],
  ] as const) {
    body = edit(body, `\t\tthis.${textQueue}.push(text);\n\t\tthis._emitQueueUpdate();`, '');
    const call = method === 'steer'
      ? '\t\tthis.agent.steer({\n\t\t\trole: "user",\n\t\t\tcontent,\n\t\t\ttimestamp: Date.now(),\n\t\t});'
      : '\t\tthis.agent.followUp({ role: "user", content, timestamp: Date.now() });';
    body = edit(body, call, `\t\tconst message: AgentMessage = { role: "user", content, timestamp: Date.now() };
\t\tawait this._acceptQueuedInput("${kind}", message, text);
\t\tthis.${textQueue}.push(text);
\t\tthis._emitQueueUpdate();
\t\tthis.agent.${method}(message);`);
  }
  body = edit(body, '\t\t\tthis._pendingNextTurnMessages.push(appMessage);',
    '\t\t\tawait this._acceptQueuedInput("nextTurn", appMessage);\n\t\t\tthis._pendingNextTurnMessages.push(appMessage);');
  body = edit(body, '\t\t} else if (this.isStreaming && options?.triggerTurn !== false) {',
    '\t\t} else if (this.isStreaming && options?.triggerTurn !== false) {\n\t\t\tawait this._acceptQueuedInput(options?.deliverAs === "followUp" ? "followUp" : "steering", appMessage);');
  body = edit(body, '\t\t\tthis._pendingCustomMessages.push(appMessage);',
    '\t\t\tawait this._acceptQueuedInput("pendingCustom", appMessage);\n\t\t\tthis._pendingCustomMessages.push(appMessage);');
  body = edit(body, '\t\t\tif (entryId) this._entryIdsByMessage.set(event.message, entryId);',
    '\t\t\tif (entryId) {\n\t\t\t\tthis._entryIdsByMessage.set(event.message, entryId);\n\t\t\t\tthis.agent.durable.tagEntry(event.message, entryId);\n\t\t\t}');
  body = edit(body, '\t\tthis.sessionManager.appendCustomMessageEntry(\n\t\t\tappMessage.customType,',
    '\t\tconst entryId = this.sessionManager.appendCustomMessageEntry(\n\t\t\tappMessage.customType,');
  body = edit(body, '\t\t\tappMessage.details,\n\t\t);\n\t\tthis._refreshFinalizedContext();',
    '\t\t\tappMessage.details,\n\t\t);\n\t\tthis.agent.durable.tagEntry(appMessage, entryId);\n\t\tthis._refreshFinalizedContext();');
  body = edit(body, '\t\tawait this._emitExtensionEvent(event);',
    '\t\tawait this._emitExtensionEvent(event);\n\t\tawait this._drainQueuedAdmissions();');
  body = edit(body, '\t\t\tawait this._extensionRunner.emit({ type: "agent_settled", aborted });',
    '\t\t\tawait this._extensionRunner.emit({ type: "agent_settled", aborted });\n\t\t\tawait this._drainQueuedAdmissions();');
  body = edit(body, '\t\t\tthis._commitBoundaryDrafts(result.entries);',
    '\t\t\tawait this._drainQueuedAdmissions();\n\t\t\tthis._commitBoundaryDrafts(result.entries);');
  body = edit(body, '\tprivate _bindExtensionCore(runner: ExtensionRunner): void {',
    '\tprivate _trackHostAction(work: () => Promise<void>): Promise<void> {\n\t\treturn this._onAction ? this._onAction(work) : work();\n\t}\n\n\tprivate _bindExtensionCore(runner: ExtensionRunner): void {');
  body = edit(body, 'if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;',
    'if (!this._modelRuntime.hasConfiguredAuth(model.provider) && !(await this._modelRuntime.checkAuth(model.provider))) return false;');
  body = edit(body, '\t\tonStarted?.();', '');
  body = edit(body, '\t\tawait this._runToSettlement(() => this.agent.prompt(messages));',
    '\t\tthis._durableStartingMessages = messages;\n\t\tif (this._durablePreparingAction) return;\n\t\tawait this._runToSettlement(() => this.agent.prompt(messages), onStarted);');
  body = edit(body, '\t\tif (await this.agent.durable.pendingRun() === undefined) return false;',
    '\t\tawait this.agent.durable.restoreSessionState();\n\t\tif (await this.agent.durable.pendingSession() === undefined && await this.agent.durable.pendingRun() === undefined) return false;');
  body = edit(body, '\t\tawait this._runToSettlement(async () => { await this.agent.resumeDurable(onBound); });',
    '\t\tawait this._runToSettlement(() => this.agent.prompt(this._durableStartingMessages ?? []), onBound);');
  const lifecycle = '\tprivate async _runToSettlement(start: () => Promise<void>): Promise<void> {';
  const start = body.indexOf(lifecycle);
  const end = body.indexOf('\n\t/**\n\t * Prepare a run', start);
  if (start < 0 || end < 0) throw new Error('Pinned native settlement implementation changed');
  body = body.slice(0, start) + `\tprivate async _runToSettlement(start: () => Promise<void>, onStarted?: () => void): Promise<void> {
\t\ttry { await this.agent.durable.settleSession({
\t\t\tstart,
\t\t\tprepared: async () => {
\t\t\t\tlet messages = this._durableStartingMessages ?? [];
\t\t\t\tconst preparation = this.agent.durable.preparedSessionInput()?.resume?.prepareAgentStart;
\t\t\t\tif (preparation) {
\t\t\t\t\tconst content = preparation.content;
\t\t\t\t\tconst prompt = typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\\n");
\t\t\t\t\tconst images = typeof content === "string" ? undefined : content.filter(part => part.type === "image");
\t\t\t\t\tmessages = await this._prepareRun({ messageType: "user", prompt, images });
\t\t\t\t\tif (preparation.placed) messages = messages.filter(message => message.role !== "user");
\t\t\t\t\telse if (preparation.tag) for (const message of messages)
\t\t\t\t\t\tif (message.role === "user") this.agent.durable.tagMessage(message, preparation.tag);
\t\t\t\t}
\t\t\t\tawait this.agent.prompt(messages);
\t\t\t},
\t\t\tcontinue: () => this.agent.continue(),
\t\t\trecover: (child, onBound) => this.agent.resumeDurable(onBound, child),
\t\t\tpost: () => this._handlePostAgentRun(),
\t\t\tbeforeSettle: () => this._runBeforeSettleBoundary(),
\t\t\taborted: () => this._agentRunAbortRequested,
\t\t\taction: async action => {
\t\t\t\tthis._isAgentRunActive = false;
\t\t\t\tthis._durablePreparingAction = true;
\t\t\t\tthis._durableStartingMessages = undefined;
\t\t\t\ttry {
\t\t\t\t\tif (action.type === "prompt") await this.prompt(action.text, action.options);
\t\t\t\t\telse await this.sendCustomMessage(action.message, action.options);
\t\t\t\t\treturn this._durableStartingMessages !== undefined;
\t\t\t\t} finally { this._durablePreparingAction = false; }
\t\t\t},
\t\t\tfinalize: async completion => {
\t\t\t\tif (completion.status === "failed") this._lastActivityOutcome = "error";
\t\t\t\tif (completion.status === "aborted") this._agentRunAbortRequested = true;
\t\t\t\tif (this._agentRunAbortRequested) this._finishCancelledRetry();
\t\t\t\tthis._failedResponse = undefined;
\t\t\t\tthis._runSystemPromptOptions = undefined;
\t\t\t\tthis._durableStartingMessages = undefined;
\t\t\t\tthis._flushPendingBashMessages();
\t\t\t\tthis._flushPendingCustomMessages();
\t\t\t\tawait this._emitAgentSettled();
\t\t\t},
\t\t}, onStarted); } finally {
\t\t\tthis._isAgentRunActive = false;
\t\t\tthis._resolveIdleWaitIfIdle();
\t\t}
\t}
` + body.slice(end);
  body = edit(body, '\tprivate _resolveIdleWaitIfIdle(): void {',
    '\tprivate _resolveIdleWaitIfIdle(): void {\n\t\tif (this.agent.durable.inSessionPhase()) return;');
  body = edit(body, '\t\t\tthis._deferredSettledActions.push(async () => await this.prompt(text, options));', `\t\t\tconst { preflightResult, ...storedOptions } = options ?? {};
\t\t\tif (await this.agent.durable.deferSessionAction({ type: "prompt", text, options: storedOptions })) {
\t\t\t\tpreflightResult?.("queued");
\t\t\t\treturn;
\t\t\t}
\t\t\tthis._deferredSettledActions.push(async () => await this.prompt(text, options));`);
  body = edit(body, '\t\t\t\tthis._deferredSettledActions.push(async () => await this.sendCustomMessage(message, options));', `\t\t\t\tif (await this.agent.durable.deferSessionAction({ type: "custom", message, options })) return;
\t\t\t\tthis._deferredSettledActions.push(async () => await this.sendCustomMessage(message, options));`);
  return body;
}

export function portSDK(source: string): string {
  let body = 'import type { DurableLoopBinding } from "../../durable-coding/engine.ts";\n' + source;
  body = edit(body, 'import { AgentSession, markRuntimeStreamFunction }',
    'import { AgentSession, markRuntimeStreamFunction, type AgentSessionConfig }');
  body = edit(body, 'export interface CreateAgentSessionOptions {',
    'export interface CreateAgentSessionOptions {\n\tdurable?: DurableLoopBinding;\n\tbaseToolsOverride?: AgentSessionConfig["baseToolsOverride"];\n\twrapTool?: AgentSessionConfig["wrapTool"];\n\tonAction?: AgentSessionConfig["onAction"];\n\tonToolsChanged?: AgentSessionConfig["onToolsChanged"];');
  body = edit(body, '\tconst agent = new Agent({', '\tconst agent = new Agent({\n\t\tdurable: options.durable,');
  body = edit(body, '\t\tcustomTools: options.customTools,',
    '\t\tcustomTools: options.customTools,\n\t\tbaseToolsOverride: options.baseToolsOverride,\n\t\twrapTool: options.wrapTool,\n\t\tonAction: options.onAction,\n\t\tonToolsChanged: options.onToolsChanged,');
  return body;
}

/** Share the pinned startup registration order with hosts that supply their own resource loader. */
export function portSessionServices(source: string): string {
  const start = source.indexOf('\tconst diagnostics: AgentSessionRuntimeDiagnostic[] = [];\n\tconst extensionsResult = resourceLoader.getExtensions();\n\tfor (const { name, config, extensionPath }');
  const endMarker = '\tawait modelRuntime.refresh({ allowNetwork: false });';
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Pinned extension model initialization changed');
  const stop = end + endMarker.length;
  const implementation = source.slice(start, stop);
  return source.slice(0, start) +
    '\tconst diagnostics = await initializeExtensionModels(resourceLoader, modelRuntime);' + source.slice(stop) +
    `\nexport async function initializeExtensionModels(
\tresourceLoader: ResourceLoader, modelRuntime: ModelRuntime,
): Promise<AgentSessionRuntimeDiagnostic[]> {
${implementation}
\treturn diagnostics;
}\n`;
}

export function portToolDefinition(path: string, source: string): string {
  if (path === 'core/extensions/types.ts') return edit(source,
    'export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {',
    'export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {\n\t/** Only tools explicitly safe to repeat may resume an uncertain durable execution. */\n\treplay?: "safe" | "never";');
  let body = edit(source, '\t\texecutionMode: definition.executionMode,',
    '\t\texecutionMode: definition.executionMode,\n\t\treplay: definition.replay,');
  body = edit(body, '\t\texecutionMode: tool.executionMode,',
    '\t\texecutionMode: tool.executionMode,\n\t\treplay: tool.replay,');
  const metadata = ['exposure', 'namespace', 'annotations', 'reachesTools', 'defaultActive', 'promptSnippet', 'promptGuidelines'];
  const shape = `Pick<ToolDefinition<any>, ${metadata.map(name => JSON.stringify(name)).join(' | ')}>`;
  body = edit(body, '): AgentTool<any, TDetails> {', `): AgentTool<any, TDetails> & ${shape} {`);
  body = edit(body, 'tool: AgentTool<any>): ToolDefinition<any, unknown>', `tool: AgentTool<any> & ${shape}): ToolDefinition<any, unknown>`);
  body = edit(body, '\t\treplay: definition.replay,', '\t\treplay: definition.replay,\n' +
    metadata.map(name => `\t\t${name}: definition.${name},`).join('\n'));
  return edit(body, '\t\treplay: tool.replay,', '\t\treplay: tool.replay,\n' +
    metadata.map(name => `\t\t${name}: tool.${name},`).join('\n'));
}
