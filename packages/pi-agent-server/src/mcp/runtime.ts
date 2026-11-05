/**
 * The part of the MCP integration that talks to servers: connections and transports. It pulls in
 * the MCP client, so only sessions with a configured server pay for it.
 *
 * Vendored from @earendil-works/pi-coding-agent 1.1.0 extensions/mcp/runtime.js — reconnect,
 * backoff, and logging behavior follow upstream. OAuth uses the pinned 1.5.0 provider, while
 * interactive sign-in is owned by the host and never starts from an automatic connection.
 */
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  JSON_RPC_ERROR_CODES,
  McpAuthRequiredError,
  McpClient,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  StdioTransport,
  StreamableHttpTransport,
  type McpTransport,
  type Resource,
  type ResourceTemplate,
  type Tool as McpTool,
} from '@earendil-works/pi-mcp';
import {
  McpOAuthAuthorizationRequiredError, createMcpAuthProvider,
  type McpAuthProvider, type McpOAuthCredentialStore, type McpOAuthSettings, type OAuthChallenge,
} from '@mkagent/pi-durable-coding/mcp-oauth';
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from './resolve-config-value.ts';
import { isMcpAppResource } from './resources.ts';
import { McpServerLog } from './log.ts';
import { isSecureMcpUrl, type McpServerEntry } from './mcp-servers.ts';

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
/** Delays between attempts to connect to an HTTP server that failed with a transient error. */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Network failures and overloaded or restarting servers, which are worth another attempt. */
function isTransientError(error: unknown): boolean {
  if (error instanceof McpHttpError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
  }
  return error instanceof TypeError;
}

function signInRequiredMessage(entry: McpServerEntry): string {
  return `MCP server "${entry.name}" requires OAuth sign-in. Use /mcp login ${entry.name}`;
}

/** HTTP servers authenticate with OAuth unless the config supplies an `Authorization` header or `auth`. */
function usesOAuth(entry: McpServerEntry): boolean {
  const { config } = entry;
  if (typeof config.url !== 'string' || !isSecureMcpUrl(config.url) || config.auth) return false;
  return !Object.keys(config.headers ?? {}).some(header => header.toLowerCase() === 'authorization');
}

/** `~` and `~/…` (also `~\…` on Windows) name the home directory, like in a shell. */
function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function createDefaultTransport(entry: McpServerEntry, cwd: string, authProvider?: McpAuthProvider): McpTransport {
  const { config, name } = entry;
  if ('url' in config && typeof config.url === 'string') {
    return new StreamableHttpTransport({
      url: config.url,
      headers: resolveHeadersOrThrow(config.headers as Record<string, string> | undefined, `MCP server "${name}"`),
      authProvider,
    });
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries((config.env as Record<string, string> | undefined) ?? {})) {
    env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
  }
  return new StdioTransport({
    command: expandHome(config.command as string),
    args: (config.args as string[] | undefined)?.map(expandHome),
    cwd: resolve(cwd, expandHome((config.cwd as string | undefined) ?? '.')),
    env,
    stderr: 'pipe',
  });
}

/** Servers that do not implement `resources/templates/list` have no templates. */
async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await list();
  } catch (error) {
    if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
    throw error;
  }
}

function listTemplates(client: McpClient, options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
  return withoutTemplates(() => client.listResourceTemplates(options), []);
}

/**
 * Resources and templates at connect time, for the counts in server status surfaces. A server whose
 * lists fail still connects: the resource tools list and read its resources on demand.
 */
