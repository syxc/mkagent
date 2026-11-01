#!/usr/bin/env node
import { BackgroundShells } from './background-shell.ts';
import type { AgentEvent } from '@mkagent/core/types';
/**
 * Pi Agent Server
 *
 * Out-of-process agent server communicating via JSONL over stdio.
 * Wraps the @earendil-works/pi-durable kernel and communicates with the main
 * Electron process using a line-delimited JSON protocol.
 *
 * The main process spawns this as a child process. All session interactions
 * (conversation lifecycle, prompting, tool execution, permissions) happen
 * here, with events synthesized back into the pi-coding-agent 1.1.0
 * `AgentSessionEvent` shapes the main process already consumes.
 *
 * This design isolates the SDK's ESM + heavy dependencies into a separate
 * process, avoiding bundling issues in the Electron main process.
 */

import http from 'node:http';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Durable kernel
import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable';
import type { AgentSessionEvent } from '@mkagent/shared/agent/pi-events';

// Pre-register the Bedrock provider module so the SDK doesn't attempt a
// dynamic import of "./amazon-bedrock.js" — which fails in the bundled output
// because bun collapses everything into a single file.
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';
setBedrockProviderModule(bedrockProviderModule);

// The bundled subprocess cannot resolve Pi's variable-specifier OAuth imports.
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
registerBunOAuthFlows();

// Model resolution (extracted for testability + custom-endpoint precedence)
import { resolvePiModel } from './model-resolution.ts';
import { queryLlm } from './ephemeral.ts';
import {
  EphemeralQueryCancelledError,
  EphemeralQueryCoordinator,
  isEphemeralQueryCancellation,
} from './ephemeral-query-lifecycle.ts';
import { stripPiPrefix, type CustomEndpointConfig } from './custom-endpoint-models.ts';
import {
  createModelRuntime,
  registerCustomEndpointModels,
  resolveCustomEndpointApiKey,
  type ModelRuntime,
} from './model-runtime.ts';

// Direct source imports from shared (bundled by bun build)
import { getSessionPath } from '../../shared/src/sessions/storage.ts';
import { buildCallLlmRequest, LLM_QUERY_TIMEOUT_MS } from '../../shared/src/agent/llm-tool.ts';
import type { LLMQueryRequest, LLMQueryResult } from '../../shared/src/agent/llm-tool.ts';
import { THINKING_TO_PI } from '../../shared/src/agent/backend/pi/constants.ts';
import { createWebFetchTool } from './tools/web-fetch.ts';
import { resolveSearchProvider } from './tools/search/resolve-provider.ts';
import { createSearchTool } from './tools/search/create-search-tool.ts';
import { createBuiltinTools } from './tools/builtin.ts';
import { wrapToolForKernel, type ToolWrapDeps } from './tools/wrap.ts';
import { createCodemodeExtensionFor } from './tools/codemode.ts';
import { loadMcpTools, closeMcpConnections, type McpToolsLoadResult } from './mcp/extension.ts';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { version as CLIENT_VERSION } from '../package.json';
import type { PiCompactResult, PiContextUsagePayload } from '../../shared/src/agent/backend/pi/protocol.ts';
import { adaptCredentialForPiSdk, type PiCredential } from './adapt-credential.ts';
import { resolveCraftAgentDir } from './agent-dir.ts';
import { toPiProviderId } from '../../shared/src/config/pi-provider-ids.ts';
import { providerEndpointEnv } from './provider-endpoint-env.ts';
import { DurableKernel, type KernelHooks, type KernelModelRef } from './kernel.ts';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';

// ============================================================
// Types — JSONL Protocol
// ============================================================

/** Init message from main process — configures the agent server */
interface InitMessage {
  type: 'init';
  apiKey: string;
  model: string;
  cwd: string;
  thinkingLevel: string;
  workspaceRootPath: string;
  sessionId: string;
  sessionPath: string;
  workingDirectory: string;
  plansFolderPath: string;
  miniModel?: string;
  agentDir?: string;
  providerType?: string;
  authType?: string;
  workspaceId?: string;
  baseUrl?: string;
  branchFromSdkSessionId?: string;
  branchFromSessionPath?: string;
  branchFromSdkTurnId?: string;
  customEndpoint?: CustomEndpointConfig;
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
  autoCompactWindow?: number;
  piAuth?: { provider: string; credential: PiCredential };
}

interface RuntimeConfigUpdateMessage {
  type: 'update_runtime_config';
  id: string;
  model: string;
  providerType?: string;
  authType?: string;
  baseUrl?: string;
  customEndpoint?: CustomEndpointConfig;
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
}

/** Messages from main process (stdin) */
type InboundMessage =
  | { type: 'stop_background_task'; id: string; taskId: string }
  | InitMessage
  | { type: 'prompt'; id: string; message: string; systemPrompt: string; images?: Array<{ type: 'image'; data: string; mimeType: string }> }
  | { type: 'register_tools'; tools: ProxyToolDef[] }
  | { type: 'tool_execute_response'; requestId: string; result: { content: string; isError: boolean } }
  | { type: 'pre_tool_use_response'; requestId: string; action: 'allow' | 'block' | 'modify'; input?: Record<string, unknown>; reason?: string }
  | { type: 'abort' }
  | { type: 'mini_completion'; id: string; prompt: string }
  | { type: 'llm_query'; id: string; request: LLMQueryRequest }
  | { type: 'cancel_ephemeral_query'; id: string }
  | { type: 'ensure_session_ready'; id: string }
  | { type: 'set_model'; model: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'compact'; id: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id: string; enabled: boolean }
  | RuntimeConfigUpdateMessage
  | { type: 'steer'; message: string }
  | { type: 'token_update'; piAuth: { provider: string; credential: PiCredential } }
  | { type: 'shutdown' };

