/** Product credential, resource-status, and cancellation policies around the Coding SDK runtime. */
import { type AuthProvider, type McpClient, type McpTransport, type Resource, type ResourceTemplate } from '@earendil-works/pi-mcp';
import {
  McpServerConnection as SdkMcpServerConnection, createDefaultTransport as sdkTransport,
} from '@mkagent/coding-runtime/mcp-runtime';
import {
  McpOAuthAuthorizationRequiredError, createMcpAuthProvider,
  type McpAuthProvider, type McpOAuthCredentialStore, type McpOAuthSettings,
} from '@mkagent/coding-runtime/mcp-oauth';
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from '@mkagent/coding-runtime/mcp-config';
import type { McpServerLog } from '@mkagent/coding-runtime/mcp-log';
import type { McpServerEntry as SdkMcpServerEntry } from '@mkagent/coding-runtime/mcp-servers';
import { isMcpAppResource } from './resources.ts';
import { isSecureMcpUrl, type McpServerEntry } from './mcp-servers.ts';

export function createDefaultTransport(entry: McpServerEntry, cwd: string, authProvider?: AuthProvider): McpTransport {
  return sdkTransport(entry as SdkMcpServerEntry, cwd, authProvider, { resolveConfigValueOrThrow, resolveHeadersOrThrow });
}

/** Status surfaces include resource counts; failed lists do not prevent connection. */
async function fetchResources(client: McpClient): Promise<{ resources: Resource[]; resourceTemplates: ResourceTemplate[] }> {
  const [resources, resourceTemplates] = await Promise.all([
    client.listResources().catch(() => [] as Resource[]),
    client.listResourceTemplates().catch(() => [] as ResourceTemplate[]),
  ]);
  return {
    resources: resources.filter(resource => !isMcpAppResource(resource)),
    resourceTemplates: resourceTemplates.filter(template => !isMcpAppResource(template)),
  };
}

export interface McpServerConnectionOptions {
  entry: McpServerEntry;
  cwd: string;
  createTransport: typeof createDefaultTransport;
  credentials?: McpOAuthCredentialStore;
  /** Read the provider's current token on each request; MCP stores no copy. */
  providerToken?: (provider: string) => Promise<string | undefined>;
  onTools: (connection: McpServerConnection) => void;
  onChange: (connection: McpServerConnection) => void;
  log: McpServerLog | undefined;
  /** Client version reported to the server at `initialize`. */
  version: string;
}

export class McpServerConnection extends SdkMcpServerConnection {
  // The host permits partial config entries; SDK transport dispatch checks the URL at runtime.
  declare readonly entry: McpServerEntry & SdkMcpServerEntry;
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  private connecting = new AbortController();
  private signedOut = false;

  constructor(options: McpServerConnectionOptions) {
    super({
      entry: options.entry as SdkMcpServerEntry,
      cwd: options.cwd,
      createTransport: (entry, cwd, authProvider) => options.createTransport(entry as McpServerEntry, cwd, authProvider),
      authProvider: undefined,
      clientInfo: { name: 'mkagent', version: options.version },
      onTools: connection => options.onTools(connection as McpServerConnection),
      onChange: connection => options.onChange(connection as McpServerConnection),
      log: options.log,
    });
    const url = this.oauthUrl;
    const providerName = this.entry.scope !== 'project' && typeof this.entry.config.url === 'string'
      && isSecureMcpUrl(this.entry.config.url) ? this.entry.config.auth?.provider : undefined;
    const provider: McpAuthProvider | undefined = url && options.credentials ? createMcpAuthProvider({
      serverUrl: url,
      store: options.credentials.forServer(this.name, url),
      settings: () => this.oauthSettings(),
      onChallenge: challenge => { this.challenge = challenge; },
    }) : providerName ? {
      token: async () => options.providerToken?.(providerName),
      settled: async () => {},
    } : undefined;
    this.authProvider = provider ? {
      token: async () => {
        if (this.signedOut || this.closed) return undefined;
        const token = await provider.token();
        return this.signedOut || this.closed ? undefined : token;
      },
      ...(provider.onUnauthorized ? {
        onUnauthorized: async context => {
          if (this.signedOut || this.closed) throw new McpOAuthAuthorizationRequiredError();
          await provider.onUnauthorized?.(context);
        },
      } : {}),
      settled: () => provider.settled(),
    } : undefined;
  }

  protected override get connectSignal(): AbortSignal {
    return AbortSignal.any([super.connectSignal, this.connecting.signal]);
  }

  override get oauthUrl(): string | undefined {
    const url = this.entry.config.url;
    return typeof url === 'string' && isSecureMcpUrl(url) ? super.oauthUrl : undefined;
  }

  override oauthSettings(): McpOAuthSettings {
    const oauth = this.entry.config.oauth;
    if (!oauth) return {};
    return {
      ...oauth,
      clientSecret: oauth.clientSecret === undefined ? undefined
        : resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.name}" oauth.clientSecret`),
      authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
    };
  }

  override getClient(): Promise<McpClient> {
    if (!this.opening && this.client?.connectionState !== 'connected') this.connecting = new AbortController();
    return super.getClient();
  }

  /** Reconnect commands can cancel setup without permanently closing this server. */
  override async reconnect(signal?: AbortSignal): Promise<void> {
    const cancel = () => this.connecting.abort();
    signal?.throwIfAborted();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.opening?.catch(() => undefined);
      signal?.throwIfAborted();
      if (this.client) await this.dropClient(this.client);
      signal?.throwIfAborted();
      this.signedOut = false;
      await this.getClient();
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  /** Wait for token rotation before the caller removes the stored grant. */
  override async signOut(): Promise<void> {
    this.signedOut = true;
    if (!this.closed) this.markNeedsAuth();
    await this.opening?.catch(() => undefined);
    if (this.client) await this.dropClient(this.client);
    await this.authProvider?.settled();
    if (!this.closed) this.markNeedsAuth();
  }

  protected override signInRequiredMessage(): string {
    if (this.entry.config.auth?.provider) {
      return `MCP server "${this.name}" requires credentials for provider "${this.entry.config.auth.provider}". Check the provider's credentials, then use /mcp reconnect ${this.name}`;
    }
    return `MCP server "${this.name}" requires OAuth sign-in. Use /mcp login ${this.name}`;
  }

  protected override markNeedsAuth(): void {
    this.state = 'needs-auth';
    this.error = undefined;
    this.tools = [];
    this.hasResources = false;
    this.resources = [];
    this.resourceTemplates = [];
    this.instructions = undefined;
    this.onTools(this);
    super.markNeedsAuth();
  }

  protected override async prepareConnection(client: McpClient): Promise<() => void> {
    client.onNotification('notifications/resources/list_changed', () => { void this.refreshResources(client); });
    const snapshot = client.serverCapabilities?.resources ? await fetchResources(client) : { resources: [], resourceTemplates: [] };
    return () => {
      if (this.signedOut) throw new McpOAuthAuthorizationRequiredError();
      this.resources = snapshot.resources;
      this.resourceTemplates = snapshot.resourceTemplates;
    };
  }

  private async refreshResources(client: McpClient): Promise<void> {
    const snapshot = await fetchResources(client);
    if (this.client !== client || this.closed) return;
    this.resources = snapshot.resources;
    this.resourceTemplates = snapshot.resourceTemplates;
    this.onTools(this);
    this.changed();
  }
}
