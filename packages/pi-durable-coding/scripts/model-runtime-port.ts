/** Keep host model ownership changes reproducible from the pinned native source. */
export function portModelRuntime(source: string): string {
  let body = source;
  const replace = (before: string, after: string) => {
    if (!body.includes(before)) throw new Error('Pinned ModelRuntime changed: ' + before);
    body = body.replace(before, after);
  };

  replace('export interface ModelRuntimeAuthOverrides', `/** One shared, memory-only runtime-key overlay over the host credential store. */
export interface ModelRuntimeCredentials extends CredentialStore {
\tsetRuntimeApiKey(providerId: string, apiKey: string): void;
\tremoveRuntimeApiKey(providerId: string): void;
\thasRuntimeApiKey(providerId: string): boolean;
}

export interface BindModelRuntimeOptions {
\t/** Read the current host collection on every operation; the runtime never mutates it. */
\tmodels: () => Models;
\t/** Pass this same port to the host Models collection. Use createCredentials() once. */
\tcredentials: ModelRuntimeCredentials;
\t/** Bound runtimes default to cache-only catalog refreshes. */
\tallowModelNetwork?: boolean;
\tsignal?: AbortSignal;
\trefreshOnCreate?: boolean;
}

export interface ModelRuntimeAuthOverrides`);
  replace('private readonly models: MutableModels;', `private readonly ownedModels: MutableModels;
\tprivate hostModels: Models | undefined;
\tprivate readonly hostProviders = new Map<string, Provider>();
\tprivate synchronizingHost = false;

\tprivate get models(): MutableModels {
\t\tthis.synchronizeHostModels();
\t\treturn this.ownedModels;
\t}

\tprivate synchronizeHostModels(): void {
\t\tif (!this.hostSource || this.synchronizingHost) return;
\t\tconst host = this.hostSource();
\t\tif (host === this) throw new Error("Host models source must not return its bound runtime.");
\t\tconst providers = host.getProviders();
\t\tif (host === this.hostModels && providers.length === this.hostProviders.size &&
\t\t\tproviders.every((provider) => this.hostProviders.get(provider.id) === provider)) return;
\t\tconst replacingHost = this.hostModels !== undefined;
\t\tthis.synchronizingHost = true;
\t\ttry {
\t\t\tthis.hostModels = host;
\t\t\tthis.hostProviders.clear();
\t\t\tthis.builtins.clear();
\t\t\tfor (const provider of providers) {
\t\t\t\tthis.hostProviders.set(provider.id, provider);
\t\t\t\tthis.builtins.set(provider.id, provider);
\t\t\t}
\t\t\t// An in-flight check must never restore auth from a superseded host collection.
\t\t\t++this.availabilityRefreshSeq;
\t\t\t++this.availabilityErrorSeq;
\t\t\tfor (const [id, seq] of this.providerAvailabilitySeq) this.providerAvailabilitySeq.set(id, seq + 1);
\t\t\tthis.snapshot = {
\t\t\t\t...this.snapshot, all: [], available: [], configuredProviders: new Set(), auth: new Map(),
\t\t\t};
\t\t\tthis.availabilityError = undefined;
\t\t\tthis.rebuildProviders();
\t\t} finally {
\t\t\tthis.synchronizingHost = false;
\t\t}
\t\t// Retain the native error snapshot and sequencing rules without a network catalog refresh.
\t\tif (replacingHost) void this.queueAvailabilityRefresh().catch(() => {});
\t}
`);
  replace('private readonly credentials: RuntimeCredentials;', 'private readonly credentials: ModelRuntimeCredentials;');
  replace('\t\tcredentials: RuntimeCredentials,', '\t\tcredentials: ModelRuntimeCredentials,');
  replace('\t\tmodelNetworkEnabled: boolean,\n\t) {', '\t\tmodelNetworkEnabled: boolean,\n\t\tprivate readonly hostSource?: () => Models,\n\t) {');
  replace('this.models = createModels({ credentials, modelsStore });', 'this.ownedModels = createModels({ credentials, modelsStore });');
  replace('\tstatic async create(options:', `\t/** Wrap the existing host store once and inject the returned port into both collections. */
\tstatic createCredentials(store: CredentialStore): ModelRuntimeCredentials {
\t\treturn new RuntimeCredentials(store);
\t}

\t/** Bind native extension, virtual-model and auth behavior without opening config or auth files. */
\tstatic async bind(options: BindModelRuntimeOptions): Promise<ModelRuntime> {
\t\tconst runtime = new ModelRuntime(
\t\t\toptions.credentials, await ModelConfig.load(undefined), undefined,
\t\t\tnew InMemoryCodingAgentModelsStore(), [], options.allowModelNetwork === true, options.models,
\t\t);
\t\tif (options.refreshOnCreate !== false) {
\t\t\tawait runtime.refresh({ allowNetwork: false, signal: options.signal });
\t\t}
\t\treturn runtime;
\t}

\tstatic async create(options:`);
  replace(
    'for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);\n\t\tfor (const providerId of this.config.getProviderIds())',
    'for (const [providerId, provider] of this.hostSource ? this.hostProviders : this.defaultBuiltins) this.builtins.set(providerId, provider);\n\t\tfor (const providerId of this.config.getProviderIds())',
  );
  replace(
    'private recomposeProvider(providerId: string): Provider | undefined {\n\t\tconst provider',
    'private recomposeProvider(providerId: string): Provider | undefined {\n\t\tthis.synchronizeHostModels();\n\t\tconst provider',
  );
  replace(
    '\t\tif (seq !== this.availabilityRefreshSeq) return;',
    '\t\tthis.synchronizeHostModels();\n\t\tif (seq !== this.availabilityRefreshSeq) return;',
  );
  replace(
    'private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {\n\t\tconst seq',
    'private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {\n\t\tthis.synchronizeHostModels();\n\t\tconst seq',
  );
  replace(
    'private async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {\n',
    'private async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {\n\t\tthis.synchronizeHostModels();\n',
  );
  replace(
    '\t\t\tsignal.throwIfAborted();\n\t\t\tif (this.providerAvailabilitySeq.get(providerId)',
    '\t\t\tsignal.throwIfAborted();\n\t\t\tthis.synchronizeHostModels();\n\t\t\tif (this.providerAvailabilitySeq.get(providerId)',
  );
  for (const signature of [
    'getAvailableSnapshot(): readonly Model<Api>[]',
    'getError(): string | undefined',
    'isUsingOAuth(providerId: string): boolean',
    'hasConfiguredAuth(providerId: string): boolean',
    'getProviderAuthStatus(providerId: string): AuthStatus',
    'registerProvider(providerId: string, config: ProviderConfigInput): void',
  ]) {
    replace(signature + ' {', signature + ' {\n\t\tthis.synchronizeHostModels();');
  }
  replace('await this.models.refresh({ allowNetwork: false, providers: [providerId], signal })',
    'await this.refreshModels({ allowNetwork: false, providers: [providerId], signal })');
  replace('\tasync refresh(options: ModelsRefreshOptions = {}):', `\tprivate async refreshModels(options: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
\t\tconst models = this.models;
\t\tconst host = this.hostModels;
\t\tif (!host) return models.refresh(options);
\t\tconst ids = options.providers ?? models.getProviders().map((provider) => provider.id);
\t\tconst hostIds = ids.filter((id) => this.hostProviders.has(id) &&
\t\t\t!this.extensionProviders.has(id) && !this.nativeExtensionProviders.has(id));
\t\tconst ownedIds = ids.filter((id) => !hostIds.includes(id));
\t\t// Host providers retain their original catalog store and refresh policy. Extension overlays
\t\t// use the runtime's memory-only store; neither path creates a second persisted config.
\t\tconst results = await Promise.all([
\t\t\thostIds.length ? host.refresh({ ...options, providers: hostIds }) : undefined,
\t\t\townedIds.length ? models.refresh({ ...options, providers: ownedIds }) : undefined,
\t\t]);
\t\treturn {
\t\t\taborted: results.some((result) => result?.aborted) || (options.signal?.aborted ?? false),
\t\t\terrors: new Map(results.flatMap((result) => [...(result?.errors ?? [])])),
\t\t};
\t}

\tasync refresh(options: ModelsRefreshOptions = {}):`);
  replace(
    '\t\tthis.config = await ModelConfig.load(this.modelsPath);',
    '\t\tthis.synchronizeHostModels();\n\t\tthis.config = await ModelConfig.load(this.modelsPath);',
  );
  replace('await this.models.refresh(refreshOptions)', 'await this.refreshModels(refreshOptions)');
  return body;
}