/** Proxy tool definition from main process */
interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Canonical tool metadata propagated on tool start events */
interface ToolExecutionMetadata {
  intent?: string;
  displayName?: string;
  source: 'interceptor';
}

type EnrichedToolExecutionStartEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' }> & {
  toolMetadata?: ToolExecutionMetadata;
};

type OutboundAgentEvent = (AgentSessionEvent | EnrichedToolExecutionStartEvent | { type: 'context_usage' }) & PiContextUsagePayload;

/** Messages to main process (stdout) */
interface OutboundReady { type: 'ready'; sessionId: string | null; callbackPort: number }
interface OutboundEvent { type: 'event'; event: OutboundAgentEvent }
interface OutboundPreToolUseReq {
  type: 'pre_tool_use_request';
  requestId: string;
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
}
interface OutboundToolExecReq { type: 'tool_execute_request'; requestId: string; toolName: string; args: Record<string, unknown> }
interface OutboundSessionToolCompleted { type: 'session_tool_completed'; toolName: string; args: Record<string, unknown>; isError: boolean }
interface OutboundMiniResult { type: 'mini_completion_result'; id: string; text: string | null }
interface OutboundLlmQueryResult {
  type: 'llm_query_result';
  id: string;
  result: LLMQueryResult | null;
  errorMessage?: string;
  /**
   * When set, signals the main process that a generic `error` with the same code
   * was also emitted on the error channel (for centralized auth-refresh detection).
   */
  errorCode?: string;
}
interface OutboundEnsureSessionReadyResult { type: 'ensure_session_ready_result'; id: string; sessionId: string | null }
interface OutboundCompactResult {
  type: 'compact_result';
  id: string;
  success: boolean;
  result?: PiCompactResult;
  errorMessage?: string;
}
interface OutboundSetAutoCompactionResult {
  type: 'set_auto_compaction_result';
  id: string;
  success: boolean;
  enabled: boolean;
  errorMessage?: string;
}
interface OutboundRuntimeConfigUpdateResult {
  type: 'update_runtime_config_result';
  id: string;
  success: boolean;
  updated: boolean;
  errorMessage?: string;
}
interface OutboundSessionIdUpdate { type: 'session_id_update'; sessionId: string }
interface OutboundOAuthCredentialUpdate {
  type: 'oauth_credential_update';
  provider: string;
  credential: Extract<PiCredential, { type: 'oauth' }>;
  previousRefresh?: string;
}
interface OutboundError { type: 'error'; message: string; code?: string; id?: string }

type OutboundMessage =
  | { type: 'background_task_event'; event: AgentEvent }
  | { type: 'stop_background_task_result'; id: string; stopped: boolean }
  | OutboundReady
  | OutboundEvent
  | OutboundPreToolUseReq
  | OutboundToolExecReq
  | OutboundSessionToolCompleted
  | OutboundMiniResult
  | OutboundLlmQueryResult
  | OutboundEnsureSessionReadyResult
  | OutboundCompactResult
  | OutboundSetAutoCompactionResult
  | OutboundRuntimeConfigUpdateResult
  | OutboundSessionIdUpdate
  | OutboundOAuthCredentialUpdate
  | OutboundError;

// ============================================================
// State
// ============================================================

let kernel: DurableKernel | null = null;
let mcpLoad: McpToolsLoadResult | null = null;
let modelRuntime: ModelRuntime | null = null;
let modelRuntimePromise: Promise<ModelRuntime> | null = null;

const ephemeralQueries = new EphemeralQueryCoordinator();
let localEphemeralQueryCounter = 0;

function nextLocalEphemeralQueryId(source: string): string {
  localEphemeralQueryCounter += 1;
  return `${source}-${localEphemeralQueryCounter}`;
}

// Init config (set on 'init' message)
let initConfig: Extract<InboundMessage, { type: 'init' }> | null = null;

// Mutable state
let currentUserMessage = '';
const backgroundShells = new BackgroundShells(event => send({ type: 'background_task_event', event }));

// Pending promises for async handshakes
const pendingPreToolUse = new Map<string, { resolve: (response: { action: string; input?: Record<string, unknown>; reason?: string }) => void }>();
const pendingToolExecutions = new Map<string, { resolve: (result: { content: string; isError: boolean }) => void }>();

// Proxy tool definitions from main process
let proxyToolDefs: ProxyToolDef[] = [];

// Speculative prefetch for read-only tools (enables parallel execution despite the
// kernel's sequential tool round). When the LLM emits multiple call_llm tool calls
// in a single message, we fire all requests to the main process in parallel on
// message_end (before the tool round starts). Each proxy tool's execute() then
// hits the cache instead of sending a new request.
const PREFETCHABLE_TOOLS = new Set(['call_llm']);
const prefetchCache = new Map<string, Promise<{ content: string; isError: boolean }>>();

function isPrefetchableTool(toolName: string): boolean {
  const stripped = toolName.replace(/^(mcp__session__|session__)/, '');
  return PREFETCHABLE_TOOLS.has(stripped);
}

// Flag: proxy tools changed since last session open — the tool registry is
// fixed at store open, so the kernel needs recreation on the next prompt.
let toolsChanged = false;

// Callback server for call_llm
let callbackServer: http.Server | null = null;
let callbackPort = 0;

// ============================================================
// JSONL I/O
// ============================================================

function send(msg: OutboundMessage): void {
  const line = JSON.stringify(msg);
  process.stdout.write(line + '\n');
}

function debugLog(message: string): void {
  // Write debug messages to stderr so they don't interfere with JSONL protocol
  process.stderr.write(`[pi-server] ${message}\n`);
}

