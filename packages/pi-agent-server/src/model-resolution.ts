import type { Api, Model, MutableModels } from '@earendil-works/pi-ai';

// Re-export from shared so the auth-aware mini-model denylist has a single
// source of truth (also used by `getMiniModel()` at selection time).
export { isDeniedMiniModelId } from '../../shared/src/config/llm-connections.ts';

/**
 * Resolve a chat model from the pi-ai `Models` collection, with optional
 * custom-endpoint precedence.
 *
 * Resolution order:
 * 1. If `preferCustomEndpoint` is true, try `'custom-endpoint'` provider first
 * 2. Exact provider+model lookup via `piAuthProvider`
 * 3. Full catalog scan by id/name (restricted to the auth provider)
 * 4. Common provider fallback list (includes 'custom-endpoint')
 */
export function resolvePiModel(
  models: MutableModels,
  modelId: string,
  piAuthProvider?: string,
  preferCustomEndpoint?: boolean,
): Model<Api> | undefined {
  // Strip MkAgent's pi/ prefix — Pi SDK uses bare model IDs.
  const bareId = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;

  // Custom-endpoint takes precedence when configured
  if (preferCustomEndpoint) {
    const custom = models.getModel('custom-endpoint', bareId);
    if (custom) return custom;
  }

  // If we know the auth provider, do an exact provider+model lookup first.
  // This avoids the catalog-scan ambiguity where the same model ID exists under
  // multiple providers (e.g., "gpt-5.2" under both "openai" and
  // "azure") and the wrong one matches first.
  if (piAuthProvider) {
    const exact = models.getModel(piAuthProvider, bareId);
    if (exact) {
      // MiniMax CN API rejects model IDs with the 'MiniMax-' prefix (e.g. 500 for
      // 'MiniMax-M2.5-highspeed') but accepts bare names ('M2.5-highspeed').
      if (piAuthProvider === 'minimax-cn' && exact.id.startsWith('MiniMax-')) {
        return { ...exact, id: exact.id.slice('MiniMax-'.length) };
      }
      return exact;
    }
  }

  // Fallback: search all known chat models.
  // When piAuthProvider is set, only return models from the same provider
  // (or 'custom-endpoint'). Without this guard, a model that exists under
  // a different provider (e.g. "gpt-5.4" under "azure"
  // when authed as "github-copilot") would be returned, and requests would
  // fail with "No API key found for <wrong-provider>".
  const match = models.getModels().find(m =>
    (m.id === bareId || m.name === bareId) &&
    (!piAuthProvider || m.provider === piAuthProvider || m.provider === 'custom-endpoint'),
  );
  if (match) return match;

  // Try common providers with the model ID
  const providers = ['custom-endpoint', 'anthropic', 'openai', 'google'];
  for (const provider of providers) {
    // Skip providers incompatible with the authenticated provider
    if (piAuthProvider && provider !== piAuthProvider && provider !== 'custom-endpoint') continue;
    const model = models.getModel(provider, bareId);
    if (model) return model;
  }

  return undefined;
}

/**
 * Returns true when an error message indicates the requested model is unavailable and a
 * different model should be tried. Matches both the standard OpenAI "model not found"
 * shapes and provider-specific "… is not supported" refusals.
 */
export function isModelNotFoundError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('model_not_found') ||
    normalized.includes('does not exist') ||
    normalized.includes('no such model') ||
    normalized.includes('is not supported') ||
    (normalized.includes('requested model') && normalized.includes('not') && normalized.includes('exist'))
  );
}

/**
 * Stricter model-rejection predicate for contexts where a 400 may instead mean
 * a rejected hosted tool or request parameter. Ambiguous messages count only
 * when they name the requested model.
 */
export function isModelRejectionError(message: string, modelId: string): boolean {
  if (!isModelNotFoundError(message)) return false;
  const normalized = message.toLowerCase();
  if (
    normalized.includes('model_not_found')
    || normalized.includes('no such model')
    || normalized.includes('requested model')
  ) {
    return true;
  }
  return modelId.length > 0 && normalized.includes(modelId.toLowerCase());
}
