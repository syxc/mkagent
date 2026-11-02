import { getMiniModel } from '../../shared/src/config/llm-connections.ts';
import { stripPiPrefix } from './custom-endpoint-models.ts';
import { isDeniedMiniModelId, resolvePiModel } from './model-resolution.ts';
import { registerCustomEndpointModels, resolveCustomEndpointApiKey, type ModelRuntime, type ModelRuntimeConfig } from './model-runtime.ts';
import { pickProviderAppropriateMiniModel } from './pick-mini-model.ts';

/** Resolve in the supplied catalog without publishing process state. */
export function resolveRuntimeModel(runtime: ModelRuntime, config: ModelRuntimeConfig, modelId: string) {
  const preferCustom = Boolean(config.customEndpoint && config.baseUrl?.trim());
  let model = resolvePiModel(runtime.models, modelId, config.piAuth?.provider, preferCustom);
  if (!model && preferCustom) {
    const id = stripPiPrefix(modelId);
    registerCustomEndpointModels({
      models: runtime.models, api: config.customEndpoint!.api, baseUrl: config.baseUrl!.trim(),
      apiKey: resolveCustomEndpointApiKey(config),
      endpointDefaults: { supportsImages: config.customEndpoint!.supportsImages === true, maxTokens: config.customEndpoint!.maxTokens },
      entries: [{ id }],
    });
    model = runtime.models.getModel('custom-endpoint', id) ?? undefined;
  }
  return model;
}

/** Preserve a valid explicit mini choice, otherwise use the new connection's catalog. */
export function resolveRuntimeMiniModel(runtime: ModelRuntime, config: ModelRuntimeConfig & { miniModel?: string }): string | undefined {
  const provider = config.piAuth?.provider;
  const preferCustom = Boolean(config.customEndpoint && config.baseUrl?.trim());
  const candidates = [
    config.miniModel,
    getMiniModel({ models: config.customModels?.map(entry => typeof entry === 'string' ? entry : entry.id), providerType: 'pi_compat', piAuthProvider: provider }),
    provider ? pickProviderAppropriateMiniModel(provider, runtime.models, preferCustom) : undefined,
    config.model,
  ];
  const selected = candidates.find(candidate => {
    if (!candidate || isDeniedMiniModelId(candidate, provider)) return false;
    const model = resolvePiModel(runtime.models, candidate, provider, preferCustom);
    if (preferCustom) return model?.provider === 'custom-endpoint';
    return !!model && (!provider || model.provider === provider || model.provider === 'custom-endpoint');
  });
  return selected && (selected === config.miniModel || selected.startsWith('pi/') ? selected : `pi/${selected}`);
}