// ============================================================
// Loopback server used by the call_llm session tool
// ============================================================

async function startCallbackServer(): Promise<void> {
  if (callbackServer) return;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/call-llm') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

      debugLog('Received call_llm request via callback server');
      const result = await preExecuteCallLlm(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLog(`call_llm via callback failed: ${msg}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      callbackPort = typeof addr === 'object' && addr ? addr.port : 0;
      debugLog(`Callback server listening on 127.0.0.1:${callbackPort}`);
      resolve();
    });
    server.on('error', reject);
  });

  callbackServer = server;
}

function stopCallbackServer(): void {
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
    callbackPort = 0;
  }
}

// ============================================================
// Session Management
// ============================================================

function resolvedCwd(): string {
  const wd = initConfig?.cwd || initConfig?.workingDirectory || process.cwd();
  if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
  if (wd === '~') return homedir();
  return wd;
}

// Helper: derive preferCustomEndpoint flag from init config
function shouldPreferCustomEndpoint(): boolean {
  return Boolean(initConfig?.customEndpoint && initConfig?.baseUrl?.trim());
}

/**
 * Expose the active model API/provider/base URL to the interceptor process.
 * This gives the interceptor a robust routing hint (instead of brittle URL-only matching).
 */
function setInterceptorApiHints(model: { api?: string; provider?: string; baseUrl?: string } | undefined): void {
  if (!model) {
    delete process.env.MKAGENT_PI_MODEL_API;
    delete process.env.MKAGENT_PI_MODEL_PROVIDER;
    delete process.env.MKAGENT_PI_MODEL_BASE_URL;
    return;
  }

  process.env.MKAGENT_PI_MODEL_API = model.api || '';
  process.env.MKAGENT_PI_MODEL_PROVIDER = model.provider || '';
  process.env.MKAGENT_PI_MODEL_BASE_URL = model.baseUrl || '';

  debugLog(
    `[interceptor-hint] api=${process.env.MKAGENT_PI_MODEL_API || '-'} provider=${process.env.MKAGENT_PI_MODEL_PROVIDER || '-'} baseUrl=${process.env.MKAGENT_PI_MODEL_BASE_URL || '-'}`,
  );
}

/**
 * Tenant-specific endpoints (Azure OpenAI, Cloudflare AI Gateway) reach the SDK
 * through env vars derived from the connection's base URL. Re-applied on runtime
 * config updates so an edited endpoint takes effect without a subprocess restart.
 */
function applyProviderEndpointEnv(config: InitMessage): void {
  const env = providerEndpointEnv(config.piAuth?.provider, config.baseUrl);
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
    debugLog(`Set ${key}=${value}`);
  }
  if (config.piAuth?.provider === 'cloudflare-ai-gateway' && !env.CLOUDFLARE_GATEWAY_ID) {
    debugLog(`Cloudflare AI Gateway: base URL ${config.baseUrl ?? '(none)'} has no account/gateway id`);
  }
}

/** Craft wire auth with the provider id the SDK knows (see pi-provider-ids.ts). */
function toPiAuth(piAuth: NonNullable<InitMessage['piAuth']>): NonNullable<InitMessage['piAuth']> {
  return { ...piAuth, provider: toPiProviderId(piAuth.provider) };
}

/**
 * Build the shared model runtime: builtin provider catalog over the process
 * credential store, plus the custom-endpoint provider when configured.
 * Cached because utility-model calls and the main session use the same provider
 * catalog. Re-created on re-init and runtime config changes; the kernel reads
 * the current instance live through modelsSource().
 */
async function ensureModelRuntime(): Promise<ModelRuntime> {
  if (!modelRuntimePromise) {
    if (!initConfig) throw new Error('Cannot create session: init not received');
    const config = initConfig;
    modelRuntimePromise = (async () => {
      const runtime = await createModelRuntime({
        apiKey: config.apiKey,
        piAuth: config.piAuth,
        baseUrl: config.baseUrl,
        customEndpoint: config.customEndpoint,
        customModels: config.customModels,
        model: config.model,
      }, update => send({ type: 'oauth_credential_update', ...update }));

      if (config.piAuth) {
        const { provider, credential } = config.piAuth;
        const adapted = adaptCredentialForPiSdk(provider, credential);
        if (adapted) {
          await runtime.credentials.seed(provider, adapted);
          debugLog(`Injected ${credential.type} credential for provider: ${provider}${
            adapted.type !== credential.type ? ` (stored as ${adapted.type} for SDK resolution)` : ''}`);
        } else {
          debugLog(`Not storing ${credential.type} credential for provider: ${provider} — resolves from environment`);
        }
      } else if (config.apiKey) {
        await runtime.credentials.seed('anthropic', { type: 'api_key', key: config.apiKey });
        debugLog('Injected API key into credential store (legacy fallback)');
      }

      modelRuntime = runtime;
      return runtime;
    })().catch((error) => {
      modelRuntimePromise = null;
      throw error;
    });
  }
  return modelRuntimePromise;
}

/**
 * Resolve a model id against the shared catalog, dynamically registering
 * unknown custom-endpoint models so mid-session switching works, and refresh
 * the interceptor hints. Returns undefined when unresolvable.
 */
async function resolveModelRef(modelId: string): Promise<KernelModelRef | undefined> {
  const runtime = await ensureModelRuntime();
  let piModel = resolvePiModel(runtime.models, modelId, initConfig?.piAuth?.provider, shouldPreferCustomEndpoint());

  if (!piModel && initConfig?.baseUrl?.trim() && initConfig?.customEndpoint) {
    const bareId = stripPiPrefix(modelId);
    // registerCustomEndpointModels accumulates known ids and re-registers the
    // full set (setProvider replaces wholesale).
    registerCustomEndpointModels({
      models: runtime.models,
      api: initConfig.customEndpoint.api,
      baseUrl: initConfig.baseUrl.trim(),
      apiKey: resolveCustomEndpointApiKey({ apiKey: initConfig.apiKey, piAuth: initConfig.piAuth, baseUrl: initConfig.baseUrl }),
      endpointDefaults: {
        supportsImages: initConfig.customEndpoint.supportsImages === true,
        maxTokens: initConfig.customEndpoint.maxTokens,
      },
      entries: [{ id: bareId }],
    });
    piModel = runtime.models.getModel('custom-endpoint', bareId) ?? undefined;
    debugLog(`[model] Dynamically registered custom endpoint model: ${bareId}`);
  }

  if (!piModel) return undefined;
  setInterceptorApiHints(piModel);
  return { provider: piModel.provider, modelId: piModel.id, contextWindow: piModel.contextWindow };
}

/**
 * Send pre_tool_use_request to main process and wait for response.
 * Returns the (potentially modified) input if approved, throws if blocked.
 * All permission checking and input transforms happen in the main process.
 */
async function requestPreToolUseApproval(
  sdkToolName: string,
  input: Record<string, unknown>,
  toolCallId?: string,
): Promise<Record<string, unknown>> {
  const requestId = `pi-ptu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  send({
    type: 'pre_tool_use_request',
    requestId,
    toolName: sdkToolName,
    ...(toolCallId ? { toolCallId } : {}),
    input,
  });

  const response = await new Promise<{ action: string; input?: Record<string, unknown>; reason?: string }>((resolve) => {
    pendingPreToolUse.set(requestId, { resolve });
  });

  if (response.action === 'block') {
    throw new Error(response.reason || `Tool "${sdkToolName}" is not allowed`);
  }

  return response.action === 'modify' && response.input ? response.input : input;
}

// ============================================================
// Tools (builtin + web + main-process proxies) on the kernel registry
// ============================================================

// Search provider is selected based on the user's LLM connection:
//   - OpenAI/OpenRouter → Responses API built-in web_search
//   - Google → Gemini API with googleSearch grounding
//   - Others → DuckDuckGo fallback
//
// IMPORTANT: resolve dynamically on each search call so token_update refreshes
// are used without recreating the session.
const searchProvider = {
  get name() {
    return resolveSearchProvider(initConfig?.piAuth, initConfig?.model ? stripPiPrefix(initConfig.model) : undefined).name;
  },
  async search(query: string, count: number) {
    return resolveSearchProvider(initConfig?.piAuth, initConfig?.model ? stripPiPrefix(initConfig.model) : undefined).search(query, count);
  },
};

/**
 * Main-process tools as kernel registrations. Durable surfaces tools to the
 * model through the request schema (no system-prompt tool listing), so the
 * 1.1.0 promptSnippet trick is no longer needed.
 */
function buildProxyTools(): ToolRegistration[] {
  debugLog(`Building proxy tools from ${proxyToolDefs.length} definitions: ${proxyToolDefs.map(t => t.name).join(', ')}`);

  return proxyToolDefs.map(def => defineTool({
    name: def.name,
    description: def.description,
    parameters: def.inputSchema as never,
    execute: async (args, api) => {
      // Check speculative prefetch cache first (parallel call_llm optimization).
      // If this tool was prefetched on message_end, the request is already in-flight —
      // just await the result instead of sending a duplicate request.
      const prefetched = prefetchCache.get(api.callId);
      if (prefetched) {
        prefetchCache.delete(api.callId);
        debugLog(`Prefetch cache hit for ${def.name} (toolCallId: ${api.callId})`);
        const result = await prefetched;
        return { output: [{ type: 'text' as const, text: result.content }], ...(result.isError ? { isError: true } : {}) };
      }

      const inputObj = (args ?? {}) as Record<string, unknown>;

      // Permission checking via main process
      const approvedInput = await requestPreToolUseApproval(def.name, inputObj, api.callId);

      // Execute via main process
      const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      send({
        type: 'tool_execute_request',
        requestId,
        toolName: def.name,
        args: approvedInput,
      });

      const result = await new Promise<{ content: string; isError: boolean }>((resolve) => {
        pendingToolExecutions.set(requestId, { resolve });
      });

      return { output: [{ type: 'text' as const, text: result.content }], ...(result.isError ? { isError: true } : {}) };
    },
  }));
}

/**
 * The full tool extension installed on the kernel registry: builtin coding
 * tools + web tools + main-process proxies, all wrapped with permission hooks
 * and large-response summarization. A main-process tool failure carries
 * `isError` so the model gets an error tool result and the UI marks the call
 * failed, as a thrown error would.
 */
function buildToolsExtension(cwd: string, mcpTools: readonly ToolRegistration[]): Extension {
  if (!initConfig) throw new Error('Cannot build tools: init not received');
  const builtinTools = createBuiltinTools(cwd);
  const searchTool = createSearchTool(searchProvider);
  const webFetchTool = createWebFetchTool(() =>
    initConfig ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId) : null
  );
  const proxyTools = buildProxyTools();

  const wrapDeps: ToolWrapDeps = {
    requestApproval: requestPreToolUseApproval,
    backgroundShells,
    tasksDirectory: join(resolveCraftAgentDir(initConfig), 'tasks'),
    // Same env options as the kernel's; background bash must not run through
    // durable's bash tool (its api is call-scoped and rejects after settle).
    shellEnv: new NodeExecutionEnv({
      cwd,
      ...(process.env.MKAGENT_GIT_BASH_PATH?.trim() ? { shellPath: process.env.MKAGENT_GIT_BASH_PATH.trim() } : {}),
    }),
    // Source the active model's contextWindow each call so the threshold
    // tracks set_model mid-session. Falls back to the fixed default when the
    // model isn't set yet.
    getContextWindow: () => kernel?.currentModel?.contextWindow,
    summarize: runMiniCompletion,
    getUserRequest: () => currentUserMessage,
    getSessionPath: () => initConfig ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId) : null,
    debugLog,
  };

  const wrapped = [
    ...builtinTools,
    searchTool,
    webFetchTool,
    // MCP tools go through the same permission + summarization wrap as the
    // rest; their callers/deferred/structuredOutputSchema fields survive the spread.
    ...mcpTools,
    ...proxyTools,
  ].map(tool => wrapToolForKernel(tool, wrapDeps));
  debugLog(`Session tools: ${builtinTools.length} builtin + ${mcpTools.length} mcp + ${proxyTools.length + 2} web/proxy = ${wrapped.length} total`);

  return defineExtension({ name: 'mkagent-tools', tools: wrapped });
}

