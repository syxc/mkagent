#!/usr/bin/env node
import { BackgroundShells } from './background-shell.ts';
import { readNativeSessionDescriptor } from './storage/native-session-projection.ts';
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
import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';

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
import { queryLlm } from './ephemeral.ts';
import { createProxyTool, type ProxyToolResult } from './tools/proxy.ts';
import {
  EphemeralQueryCancelledError,
  EphemeralQueryCoordinator,
  isEphemeralQueryCancellation,
} from './ephemeral-query-lifecycle.ts';
import { stripPiPrefix, type CustomEndpointConfig } from './custom-endpoint-models.ts';
import {
  createModelRuntime,
  type ModelRuntime,
} from './model-runtime.ts';
import { resolveRuntimeMiniModel, resolveRuntimeModel } from './runtime-models.ts';

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
import type { PiCompactResult, PiContextUsagePayload, PiProxyToolDefinition, PiWorkerInitConfig, PiWorkerScope } from '../../shared/src/agent/backend/pi/protocol.ts';
import { adaptCredentialForPiSdk, type PiCredential } from './adapt-credential.ts';
import { resolveCraftAgentDir } from './agent-dir.ts';
import { toPiProviderId } from '../../shared/src/config/pi-provider-ids.ts';
import { ProviderEndpointEnvironment, providerEndpointEnv } from './provider-endpoint-env.ts';
import { DurableKernel, type KernelHooks, type KernelModelRef } from './kernel.ts';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { RpcExtensionUIResponse } from '@mkagent/pi-durable-coding/native';
import { ExtensionUIHost, type ExtensionUIEvent } from './extension-ui.ts';
import { NativeOwnerExchange } from './native-owner.ts';
import type {
  PiNativeOwnerActivation, PiNativeOwnerControl, PiNativeOwnerEventBody,
} from '../../shared/src/agent/backend/pi/native-owner-protocol.ts';

// ============================================================
// Types — JSONL Protocol
// ============================================================

/** Init message from main process — configures the agent server */
interface InitMessage extends PiWorkerInitConfig {
  type: 'init';
}

interface RuntimeConfigUpdateMessage {
  type: 'update_runtime_config';
  id: string;
  model: string;
  deadline?: number;
  providerType?: string;
  authType?: string;
  baseUrl?: string;
  customEndpoint?: CustomEndpointConfig;
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
}

/** Messages from main process (stdin) */
type InboundMessage = (
  | PiNativeOwnerControl
  | { type: 'release_owner'; id: string }
  | { type: 'extension_ui_available'; available: boolean }
  | (RpcExtensionUIResponse & { uiEpoch: string; responseId: string })
  | { type: 'stop_background_task'; id: string; taskId: string }
  | InitMessage
  | { type: 'prompt'; id: string; inputId?: string; message: string; systemPrompt: string; images?: Array<{ type: 'image'; data: string; mimeType: string }>;
      nativeInput?: { text: string; hostContextPrefix: string } }
  | { type: 'register_tools'; tools: ProxyToolDef[] }
  | { type: 'tool_execute_response'; requestId: string; result: ProxyToolResult }
  | { type: 'pre_tool_use_response'; requestId: string; action: 'allow' | 'block' | 'modify'; input?: Record<string, unknown>; reason?: string }
  | { type: 'abort' }
  | { type: 'mini_completion'; id: string; prompt: string }
  | { type: 'llm_query'; id: string; request: LLMQueryRequest }
  | { type: 'cancel_ephemeral_query'; id: string }
  | { type: 'ensure_session_ready'; id: string }
  | { type: 'set_model'; model: string }
  | { type: 'set_session_name'; id: string; name: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'compact'; id: string; customInstructions?: string }
  | { type: 'cancel_compact'; id: string }
  | { type: 'set_auto_compaction'; id: string; enabled: boolean }
  | RuntimeConfigUpdateMessage
  | { type: 'steer'; inputId?: string; message: string }
  | { type: 'token_update'; piAuth: { provider: string; credential: PiCredential } }
  | { type: 'shutdown' }
) & Partial<PiWorkerScope>;

/** Proxy tool definition from main process */
type ProxyToolDef = PiProxyToolDefinition;

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
  miniModel?: string;
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
  | PiNativeOwnerEventBody
  | { type: 'callback_port'; callbackPort: number }
  | { type: 'owner_released'; id: string; released: boolean; error?: string }
  | { type: 'set_session_name_result'; id: string; success: boolean; errorMessage?: string }
  | ExtensionUIEvent
  | { type: 'extension_ui_response_result'; id: string; accepted: boolean }
  | { type: 'prompt_result'; id: string; handled: boolean; completed: boolean }
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
let kernelPromise: Promise<DurableKernel> | null = null;
// Separate from source startup: a startup hook can replace its own kernel.
let ownerLoading: Promise<DurableKernel> | null = null;
let initialization: Promise<void> = Promise.resolve();
// Invalidated at receipt, before commands waiting on initialization can run.
let inputGeneration = 0;
let reinitializing = false;
let shuttingDown: Promise<void> | undefined;
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
let credentialGeneration = 0;
let runtimeConfigGeneration = 0;
let runtimeConfigRequest = 0;
let runtimeCommit: Promise<void> = Promise.resolve();
const endpointEnvironment = new ProviderEndpointEnvironment();

