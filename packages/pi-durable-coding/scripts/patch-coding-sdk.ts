/** Rebuild narrow SDK exports and host package policy options from pristine releases. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codingPackagePolicy } from './coding-package-policy.ts';
import { codingSessionPolicy } from './coding-session-policy.ts';
import { codingResourcePolicy } from './coding-resource-policy.ts';
import { codingExtensionPolicy } from './coding-extension-policy.ts';
import { codingModelRuntimePolicy } from './coding-model-runtime-policy.ts';
import { codingRunnerPolicy } from './coding-runner-policy.ts';
import { codingAgentSessionPolicy } from './coding-agent-session-policy.ts';
import { codingToolPolicy } from './coding-tool-policy.ts';
import { codingToolFactoriesPolicy } from './coding-tool-factories-policy.ts';
import { codingAnsiPolicy, codingBashOutputPolicy, codingShellHelpersPolicy, codingShellPolicy } from './coding-shell-policy.ts';
import { codingCodemodePolicy } from './coding-codemode-policy.ts';
import { codingUIPolicy } from './coding-ui-policy.ts';
import { codingImagePolicy } from './coding-image-policy.ts';
import { codingImageProcessingPolicy } from './coding-image-processing-policy.ts';
import { codingCachePolicy } from './coding-cache-policy.ts';
import { codingSessionServicesPolicy } from './coding-session-services-policy.ts';
import { codingSessionRuntimePolicy } from './coding-session-runtime-policy.ts';
import { codingSessionFactoryPolicy } from './coding-session-factory-policy.ts';
import { codingMcpOAuthPolicy } from './coding-mcp-oauth-policy.ts';
import { codingManagementHttpPolicy, codingToolsManagerPolicy } from './coding-tools-manager-policy.ts';
import { codingMcpRuntimePolicy } from './coding-mcp-runtime-policy.ts';

/** Export method values without wrapping or changing AgentSession's instance calls. */
function codingBoundaryExports(source: string, declarations: boolean): string {
  const marker = '//# sourceMappingURL=';
  if (source.split(marker).length !== 2) throw new Error('Published AgentSession source map marker changed');
  if (!declarations) {
    return source.replace(marker,
      'export const applySessionBoundaryDrafts = AgentSession.prototype._applyBoundaryDrafts;\n'
      + 'export const buildSessionBoundaryContext = AgentSession.prototype._buildBoundaryContext;\n'
      + 'export const replaceSessionMessageInPlace = AgentSession.prototype._replaceMessageInPlace;\n'
      + marker);
  }
  const before = 'import type { AgentActivityOutcome } from "./extensions/types.ts";';
  if (source.split(before).length !== 2) throw new Error('AgentSession boundary type import changed');
  return source.replace(before, 'import type { AgentActivityOutcome, SessionBoundaryDraft } from "./extensions/types.ts";')
    .replace(marker, boundaryDeclarations + marker);
}

const boundaryDeclarations = `
/** The manager operations used by the original method; entries retain the host's own type. */
export type SessionBoundaryDraftManager<Entry extends object> = Pick<SessionManager,
    "appendCustomEntry" | "appendCustomMessageEntry" | "appendContextEdit" | "appendCompaction"
    | "buildSessionProjection" | "getBranch"> & {
    getEntry(id: string): Entry | undefined;
};
type SessionBoundaryProjection = Pick<ReturnType<SessionManager["buildSessionProjection"]>, "entries" | "messages">;
/** Structural receiver for the patched method, including its configured conversion hook. */
export interface SessionBoundaryContextHost<Projection extends SessionBoundaryProjection, Pending> {
    _createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): {
        buildSessionProjection(): Projection;
    };
    _getPendingBoundaryMessages(): Pending;
    _pendingCustomMessages: { readonly length: number };
    _convertToLlm: typeof convertToLlm;
    agent: Pick<Agent, "hasQueuedMessages">;
}
export declare const applySessionBoundaryDrafts: <Entry extends object>(
    manager: SessionBoundaryDraftManager<Entry>, drafts: SessionBoundaryDraft[],
) => Entry[];
export declare const buildSessionBoundaryContext: <Projection extends SessionBoundaryProjection, Pending>(
    this: SessionBoundaryContextHost<Projection, Pending>, drafts: SessionBoundaryDraft[],
    boundary: "turn_end" | "agent_before_settle",
) => {
    contextEntries: Projection["entries"];
    contextMessages: Projection["messages"];
    llmMessages: ReturnType<typeof convertToLlm>;
    pendingMessages: Pending;
    canContinue: boolean;
};
/** Preserve identity and the patched SDK's host-message metadata rules. */
export declare const replaceSessionMessageInPlace: (target: object, replacement: object) => void;
`;

