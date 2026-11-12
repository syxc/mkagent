/** Bind host model ownership without replacing SDK composition, auth or request algorithms. */
export function codingModelRuntimePolicy(source: string, declarations: boolean): string {
  let body = source;
  const replace = (before: string, after: string, count = 1) => {
    if (body.split(before).length - 1 !== count) throw new Error('Published ModelRuntime boundary changed: ' + before);
    body = body.replaceAll(before, after);
  };
  if (declarations) {
    replace('export interface CreateModelRuntimeOptions {', `export interface CreateModelRuntimeOptions {
    authContext?: import("@earendil-works/pi-ai").AuthContext;`);
    replace('export interface ModelRuntimeAuthOverrides', `/** Shared memory-only key overlay over the host credential store. */
export interface ModelRuntimeCredentials extends CredentialStore {
    setRuntimeApiKey(providerId: string, apiKey: string): void;
    removeRuntimeApiKey(providerId: string): void;
    hasRuntimeApiKey(providerId: string): boolean;
}
export interface BindModelRuntimeOptions {
    /** The host can replace its collection or providers while the runtime is open. */
    models: () => Models;
    credentials: ModelRuntimeCredentials;
    authContext?: import("@earendil-works/pi-ai").AuthContext;
    allowModelNetwork?: boolean;
    signal?: AbortSignal;
    refreshOnCreate?: boolean;
}
export interface ModelRuntimeAuthOverrides`);
    replace('    private readonly models;', `    private readonly ownedModels;
    private readonly hostSource;
    private hostModels;
    private readonly hostProviders;
    private synchronizingHost;
    private get models();
    private synchronizeHostModels;`);
    replace('    static create(options?', `    static createCredentials(store: CredentialStore): ModelRuntimeCredentials;
    static bind(options: BindModelRuntimeOptions): Promise<ModelRuntime>;
    private refreshModels;
    static create(options?`);
    return body;
  }
  replace('    models;', `    ownedModels;
    hostSource;
    hostModels;
    hostProviders = new Map();
    synchronizingHost = false;
    get models() {
        this.synchronizeHostModels();
        return this.ownedModels;
    }
    synchronizeHostModels() {
        if (!this.hostSource || this.synchronizingHost) return;
        const host = this.hostSource();
        if (host === this) throw new Error("Host models source must not return its bound runtime.");
        const providers = host.getProviders();
        if (host === this.hostModels && providers.length === this.hostProviders.size &&
            providers.every(provider => this.hostProviders.get(provider.id) === provider)) return;
        const replacingHost = this.hostModels !== undefined;
        this.synchronizingHost = true;
        try {
            this.hostModels = host;
            this.hostProviders.clear();
            this.builtins.clear();
            for (const provider of providers) {
                this.hostProviders.set(provider.id, provider);
                this.builtins.set(provider.id, provider);
            }
            // Checks for a replaced host must not restore its old availability or auth.
            ++this.availabilityRefreshSeq;
            ++this.availabilityErrorSeq;
            for (const [id, seq] of this.providerAvailabilitySeq) this.providerAvailabilitySeq.set(id, seq + 1);
            this.snapshot = { ...this.snapshot, all: [], available: [], configuredProviders: new Set(), auth: new Map() };
            this.availabilityError = undefined;
            this.rebuildProviders();
        } finally {
            this.synchronizingHost = false;
        }
        if (replacingHost) void this.queueAvailabilityRefresh().catch(() => {});
    }`);
  replace('constructor(credentials, config, modelsPath, modelsStore, providers, modelNetworkEnabled) {',
    'constructor(credentials, config, modelsPath, modelsStore, providers, modelNetworkEnabled, hostSource, authContext) {\n        this.hostSource = hostSource;');
  replace('this.models = createModels({ credentials, modelsStore });', 'this.ownedModels = createModels({ credentials, modelsStore, authContext });');
  replace('    static async create(options = {}) {', `    static createCredentials(store) {
        return new RuntimeCredentials(store);
    }
    static async bind(options) {
        const runtime = new ModelRuntime(
            options.credentials, await ModelConfig.load(undefined), undefined,
            new InMemoryCodingAgentModelsStore(), [], options.allowModelNetwork === true, options.models, options.authContext,
        );
        if (options.refreshOnCreate !== false) {
            await runtime.refresh({ allowNetwork: false, signal: options.signal });
        }
        return runtime;
    }
    static async create(options = {}) {`);
  replace('new ModelRuntime(credentials, config, modelsPath, modelsStore, providers, process.env.PI_OFFLINE === undefined)',
    'new ModelRuntime(credentials, config, modelsPath, modelsStore, providers, process.env.PI_OFFLINE === undefined, undefined, options.authContext)');
  replace('        for (const [providerId, provider] of this.defaultBuiltins)\n            this.builtins.set(providerId, provider);\n        for (const providerId',
    '        for (const [providerId, provider] of this.hostSource ? this.hostProviders : this.defaultBuiltins)\n            this.builtins.set(providerId, provider);\n        for (const providerId');
  replace('        if (seq !== this.availabilityRefreshSeq)', '        this.synchronizeHostModels();\n        if (seq !== this.availabilityRefreshSeq)');
  replace('            if (this.providerAvailabilitySeq.get(providerId) !== providerSeq)',
    '            this.synchronizeHostModels();\n            if (this.providerAvailabilitySeq.get(providerId) !== providerSeq)');
  for (const signature of [
    'recomposeProvider(providerId)',
    'queueAvailabilityRefresh(signal)',
    'async refreshProviderAvailability(providerId, signal)',
    'getAvailableSnapshot()',
    'getError()',
    'isUsingOAuth(providerId)',
    'hasConfiguredAuth(providerId)',
    'getProviderAuthStatus(providerId)',
    'async refresh(options = {})',
    'registerProvider(providerId, config)',
  ]) replace('    ' + signature + ' {', '    ' + signature + ' {\n        this.synchronizeHostModels();');
  replace('await this.models.refresh(', 'await this.refreshModels(', 2);
  replace('    async refresh(options = {}) {', `    async refreshModels(options) {
        const models = this.models;
        const host = this.hostModels;
        if (!host) return models.refresh(options);
        const ids = options.providers ?? models.getProviders().map(provider => provider.id);
        const hostIds = ids.filter(id => this.hostProviders.has(id) &&
            !this.extensionProviders.has(id) && !this.nativeExtensionProviders.has(id));
        const ownedIds = ids.filter(id => !hostIds.includes(id));
        // Host catalogs keep their original store. Extension overlays use the memory-only collection.
        const results = await Promise.all([
            hostIds.length ? host.refresh({ ...options, providers: hostIds }) : undefined,
            ownedIds.length ? models.refresh({ ...options, providers: ownedIds }) : undefined,
        ]);
        return {
            aborted: results.some(result => result?.aborted) || (options.signal?.aborted ?? false),
            errors: new Map(results.flatMap(result => [...(result?.errors ?? [])])),
        };
    }
    async refresh(options = {}) {`);
  return body;
}