// Mutable state
let currentUserMessage = '';
let foregroundScope: PiWorkerScope | undefined;
let foregroundActive = true;
let foregroundEpoch = 0;
let foregroundUI: ExtensionUIHost | undefined;
const workerContext = new AsyncLocalStorage<{ scope?: PiWorkerScope; ui?: ExtensionUIHost; inputId?: string }>();
const nativeOwner = new NativeOwnerExchange({
  send: event => sendScoped(event, event),
  withTargetScope: (scope, work) => {
    if (!isForegroundScope(scope)) throw new Error('Native target scope is no longer active');
    return workerContext.run({ scope, ui: foregroundUI, inputId: workerContext.getStore()?.inputId }, work);
  },
});
const backgroundShells = new BackgroundShells((event, scope) => sendScoped({ type: 'background_task_event', event }, scope));

// Pending promises for async handshakes
const pendingPreToolUse = new Map<string, { resolve: (response: { action: string; input?: Record<string, unknown>; reason?: string }) => void }>();
const pendingToolExecutions = new Map<string, { resolve: (result: ProxyToolResult) => void }>();
const pendingCompactions = new Map<string, AbortController>();

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

// Callback server for call_llm
interface CallbackBinding {
  server: http.Server;
  sockets: Set<import('node:net').Socket>;
  active: boolean;
}
let callbackServer: CallbackBinding | null = null;
let callbackPort = 0;

// ============================================================
// JSONL I/O
// ============================================================

function currentWorkerScope(): PiWorkerScope | undefined {
  const context = workerContext.getStore();
  return context ? context.scope : foregroundScope;
}

function isForegroundScope(scope: PiWorkerScope | undefined): boolean {
  return foregroundActive && scope?.ownerSessionId === foregroundScope?.ownerSessionId &&
    scope?.runtimeGeneration === foregroundScope?.runtimeGeneration;
}

function sendScoped(msg: OutboundMessage, scope?: PiWorkerScope): void {
  const line = JSON.stringify({ ...msg, ...scope });
  process.stdout.write(line + '\n');
}

function send(msg: OutboundMessage): void {
  sendScoped(msg, currentWorkerScope());
}

function readWorkerScope(msg: Partial<PiWorkerScope>): PiWorkerScope | undefined {
  if (msg.ownerSessionId === undefined && msg.runtimeGeneration === undefined) return undefined;
  if (typeof msg.ownerSessionId !== 'string' || !msg.ownerSessionId ||
      typeof msg.runtimeGeneration !== 'number' || !Number.isSafeInteger(msg.runtimeGeneration) || msg.runtimeGeneration < 1) {
    throw new Error('Invalid Pi worker message scope');
  }
  return { ownerSessionId: msg.ownerSessionId, runtimeGeneration: msg.runtimeGeneration };
}

function debugLog(message: string): void {
  // Write debug messages to stderr so they don't interfere with JSONL protocol
  process.stderr.write(`[pi-server] ${message}\n`);
}

// ============================================================
// Loopback server used by the call_llm session tool
// ============================================================