// ============================================================
// Kernel session lifecycle
// ============================================================

const kernelHooks: KernelHooks = {
  emitEvent: (event) => send({ type: 'event', event: event as OutboundAgentEvent }),
  sessionToolCompleted: (toolName, args, isError) => send({ type: 'session_tool_completed', toolName, args, isError }),
  prefetchToolCall: (toolCallId, toolName, args) => {
    const requestId = `prefetch-${toolCallId}`;
    const promise = new Promise<{ content: string; isError: boolean }>((resolve) => {
      pendingToolExecutions.set(requestId, { resolve });
    });
    send({
      type: 'tool_execute_request',
      requestId,
      toolName,
      args,
    });
    prefetchCache.set(toolCallId, promise);
  },
  isPrefetchableTool,
  debugLog,
};

async function ensureKernel(): Promise<DurableKernel> {
  if (kernel) return kernel;
  if (!initConfig) throw new Error('Cannot create session: init not received');

  const cwd = resolvedCwd();
  const sessionPath = getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId);

  // MCP servers connect once at kernel open; tools register statically (see mcp/extension.ts).
  // projectTrusted stays unset: project-scope `.mkagent/mcp.json` is implemented but not
  // loaded until mkagent grows a project-trust concept (global mcp.json always loads).
  // Kernel recreation paths (re-init, tools-changed) leave the previous load behind — close it.
  if (mcpLoad) await closeMcpConnections(mcpLoad.connections);
  mcpLoad = await loadMcpTools({
    agentDir: resolveCraftAgentDir(initConfig),
    cwd,
    version: CLIENT_VERSION,
    debugLog,
  });
  for (const error of mcpLoad.errors) debugLog(`MCP: ${error}`);

  const k = new DurableKernel({
    sessionPath,
    cwd,
    shellPath: process.env.MKAGENT_GIT_BASH_PATH?.trim() || undefined,
    autoCompactWindow: initConfig.autoCompactWindow,
    modelsSource: () => {
      if (!modelRuntime) throw new Error('Model runtime not initialized');
      return modelRuntime.models;
    },
    hooks: kernelHooks,
    toolsExtension: buildToolsExtension(cwd, mcpLoad.tools),
    extensions: [
      // Codemode + tool_search default on (mcp.json autoEnableCodemode: false opts out of codemode).
      ...(mcpLoad.autoEnableCodemode ? [createCodemodeExtensionFor(mcpLoad.namespaces)] : []),
      createToolSearchExtension(),
    ],
  });

  let model: KernelModelRef | undefined;
  if (initConfig.model) {
    try {
      model = await resolveModelRef(initConfig.model);
    } catch {
      debugLog(`Could not resolve Pi model: ${initConfig.model}`);
    }
  }
  if (!model) setInterceptorApiHints(undefined);

  await k.open({
    ...(model ? { model } : {}),
    thinkingLevel: THINKING_TO_PI[initConfig.thinkingLevel as keyof typeof THINKING_TO_PI],
    ...(initConfig.branchFromSessionPath ? { branchFromSessionPath: initConfig.branchFromSessionPath } : {}),
    ...(initConfig.branchFromSdkTurnId ? { branchFromSdkTurnId: initConfig.branchFromSdkTurnId } : {}),
  });

  kernel = k;
  toolsChanged = false;
  debugLog(`Created durable kernel session: ${k.sessionId}`);

  // Notify main process of session ID
  send({ type: 'session_id_update', sessionId: k.sessionId });

  return k;
}

