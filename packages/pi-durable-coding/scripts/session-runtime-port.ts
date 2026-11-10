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
    '\t\tasync (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,\n\t\toptions.onBackgroundAction ?? (work => work()),');
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