async function startCallbackServer(): Promise<void> {
  if (!initConfig) throw new Error('Callback server requires initialization');
  const config = initConfig;
  const scope = currentWorkerScope();
  const epoch = foregroundEpoch;
  const assertOwner = () => {
    if (epoch !== foregroundEpoch || !isForegroundScope(scope)) {
      throw new EphemeralQueryCancelledError('Callback owner is no longer active');
    }
  };
  assertOwner();

  const server = http.createServer(async (req, res) => {
    const id = nextLocalEphemeralQueryId('callback');
    let finished = false;
    const cancel = () => {
      finished = true;
      ephemeralQueries.cancel(id, new EphemeralQueryCancelledError('Callback connection closed'));
    };
    const check = () => {
      assertOwner();
      if (!binding.active || finished || res.destroyed) throw new EphemeralQueryCancelledError('Callback retired');
    };
    const timer = setTimeout(() => {
      cancel();
      req.destroy();
      res.destroy();
    }, LLM_QUERY_TIMEOUT_MS);
    timer.unref();
    res.once('close', () => { clearTimeout(timer); cancel(); });
    if (req.method !== 'POST' || req.url !== '/call-llm') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      check();
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        check();
        chunks.push(chunk as Buffer);
      }
      check();
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

      debugLog('Received call_llm request via callback server');
      const result = await workerContext.run({ scope }, () => preExecuteCallLlm(body, config, id, check));
      check();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (!binding.active || epoch !== foregroundEpoch || !isForegroundScope(scope) || finished || res.destroyed) {
        res.destroy();
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      debugLog(`call_llm via callback failed: ${msg}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  });
  const binding: CallbackBinding = { server, sockets: new Set(), active: true };
  callbackServer = binding;
  server.on('connection', socket => {
    binding.sockets.add(socket);
    socket.once('close', () => binding.sockets.delete(socket));
    if (!binding.active) socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      if (!binding.active) { reject(new EphemeralQueryCancelledError('Callback retired while listening')); return; }
      const addr = server.address();
      callbackPort = typeof addr === 'object' && addr ? addr.port : 0;
      debugLog(`Callback server listening on 127.0.0.1:${callbackPort}`);
      resolve();
    });
    server.on('error', reject);
  });

  assertOwner();
}

function stopCallbackServer(): Promise<void> {
  const binding = callbackServer;
  if (!binding) return Promise.resolve();
  binding.active = false;
  callbackServer = null;
  callbackPort = 0;
  // close() alone leaves already accepted HTTP bodies and keep-alive sockets live.
  const closed = new Promise<void>(resolve => binding.server.close(() => resolve()));
  for (const socket of binding.sockets) socket.destroy();
  return closed;
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
  endpointEnvironment.apply(env);
  for (const [key, value] of Object.entries(env)) {
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
    const credentialOwner = credentialGeneration;
    let promise!: Promise<ModelRuntime>;
    promise = (async () => {
      const runtime = await createModelRuntime({
        apiKey: config.apiKey,
        piAuth: config.piAuth,
        baseUrl: config.baseUrl,
        customEndpoint: config.customEndpoint,
        customModels: config.customModels,
        model: config.model,
      }, update => {
        if (credentialOwner === credentialGeneration && initConfig?.piAuth?.provider === update.provider
            && initConfig.piAuth.credential.type === 'oauth' && initConfig.piAuth.credential.refresh === update.previousRefresh) {
          initConfig.piAuth = { provider: update.provider, credential: update.credential };
          send({ type: 'oauth_credential_update', ...update });
        }
      });

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

      if (modelRuntimePromise === promise) modelRuntime = runtime;
      return runtime;
    })().catch((error) => {
      if (modelRuntimePromise === promise) modelRuntimePromise = null;
      throw error;
    });
    modelRuntimePromise = promise;
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
  const piModel = initConfig ? resolveRuntimeModel(runtime, initConfig, modelId) : undefined;

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
  if (shuttingDown) throw new Error('Server shutting down');
  if (reinitializing) throw new Error('Pi server reinitialized');
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
  async search(query: string, count: number, signal?: AbortSignal) {
    return resolveSearchProvider(initConfig?.piAuth, initConfig?.model ? stripPiPrefix(initConfig.model) : undefined).search(query, count, signal);
  },
};

/**
 * Main-process tools as kernel registrations. Durable surfaces tools to the
 * model through the request schema (no system-prompt tool listing), so the
 * 1.1.0 promptSnippet trick is no longer needed.
 */
function buildProxyTools(): ToolRegistration[] {
  debugLog(`Building proxy tools from ${proxyToolDefs.length} definitions: ${proxyToolDefs.map(t => t.name).join(', ')}`);

  return proxyToolDefs.map(def => createProxyTool(def, {
    prefetched(callId) {
      const result = prefetchCache.get(callId);
      if (result) {
        prefetchCache.delete(callId);
        debugLog(`Prefetch cache hit for ${def.name} (toolCallId: ${callId})`);
      }
      return result;
    },
    approve: requestPreToolUseApproval,
    async execute(toolName, args) {
      if (shuttingDown) throw new Error('Server shutting down');
      if (reinitializing) throw new Error('Pi server reinitialized');
      const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      send({ type: 'tool_execute_request', requestId, toolName, args });
      return new Promise<ProxyToolResult>(resolve => { pendingToolExecutions.set(requestId, { resolve }); });
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
function toolWrapDependencies(cwd: string): ToolWrapDeps {
  if (!initConfig) throw new Error('Cannot build tools: init not received');
  return {
    requestApproval: requestPreToolUseApproval,
    backgroundShells,
    ownerScope: currentWorkerScope(),
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
}

function buildToolsExtension(cwd: string, mcpTools: readonly ToolRegistration[]): Extension {
  const builtinTools = createBuiltinTools(cwd);
  const searchTool = createSearchTool(searchProvider);
  const webFetchTool = createWebFetchTool(() =>
    initConfig ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId) : null
  );
  const proxyTools = buildProxyTools();
  const wrapDeps = toolWrapDependencies(cwd);
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

function releaseForegroundRequests(reason: string): void {
  ephemeralQueries.cancelAll(new EphemeralQueryCancelledError(reason));
  for (const controller of pendingCompactions.values()) controller.abort();
  for (const pending of pendingPreToolUse.values()) pending.resolve({ action: 'block', reason });
  pendingPreToolUse.clear();
  for (const pending of pendingToolExecutions.values()) pending.resolve({ content: reason, isError: true });
  pendingToolExecutions.clear();
  prefetchCache.clear();
}

function createKernelHooks(scope: PiWorkerScope | undefined): KernelHooks {
  return {
    sessionIdentity: sessionId => sendScoped({ type: 'session_id_update', sessionId }, scope),
    emitEvent: (event) => sendScoped({ type: 'event', event: event as OutboundAgentEvent }, scope),
    sessionToolCompleted: (toolName, args, isError) => sendScoped({ type: 'session_tool_completed', toolName, args, isError }, scope),
    prefetchToolCall: (toolCallId, toolName, args) => {
      if (reinitializing || shuttingDown) return;
      const requestId = `prefetch-${toolCallId}`;
      const promise = new Promise<{ content: string; isError: boolean }>((resolve) => {
        pendingToolExecutions.set(requestId, { resolve });
      });
      sendScoped({
        type: 'tool_execute_request',
        requestId,
        toolName,
        args,
      }, scope);
      prefetchCache.set(toolCallId, promise);
    },
    isPrefetchableTool,
    debugLog,
  };
}

async function ensureKernel(): Promise<DurableKernel> {
  if (kernel) return kernel;
  if (ownerLoading) return ownerLoading;
  if (!kernelPromise) {
    const pending: Promise<DurableKernel> = openKernel().finally(() => {
      if (kernelPromise === pending) kernelPromise = null;
    });
    kernelPromise = pending;
  }
  return kernelPromise;
}

async function openKernel(replacement?: PiNativeOwnerActivation, signal?: AbortSignal): Promise<DurableKernel> {
  if (!initConfig) throw new Error('Cannot create session: init not received');
  const config = initConfig;
  const scope = currentWorkerScope();
  const epoch = foregroundEpoch;
  const assertOwner = () => {
    signal?.throwIfAborted();
    if (epoch !== foregroundEpoch || !isForegroundScope(scope)) throw new Error('Kernel owner is no longer active');
  };
  assertOwner();

  const codingUI = workerContext.getStore()?.ui;
  const cwd = resolvedCwd();
  const sessionPath = getSessionPath(config.workspaceRootPath, config.sessionId);

  const initGeneration = credentialGeneration;
  // MCP list changes publish a replacement tool set on the existing kernel.
  // projectTrusted stays unset: project-scope `.mkagent/mcp.json` is implemented but not
  // loaded until mkagent grows a project-trust concept (global mcp.json always loads).
  // Kernel recreation on re-init leaves the previous load behind — close it.
  if (mcpLoad) await closeMcpConnections(mcpLoad.connections);
  assertOwner();
  let openingKernel: DurableKernel | undefined;
  const loadedMcp = await loadMcpTools({
    agentDir: resolveCraftAgentDir(config),
    cwd,
    version: CLIENT_VERSION,
    debugLog,
    onUpdate: tools => openingKernel?.updateTools(buildToolsExtension(cwd, tools)),
  });
  try {
    assertOwner();
  } catch (error) {
    await closeMcpConnections(loadedMcp.connections);
    throw error;
  }
  mcpLoad = loadedMcp;
  for (const error of loadedMcp.errors) debugLog(`MCP: ${error}`);

  const k = new DurableKernel({
    sessionPath,
    cwd,
    shellPath: process.env.MKAGENT_GIT_BASH_PATH?.trim() || undefined,
    autoCompactWindow: config.autoCompactWindow,
    modelsSource: () => {
      if (!modelRuntime) throw new Error('Model runtime not initialized');
      return modelRuntime.models;
    },
    modelCredentialsSource: () => {
      if (!modelRuntime) throw new Error('Model runtime not initialized');
      return modelRuntime.codingCredentials;
    },
    hooks: createKernelHooks(scope),
    toolsExtension: buildToolsExtension(cwd, loadedMcp.tools),
    replaceNativeSession: (request, runTarget) => {
      let target: DurableKernel | undefined;
      return nativeOwner.replace(currentWorkerScope(), { ...request, inputId: workerContext.getStore()?.inputId }, {
        closeSource: async signal => {
          signal.throwIfAborted();
          inputGeneration++;
          const callbacksClosed = stopCallbackServer();
          releaseForegroundRequests('Native session replaced');
          await callbacksClosed;
          await k.close(request.operation.type === 'switch' ? 'resume' : request.operation.type);
          openingKernel = undefined;
          if (kernel === k) kernel = null;
          await closeMcpConnections(loadedMcp.connections);
          if (mcpLoad === loadedMcp) mcpLoad = null;
          codingUI?.close();
          const { entryIds: _entryIds, ...reference } = await readNativeSessionDescriptor(sessionPath);
          return reference;
        },
        bindTarget: async (activation, signal) => {
          // Register before initialize's first await. Never join source kernelPromise
          // here: startup replacement executes inside that very promise.
          const loading = Promise.resolve().then(async () => {
            signal.throwIfAborted();
            await initialize({ ...activation.config, type: 'init' }, 'owner', signal);
            signal.throwIfAborted();
            proxyToolDefs = activation.tools;
            return openKernel(activation, signal);
          });
          ownerLoading = loading;
          try {
            target = await loading;
            const { entryIds: _entryIds, ...reference } = await readNativeSessionDescriptor(activation.config.sessionPath);
            return { nativeSessionId: target.sessionId!, reference };
          } finally {
            if (ownerLoading === loading) ownerLoading = null;
          }
        },
        runTarget: async (_activation, signal) => {
          if (!target) throw new Error('Native replacement target was not bound');
          await runTarget(target, signal);
        },
      });
    },
    ...(config.agentProfile === 'coding' || config.codingResources ? {
      codingUI,
      coding: {
        ...config.codingResources,
        agentDir: config.codingResources?.agentDir
          ?? (process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')),
      },
      wrapCodingTool: tool => wrapToolForKernel(tool, toolWrapDependencies(cwd)),
    } : {}),
    extensions: [
      // Codemode + tool_search default on (mcp.json autoEnableCodemode: false opts out of codemode).
      ...(loadedMcp.autoEnableCodemode ? [createCodemodeExtensionFor(loadedMcp.namespaces, requestPreToolUseApproval)] : []),
      createToolSearchExtension(),
    ],
  });
  openingKernel = k;
  if (replacement) k.systemPrompt = replacement.systemPrompt;

  let model: KernelModelRef | undefined;
  let modelGeneration = runtimeConfigGeneration;
  let requestedModel = config.model;
  try {
    if (requestedModel) model = await resolveModelRef(requestedModel);
    assertOwner();
    if (!model) {
      setInterceptorApiHints(undefined);
      throw new Error(`Could not resolve model: ${requestedModel || '(unset)'}`);
    }
    await k.open({
      ...(replacement ? { codingReplacement: { reason: replacement.reason } } : {}),
      ...(model ? { model } : {}),
      thinkingLevel: THINKING_TO_PI[config.thinkingLevel as keyof typeof THINKING_TO_PI],
      ...(config.branchFromSessionPath ? { branchFromSessionPath: config.branchFromSessionPath } : {}),
      ...(config.branchFromSdkTurnId ? { branchFromSdkTurnId: config.branchFromSdkTurnId } : {}),
      ...(config.nativeFork ? { nativeFork: config.nativeFork } : {}),
      ...(config.nativeResume ? { nativeResume: config.nativeResume } : {}),
      ...(config.nativeParent ? { nativeParent: config.nativeParent } : {}),
    });
    assertOwner();
    k.updateTools(buildToolsExtension(cwd, loadedMcp.tools));
    while (initGeneration === credentialGeneration && initConfig.model && modelGeneration !== runtimeConfigGeneration) {
      modelGeneration = runtimeConfigGeneration;
      requestedModel = initConfig.model;
      const updatedModel = await resolveModelRef(requestedModel);
      if (!updatedModel) throw new Error(`Could not resolve model after runtime update: ${requestedModel}`);
      await k.setModel(updatedModel);
      assertOwner();
    }
  } catch (error) {
    openingKernel = undefined;
    await k.close().catch(() => {});
    await closeMcpConnections(loadedMcp.connections);
    if (mcpLoad === loadedMcp) mcpLoad = null;
    throw error;
  }

  kernel = k;
  debugLog(`Created durable kernel session: ${k.sessionId}`);

  return k;
}

// ============================================================
// Ephemeral LLM Queries (call_llm + mini completions)
// ============================================================

// Utility-query deadline: the host's llm-query timeout minus a margin so the
// coordinator cancels before the host's own timeout fires.
const MKAGENT_PI_EPHEMERAL_QUERY_DEADLINE_MS = LLM_QUERY_TIMEOUT_MS - 5_000;

async function runEphemeralLlmQuery(id: string, request: LLMQueryRequest): Promise<LLMQueryResult> {
  const scope = currentWorkerScope();
  const epoch = foregroundEpoch;
  const assertOwner = () => {
    if (epoch !== foregroundEpoch || !isForegroundScope(scope)) throw new EphemeralQueryCancelledError('Query owner retired');
  };
  assertOwner();
  return ephemeralQueries.run(id, MKAGENT_PI_EPHEMERAL_QUERY_DEADLINE_MS, async (lifecycle) => {
    lifecycle.throwIfCancelled();
    assertOwner();
    const runtime = await ensureModelRuntime();
    // Capture the pair after lazy construction; a committed replacement is synchronous.
    const config = initConfig;
    lifecycle.throwIfCancelled();
    assertOwner();
    const result = await queryLlm(request, lifecycle, {
      models: runtime.models,
      getConfig: () => config ? {
        miniModel: config.miniModel,
        sessionModel: config.model,
        piAuthProvider: config.piAuth?.provider,
        preferCustomEndpoint: Boolean(config.customEndpoint && config.baseUrl?.trim()),
      } : null,
      debugLog,
    });
    lifecycle.throwIfCancelled();
    assertOwner();
    return result;
  });
}

async function preExecuteCallLlm(
  input: Record<string, unknown>, config: InitMessage, id: string, check: () => void,
): Promise<LLMQueryResult> {
  check();
  const sessionPath = getSessionPath(config.workspaceRootPath, config.sessionId);
  const request = await buildCallLlmRequest(input, { backendName: 'Pi', sessionPath });
  check();
  const result = await runEphemeralLlmQuery(id, request);
  check();
  return result;
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
  reinitializing = true;
  try {
    await initialize(msg);
  } finally {
    reinitializing = false;
  }
}

async function initialize(
  msg: Extract<InboundMessage, { type: 'init' }>, mode: 'init' | 'owner' = 'init', signal?: AbortSignal,
): Promise<void> {
  const scope = currentWorkerScope();
  const epoch = foregroundEpoch;
  const assertOwner = () => {
    signal?.throwIfAborted();
    if (epoch !== foregroundEpoch || !isForegroundScope(scope)) throw new Error('Initialization owner retired');
  };
  assertOwner();
  const callbacksClosed = stopCallbackServer();
  // A re-init invalidates every utility query created under the old credentials.
  credentialGeneration++;
  ephemeralQueries.cancelAll(new EphemeralQueryCancelledError('Pi server reinitialized'));

  // Reject old host waits before open or close; the admission guard rejects later requests.
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Pi server reinitialized' });
  }
  pendingPreToolUse.clear();
  for (const [, pending] of pendingToolExecutions) {
    pending.resolve({ content: 'Pi server reinitialized', isError: true });
  }
  pendingToolExecutions.clear();
  prefetchCache.clear();

  await runtimeCommit;
  await callbacksClosed;
  if (mode === 'init' && kernelPromise) await kernelPromise.catch(() => undefined);
  assertOwner();
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
  assertOwner();

  // Provider/custom-endpoint settings may have changed across re-init.
  modelRuntimePromise = null;
  modelRuntime = null;

  // Craft's stored provider ids → SDK ids, once, so every consumer below
  // (credential store, model resolution, search) sees the SDK's id.
  initConfig = msg.piAuth ? { ...msg, piAuth: toPiAuth(msg.piAuth) } : msg;
  process.env.MKAGENT_SESSION_DIR = getSessionPath(msg.workspaceRootPath, msg.sessionId);
  applyProviderEndpointEnv(initConfig);

  // Each owner receives a new listener; old accepted requests are revoked too.
  await startCallbackServer();
  assertOwner();

  if (mode === 'owner') send({ type: 'callback_port', callbackPort });
  else send({
    type: 'ready',
    sessionId: null,
    callbackPort,
  });
}

async function handlePrompt(msg: Extract<InboundMessage, { type: 'prompt' }>): Promise<void> {
  const generation = inputGeneration;
  currentUserMessage = msg.message;

  try {
    await runtimeCommit;
    const k = await ensureKernel();
    await runtimeCommit;
    if (generation !== inputGeneration) return;

    // Force the Craft-built system prompt onto the conversation; the prompt
    // section renders it at request preparation.
    if (msg.systemPrompt) {
      k.systemPrompt = msg.systemPrompt;
    }

    // Queued as followUp when a run is already active, matching the 1.1.0
    // streamingBehavior contract.
    const result = await k.submitPrompt(msg.message, msg.images, msg.nativeInput, msg.inputId);
    if (generation === inputGeneration) send({ type: 'prompt_result', id: msg.id, ...result });
  } catch (error) {
    if (generation !== inputGeneration) return;
    const errorMsg = error instanceof Error ? error.message : String(error);

    // No wrapper-side overflow recovery here. The durable kernel's compaction
    // policy already retries once past the reserve threshold, and the host
    // event queue stays open across that recovery (kernel synthesizes the
    // retry events the PiEventAdapter expects).

    debugLog(`Prompt failed: ${errorMsg}`);
    send({ type: 'error', id: msg.id, message: errorMsg, code: 'prompt_error' });
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

  if (kernel && mcpLoad) {
    kernel.updateTools(buildToolsExtension(resolvedCwd(), mcpLoad.tools));
    debugLog('Published updated proxy tools for the next request');
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
  nativeOwner.cancel();
  const resumeUI = workerContext.getStore()?.ui?.suspend();
  try {
    for (const controller of pendingCompactions.values()) controller.abort();

    // Release host callbacks before waiting for SDK tasks that depend on them.
    for (const [, pending] of pendingPreToolUse) {
      pending.resolve({ action: 'block', reason: 'Aborted' });
    }
    pendingPreToolUse.clear();
    for (const [, pending] of pendingToolExecutions) {
      pending.resolve({ content: 'Aborted', isError: true });
    }
    pendingToolExecutions.clear();
    prefetchCache.clear();

    const active = kernel ?? await kernelPromise?.catch(() => undefined);
    if (active) {
      try {
        await active.abort();
      } catch (error) {
        debugLog(`Abort failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    resumeUI?.();
  }
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

async function handleCompact(msg: Extract<InboundMessage, { type: 'compact' }>, controller: AbortController): Promise<void> {
  const startedAt = Date.now();
  try {
    if (controller.signal.aborted) throw new Error('Compaction aborted');
    await runtimeCommit;
    const k = await ensureKernel();
    await runtimeCommit;
    if (controller.signal.aborted) throw new Error('Compaction aborted');
    const result = await k.compact(msg.customInstructions, controller.signal);
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
        ...(await k.contextUsagePayload()),
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
  } finally {
    if (pendingCompactions.get(msg.id) === controller) pendingCompactions.delete(msg.id);
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

    const request = ++runtimeConfigRequest;
    const initGeneration = credentialGeneration;
    const candidateConfig: InitMessage = {
      ...initConfig,
      model: msg.model,
      providerType: msg.providerType ?? initConfig.providerType,
      authType: msg.authType ?? initConfig.authType,
      baseUrl: msg.baseUrl,
      customEndpoint: msg.customEndpoint,
      customModels: msg.customModels,
    };
    const previous = await ensureModelRuntime();
    const candidate = await createModelRuntime(candidateConfig, () => {}, previous.credentials, previous.codingCredentials);
    const model = resolveRuntimeModel(candidate, candidateConfig, msg.model);
    if (!model) throw new Error(`Could not resolve model after runtime update: ${msg.model}`);
    candidateConfig.miniModel = resolveRuntimeMiniModel(candidate, candidateConfig);
    const endpointEnv = providerEndpointEnv(candidateConfig.piAuth?.provider, candidateConfig.baseUrl);
    const checkCurrent = () => {
      if (initGeneration !== credentialGeneration || request !== runtimeConfigRequest) throw new Error('Runtime config update superseded');
      if (msg.deadline !== undefined && Date.now() >= msg.deadline) throw new Error('Runtime config update deadline exceeded');
    };
    const commit = runtimeCommit.then(async () => {
      checkCurrent();
      if (kernelPromise) await kernelPromise.catch(() => undefined);
      checkCurrent();
      const active = kernel;
      const context = msg.deadline === undefined ? BACKGROUND_CONTEXT
        : withAbortSignal(AbortSignal.timeout(Math.max(0, msg.deadline - Date.now())), BACKGROUND_CONTEXT);
      await active?.waitForIdle(context);
      checkCurrent();
      const ref = { provider: model.provider, modelId: model.id, contextWindow: model.contextWindow };
      await active?.setModel(ref, candidate.models, context);
      // No await between changing the kernel model and publishing its matching catalog.
      candidateConfig.piAuth = initConfig!.piAuth;
      initConfig = candidateConfig;
      modelRuntime = candidate;
      modelRuntimePromise = Promise.resolve(candidate);
      runtimeConfigGeneration++;
      endpointEnvironment.apply(endpointEnv);
      setInterceptorApiHints(model);
      debugLog(`[runtime_config] Updated runtime config and active model: ${ref.provider}/${ref.modelId}`);
      send({ type: 'update_runtime_config_result', id: msg.id, success: true, updated: true, miniModel: candidateConfig.miniModel });
    });
    runtimeCommit = commit.catch(() => {});
    await commit;
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
  try {
    const operation = runtimeCommit.then(async () => {
      if (!kernel) throw new Error('Session closed during model change');
      const ref = await resolveModelRef(msg.model);
      if (!ref) throw new Error(`Could not resolve model: ${msg.model}`);
      await kernel.setModel(ref);
      if (initConfig) initConfig = { ...initConfig, model: msg.model };
      debugLog(`[set_model] Model changed to: ${msg.model} (resolved: ${ref.provider}/${ref.modelId})`);
    });
    runtimeCommit = operation.catch(() => {});
    await operation;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_model] Failed to set model: ${errorMsg}`);
    send({ type: 'error', message: errorMsg, code: 'set_model_error' });
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

function handleShutdown(): Promise<void> {
  return shuttingDown ??= shutdown();
}

async function shutdown(): Promise<void> {
  debugLog('Shutdown requested');
  nativeOwner.cancel('Pi server shutting down');
  foregroundUI?.close();
  for (const controller of pendingCompactions.values()) controller.abort();

  // Release host callbacks before waiting for SDK tasks that depend on them.
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Server shutting down' });
  }
  pendingPreToolUse.clear();
  for (const [, pending] of pendingToolExecutions) {
    pending.resolve({ content: 'Server shutting down', isError: true });
  }
  pendingToolExecutions.clear();
  prefetchCache.clear();
  await backgroundShells.dispose();

  // Abort utility queries independently from the main session.
  ephemeralQueries.cancelAll(new EphemeralQueryCancelledError('Pi server shutting down'));

  // Close the kernel session
  if (kernelPromise) await kernelPromise.catch(() => undefined);
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

  process.exit(0);
}

// ============================================================
// Main JSONL Reader Loop
// ============================================================

async function processMessage(msg: InboundMessage, compactController?: AbortController): Promise<void> {
  switch (msg.type) {
    case 'release_owner': {
      // Revoke admission synchronously, including callbacks still reading a body.
      foregroundActive = false;
      foregroundEpoch++;
      credentialGeneration++;
      nativeOwner.cancel('Native owner released');
      inputGeneration++;
      const callbacksClosed = stopCallbackServer();
      const active = kernel;
      const loaded = mcpLoad;
      // A target load can be nested inside the source startup promise.
      // Capture only this owner's work before any other binding can initialize.
      const loading = ownerLoading ?? (!active ? kernelPromise : null);
      releaseForegroundRequests('Native owner released');
      try {
        workerContext.getStore()?.ui?.close();
        await callbacksClosed;
        if (loading) await loading.catch(() => undefined);
        await active?.close();
        if (kernel === active) kernel = null;
        if (loaded && mcpLoad === loaded) {
          await closeMcpConnections(loaded.connections);
          if (mcpLoad === loaded) mcpLoad = null;
        }
        send({ type: 'owner_released', id: msg.id, released: true });
      } catch (error) {
        send({ type: 'owner_released', id: msg.id, released: false,
          error: error instanceof Error ? error.message : String(error) });
      }
      break;
    }
    case 'extension_ui_available':
      workerContext.getStore()?.ui?.setAvailable(msg.available === true);
      break;
    case 'extension_ui_response':
      send({ type: 'extension_ui_response_result', id: msg.responseId,
        accepted: workerContext.getStore()?.ui?.respond(msg.uiEpoch, msg) ?? false });
      break;
    case 'stop_background_task':
      send({ type: 'stop_background_task_result', id: msg.id, stopped: await backgroundShells.stop(msg.taskId, currentWorkerScope()) });
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
      await handleCompact(msg, compactController!);
      break;

    case 'cancel_compact':
      pendingCompactions.get(msg.id)?.abort();
      break;

    case 'set_auto_compaction':
      await handleSetAutoCompaction(msg);
      break;

    case 'set_session_name':
      try {
        if (typeof msg.name !== 'string') throw new Error('Invalid native session name');
        const active = await ensureKernel();
        await active.setSessionName(msg.name);
        send({ type: 'set_session_name_result', id: msg.id, success: true });
      } catch (error) {
        send({ type: 'set_session_name_result', id: msg.id, success: false,
          errorMessage: error instanceof Error ? error.message : String(error) });
      }
      break;

    case 'update_runtime_config':
      await handleUpdateRuntimeConfig(msg);
      break;

    case 'steer': {
      const generation = inputGeneration;
      await runtimeCommit;
      const active = kernel ?? await kernelPromise;
      await runtimeCommit;
      if (generation !== inputGeneration) break;
      if (active && active === kernel) {
        debugLog(`Steering with: "${msg.message.slice(0, 100)}"`);
        await active.steer(msg.message, msg.inputId);
      } else {
        debugLog('Steer ignored — no active session');
      }
      break;
    }

    case 'token_update': {
      const piAuth = toPiAuth(msg.piAuth);
      if (initConfig) initConfig.piAuth = piAuth;
      let runtime: ModelRuntime | null = null;
      try {
        runtime = modelRuntimePromise ? await modelRuntimePromise : null;
      } catch {
        runtime = null;
      }
      if (runtime) {
        const { provider, credential } = piAuth;
        const adapted = adaptCredentialForPiSdk(provider, credential);
        if (adapted) await runtime.credentials.seed(provider, adapted);
        debugLog(`Updated ${credential.type} credential for provider: ${provider}`);
      } else {
        debugLog(`Stored ${piAuth.credential.type} credential for provider: ${piAuth.provider}`);
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
  process.on('SIGTERM', () => { void handleShutdown(); });
  debugLog('Pi agent server starting');

  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as InboundMessage;
      const scope = readWorkerScope(msg);
      if (msg.type === 'owner_prepared' || msg.type === 'owner_activate' ||
          msg.type === 'owner_committed' || msg.type === 'owner_abort') {
        const accepted = nativeOwner.receive(msg, scope);
        if (accepted && msg.type === 'owner_activate' && !isForegroundScope(scope)) {
          void stopCallbackServer();
          foregroundUI?.close();
          foregroundScope = scope;
          foregroundActive = true;
          foregroundEpoch++;
          foregroundUI = new ExtensionUIHost(event => sendScoped(event, scope));
          foregroundUI.setAvailable(msg.activation.config.extensionUIAvailable === true);
        }
        return;
      }
      if (msg.type === 'init') {
        if ((scope && scope.ownerSessionId !== msg.sessionId) ||
            (foregroundScope && (!scope || scope.runtimeGeneration < foregroundScope.runtimeGeneration ||
              (scope.runtimeGeneration === foregroundScope.runtimeGeneration && scope.ownerSessionId !== foregroundScope.ownerSessionId)))) {
          debugLog('Ignoring stale or mismatched worker initialization');
          return;
        }
        // Close at receipt so an old startup hook cannot block the re-init queue.
        foregroundUI?.close();
        void stopCallbackServer();
        nativeOwner.cancel('Pi worker reinitialized');
        foregroundScope = scope;
        foregroundActive = true;
        foregroundEpoch++;
        foregroundUI = new ExtensionUIHost(event => sendScoped(event, scope));
        foregroundUI.setAvailable(msg.extensionUIAvailable === true);
      } else if (msg.type !== 'stop_background_task' && !isForegroundScope(scope)) {
        debugLog('Ignoring message from an inactive worker binding');
        return;
      }
      if (msg.type === 'abort' || msg.type === 'init' || msg.type === 'shutdown') inputGeneration++;
      const generation = inputGeneration;
      const ui = foregroundUI;
      if (msg.type === 'init') {
        // Later compact requests belong to the new initialization and must remain active.
        for (const controller of pendingCompactions.values()) controller.abort();
      }
      let compactController: AbortController | undefined;
      if (msg.type === 'compact') {
        if (pendingCompactions.has(msg.id)) throw new Error(`Duplicate compact request: ${msg.id}`);
        compactController = new AbortController();
        pendingCompactions.set(msg.id, compactController);
      }
      const dispatch = () => {
        if (msg.type !== 'init' && msg.type !== 'stop_background_task' && !isForegroundScope(scope)) {
          // Retired requests never reach handleCompact's cleanup.
          if (msg.type === 'compact' && pendingCompactions.get(msg.id) === compactController) pendingCompactions.delete(msg.id);
          debugLog('Ignoring queued message from an inactive worker binding');
          return Promise.resolve();
        }
        const inputId = msg.type === 'prompt' || msg.type === 'steer' ? msg.inputId : undefined;
        return workerContext.run({ scope, ui, inputId }, () => processMessage(msg, compactController));
      };
      const operation = msg.type === 'init'
        ? initialization.catch(() => undefined).then(dispatch)
        : ['tool_execute_response', 'pre_tool_use_response', 'extension_ui_response', 'extension_ui_available',
            'abort', 'cancel_compact', 'stop_background_task', 'release_owner', 'shutdown'].includes(msg.type)
          ? dispatch()
          : initialization.then(() => {
              if ((msg.type === 'prompt' || msg.type === 'steer') && generation !== inputGeneration) return;
              return dispatch();
            });
      if (msg.type === 'init') initialization = operation;
      operation.catch((error) => {
        if (msg.type === 'compact' && pendingCompactions.get(msg.id) === compactController) pendingCompactions.delete(msg.id);
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`Error processing message: ${errorMsg}`);
        sendScoped({ type: 'error', message: errorMsg }, scope);
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
