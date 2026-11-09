/** Keep the host's durable state and tool boundaries reproducible from pinned native sources. */
function edit(source: string, before: string, after: string): string {
  if (!source.includes(before)) throw new Error('Pinned native session boundary changed: ' + before);
  return source.replace(before, after);
}

export function portNativeMessages(source: string): string {
  const body = edit(source, 'export function convertToLlm(messages: AgentMessage[]): Message[] {',
    'export function convertToLlm(\n\tmessages: AgentMessage[],\n\toptions: { preserveHostMetadata?: boolean } = {},\n): Message[] {');
  return edit(body, '\t\t\t\tcase "toolResult":\n\t\t\t\t\treturn m;',
    '\t\t\t\tcase "toolResult":\n\t\t\t\t\t// Legacy projections require the original object for identity-based reconciliation.\n\t\t\t\t\t// Native model context excludes host metadata by default.\n\t\t\t\t\tif (!options.preserveHostMetadata && ("hostMessageId" in m || "hostUserInput" in m)) {\n\t\t\t\t\t\tconst message = { ...m };\n\t\t\t\t\t\tReflect.deleteProperty(message, "hostMessageId");\n\t\t\t\t\t\tReflect.deleteProperty(message, "hostUserInput");\n\t\t\t\t\t\treturn message;\n\t\t\t\t\t}\n\t\t\t\t\treturn m;');
}

export function portSDK(source: string): string {
  let body = 'import type { DurableLoopBinding } from "../../durable-coding/engine.ts";\n'
    + 'import * as resourceExtensionLoader from "../../native-extension-loader.ts";\n' + source;
  body = edit(body, "new DefaultResourceLoader({ cwd, agentDir, settingsManager })",
    "new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionLoader: resourceExtensionLoader })");
  body = edit(body, 'import { AgentSession, markRuntimeStreamFunction }',
    'import { AgentSession, markRuntimeStreamFunction, type AgentSessionConfig }');
  body = edit(body, 'export interface CreateAgentSessionOptions {',
    'export interface CreateAgentSessionOptions {\n\tdurable?: DurableLoopBinding;\n\tbaseToolsOverride?: AgentSessionConfig["baseToolsOverride"];\n\twrapTool?: AgentSessionConfig["wrapTool"];\n\tonAction?: AgentSessionConfig["onAction"];\n\t/** Own auxiliary native writes and commit them before their events are published. */\n\tonBackgroundAction?: <T>(work: () => Promise<T>) => Promise<T>;\n\tonToolsChanged?: AgentSessionConfig["onToolsChanged"];\n\tcaptureUserInput?: AgentSessionConfig["captureUserInput"];');
  body = edit(body, '\t\tasync (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,',
    '\t\tasync (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,\n\t\toptions.onBackgroundAction,');
  body = edit(body, '\tdurable?: DurableLoopBinding;',
    '\tdurable?: DurableLoopBinding;\n\t/** A host restoring a committed tree can suppress SDK bootstrap writes. */\n\tinitializeSessionMetadata?: boolean;');
  body = edit(body, '\tif (hasExistingSession) {\n\t\tif (!hasThinkingEntry) {',
    '\tif (options.initializeSessionMetadata !== false && hasExistingSession) {\n\t\tif (!hasThinkingEntry) {');
  body = edit(body, '\t} else {\n\t\t// Save initial model and thinking level for new sessions',
    '\t} else if (options.initializeSessionMetadata !== false) {\n\t\t// Save initial model and thinking level for new sessions');
  body = edit(body, '\tconst agent = new Agent({', '\tconst agent = new Agent({\n\t\tdurable: options.durable,');
  body = edit(body, '\t\tcustomTools: options.customTools,',
    '\t\tcustomTools: options.customTools,\n\t\tbaseToolsOverride: options.baseToolsOverride,\n\t\twrapTool: options.wrapTool,\n\t\tonAction: options.onAction,\n\t\tonToolsChanged: options.onToolsChanged,\n\t\tcaptureUserInput: options.captureUserInput,');
  return body;
}

/** Timers need fresh journal phases; publish usage only after the host receives its commit. */
export function portCacheWarmer(source: string): string {
  let body = edit(source, '\ttype Api,', '\ttype Api,\n\ttype AssistantMessage,');
  body = edit(body, '\tprivate readonly decide:', '\tprivate readonly runAction: <T>(work: () => Promise<T>) => Promise<T>;\n\tprivate readonly decide:');
  body = edit(body, '\t\tthis.decide = decide;', '\t\tthis.decide = decide;\n\t\tthis.runAction = runAction;');
  body = edit(body,
    '\t\tdecide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,',
    '\t\tdecide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,\n\t\trunAction: <T>(work: () => Promise<T>) => Promise<T> = work => work(),');
  body = edit(body, '\tprivate async refresh(run: ActiveRun): Promise<void> {', `\tprivate async refresh(run: ActiveRun): Promise<void> {
\t\tlet entry: UsageEntry | undefined;
\t\ttry {
\t\t\tentry = await this.runAction(() => this.refreshInAction(run));
\t\t} catch {
\t\t\tif (this.run === run) this.stop("cache usage persistence failed");
\t\t\treturn;
\t\t}
\t\ttry { if (entry) this.onWarmed?.(entry); } catch { /* Observers do not own warming. */ }
\t\tif (this.run === run) this.schedule(run);
\t}

\tprivate async refreshInAction(run: ActiveRun): Promise<UsageEntry | undefined> {`);
  body = edit(body, '\t\trun.extensionOverride = extensionOverride;\n\t\ttry {',
    '\t\trun.extensionOverride = extensionOverride;\n\t\tlet message: AssistantMessage;\n\t\ttry {');
  body = edit(body, '\t\t\tconst message = await this.models', '\t\t\tmessage = await this.models');
  body = edit(body, `\t\t\tif (!this.validateRun(run)) return;
\t\t\tif (message.stopReason !== "error" && message.stopReason !== "aborted") {
\t\t\t\tconst entry = this.sessionManager.appendUsage(
\t\t\t\t\t"cache_warm",
\t\t\t\t\tmessage.provider,
\t\t\t\t\tmessage.responseModel ?? message.model,
\t\t\t\t\tmessage.usage,
\t\t\t\t\textensionOverride ? "extension override" : undefined,
\t\t\t\t);
\t\t\t\tthis.onWarmed?.(entry);
\t\t\t}`, '');
  return edit(body, `\t\t} catch {
\t\t\t// Cache warming is best-effort and must not affect the active agent run.
\t\t}
\t\tif (this.run === run) this.schedule(run);`, `\t\t} catch {
\t\t\t// Network failures remain best-effort; persistence failures must escape this catch.
\t\t\treturn;
\t\t}
\t\tif (!this.validateRun(run) || message.stopReason === "error" || message.stopReason === "aborted") return;
\t\treturn this.sessionManager.appendUsage(
\t\t\t"cache_warm", message.provider, message.responseModel ?? message.model, message.usage,
\t\t\textensionOverride ? "extension override" : undefined,
\t\t);`);
}

/** Share the pinned startup registration order with hosts that supply their own resource loader. */
export function portSessionServices(source: string): string {
  source = 'import * as resourceExtensionLoader from "../../native-extension-loader.ts";\n' + source;
  source = edit(source, "const resourceLoader = new DefaultResourceLoader({",
    "const resourceLoader = new DefaultResourceLoader({\n\t\textensionLoader: resourceExtensionLoader,");
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
