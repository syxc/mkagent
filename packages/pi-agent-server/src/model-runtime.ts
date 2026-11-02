/**
 * pi-ai 1.4.0 model runtime for the durable kernel.
 *
 * Replaces the 1.1.0 `ModelRuntime`/`ModelRegistry` pair: one `MutableModels`
 * collection owns provider auth (credential store) and the model catalog.
 * The custom-endpoint provider is rebuilt through `createProvider` on every
 * registration, because `setProvider` replaces the provider wholesale — the
 * same contract the old `registry.registerProvider` had.
 */
import {
  InMemoryCredentialStore,
  createProvider,
  type Credential,
  type ProviderStreams,
  type Provider,
  type Api,
  type Model,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { MutableModels } from '@earendil-works/pi-ai';
import type {
  CustomEndpointApi,
  CustomEndpointModelEntry,
  CustomEndpointModelOverrides,
} from './custom-endpoint-models.ts';
import { buildCustomEndpointModelDef, normalizeCustomEndpointModelEntry } from './custom-endpoint-models.ts';
import type { PiCredential } from './adapt-credential.ts';

/** Lazy API implementations keyed by `model.api`, shared by custom endpoints. */
const CUSTOM_ENDPOINT_APIS: Record<CustomEndpointApi, () => ProviderStreams> = {
  'openai-completions': openAICompletionsApi,
  'anthropic-messages': anthropicMessagesApi,
};

export type OAuthUpdateHandler = (update: {
  provider: string;
  credential: Extract<Credential, { type: 'oauth' }>;
  previousRefresh?: string;
}) => void;

export class OAuthSyncCredentialStore extends InMemoryCredentialStore {
  constructor(private readonly onOAuthUpdate: OAuthUpdateHandler) {
    super();
  }

  /** Seed from the main process without echoing the same credential back. */
  seed(provider: string, credential: Credential): Promise<Credential | undefined> {
    return super.modify(provider, async () => credential);
  }

  override async modify(
    provider: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    let previous: Credential | undefined;
    const next = await super.modify(provider, async current => {
      previous = current;
      return fn(current);
    });
    if (
      previous?.type === 'oauth'
      && next?.type === 'oauth'
      && JSON.stringify(previous) !== JSON.stringify(next)
    ) {
      this.onOAuthUpdate({ provider, credential: next, previousRefresh: previous.refresh });
    }
    return next;
  }
}

const customEndpointModels = new WeakMap<MutableModels, Map<string, CustomEndpointModelOverrides>>();

export interface RegisterCustomEndpointOptions {
  models: MutableModels;
  api: CustomEndpointApi;
  baseUrl: string;
  /** Truthy key for non-localhost endpoints; localhost may use a placeholder. */
  apiKey: string;
  endpointDefaults?: { supportsImages?: boolean; maxTokens?: number };
  entries: CustomEndpointModelEntry[];
}

/**
 * Register (or re-register) the custom-endpoint provider with the given models.
 * The full known model set is always passed: `setProvider` replaces wholesale.
 */
export function registerCustomEndpointModels(options: RegisterCustomEndpointOptions): void {
  const { models, api, baseUrl, apiKey, endpointDefaults, entries } = options;
  let registered = customEndpointModels.get(models);
  if (!registered) {
    registered = new Map();
    customEndpointModels.set(models, registered);
  }
  for (const entry of entries) {
    if (entry.contextWindow || entry.supportsImages !== undefined) {
      registered.set(entry.id, {
        ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
        ...(entry.supportsImages !== undefined ? { supportsImages: entry.supportsImages } : {}),
      });
    } else if (!registered.has(entry.id)) {
      registered.set(entry.id, {});
    }
  }

  const provider = createProvider({
    id: 'custom-endpoint',
    name: 'Custom endpoint',
    baseUrl,
    auth: {
      apiKey: {
        name: 'Custom endpoint API key',
        resolve: async () => (apiKey ? { auth: { apiKey } } : undefined),
      },
    },
    models: [...registered].map(([id, overrides]) => buildCustomEndpointModelDef(
      id,
      api,
      baseUrl,
      endpointDefaults,
      overrides,
    )),
    api: { [api]: CUSTOM_ENDPOINT_APIS[api]() },
  });
  models.setProvider(provider);
}

export interface ModelRuntimeConfig {
  /** api_key credential for the main provider (legacy single-key path). */
  apiKey?: string;
  piAuth?: { provider: string; credential: PiCredential };
  baseUrl?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean; maxTokens?: number };
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
  model?: string;
}

/** Resolve the API key for custom endpoint auth (moved from index.ts unchanged). */
export function resolveCustomEndpointApiKey(config: ModelRuntimeConfig): string {
  if (config.piAuth?.credential?.type === 'api_key') {
    return config.piAuth.credential.key;
  }
  const key = config.apiKey || '';
  if (!key && config.baseUrl) {
    if (isLocalhostUrl(config.baseUrl)) {
      // Local endpoints (Ollama, LM Studio) don't need auth.
      // pi-ai requires a truthy apiKey to register models, so use a placeholder.
      return 'not-needed';
    }
    return '';
  }
  return key;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
  } catch {
    return false;
  }
}

export function withModelRequestCompatibility(provider: Provider): Provider {
  if (provider.id !== 'minimax-cn') return provider;
  // Keep catalog identity stable; MiniMax CN only accepts the bare ID on the wire.
  const requestModel = <T extends Api>(model: Model<T>): Model<T> => model.id.startsWith('MiniMax-')
    ? { ...model, id: model.id.slice('MiniMax-'.length) }
    : model;
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(requestModel(model), context, options),
    streamSimple: (model, context, options) => provider.streamSimple(requestModel(model), context, options),
  };
}

export interface ModelRuntime {
  models: MutableModels;
  credentials: OAuthSyncCredentialStore;
}

/**
 * Build the shared model runtime: builtin provider catalog over the process
 * credential store, plus the custom-endpoint provider when configured.
 * Cached by the caller; re-created on re-init and runtime config changes.
 */
export async function createModelRuntime(
  config: ModelRuntimeConfig,
  onOAuthUpdate: OAuthUpdateHandler,
): Promise<ModelRuntime> {
  const credentials = new OAuthSyncCredentialStore(onOAuthUpdate);
  const models = builtinModels({ credentials });
  const minimax = models.getProvider('minimax-cn');
  if (minimax) models.setProvider(withModelRequestCompatibility(minimax));

  const baseUrl = config.baseUrl?.trim();
  if (baseUrl && config.customEndpoint) {
    const entries = (config.customModels?.length
      ? config.customModels
      : [config.model || 'default']
    ).map(normalizeCustomEndpointModelEntry);
    registerCustomEndpointModels({
      models,
      api: config.customEndpoint.api,
      baseUrl,
      apiKey: resolveCustomEndpointApiKey(config),
      endpointDefaults: {
        supportsImages: config.customEndpoint.supportsImages === true,
        maxTokens: config.customEndpoint.maxTokens,
      },
      entries,
    });
  }

  return { models, credentials };
}

export { CUSTOM_ENDPOINT_APIS };