const [published, mode] = process.argv.slice(2);
if (!published || !['--write', '--check'].includes(mode!)) {
  throw new Error('Usage: bun patch-coding-sdk.ts /pristine-coding-sdk --write|--check');
}
const baseline = resolve(published);
const info = JSON.parse(readFileSync(join(baseline, 'package.json'), 'utf8'));
if (info.name !== '@earendil-works/pi-coding-agent' || info.version !== '1.5.0') {
  throw new Error('Expected published pi-coding-agent 1.5.0');
}
const root = resolve(import.meta.dir, '../../..');
const patchPath = join(root, 'patches/@earendil-works%2Fpi-coding-agent@1.5.0.patch');
const manifestPath = join(import.meta.dir, '../CODING-PATCH.json');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const replace = (source: string, before: string, after: string) => {
  if (source.split(before).length !== 2) throw new Error('Published settings boundary changed: ' + before);
  return source.replace(before, after);
};
const outputs = new Map<string, string>();
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/index.${suffix}`;
  let original = readFileSync(join(baseline, path), 'utf8');
  if (suffix === 'd.ts') original = replace(original, ' KeybindingsManager,', '');
  if (original.includes('export * from "./core/settings-manager.')) throw new Error('Expected unpatched SDK');
  const extension = suffix === 'js' ? 'js' : 'ts';
  const exports = [
    `export * from "./core/agent-session.${extension}";`,
    `export { initializeExtensionModels } from "./core/agent-session-services.${extension}";`,
    `export { CacheWarmer } from "./core/cache-warmer.${extension}";`,
    `export { ${suffix === 'd.ts' ? 'type AuthStorageBackend, ' : ''}FileAuthStorageBackend, InMemoryAuthStorageBackend } from "./core/auth-storage.${extension}";`,
    `export * from "./core/settings-manager.${extension}";`,
    `export { getProjectTrustOptions } from "./core/trust-manager.${extension}";`,
    `export { SETTINGS_DEFAULTS } from "./core/settings-defaults.${extension}";`,
    `export { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "./core/resolve-config-value.${extension}";`,
    `export * from "./core/package-manager.${extension}";`,
    `export * from "./core/model-registry.${extension}";`,
    `export * from "./core/model-runtime.${extension}";`,
    `export { findInitialModel } from "./core/model-resolver.${extension}";`,
    `export * from "./core/models-store.${extension}";`,
    `export { composeModelProvider, resolveCompatibilityRequestConfig, validateExtensionProvider } from "./core/provider-composer.${extension}";`,
    `export * from "./core/virtual-models.${extension}";`,
    `export * from "./core/session-manager.${extension}";`,
    `export { ${suffix === 'd.ts' ? 'type ContextUsageEstimate, ' : ''}estimateContextTokens, estimateProjectedContextTokens } from "./core/compaction/compaction.${extension}";`,
    `export * from "./core/resource-loader.${extension}";`,
    ...['source-info', 'timings', 'usage-totals', 'skills', 'prompt-templates', 'system-prompt', 'messages'].map(name => `export * from "./core/${name}.${extension}";`),
    `export * from "./core/extensions/loader.${extension}";`,
    `export * from "./core/extensions/runner.${extension}";`,
    `export * from "./core/extensions/types.${extension}";`,
    `export * from "./core/exec.${extension}";`,
    `export { allToolNames, createToolFactories, createToolDefinition, createTool, createCodingToolDefinitions, createReadOnlyToolDefinitions, createAllToolDefinitions, createAllTools${suffix === 'd.ts' ? ', type Tool, type ToolDef, type ToolName, type ToolFactoryDependencies, type ToolFactories' : ''} } from "./core/tools/index.${extension}";`,
    `export * from "./core/tools/tool-definition-wrapper.${extension}";`,
    `export { formatToolCallWithArgs, getTextOutput, replaceTabs } from "./core/tools/render-utils.${extension}";`,
    `export { spawnProcess, spawnProcessSync } from "./utils/child-process.${extension}";`,
    `export { writeOutputFile } from "./utils/output-files.${extension}";`,
    `export { ${suffix === 'd.ts' ? 'type PathInputOptions, ' : ''}canonicalizePath, isPathWithin, normalizePath, pathsEqual, resolvePath } from "./utils/paths.${extension}";`,
    `export { resolveReadPath, resolveToCwd } from "./core/tools/path-utils.${extension}";`,
    `export { stripBom } from "./utils/text.${extension}";`,
    `export { createShellHelpers${suffix === 'd.ts' ? ', type ShellConfig, type ShellHelperDependencies, type ShellHelpers' : ''} } from "./utils/shell.${extension}";`,
    `export { createToolManager${suffix === 'd.ts' ? ', type ToolManagerDependencies, type ToolStatus' : ''} } from "./utils/tools-manager.${extension}";`,
    `export { ${suffix === 'd.ts' ? 'type MiddleTruncationResult, ' : ''}GREP_MAX_LINE_LENGTH, truncateMiddle } from "./core/tools/truncate.${extension}";`,
    `export * from "./extensions/codemode/tool.${extension}";`,
    `export { createToolSearchToolDefinition${suffix === 'd.ts' ? ', type ToolSearchDependencies, type ToolSearchToolOptions' : ''} } from "./extensions/tool-search/tool.${extension}";`,
    ...['grep', 'find', 'ls'].map(name => `export * from "./core/tools/${name}.${extension}";`),
    `export * from "./core/export-html/index.${extension}";`,
    `export * from "./core/export-html/ansi-to-html.${extension}";`,
    `export * from "./core/export-html/tool-renderer.${extension}";`,
    `export * from "./utils/sleep.${extension}";`,
    `export * from "./utils/zip.${extension}";`,
    `export * from "./core/mcp-servers.${extension}";`,
    `export { loadMcpConfig } from "./extensions/mcp/config.${extension}";`,
    `export * from "./extensions/mcp/oauth.${extension}";`,
    `export { McpServerLog, formatMcpLogMessage } from "./extensions/mcp/log.${extension}";`,
    `export { McpServerConnection, createDefaultTransport } from "./extensions/mcp/runtime.${extension}";`,
    `export { MCP_OUTPUT_MAX_BYTES, convertMcpResult, createMcpResultSchema, createMcpToolName, limitMcpContent, saveToTempFile, toModelContent } from "./extensions/mcp/tools.${extension}";`,
    `export { createMcpResourceToolDefinitions, isMcpAppResource${suffix === 'd.ts' ? ', type McpResourceServer' : ''} } from "./extensions/mcp/resources.${extension}";`,
    `export * from "./core/keybindings.${extension}";`,
    `export { KeybindingsManager } from "./core/keybindings.${extension}";`,
    `export * from "./modes/interactive/theme/theme.${extension}";`,
    `export { AuthUrlComponent } from "./modes/interactive/components/auth-url.${extension}";`,
    `export { VisualLinePreview } from "./modes/interactive/components/visual-truncate.${extension}";`,
    `export { createImageConverters } from "./utils/image-convert.${extension}";`,
    `export * from "./utils/image-process.${extension}";`,
    `export * from "./utils/image-resize.${extension}";`,
    `export { ENV_AGENT_DIR, getBinDir, getCodemodeWorkerSpecifier, getThemesDir, getExportTemplateDir } from "./config.${extension}";`,
  ].join('\n') + '\n';
  const marker = '//# sourceMappingURL=';
  const position = original.indexOf(marker);
  if (position < 0) throw new Error('Published index source map marker changed');
  outputs.set(path, original.slice(0, position) + exports + original.slice(position));
  // Select the export-options contract when both HTML modules expose the same type name.
  if (suffix === 'd.ts') outputs.set(path, outputs.get(path)!.replace(marker,
    'export type { ToolHtmlRenderer } from "./core/export-html/index.ts";\n'
    + 'export type { ShellDependencies } from "./core/tools/bash.ts";\n'
    + 'export type { CreateAgentSessionDependencies } from "./core/sdk.ts";\n' + marker));
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/extensions/mcp/resources.${suffix}`;
  let body = readFileSync(join(baseline, path), 'utf8');
  if (suffix === 'js') {
    body = replace(body, 'function isMcpAppResource(item) {', 'export function isMcpAppResource(item) {');
  } else {
    body = replace(body, '/** A connected server that offers resources. */',
      'export declare function isMcpAppResource(item: { uri?: string; uriTemplate?: string; mimeType?: string }): boolean;\n/** A connected server that offers resources. */');
    body = replace(body, '}): ToolDefinition<TSchema, McpToolDetails>[];', `}): (ToolDefinition<TSchema, McpToolDetails> & {
    /** Resource tools do not use updates or an extension context. */
    execute(toolCallId: string, params: Record<string, unknown> | undefined, signal: AbortSignal | undefined): ReturnType<ToolDefinition<TSchema, McpToolDetails>["execute"]>;
})[];`);
  }
  outputs.set(path, body);
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/core/agent-session-services.${suffix}`;
  outputs.set(path, codingSessionServicesPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/core/sdk.${suffix}`;
  outputs.set(path, codingSessionFactoryPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
}
const runtimeDeclaration = 'dist/core/agent-session-runtime.d.ts';
outputs.set(runtimeDeclaration, codingSessionRuntimePolicy(readFileSync(join(baseline, runtimeDeclaration), 'utf8')));
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/extensions/mcp/runtime.${suffix}`;
  outputs.set(path, codingMcpRuntimePolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/extensions/mcp/oauth.${suffix}`;
  outputs.set(path, codingMcpOAuthPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/core/system-prompt.${suffix}`;
  let body = readFileSync(join(baseline, path), 'utf8');
  if (suffix === 'js') {
    body = replace(body, 'import { getDocsPath, getExamplesPath, getReadmePath }',
      'import { getDocsPath as defaultGetDocsPath, getExamplesPath as defaultGetExamplesPath, getReadmePath as defaultGetReadmePath }');
    body = replace(body, 'export function buildSystemPromptSections(input) {',
      'export function createSystemPromptBuilder({ getDocsPath = defaultGetDocsPath, getExamplesPath = defaultGetExamplesPath, getReadmePath = defaultGetReadmePath } = {}) {\nfunction buildSystemPromptSections(input) {');
    for (const name of ['buildSystemPromptState', 'buildSystemPrompt']) {
      body = replace(body, `export function ${name}(input) {`, `function ${name}(input) {`);
    }
    body = replace(body, '/**\n * Diff the sections',
      'return { buildSystemPromptSections, buildSystemPromptState, buildSystemPrompt };\n}\nexport const { buildSystemPromptSections, buildSystemPromptState, buildSystemPrompt } = createSystemPromptBuilder();\n/**\n * Diff the sections');
  } else {
    body = replace(body, '//# sourceMappingURL=',
      'export declare function createSystemPromptBuilder(dependencies?: {\n'
      + '    getDocsPath?: () => string;\n    getExamplesPath?: () => string;\n    getReadmePath?: () => string;\n'
      + '}): {\n    buildSystemPromptSections: typeof buildSystemPromptSections;\n'
      + '    buildSystemPromptState: typeof buildSystemPromptState;\n    buildSystemPrompt: typeof buildSystemPrompt;\n};\n'
      + '//# sourceMappingURL=');
  }
  outputs.set(path, body);
}
for (const name of ['skills', 'prompt-templates']) for (const suffix of ['js', 'd.ts']) {
  const path = `dist/core/${name}.${suffix}`;
  const fn = name === 'skills' ? 'loadSkills' : 'loadPromptTemplates';
  const options = name === 'skills' ? 'LoadSkillsOptions' : 'LoadPromptTemplatesOptions';
  let body = readFileSync(join(baseline, path), 'utf8');
  body = suffix === 'd.ts'
    ? replace(body, `${fn}(options: ${options})`, `${fn}(options: ${options}, projectConfigDir?: string)`)
    : replace(body, `${fn}(options)`, `${fn}(options, projectConfigDir = CONFIG_DIR_NAME)`);
  if (suffix === 'js') {
    const count = name === 'skills' ? 2 : 1;
    const before = 'resolve(resolvedCwd, CONFIG_DIR_NAME,';
    if (body.split(before).length !== count + 1) throw new Error('Published resource directory boundary changed: ' + name);
    body = body.replaceAll(before, 'resolve(resolvedCwd, projectConfigDir,');
  }
  outputs.set(path, body);
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/utils/image-convert.${suffix}`;
  outputs.set(path, codingImagePolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/modes/interactive/components/tool-execution.${suffix}`;
  outputs.set(path, codingUIPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
}
for (const name of ['tool', 'index']) for (const suffix of ['js', 'd.ts']) {
  const path = `dist/extensions/tool-search/${name}.${suffix}`;
  let body = readFileSync(join(baseline, path), 'utf8');
  if (name === 'tool') {
    if (suffix === 'js') {
      body = replace(body, 'function searchAndLoad(tools, query, limit) {',
        'function searchAndLoad(tools, query, limit, dependencies) {');
      body = replace(body, 'createToolSearchDocument(tool, tool.namespace)',
        '(dependencies.createDocument ?? createToolSearchDocument)(tool, tool.namespace)');
      body = replace(body, 'const matches = new Bm25Ranker().rank(query, documents, limit);',
        'const matches = dependencies.rank ? dependencies.rank(query, documents, limit) : new Bm25Ranker().rank(query, documents, limit);');
      body = replace(body, 'createToolSearchToolDefinition(options = {}) {',
        'createToolSearchToolDefinition(options = {}, dependencies = {}) {');
      body = replace(body, 'searchAndLoad(options.tools, query, max)',
        'searchAndLoad(options.tools, query, max, dependencies)');
    } else {
      body = replace(body, 'export interface ToolSearchToolOptions {',
        'export interface ToolSearchDependencies {\n    /** Build metadata through the host shared search implementation. */\n    createDocument?: typeof createToolSearchDocument;\n    /** Rank metadata through the host shared search implementation. */\n    rank?: ToolRanker["rank"];\n}\nexport interface ToolSearchToolOptions {');
      body = replace(body, 'createToolSearchToolDefinition(options?: ToolSearchToolOptions)',
        'createToolSearchToolDefinition(options?: ToolSearchToolOptions, dependencies?: ToolSearchDependencies)');
    }
  } else if (suffix === 'js') {
    body = replace(body, 'createToolSearchExtension() {', 'createToolSearchExtension(dependencies = {}) {');
    body = replace(body, 'createToolSearchToolDefinition({ tools: pi })',
      'createToolSearchToolDefinition({ tools: pi }, dependencies)');
  } else {
    body = 'import type { ToolSearchDependencies } from "./tool.ts";\n' + replace(body,
      'export declare function createToolSearchExtension()', 'export declare function createToolSearchExtension(dependencies?: ToolSearchDependencies)');
  }
  outputs.set(path, body);
}
for (const name of ['tool', 'index']) for (const suffix of ['js', 'd.ts']) {
  const path = `dist/extensions/codemode/${name}.${suffix}`;
  outputs.set(path, codingCodemodePolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts', name === 'index'));
}
for (const name of ['bash', 'powershell']) for (const suffix of ['js', 'd.ts']) {
  const path = `dist/core/tools/${name}.${suffix}`;
  outputs.set(path, codingShellPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts', name === 'powershell'));
}
const bashExecutor = 'dist/core/bash-executor.js';
outputs.set(bashExecutor, codingBashOutputPolicy(readFileSync(join(baseline, bashExecutor), 'utf8')));
const ansi = 'dist/utils/ansi.js';
outputs.set(ansi, codingAnsiPolicy(readFileSync(join(baseline, ansi), 'utf8')));
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/utils/shell.${suffix}`;
  outputs.set(path, codingShellHelpersPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/utils/tools-manager.${suffix}`;
  outputs.set(path, codingToolsManagerPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
  const httpPath = `dist/utils/management-http.${suffix}`;
  outputs.set(httpPath, codingManagementHttpPolicy(readFileSync(join(baseline, httpPath), 'utf8'), suffix === 'd.ts'));
}
const rpcPath = 'dist/modes/rpc/rpc-client.js';
let rpc = replace(readFileSync(join(baseline, rpcPath), 'utf8'),
  'const cliPath = this.options.cliPath ?? "dist/cli.js";',
  'const cliPath = this.resolveCliPath(this.options.cliPath);');
outputs.set(rpcPath, replace(rpc, '    /**\n     * Start the RPC agent process.\n     */\n    async start() {',
  '    resolveCliPath(cliPath) {\n        return cliPath ?? "dist/cli.js";\n    }\n    /**\n     * Start the RPC agent process.\n     */\n    async start() {'));
const rpcTypesPath = 'dist/modes/rpc/rpc-client.d.ts';
outputs.set(rpcTypesPath, replace(readFileSync(join(baseline, rpcTypesPath), 'utf8'),
  '    /**\n     * Start the RPC agent process.\n     */\n    start(): Promise<void>;',
  '    protected resolveCliPath(cliPath: string | undefined): string;\n    /**\n     * Start the RPC agent process.\n     */\n    start(): Promise<void>;'));
const managerPath = 'dist/core/settings-manager.js';
outputs.set(managerPath, replace(readFileSync(join(baseline, managerPath), 'utf8'),
  'function deepMergeSettings(base, overrides) {', 'export function deepMergeSettings(base, overrides) {'));
const typesPath = 'dist/core/settings-manager.d.ts';
outputs.set(typesPath, replace(readFileSync(join(baseline, typesPath), 'utf8'),
  'export type SettingsScope =',
  'export declare function deepMergeSettings(base: Settings, overrides: Settings): Settings;\nexport type SettingsScope ='));
for (const suffix of ['js', 'd.ts']) {
  const cachePath = `dist/core/cache-warmer.${suffix}`;
  outputs.set(cachePath, codingCachePolicy(readFileSync(join(baseline, cachePath), 'utf8'), suffix === 'd.ts'));
  const path = `dist/core/package-manager.${suffix}`;
  outputs.set(path, codingPackagePolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
  const sessionPath = `dist/core/session-manager.${suffix}`;
  outputs.set(sessionPath, codingSessionPolicy(readFileSync(join(baseline, sessionPath), 'utf8'), suffix === 'd.ts'));
  const resourcePath = `dist/core/resource-loader.${suffix}`;
  outputs.set(resourcePath, codingResourcePolicy(readFileSync(join(baseline, resourcePath), 'utf8'), suffix === 'd.ts'));
  const extensionPath = `dist/core/extensions/loader.${suffix}`;
  outputs.set(extensionPath, codingExtensionPolicy(readFileSync(join(baseline, extensionPath), 'utf8'), suffix === 'd.ts'));
  const runtimePath = `dist/core/model-runtime.${suffix}`;
  outputs.set(runtimePath, codingModelRuntimePolicy(readFileSync(join(baseline, runtimePath), 'utf8'), suffix === 'd.ts'));
  const agentSessionPath = `dist/core/agent-session.${suffix}`;
  outputs.set(agentSessionPath, codingBoundaryExports(codingAgentSessionPolicy(readFileSync(join(baseline, agentSessionPath), 'utf8'), suffix === 'd.ts'), suffix === 'd.ts'));
  const runnerPath = `dist/core/extensions/runner.${suffix}`;
  outputs.set(runnerPath, codingRunnerPolicy(readFileSync(join(baseline, runnerPath), 'utf8'), suffix === 'd.ts'));
  const toolPath = `dist/core/tools/tool-definition-wrapper.${suffix}`;
  outputs.set(toolPath, codingToolPolicy(readFileSync(join(baseline, toolPath), 'utf8'), suffix === 'd.ts'));
}
for (const name of ['grep', 'find']) {
  const tool = name === 'grep' ? 'rg' : 'fd';
  const type = name === 'grep' ? 'GrepToolOptions' : 'FindToolOptions';
  const jsPath = `dist/core/tools/${name}.js`;
  let implementation = replace(readFileSync(join(baseline, jsPath), 'utf8'),
    `await ensureTool("${tool}")`, `await (options?.ensureTool ?? ensureTool)("${tool}")`);
  if (name === 'grep') {
    const abort = `                        if (signal?.aborted) {
                            settle(() => reject(new Error("Operation aborted")));
                            return;
                        }
`;
    // An asynchronous host resolver or directory operation can outlive cancellation.
    implementation = replace(implementation, '                        if (!rgPath) {', abort + '                        if (!rgPath) {');
    implementation = replace(implementation, '                        const contextValue =', abort + '                        const contextValue =');
  }
  outputs.set(jsPath, implementation);
  const declarationPath = `dist/core/tools/${name}.d.ts`;
  let declaration = replace(readFileSync(join(baseline, declarationPath), 'utf8'),
    `export interface ${type} {`, `export interface ${type} {\n    /** Resolve binaries with the host's installation and offline policy. */\n    ensureTool?: typeof ensureTool;`);
  if (name === 'find') declaration = replace(declaration, 'pathModule?: path.PlatformPath', 'pathModule?: typeof path.posix');
  outputs.set(declarationPath, 'import type { ensureTool } from "../../utils/tools-manager.ts";\n' + declaration);
}
const readPath = 'dist/core/tools/read.js';
let read = replace(readFileSync(join(baseline, readPath), 'utf8'),
  'await processImage(buffer, mimeType, {', 'await (options?.processImage ?? processImage)(buffer, mimeType, {');
read = replace(read, 'import { readRenderers }', 'import { createReadRenderers, readRenderers }');
read = replace(read, '    const ops = options?.operations ?? defaultReadOperations;',
  '    const ops = options?.operations ?? defaultReadOperations;\n    const getReadmePath = options?.getReadmePath;');
outputs.set(readPath, replace(read, '        ...readRenderers,',
  '        ...(getReadmePath ? createReadRenderers(getReadmePath) : readRenderers),'));
const readTypesPath = 'dist/core/tools/read.d.ts';
outputs.set(readTypesPath, 'import type { processImage } from "../../utils/image-process.ts";\n' + replace(
  readFileSync(join(baseline, readTypesPath), 'utf8'), 'export interface ReadToolOptions {',
  'export interface ReadToolOptions {\n    /** Process images with the host shared image runtime. */\n    processImage?: typeof processImage;\n    /** Locate host documentation for compact read presentation. */\n    getReadmePath?: () => string;'));
const readRendererPath = 'dist/core/tools/renderers/read.js';
let readRenderer = replace(readFileSync(join(baseline, readRendererPath), 'utf8'),
  'import { getReadmePath }', 'import { getReadmePath as defaultGetReadmePath }');
readRenderer = replace(readRenderer, 'function getPiDocsClassification(absolutePath) {',
  'export function createReadRenderers(getReadmePath = defaultGetReadmePath) {\nfunction getPiDocsClassification(absolutePath) {');
readRenderer = replace(readRenderer, 'export const readRenderers = {', 'return {');
outputs.set(readRendererPath, replace(readRenderer, '};\n//# sourceMappingURL=',
  '};\n}\nexport const readRenderers = createReadRenderers();\n//# sourceMappingURL='));
const readRendererTypesPath = 'dist/core/tools/renderers/read.d.ts';
outputs.set(readRendererTypesPath, replace(readFileSync(join(baseline, readRendererTypesPath), 'utf8'),
  'export declare const readRenderers:',
  'export declare function createReadRenderers(getReadmePath?: () => string): typeof readRenderers;\nexport declare const readRenderers:'));
const extensionTypesPath = 'dist/core/extensions/types.d.ts';
outputs.set(extensionTypesPath, replace(readFileSync(join(baseline, extensionTypesPath), 'utf8'),
  'export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {',
  'export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {\n    /** Only tools explicitly safe to repeat may resume an uncertain durable execution. */\n    replay?: "safe" | "never";'));
const composerPath = 'dist/core/provider-composer.d.ts';
outputs.set(composerPath, replace(readFileSync(join(baseline, composerPath), 'utf8'),
  'modelConfig: ModelConfig,', 'modelConfig: Pick<ModelConfig, "getProvider">,'));
// Registry implementations only call public runtime operations; host ownership stays structural.
const registryPath = 'dist/core/model-registry.d.ts';
outputs.set(registryPath, replace(readFileSync(join(baseline, registryPath), 'utf8'),
  'constructor(runtime: ModelRuntime);', 'constructor(runtime: Pick<ModelRuntime, keyof ModelRuntime>);'));
const themeValidationComment = ` * Install full theme validation. Without it, documents are accepted as-is, which is what built-in
 * themes already do: validating user-authored JSON needs typebox, and a presentation that only uses
 * built-in themes should not pay ~17 MB of module graph for it.`;
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/modes/interactive/theme/theme.${suffix}`;
  let body = replace(readFileSync(join(baseline, path), 'utf8'), themeValidationComment,
    ' * Replace the default full theme validator. File loading validates without CLI initialization.');
  if (suffix === 'js') {
    body = replace(body, 'let themeJsonValidator;',
      'let themeJsonValidator = validateThemeJson;');
    body = 'import { validateThemeJson } from "./theme-schema.js";\n' + body;
  }
  outputs.set(path, body);
}
const schemaComment = ` * Theme JSON validation, kept out of \`theme.ts\` on purpose.
 *
 * Validating user-authored theme files needs typebox, which costs ~17 MB of module graph to import.
 * Palette lookup does not, so a presentation that only uses built-in themes should never pay for it.
 * \`main.ts\` installs this validator before runtime resource loading; other consumers can opt in with
 * \`setThemeJsonValidator()\`. Built-in themes do not need validation.`;
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/modes/interactive/theme/theme-schema.${suffix}`;
  outputs.set(path, replace(readFileSync(join(baseline, path), 'utf8'), schemaComment,
    ' * Full theme JSON validation. The SDK theme module enables it by default.\n * Hosts can replace it with setThemeJsonValidator().'));
}
const configPath = 'dist/config.js';
let config = readFileSync(join(baseline, configPath), 'utf8');
for (const [name, directory] of [['getThemesDir', 'theme'], ['getExportTemplateDir', 'export-html']]) {
  config = replace(config, `export function ${name}() {`, `export function ${name}() {
    // The host distributes SDK assets beside its worker bundle.
    const bundled = join(isBunBinary ? dirname(process.execPath) : __dirname, "coding-assets", "${directory}");
    if (existsSync(bundled)) return bundled;`);
}
outputs.set(configPath, config);
const sleepPath = 'dist/utils/sleep.js';
let sleep = readFileSync(join(baseline, sleepPath), 'utf8');
sleep = replace(sleep, '        const timeout = setTimeout(resolve, ms);', `        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const timeout = setTimeout(() => { cleanup(); resolve(); }, ms);`);
sleep = replace(sleep, '        signal?.addEventListener("abort", () => {', '        const onAbort = () => {\n            cleanup();');
sleep = replace(sleep, '        });\n    });', '        };\n        signal?.addEventListener("abort", onAbort, { once: true });\n    });');
outputs.set(sleepPath, sleep);
const imagePath = 'dist/utils/image-resize.js';
outputs.set(imagePath, codingImageProcessingPolicy(replace(readFileSync(join(baseline, imagePath), 'utf8'), `    // Bun compiled executables resolve worker entrypoints by string path, not via
    // new URL(..., import.meta.url). Try the string path first under Bun so the
    // release binary uses the embedded worker instead of falling back in-process.
    if (typeof process.versions.bun === "string") {
        try {
            return await resizeImageInWorker("./src/utils/image-resize-worker.ts", inputBytes, mimeType, options);
        }
        catch { }
    }
`, '    // A project directory cannot supply executable image workers. Use the module URL or process locally.\n'), false, 'image-resize'));
for (const [module, suffix] of [['image-resize', 'd.ts'], ['image-process', 'js'], ['image-process', 'd.ts'], ['image-resize-worker', 'js']]) {
  const path = `dist/utils/${module}.${suffix}`;
  outputs.set(path, codingImageProcessingPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts', module));
}
const mcpToolsPath = 'dist/extensions/mcp/tools.js';
outputs.set(mcpToolsPath, replace(readFileSync(join(baseline, mcpToolsPath), 'utf8'),
  '    const relocated = {};', `    // A schema resource keeps its own local reference base when embedded.
    if (typeof schema.$id === "string")
        return schema;
    const relocated = {};`));
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/core/resolve-config-value.${suffix}`;
  let body = readFileSync(join(baseline, path), 'utf8');
  if (suffix === 'js') {
    body = replace(body, 'function executeCommandUncached(commandConfig) {', 'function executeCommandUncached(commandConfig, options) {');
    body = replace(body, 'return process.platform === "win32"', 'return options?.shell !== "default" && process.platform === "win32"');
    body = replace(body, 'resolveConfigValueUncached(config, env) {', 'resolveConfigValueUncached(config, env, options) {');
    body = replace(body, 'return executeCommandUncached(reference.config);', 'return executeCommandUncached(reference.config, options);');
    body = replace(body, 'resolveConfigValueOrThrow(config, description, env) {', 'resolveConfigValueOrThrow(config, description, env, options) {');
    body = replace(body, 'resolveConfigValueUncached(config, env);', 'resolveConfigValueUncached(config, env, options);');
    body = replace(body, 'resolveHeadersOrThrow(headers, description, env) {', 'resolveHeadersOrThrow(headers, description, env, options) {');
    body = replace(body, 'resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);', 'resolveConfigValueOrThrow(value, `${description} header "${key}"`, env, options);');
  } else {
    for (const signature of [
      'resolveConfigValueUncached(config: string, env?: Record<string, string>',
      'resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>',
      'resolveHeadersOrThrow(headers: Record<string, string> | undefined, description: string, env?: Record<string, string>',
    ]) body = replace(body, signature + ')', signature + ', options?: { shell?: "default" })');
  }
  outputs.set(path, body);
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/extensions/mcp/config.${suffix}`;
  let body = readFileSync(join(baseline, path), 'utf8');
  if (suffix === 'js') {
    body = replace(body, 'function readConfigFile(path, scope, state) {',
      'function readConfigFile(path, scope, state, validateConfig = validateMcpServerConfig) {');
    body = replace(body, 'const config = validateMcpServerConfig(name, { ...base.config, ...value });',
      'const config = validateConfig(name, { ...base.config, ...value });');
    body = replace(body, 'const config = validateMcpServerConfig(name, value);', 'const config = validateConfig(name, value);');
    body = replace(body, `    readConfigFile(join(options.agentDir, "mcp.json"), "global", state);
    const projectConfig = options.projectTrusted ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
    if (projectConfig)
        readConfigFile(projectConfig, "project", state);`, `    const projectConfig = options.projectTrusted
        ? options.configFiles ? options.configFiles.findLast(file => file.scope === "project")?.path
            : join(options.cwd, CONFIG_DIR_NAME, "mcp.json")
        : undefined;
    const files = options.configFiles ?? [
        { path: join(options.agentDir, "mcp.json"), scope: "global" },
        ...(projectConfig ? [{ path: projectConfig, scope: "project" }] : []),
    ];
    for (const { path, scope } of files) {
        if (scope === "project" && !options.projectTrusted) continue;
        readConfigFile(path, scope, state, options.validateServerConfig);
    }`);
  } else {
    body = replace(body, 'export declare function loadMcpConfig(options: {', `export declare function loadMcpConfig(options: {
    /** Read these files in order; project files still require projectTrusted. */
    configFiles?: readonly { path: string; scope: "global" | "project" }[];
    /** Apply host policy to definitions and merged overrides before storing them. */
    validateServerConfig?: (name: string, raw: unknown) => McpServerConfig | string;`);
  }
  outputs.set(path, body);
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/core/tools/index.${suffix}`;
  outputs.set(path, codingToolFactoriesPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
}
const staging = mkdtempSync(join(tmpdir(), 'coding-sdk-exports-'));
let patch = '';
for (const [path, output] of outputs) {
  const candidate = join(staging, path.replaceAll('/', '-'));
  writeFileSync(candidate, output);
  const diff = Bun.spawnSync(['git', 'diff', '--no-index', '--no-color', '--unified=3', '--', join(baseline, path), candidate]);
  if (diff.exitCode !== 1) throw new Error('Cannot create export patch: ' + diff.stderr.toString());
  const lines = diff.stdout.toString().split('\n');
  const start = lines.findIndex(line => line.startsWith('@@'));
  if (start < 0) throw new Error('Missing export patch hunk');
  patch += `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${lines.slice(start).join('\n')}`;
}
patch = `# Content SHA-256: ${hash(patch)}\n${patch}`;
const manifest = JSON.stringify({
  repository: 'https://github.com/earendil-works/pi',
  revision: 'f9a26365568127461c47a07a37dcb42c140a3ac5',
  version: '1.5.0',
  patch: 'coding-sdk-host-boundaries-v1',
  policy: 'Export existing settings, package, keybinding, theme, registry, session and resource contracts. Preserve published algorithms; add host package policies, structural runtime constructor typing, context projection callbacks, legacy session factories, resource trust and extension bindings, per-importer plugin caches and module import hooks, host discovery paths, live host model and shared credential binding with memory-only overlays, structural provider config typing, per-runner theme and prompt bindings, session tool and action callbacks, protected durable execution and input admission hooks, optional nested tool executor, internal model message projection and prompt and read-tool image processing bindings and host read-renderer documentation paths, host input metadata and summary stream bindings, optional durable tool replay typing and tool conversion metadata with symbol descriptors, module-relative executable image workers, default full theme validation, existing HTML, sleep and ZIP module exports, optional host search binary resolution, Node-compatible find path typing, post-await grep cancellation checks and existing search tool exports, optional codemode executor binding and existing codemode presentation exports, optional host shell configuration, environment, process waiting, termination and tracking dependencies, sleep listener cleanup, shared extension model initialization, an optional session factory and runtime session subtype declarations, and installed worker theme and HTML asset lookup, and protected RPC CLI selection with the published default, and MCP schema resource boundaries during local-reference relocation, and optional platform default shell resolution for host MCP configuration, and optional ordered MCP configuration files with trusted project loading and host validation before definitions and overrides are stored, and existing MCP resource tools and app-resource detection with their context-free execution overload, completed Bash output writes and bounded OSC stream cleanup.',
  files: [...outputs].map(([path, output]) => ({
    path, originalSha256: hash(readFileSync(join(baseline, path), 'utf8')), sha256: hash(output),
  })),
}, null, 2) + '\n';
if (mode === '--check') {
  if (readFileSync(patchPath, 'utf8') !== patch || readFileSync(manifestPath, 'utf8') !== manifest) {
    throw new Error('Coding SDK export patch or inventory differs');
  }
} else {
  writeFileSync(patchPath, patch);
  writeFileSync(manifestPath, manifest);
}
console.log(`Validated ${outputs.size} Coding SDK patch files; ${mode}.`);
