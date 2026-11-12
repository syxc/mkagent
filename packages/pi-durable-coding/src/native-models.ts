/** Expose the upstream registry facade over the host's existing pi-ai collection. */
import type { Api, AuthCheck, Model, Models, MutableModels, Provider } from '@earendil-works/pi-ai';
import { ModelRegistry } from './upstream/core/model-registry.js';
import { composeModelProvider, resolveCompatibilityRequestConfig, validateExtensionProvider } from '@earendil-works/pi-coding-agent';

export class NativeModelRegistry {
  readonly registry: ModelRegistry;
  private available: readonly Model<Api>[] = [];
  private readonly auth = new Map<string, AuthCheck | undefined>();
  private readonly registered = new Map<string, { base?: Provider; config?: object; native?: Provider }>();
  private current: Models | undefined;

  constructor(private readonly source: () => Models) {
    const actions = {
      getAvailableSnapshot: () => { this.collection; return this.available; },
      refresh: async (options?: Parameters<Models['refresh']>[0]) => {
        const result = await this.collection.refresh(options);
        await this.refreshSnapshot();
        return result;
      },
      getError: () => undefined,
      hasConfiguredAuth: (provider: string) => this.authStatus(provider) !== undefined,
      isUsingOAuth: (provider: string) => this.authStatus(provider)?.type === 'oauth',
      getProviderAuthStatus: (provider: string) => ({
        configured: this.authStatus(provider) !== undefined, label: this.authStatus(provider)?.source,
      }),
      getCompatibilityRequestConfig: (model: Model<Api>) =>
        resolveCompatibilityRequestConfig(model, undefined, this.registered.get(model.provider)?.config),
      registerProvider: (name: string, config: object) => {
        const models = this.mutable();
        const previous = this.registered.get(name);
        const base = previous ? previous.base : models.getProvider(name);
        validateExtensionProvider(name, base, undefined, config);
        const provider = composeModelProvider(name, base, { getProvider: () => undefined }, config);
        this.registered.set(name, { base, config });
        models.setProvider(provider);
      },
      registerNativeProvider: (provider: Provider) => {
        const models = this.mutable();
        const previous = this.registered.get(provider.id);
        const base = previous ? previous.base : models.getProvider(provider.id);
        this.registered.set(provider.id, { base, native: provider });
        models.setProvider(provider);
      },
      unregisterProvider: (name: string) => {
        const registration = this.registered.get(name);
        if (!registration) return;
        const models = this.mutable();
        if (registration.base) models.setProvider(registration.base);
        else models.deleteProvider(name);
        this.registered.delete(name);
      },
      getRegisteredProviderConfig: (name: string) => this.registered.get(name)?.config,
      getRegisteredNativeProvider: (name: string) => this.registered.get(name)?.native,
      getRegisteredProviderIds: () => [...this.registered.keys()],
    };
    // Upstream ModelRegistry delegates to ModelRuntime; common operations map directly to pi-ai Models.
    const bridge = new Proxy(actions, {
      get: (target, key) => {
        const owner = Reflect.has(target, key) ? target : this.collection;
        const value = Reflect.get(owner, key);
        return typeof value === 'function' ? value.bind(owner) : value;
      },
    });
    this.registry = new ModelRegistry(bridge);
  }

  /** Recompose declarations when the host replaces its model collection. */
  get collection(): Models {
    const models = this.source();
    if (models !== this.current) {
      const mutable = this.registered.size ? this.mutable(models) : undefined;
      for (const [name, registration] of this.registered) {
        const base = models.getProvider(name);
        const provider = registration.native
          ?? composeModelProvider(name, base, { getProvider: () => undefined }, registration.config);
        mutable!.setProvider(provider);
        registration.base = base;
      }
      this.current = models;
      this.available = [];
      this.auth.clear();
    }
    return models;
  }

  /** Refresh synchronous extension reads without refreshing OAuth or remote catalogs. */
  async refreshSnapshot(): Promise<void> {
    const models = this.collection;
    const auth = await Promise.all(models.getProviders().map(async provider =>
      [provider.id, await models.checkAuth(provider.id)] as const));
    const available = await models.getAvailable();
    if (models !== this.collection) return this.refreshSnapshot();
    this.available = available;
    this.auth.clear();
    for (const [provider, status] of auth) this.auth.set(provider, status);
  }

  private authStatus(provider: string): AuthCheck | undefined {
    this.collection;
    return this.auth.get(provider);
  }

  private mutable(models: Models = this.collection): MutableModels {
    if (!('setProvider' in models) || !('deleteProvider' in models)) {
      throw new Error('Provider registration requires the host mutable pi-ai Models collection');
    }
    // The host supplies the standard pi-ai collection, whose mutation methods define MutableModels.
    return models as MutableModels;
  }
}