// ============================================================
// Ephemeral LLM Queries (call_llm + mini completions)
// ============================================================

// Utility-query deadline: the host's llm-query timeout minus a margin so the
// coordinator cancels before the host's own timeout fires.
const MKAGENT_PI_EPHEMERAL_QUERY_DEADLINE_MS = LLM_QUERY_TIMEOUT_MS - 5_000;

async function runEphemeralLlmQuery(id: string, request: LLMQueryRequest): Promise<LLMQueryResult> {
  return ephemeralQueries.run(id, MKAGENT_PI_EPHEMERAL_QUERY_DEADLINE_MS, async (lifecycle) => {
    const runtime = await ensureModelRuntime();
    lifecycle.throwIfCancelled();
    return queryLlm(request, lifecycle, {
      models: runtime.models,
      getConfig: () => initConfig ? {
        miniModel: initConfig.miniModel,
        sessionModel: initConfig.model,
        piAuthProvider: initConfig.piAuth?.provider,
        preferCustomEndpoint: shouldPreferCustomEndpoint(),
      } : null,
      debugLog,
    });
  });
}

async function preExecuteCallLlm(input: Record<string, unknown>): Promise<LLMQueryResult> {
  const sessionPath = initConfig
    ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId)
    : undefined;
  const request = await buildCallLlmRequest(input, { backendName: 'Pi', sessionPath });
  return runEphemeralLlmQuery(nextLocalEphemeralQueryId('callback'), request);
}

