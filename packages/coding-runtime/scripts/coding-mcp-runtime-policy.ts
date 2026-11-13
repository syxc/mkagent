/** Expose connection policy hooks without maintaining the SDK's connection algorithm. */
export function codingMcpRuntimePolicy(source: string, declaration: boolean): string {
  const replace = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error('Published MCP runtime boundary changed: ' + before);
    source = source.replace(before, after);
  };
  if (declaration) {
    replace('authProvider: AuthProvider | undefined): McpTransport;', `authProvider: AuthProvider | undefined, dependencies?: {
    resolveConfigValueOrThrow?: typeof import("../../core/resolve-config-value.ts").resolveConfigValueOrThrow;
    resolveHeadersOrThrow?: typeof import("../../core/resolve-config-value.ts").resolveHeadersOrThrow;
}): McpTransport;`);
    replace('private client;', 'client: McpClient | undefined;');
    replace('private opening;', 'protected opening: Promise<McpClient> | undefined;');
    replace('private readonly onTools;', 'protected readonly onTools: (connection: McpServerConnection) => void;');
    replace('private readonly authProvider;', 'authProvider: import("./oauth.ts").McpAuthProvider | undefined;');
    replace('private get closed();', 'get closed(): boolean;');
    replace('private markNeedsAuth;', 'protected markNeedsAuth(): void;');
    replace('private changed;', 'protected changed(): void;');
    replace('private dropClient;', 'protected dropClient(client: McpClient): Promise<void>;');
    replace('credentials: McpOAuthCredentialStore;', `credentials?: McpOAuthCredentialStore;
        /** An own property overrides the default credential binding, including undefined. */
        authProvider?: import("./oauth.ts").McpAuthProvider;
        clientInfo?: { name: string; version: string };`);
    replace('    get name(): string;', `    private readonly clientInfo;
    protected get connectSignal(): AbortSignal;
    protected signInRequiredMessage(): string;
    /** Prepare discovery and return a synchronous commit, run only after setup remains valid. */
    protected prepareConnection(client: McpClient): Promise<() => void>;
    get name(): string;`);
    return source;
  }
  replace('createDefaultTransport(entry, cwd, authProvider) {', 'createDefaultTransport(entry, cwd, authProvider, dependencies = {}) {');
  replace('if ("url" in config) {', 'if (typeof config.url === "string") {');
  replace('headers: resolveHeadersOrThrow(config.headers,', 'headers: (dependencies.resolveHeadersOrThrow ?? resolveHeadersOrThrow)(config.headers,');
  replace('env[key] = resolveConfigValueOrThrow(value,', 'env[key] = (dependencies.resolveConfigValueOrThrow ?? resolveConfigValueOrThrow)(value,');
  replace('    authProvider;\n', '    authProvider;\n    clientInfo;\n');
  replace('        const url = this.oauthUrl;', `        this.clientInfo = options.clientInfo ?? { name: "pi", version: VERSION };
        if (Object.hasOwn(options, "authProvider")) {
            this.authProvider = options.authProvider;
            return;
        }
        const url = this.oauthUrl;`);
  replace('this.authProvider = url\n', 'this.authProvider = url && options.credentials\n');
  replace('    get name() {', `    get connectSignal() { return this.shutdown.signal; }
    signInRequiredMessage() { return signInRequiredMessage(this.entry); }
    async prepareConnection(_client) { return () => {}; }
    get name() {`);
  if (source.split('signInRequiredMessage(this.entry)').length !== 4) throw new Error('Published MCP sign-in call sites changed');
  // Leave the default hook's call to the upstream message formatter intact.
  source = source.replaceAll('new Error(signInRequiredMessage(this.entry))', 'new Error(this.signInRequiredMessage())');
  replace('        const retries = "url" in this.entry.config', '        const signal = this.connectSignal;\n        const retries = "url" in this.entry.config');
  replace('if (this.closed || delay === undefined', 'if (signal.aborted || delay === undefined');
  replace('await sleep(delay, undefined, { signal: this.shutdown.signal })', 'await sleep(delay, undefined, { signal })');
  replace('                if (this.closed)\n', '                if (signal.aborted)\n');
  replace('    async connectOnce() {', '    async connectOnce() {\n        const signal = this.connectSignal;');
  replace('            name: "pi",\n            version: VERSION,', '            ...this.clientInfo,');
  replace('this.shutdown.signal.addEventListener("abort", closeClient', 'signal.addEventListener("abort", closeClient');
  replace('this.shutdown.signal.removeEventListener("abort", closeClient', 'signal.removeEventListener("abort", closeClient');
  replace('            const tools = client.serverCapabilities?.tools ? await client.listTools() : [];', `            const [tools, commit] = await Promise.all([
                client.serverCapabilities?.tools ? client.listTools() : [],
                this.prepareConnection(client),
            ]);`);
  replace('            if (this.closed)\n', '            if (signal.aborted)\n');
  replace('            this.client = client;', '            commit();\n            this.client = client;');
  return source;
}