async function fetchResources(client: McpClient): Promise<{ resources: Resource[]; resourceTemplates: ResourceTemplate[] }> {
  const [resources, resourceTemplates] = await Promise.all([
    client.listResources().catch(() => [] as Resource[]),
    listTemplates(client).catch(() => [] as ResourceTemplate[]),
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
  onTools: (connection: McpServerConnection) => void;
  onChange: (connection: McpServerConnection) => void;
  log: McpServerLog | undefined;
  /** Client version reported to the server at `initialize`. */
  version: string;
}

type McpRequestOptions = import('@earendil-works/pi-mcp').McpRequestOptions;

/** One configured server. Reconnects lazily when a call finds the connection gone. */
export class McpServerConnection {
  entry: McpServerEntry;
  state: 'connecting' | 'connected' | 'disconnected' | 'failed' | 'needs-auth' | 'closed' = 'connecting';
  error: string | undefined;
  tools: McpTool[] = [];
  /**
   * Whether the server offers resources. The lists below are what it listed at the last connect or
   * change, without MCP App resources.
   */
  hasResources = false;
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  /** Server instructions from `initialize`, describing its tools as a group. */
  instructions: string | undefined;
  client: McpClient | undefined;
  opening: Promise<McpClient> | undefined;
  private connecting = new AbortController();
  /** Aborted by `close()`; cancels a connect in progress, including the wait between retries. */
  shutdown = new AbortController();
  /** Stderr of the last stdio server that failed to connect. */
  stderrTail: string | undefined;
  cwd: string;
  createTransport: typeof createDefaultTransport;
  authProvider: McpAuthProvider | undefined;
  private signedOut = false;
  challenge: OAuthChallenge | undefined;
  onTools: (connection: McpServerConnection) => void;
  onChange: (connection: McpServerConnection) => void;
  log: McpServerLog | undefined;
  version: string;

  constructor(options: McpServerConnectionOptions) {
    this.entry = options.entry;
    this.cwd = options.cwd;
    this.createTransport = options.createTransport;
    this.onTools = options.onTools;
    this.onChange = options.onChange;
    this.log = options.log;
    this.version = options.version;
    const url = this.oauthUrl;
    const provider = url && options.credentials ? createMcpAuthProvider({
      serverUrl: url,
      store: options.credentials.forServer(this.name, url),
      settings: () => this.oauthSettings(),
      onChallenge: challenge => { this.challenge = challenge; },
    }) : undefined;
    this.authProvider = provider ? {
      token: async () => {
        if (this.signedOut) return undefined;
        const token = await provider.token();
        return this.signedOut ? undefined : token;
      },
      onUnauthorized: async context => {
        if (this.signedOut) throw new McpOAuthAuthorizationRequiredError();
        await provider.onUnauthorized?.(context);
      },
      settled: () => provider.settled(),
    } : undefined;
  }

  get name(): string {
    return this.entry.name;
  }

  get closed(): boolean {
    return this.shutdown.signal.aborted;
  }

  get timeoutMs(): number {
    return ((this.entry.config.timeout as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  get oauthUrl(): string | undefined {
    return usesOAuth(this.entry) ? this.entry.config.url : undefined;
  }

  oauthSettings(): McpOAuthSettings {
    const oauth = this.entry.config.oauth;
    if (!oauth) return {};
    return {
      ...oauth,
      clientSecret: oauth.clientSecret === undefined ? undefined
        : resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.name}" oauth.clientSecret`),
      authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
    };
  }

  getClient(): Promise<McpClient> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
    if (this.client?.connectionState === 'connected') return Promise.resolve(this.client);
    if (!this.opening) {
      this.connecting = new AbortController();
      this.opening = this.open().finally(() => { this.opening = undefined; });
    }
    return this.opening;
  }

  callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions) {
    return this.withClient(client => client.callTool(name, args, options));
  }

  readResource(uri: string, options: McpRequestOptions) {
    return this.withClient(client => client.readResource(uri, options), true);
  }

  resourcesPage(cursor: string | undefined, options: McpRequestOptions) {
    return this.withClient(client => client.listResourcesPage(cursor, options), true);
  }

  resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions) {
    return this.withClient(
      client =>
        withoutTemplates(() => client.listResourceTemplatesPage(cursor, options), {
          resourceTemplates: [] as ResourceTemplate[],
        }),
      true,
    );
  }

  allResources(options: McpRequestOptions) {
    return this.withClient(client => client.listResources(options), true);
  }

  allResourceTemplates(options: McpRequestOptions) {
    return this.withClient(client => listTemplates(client, options), true);
  }

  /**
   * Run a request, reconnecting when needed. `readOnly` requests are retried once after a transient
   * HTTP error; tool calls are not, since they may have run.
   */
  async withClient<T>(run: (client: McpClient) => Promise<T>, readOnly = false): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.getClient();
      try {
        return await run(client);
      } catch (error) {
        if (readOnly && attempt === 1 && error instanceof McpHttpError && isTransientError(error)) {
          await new Promise(resolve => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[0]));
          continue;
        }
        if (error instanceof McpSessionExpiredError && attempt === 1) {
          // The server no longer knows the session (restart, deploy), so it did not run the request.
          // Retry once on a new session. The old client is detached but not closed: closing would
          // fail its other in-flight calls, which instead get the same 404 and retry the same way.
          if (this.client === client) this.client = undefined;
          continue;
        }
        if (!this.needsSignIn(error)) throw error;
        await this.dropClient(client);
        this.markNeedsAuth();
        throw new Error(signInRequiredMessage(this.entry));
      }
    }
  }

  /** Connect again, for example after the server restarted. */
  async reconnect(signal?: AbortSignal): Promise<void> {
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

  /** Wait for any token rotation before the caller removes the stored grant. */
  async signOut(): Promise<void> {
    this.signedOut = true;
    if (!this.closed) this.markNeedsAuth();
    await this.opening?.catch(() => undefined);
    if (this.client) await this.dropClient(this.client);
    await this.authProvider?.settled();
    if (!this.closed) this.markNeedsAuth();
  }

  /** A 401 after refresh, or a scope challenge, needs explicit user sign-in. */
  needsSignIn(error: unknown): boolean {
    return error instanceof McpOAuthAuthorizationRequiredError
      || (this.authProvider !== undefined && error instanceof McpAuthRequiredError);
  }

  markNeedsAuth(): void {
    this.state = 'needs-auth';
    this.error = undefined;
    this.tools = [];
    this.hasResources = false;
    this.resources = [];
    this.resourceTemplates = [];
    this.instructions = undefined;
    this.onTools(this);
    this.changed();
  }

  changed(): void {
    this.onChange?.(this);
  }

  async dropClient(client: McpClient): Promise<void> {
    if (this.client === client) this.client = undefined;
    await client.close().catch(() => undefined);
  }

  async open(): Promise<McpClient> {
    this.state = 'connecting';
    this.changed();
    const retries = 'url' in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];
    for (let attempt = 0; ; attempt++) {
      this.stderrTail = undefined;
      try {
        return await this.connectOnce();
      } catch (error) {
        const delay = retries[attempt];
        if (this.closed || this.connecting.signal.aborted || delay === undefined || !isTransientError(error)) {
          throw this.connectFailed(error);
        }
        await sleep(delay, undefined, {
          signal: AbortSignal.any([this.shutdown.signal, this.connecting.signal]),
        }).catch(() => undefined);
        if (this.closed || this.connecting.signal.aborted) throw this.connectFailed(error);
      }
    }
  }

  async connectOnce(): Promise<McpClient> {
    const client = new McpClient({
      name: 'mkagent',
      version: this.version,
      requestTimeoutMs: this.timeoutMs,
      roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
    });
    const log = this.log;
    if (log) client.onNotification('notifications/message', params => log.write(this.entry.name, params));
    // Closing the client fails its pending initialize or discovery requests and closes the transport.
    // Memoized: a second `client.close()` returns before the first finished closing the transport.
    let closing: Promise<void> | undefined;
    const closeClient = () => {
      closing ??= client.close().catch(() => undefined);
      return closing;
    };
    this.shutdown.signal.addEventListener('abort', closeClient, { once: true });
    this.connecting.signal.addEventListener('abort', closeClient, { once: true });
    let transport: McpTransport | undefined;
    try {
      transport = this.createTransport(this.entry, this.cwd, this.authProvider);
      await client.connect(transport);
      client.onNotification('notifications/tools/list_changed', () => {
        void this.refreshTools(client);
      });
      client.onNotification('notifications/resources/list_changed', () => {
        void this.refreshResources(client);
      });
      const stdio = transport instanceof StdioTransport ? transport : undefined;
      client.onClose(() => this.handleClientClose(client, stdio));
      // Servers without the tools capability (prompts or resources only) do not answer tools/list.
      const hasResources = client.serverCapabilities?.resources !== undefined;
      const [tools, resources] = await Promise.all([
        client.serverCapabilities?.tools ? client.listTools() : Promise.resolve([] as McpTool[]),
        hasResources ? fetchResources(client) : { resources: [], resourceTemplates: [] },
      ]);
      if (this.closed || this.connecting.signal.aborted) throw new Error('cancelled while connecting');
      if (this.signedOut) throw new McpOAuthAuthorizationRequiredError();
      if (client.connectionState !== 'connected') throw new Error('connection closed during setup');
      this.client = client;
      this.tools = tools;
      this.hasResources = hasResources;
      this.resources = resources.resources;
      this.resourceTemplates = resources.resourceTemplates;
      this.instructions = client.instructions?.trim() || undefined;
      this.state = 'connected';
      this.error = undefined;
      this.onTools(this);
      this.changed();
      return client;
    } catch (error) {
      await closeClient();
      if (transport instanceof StdioTransport) {
        this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
      }
      throw error;
    } finally {
      this.shutdown.signal.removeEventListener('abort', closeClient);
      this.connecting.signal.removeEventListener('abort', closeClient);
    }
  }

  connectFailed(error: unknown): Error {
    if (this.needsSignIn(error) && !this.closed) {
      this.markNeedsAuth();
      return new Error(signInRequiredMessage(this.entry));
    }
    this.state = this.closed ? 'closed' : 'failed';
    this.error = this.stderrTail ? `${errorMessage(error)}\n${this.stderrTail}` : errorMessage(error);
    this.changed();
    return new Error(`MCP server "${this.entry.name}" failed to connect: ${this.error}`);
  }

  /** The transport dropped. The next call reconnects; until then the status shows why. */
  handleClientClose(client: McpClient, stdio: StdioTransport | undefined): void {
    if (this.client !== client || this.closed) return;
    this.client = undefined;
    this.state = 'disconnected';
    const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
    this.error = stderr ? `Connection closed\n${stderr}` : 'Connection closed';
    this.changed();
  }

  async refreshTools(client: McpClient): Promise<void> {
    try {
      const tools = await client.listTools();
      if (this.client !== client || this.closed) return;
      this.tools = tools;
      this.onTools(this);
    } catch (error) {
      this.error = `Failed to refresh tools: ${errorMessage(error)}`;
    }
    this.changed();
  }

  async refreshResources(client: McpClient): Promise<void> {
    const { resources, resourceTemplates } = await fetchResources(client);
    if (this.client !== client || this.closed) return;
    this.resources = resources;
    this.resourceTemplates = resourceTemplates;
    this.onTools(this);
    this.changed();
  }

  /** Resolves once no transport of this server is open, including one that was still connecting. */
  async close(): Promise<void> {
    this.shutdown.abort();
    this.state = 'closed';
    this.changed();
    const client = this.client;
    this.client = undefined;
    await Promise.all([client?.close().catch(() => undefined), this.opening?.catch(() => undefined)]);
    // A completed refresh can rotate its token even after the transport was closed.
    await this.authProvider?.settled();
  }
}