async function runMiniCompletion(prompt: string): Promise<string | null> {
  try {
    const result = await runEphemeralLlmQuery(
      nextLocalEphemeralQueryId('summary'),
      { prompt },
    );
    const text = result.text || null;
    debugLog(`[runMiniCompletion] Result: ${text ? `"${text.slice(0, 200)}"` : 'null'}`);
    return text;
  } catch (error) {
    debugLog(`[runMiniCompletion] Failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ============================================================
// Command Handlers
// ============================================================

async function handleInit(msg: Extract<InboundMessage, { type: 'init' }>): Promise<void> {
  // A re-init invalidates every utility query created under the old credentials.
  ephemeralQueries.cancelAll(new EphemeralQueryCancelledError('Pi server reinitialized'));

  // Clean up any existing session from a previous init
  if (kernel) {
    try {
      await kernel.close();
    } catch (error) {
      debugLog(`Kernel close failed during re-init: ${error instanceof Error ? error.message : String(error)}`);
    }
    kernel = null;
    debugLog('Cleaned up existing session for re-init');
  }

  // Re-init invalidates the old MCP connections; a new kernel opens lazily below.
  if (mcpLoad) {
    await closeMcpConnections(mcpLoad.connections);
    mcpLoad = null;
  }

  // Provider/custom-endpoint settings may have changed across re-init.
  modelRuntimePromise = null;
  modelRuntime = null;

  // Craft's stored provider ids → SDK ids, once, so every consumer below
  // (credential store, model resolution, search) sees the SDK's id.
  initConfig = msg.piAuth ? { ...msg, piAuth: toPiAuth(msg.piAuth) } : msg;
  applyProviderEndpointEnv(initConfig);

  // Start callback server for call_llm (idempotent — skips if already running)
  await startCallbackServer();

  send({
    type: 'ready',
    sessionId: null,
    callbackPort,
  });
}

async function handlePrompt(msg: Extract<InboundMessage, { type: 'prompt' }>): Promise<void> {
  currentUserMessage = msg.message;

  try {
    // If proxy tools changed since last session open, close and reopen the
    // kernel — the tool registry is fixed at store open.
    if (toolsChanged && kernel) {
      debugLog('Recreating session due to tool changes');
      await kernel.close();
      kernel = null;
    }

    const k = await ensureKernel();

    // Force the Craft-built system prompt onto the conversation; the prompt
    // section renders it at request preparation.
    if (msg.systemPrompt) {
      k.systemPrompt = msg.systemPrompt;
    }

    // Queued as followUp when a run is already active, matching the 1.1.0
    // streamingBehavior contract.
    await k.submitPrompt(msg.message, msg.images);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // No wrapper-side overflow recovery here. The durable kernel's compaction
    // policy already retries once past the reserve threshold, and the host
    // event queue stays open across that recovery (kernel synthesizes the
    // retry events the PiEventAdapter expects).

    debugLog(`Prompt failed: ${errorMsg}`);
    send({ type: 'error', message: errorMsg, code: 'prompt_error' });
    // Send synthetic agent_end so the main process event queue unblocks.
    // willRetry: false — this is the terminal error path, no retry follows.
    send({ type: 'event', event: { type: 'agent_end', messages: [], willRetry: false } });
  }
}

function handleRegisterTools(msg: Extract<InboundMessage, { type: 'register_tools' }>): void {
  // Merge: replace existing tools by name, add new ones
  const incoming = new Map(msg.tools.map(t => [t.name, t]));
  proxyToolDefs = [
    ...proxyToolDefs.filter(t => !incoming.has(t.name)),
    ...msg.tools,
  ];
  debugLog(`Registered ${msg.tools.length} proxy tools (total: ${proxyToolDefs.length}): ${msg.tools.map(t => t.name).join(', ')}`);

  // If the session exists, mark for recreation on next prompt.
  // Don't close mid-generation — the flag is checked in handlePrompt().
  if (kernel) {
    toolsChanged = true;
    debugLog('Proxy tools changed — session will be recreated on next prompt');
  }
}

function handleToolExecuteResponse(msg: Extract<InboundMessage, { type: 'tool_execute_response' }>): void {
  const pending = pendingToolExecutions.get(msg.requestId);
  if (pending) {
    pendingToolExecutions.delete(msg.requestId);
    pending.resolve(msg.result);
  } else {
    debugLog(`No pending tool execution for requestId: ${msg.requestId}`);
  }
}

function handlePreToolUseResponse(msg: Extract<InboundMessage, { type: 'pre_tool_use_response' }>): void {
  const pending = pendingPreToolUse.get(msg.requestId);
  if (pending) {
    pendingPreToolUse.delete(msg.requestId);
    pending.resolve({ action: msg.action, input: msg.input, reason: msg.reason });
  } else {
    debugLog(`No pending pre_tool_use for requestId: ${msg.requestId}`);
  }
}

function handleCancelEphemeralQuery(
  msg: Extract<InboundMessage, { type: 'cancel_ephemeral_query' }>,
): void {
  const cancelled = ephemeralQueries.cancel(
    msg.id,
    new EphemeralQueryCancelledError(`Ephemeral query cancelled by host: ${msg.id}`),
  );
  debugLog(`${cancelled ? 'Cancelled' : 'No active'} ephemeral query: ${msg.id}`);
}

async function handleAbort(): Promise<void> {
  if (kernel) {
    try {
      await kernel.abort();
    } catch (error) {
      debugLog(`Abort failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Reject all pending pre-tool-use requests
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Aborted' });
  }
  pendingPreToolUse.clear();

  // Clear speculative prefetch cache — in-flight prefetches will resolve but never be consumed
  prefetchCache.clear();
}

async function handleMiniCompletion(msg: Extract<InboundMessage, { type: 'mini_completion' }>): Promise<void> {
  // Call runEphemeralLlmQuery directly (not runMiniCompletion) so auth errors
  // propagate as 'error' messages instead of being swallowed and returned as
  // null. runMiniCompletion is for the summarize callback where null is fine.
  try {
    const result = await runEphemeralLlmQuery(msg.id, { prompt: msg.prompt });
    send({ type: 'mini_completion_result', id: msg.id, text: result.text || null });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[handleMiniCompletion] Error: ${errorMsg}`);
    if (isEphemeralQueryCancellation(error)) {
      // Mini completions are best-effort; preserve their null-on-timeout contract.
      send({ type: 'mini_completion_result', id: msg.id, text: null });
    } else {
      send({ type: 'error', id: msg.id, message: errorMsg, code: 'mini_completion_error' });
    }
  }
}

// INVARIANT: the full LLMQueryRequest shape must pass through this RPC unchanged.
// Adding a field to LLMQueryRequest? Nothing to do here — we pass `msg.request`
// to queryLlm() verbatim. But verify queryLlm() actually honors the new field;
// request-propagation + request-honoring are independent (see #596).
async function handleLlmQuery(msg: Extract<InboundMessage, { type: 'llm_query' }>): Promise<void> {
  try {
    const result = await runEphemeralLlmQuery(msg.id, msg.request);
    send({ type: 'llm_query_result', id: msg.id, result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[handleLlmQuery] Error: ${errorMsg}`);
    // Dual-emit: the generic `error` channel drives main-process OAuth
    // auth-refresh detection (centralized in PiAgent), while the targeted
    // `llm_query_result` rejects only this pending call.
    send({ type: 'error', id: msg.id, message: errorMsg, code: 'llm_query_error' });
    send({ type: 'llm_query_result', id: msg.id, result: null, errorMessage: errorMsg, errorCode: 'llm_query_error' });
  }
}

