/**
 * Ephemeral LLM queries (`call_llm`, titles, summaries) without a Pi session.
 *
 * The 1.1.0 kernel ran these through throwaway `AgentSession`s; the durable
 * kernel instead calls `models.completeSimple()` directly — one provider
 * request, no conversation, no storage. Deadlines, cancellation, and model
 * fallback stay in `EphemeralQueryCoordinator` / `queryMiniModel`, unchanged.
 */
import type { AssistantMessage, MutableModels } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { LLMQueryRequest, LLMQueryResult } from '../../shared/src/agent/llm-tool.ts';
import { getDefaultSummarizationModel } from '../../shared/src/config/models.ts';
import type { EphemeralQueryContext } from './ephemeral-query-lifecycle.ts';
import { EphemeralQueryCancelledError } from './ephemeral-query-lifecycle.ts';
import { isDeniedMiniModelId, resolvePiModel } from './model-resolution.ts';
import { pickProviderAppropriateMiniModel } from './pick-mini-model.ts';
import { queryMiniModel } from './mini-model-query.ts';

/** Retry budget mirrored from the old ephemeral SettingsManager (see git history). */
const EPHEMERAL_MAX_AGENT_RETRIES = 2;
const EPHEMERAL_BASE_DELAY_MS = 2_000;
/** Provider-level retries inside one request attempt (pi-ai StreamOptions). */
const EPHEMERAL_PROVIDER_RETRIES = { maxRetries: 2, maxRetryDelayMs: 10_000 };

export interface QueryLlmDeps {
  models: MutableModels;
  getConfig: () => {
    miniModel?: string;
    sessionModel?: string;
    piAuthProvider?: string;
    preferCustomEndpoint: boolean;
  } | null;
  debugLog: (message: string) => void;
}

function resultText(message: AssistantMessage): string {
  return message.content
    .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
    .map(c => c.text)
    .join('');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new EphemeralQueryCancelledError());
    }, { once: true });
  });
}

export async function queryLlm(
  request: LLMQueryRequest,
  lifecycle: EphemeralQueryContext,
  deps: QueryLlmDeps,
): Promise<LLMQueryResult> {
  lifecycle.throwIfCancelled();
  const config = deps.getConfig();
  if (!config) throw new Error('Cannot run queryLlm: init not received');

  deps.debugLog('[queryLlm] Starting');

  // Pick mini model. If the configured miniModel uses a different provider than
  // what the user authenticated with (e.g. gemini-2.5-pro when only anthropic
  // credentials exist), fall back to the default summarization model which uses
  // the same provider family.
  let model = request.model ?? config.miniModel ?? getDefaultSummarizationModel();

  // If piAuth is set, ensure the mini model uses the same provider.
  // pi-ai would fail with "No API key found" if the model requires a different provider.
  // Exception: 'custom-endpoint' provider is always compatible because it carries
  // its own API key and doesn't use the credential store.
  if (config.piAuthProvider) {
    const bareModel = model.startsWith('pi/') ? model.slice(3) : model;
    const resolved = resolvePiModel(deps.models, bareModel, config.piAuthProvider, config.preferCustomEndpoint);
    const isCompatible = resolved?.provider === config.piAuthProvider || resolved?.provider === 'custom-endpoint';
    if (!resolved || !isCompatible || isDeniedMiniModelId(model, config.piAuthProvider)) {
      // Anthropic: keep Haiku (the cheap/fast mini). For every other provider
      // Haiku is unresolvable, so walk PI_PREFERRED_DEFAULTS for a model that
      // actually works under the user's auth.
      const providerDefault = config.piAuthProvider === 'anthropic'
        ? undefined
        : pickProviderAppropriateMiniModel(config.piAuthProvider, deps.models, config.preferCustomEndpoint);
      const fallback = providerDefault ?? getDefaultSummarizationModel();
      deps.debugLog(`[queryLlm] Model ${bareModel} incompatible with ${config.piAuthProvider} (resolved: ${resolved?.provider}), falling back to ${fallback}`);
      model = fallback;
    }
  }

  const runQueryWithModel = async (modelId: string): Promise<string> => {
    lifecycle.throwIfCancelled();
    deps.debugLog(`[queryLlm] Using model: ${modelId}`);

    // Resolve model — fail fast if unresolvable so we don't hit a misleading
    // "No API key found" from an internal default.
    const piModel = resolvePiModel(deps.models, modelId, config.piAuthProvider, config.preferCustomEndpoint);
    if (!piModel) {
      throw new Error(
        `Could not resolve mini model "${modelId}" for provider "${config.piAuthProvider ?? '(unknown)'}"`,
      );
    }

    const context = {
      systemPrompt: request.systemPrompt ?? 'Reply with ONLY the requested text. No explanation.',
      messages: [{ role: 'user' as const, content: request.prompt, timestamp: Date.now() }],
    };

    // `complete()` resolves only after SDK retries settle, so the request-level
    // coordinator owns the one actual deadline around this call. Terminal
    // provider errors come back as stopReason "error", not throws.
    for (let attempt = 0; ; attempt++) {
      lifecycle.throwIfCancelled();
      let message: AssistantMessage;
      try {
        message = await deps.models.completeSimple(piModel, context, {
          signal: lifecycle.signal,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          ...EPHEMERAL_PROVIDER_RETRIES,
        });
      } catch (error) {
        if (lifecycle.signal.aborted) throw new EphemeralQueryCancelledError();
        throw error;
      }
      lifecycle.throwIfCancelled();

      if (message.stopReason === 'error') {
        const errorMessage = message.errorMessage || 'Unknown provider error';
        if (attempt < EPHEMERAL_MAX_AGENT_RETRIES && isRetryableAssistantError(message)) {
          deps.debugLog(`[queryLlm] Retryable error (attempt ${attempt + 1}): ${errorMessage}`);
          await sleep(EPHEMERAL_BASE_DELAY_MS * 2 ** attempt, lifecycle.signal);
          continue;
        }
        throw new Error(errorMessage);
      }

      const text = resultText(message).trim();
      deps.debugLog(`[queryLlm] Result length: ${text.length}`);
      return text;
    }
  };

  return queryMiniModel({
    model,
    miniModel: config.miniModel,
    sessionModel: config.sessionModel,
    authProvider: config.piAuthProvider,
    models: deps.models,
    preferCustomEndpoint: config.preferCustomEndpoint,
    onFallback: (rejectedModel, retryModel) => {
      deps.debugLog(`[queryLlm] Model ${rejectedModel} unavailable, retrying with ${retryModel}`);
    },
  }, runQueryWithModel);
}