async function handleEnsureSessionReady(msg: Extract<InboundMessage, { type: 'ensure_session_ready' }>): Promise<void> {
  const k = await ensureKernel();
  send({
    type: 'ensure_session_ready_result',
    id: msg.id,
    sessionId: k.sessionId || null,
  });
}

async function handleCompact(msg: Extract<InboundMessage, { type: 'compact' }>): Promise<void> {
  const startedAt = Date.now();
  try {
    const k = await ensureKernel();
    const result = await k.compact(msg.customInstructions);
    debugLog(`[compact] Done in ${Date.now() - startedAt}ms: ${result.tokensBefore} -> ~${result.estimatedTokensAfter} tokens`);
    send({
      type: 'compact_result',
      id: msg.id,
      success: true,
      result: {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter: result.estimatedTokensAfter,
        ...k.contextUsagePayload(),
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[compact] Failed after ${Date.now() - startedAt}ms: ${errorMsg}`);
    send({
      type: 'compact_result',
      id: msg.id,
      success: false,
      errorMessage: errorMsg,
    });
  }
}

async function handleSetAutoCompaction(msg: Extract<InboundMessage, { type: 'set_auto_compaction' }>): Promise<void> {
  try {
    const k = await ensureKernel();
    k.setAutoCompaction(msg.enabled);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: true,
      enabled: k.getAutoCompactionEnabled(),
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_auto_compaction] Failed: ${errorMsg}`);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: false,
      enabled: msg.enabled,
      errorMessage: errorMsg,
    });
  }
}

async function handleUpdateRuntimeConfig(msg: RuntimeConfigUpdateMessage): Promise<void> {
  try {
    if (!initConfig) {
      throw new Error('Runtime config update received before init');
    }

    initConfig = {
      ...initConfig,
      model: msg.model,
      providerType: msg.providerType ?? initConfig.providerType,
      authType: msg.authType ?? initConfig.authType,
      baseUrl: msg.baseUrl,
      customEndpoint: msg.customEndpoint,
      customModels: msg.customModels,
    };
    applyProviderEndpointEnv(initConfig);

    // Rebuild the model runtime so edited endpoint settings take effect; the
    // kernel picks up the new catalog live through modelsSource().
    modelRuntimePromise = null;
    modelRuntime = null;

    if (kernel) {
      const ref = await resolveModelRef(msg.model);
      if (!ref) {
        throw new Error(`Could not resolve model after runtime update: ${msg.model}`);
      }
      await kernel.setModel(ref);
      debugLog(`[runtime_config] Updated runtime config and active model: ${ref.provider}/${ref.modelId}`);
    } else {
      debugLog('[runtime_config] Stored update; no active session yet');
    }

    send({ type: 'update_runtime_config_result', id: msg.id, success: true, updated: true });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[runtime_config] Failed: ${errorMsg}`);
    send({ type: 'update_runtime_config_result', id: msg.id, success: false, updated: false, errorMessage: errorMsg });
  }
}

async function handleSetModel(msg: Extract<InboundMessage, { type: 'set_model' }>): Promise<void> {
  debugLog(`[set_model] Received: ${msg.model}`);
  if (!kernel || !modelRuntime) {
    debugLog(`[set_model] No active session or model runtime, ignoring`);
    return;
  }
  const ref = await resolveModelRef(msg.model);
  if (!ref) {
    debugLog(`[set_model] Could not resolve model: ${msg.model}`);
    setInterceptorApiHints(undefined);
    return;
  }
  try {
    await kernel.setModel(ref);
    if (initConfig) initConfig.model = msg.model;
    debugLog(`[set_model] Model changed to: ${msg.model} (resolved: ${ref.provider}/${ref.modelId})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_model] Failed to set model: ${errorMsg}`);
  }
}

async function handleSetThinkingLevel(msg: Extract<InboundMessage, { type: 'set_thinking_level' }>): Promise<void> {
  debugLog(`[set_thinking_level] Received: ${msg.level}`);

  if (!kernel) {
    debugLog('[set_thinking_level] No active session, ignoring');
    return;
  }

  const piLevel = THINKING_TO_PI[msg.level as keyof typeof THINKING_TO_PI];
  if (!piLevel) {
    debugLog(`[set_thinking_level] No Pi mapping for level: ${msg.level}`);
    return;
  }

  try {
    await kernel.setThinkingLevel(piLevel);
    debugLog(`[set_thinking_level] Thinking level changed to: ${msg.level} (mapped: ${piLevel})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_thinking_level] Failed to set thinking level: ${errorMsg}`);
  }
}

async function handleShutdown(): Promise<void> {
  await backgroundShells.dispose();
  debugLog('Shutdown requested');

  // Abort utility queries independently from the main session.
  ephemeralQueries.cancelAll(new EphemeralQueryCancelledError('Pi server shutting down'));

  // Close the kernel session
  if (kernel) {
    try {
      await kernel.close();
    } catch {
      // Best-effort during shutdown.
    }
    kernel = null;
  }

  // Disconnect MCP servers
  if (mcpLoad) {
    await closeMcpConnections(mcpLoad.connections);
    mcpLoad = null;
  }

  // Stop callback server
  stopCallbackServer();

  // Reject pending promises
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Server shutting down' });
  }
  pendingPreToolUse.clear();

  for (const [, pending] of pendingToolExecutions) {
    pending.resolve({ content: 'Server shutting down', isError: true });
  }
  pendingToolExecutions.clear();

  process.exit(0);
}

// ============================================================
// Main JSONL Reader Loop
// ============================================================

async function processMessage(msg: InboundMessage): Promise<void> {
  switch (msg.type) {
    case 'stop_background_task':
      send({ type: 'stop_background_task_result', id: msg.id, stopped: await backgroundShells.stop(msg.taskId) });
      break;
    case 'init':
      await handleInit(msg);
      break;

    case 'prompt':
      await handlePrompt(msg);
      break;

    case 'register_tools':
      handleRegisterTools(msg);
      break;

    case 'tool_execute_response':
      handleToolExecuteResponse(msg);
      break;

    case 'pre_tool_use_response':
      handlePreToolUseResponse(msg);
      break;

    case 'abort':
      await handleAbort();
      break;

    case 'mini_completion':
      await handleMiniCompletion(msg);
      break;

    case 'llm_query':
      await handleLlmQuery(msg);
      break;

    case 'cancel_ephemeral_query':
      handleCancelEphemeralQuery(msg);
      break;

    case 'ensure_session_ready':
      await handleEnsureSessionReady(msg);
      break;

    case 'set_model':
      await handleSetModel(msg);
      break;

    case 'set_thinking_level':
      await handleSetThinkingLevel(msg);
      break;

    case 'compact':
      await handleCompact(msg);
      break;

    case 'set_auto_compaction':
      await handleSetAutoCompaction(msg);
      break;

    case 'update_runtime_config':
      await handleUpdateRuntimeConfig(msg);
      break;

    case 'steer':
      if (kernel) {
        debugLog(`Steering with: "${msg.message.slice(0, 100)}"`);
        await kernel.steer(msg.message);
      } else {
        debugLog('Steer ignored — no active session');
      }
      break;

    case 'token_update': {
      let runtime: ModelRuntime | null = null;
      try {
        runtime = modelRuntimePromise ? await modelRuntimePromise : null;
      } catch {
        runtime = null;
      }
      if (runtime) {
        const piAuth = toPiAuth(msg.piAuth);
        const { provider, credential } = piAuth;
        const adapted = adaptCredentialForPiSdk(provider, credential);
        if (adapted) await runtime.credentials.seed(provider, adapted);
        if (initConfig) {
          initConfig.piAuth = piAuth;
        }
        debugLog(`Updated ${credential.type} credential for provider: ${provider}`);
      } else {
        debugLog('token_update received but no model runtime initialized');
      }
      break;
    }

    case 'shutdown':
      handleShutdown();
      break;

    default:
      debugLog(`Unknown message type: ${(msg as any).type}`);
  }
}

function main(): void {
  debugLog('Pi agent server starting');

  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as InboundMessage;
      processMessage(msg).catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`Error processing message: ${errorMsg}`);
        send({ type: 'error', message: errorMsg });
      });
    } catch (parseError) {
      debugLog(`Failed to parse JSONL: ${parseError}`);
    }
  });

  rl.on('close', () => {
    debugLog('stdin closed, shutting down');
    handleShutdown();
  });

  // Handle unexpected errors — process state is unreliable after these,
  // so we attempt to report and then exit immediately.
  // send() is wrapped in try/catch because stdout itself may be broken
  // (e.g. EFAULT from a closed pipe), and we must not let the error
  // report trigger another uncaughtException (which would loop).
  process.on('uncaughtException', (error) => {
    debugLog(`Uncaught exception: ${error.message}`);
    try {
      send({ type: 'error', message: `Uncaught exception: ${error.message}`, code: 'uncaught' });
    } catch {
      // stdout may be broken — swallow to avoid re-triggering
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    debugLog(`Unhandled rejection: ${msg}`);
    try {
      send({ type: 'error', message: `Unhandled rejection: ${msg}`, code: 'unhandled_rejection' });
    } catch {
      // stdout may be broken — swallow to avoid re-triggering
    }
    process.exit(1);
  });
}

main();
