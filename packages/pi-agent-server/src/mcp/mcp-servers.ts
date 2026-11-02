/**
 * MCP server configuration and the servers extensions register with `pi.registerMcpServer()`.
 *
 * The core only validates and stores registrations. The MCP extension (built in, or another
 * extension that handles `mcp_servers_change`) connects them next to the servers from `mcp.json`.
 *
 * Vendored from @earendil-works/pi-coding-agent 1.1.0 core/tools/../core/mcp-servers.js.
 * Adapted to ignore inherited exposure overrides and reject invalid exposures.
 */

/** Where a tool of an MCP server is surfaced. */
export type McpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden';

/** One server entry of the `mcpServers` shape, after validation. */
export interface McpServerConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  auth?: { provider: string };
  oauth?: Record<string, unknown>;
  enabled?: boolean;
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
  description?: string;
  timeout?: number;
  [key: string]: unknown;
}

/** Where a configured server came from. */
export type McpServerScope = 'global' | 'project' | 'extension';

/** A server entry as the loader and runtime see it. */
export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  source?: string;
  scope: McpServerScope;
  /** Config file that overrode a global server, when this entry is an override. */
  override?: string;
}

/** Regular expression for a tool name pattern where `*` matches any characters, as `toolExposure`,
 * `--tools`, and `--exclude-tools` accept them. */
function toolPatternRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** Whether a tool name matches any of the entries, each an exact name or a pattern. */
export function createToolNameMatcher(entries: string[]): (name: string) => boolean {
  const names = new Set(entries.filter(entry => !entry.includes('*')));
  const patterns = entries.filter(entry => entry.includes('*')).map(toolPatternRegExp);
  return name => names.has(name) || patterns.some(pattern => pattern.test(name));
}

/** MCP resource tools, which reach every server with resources. */
export const LIST_MCP_RESOURCES_TOOL = 'list_mcp_resources';
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = 'list_mcp_resource_templates';
export const READ_MCP_RESOURCE_TOOL = 'read_mcp_resource';
const MCP_RESOURCE_TOOLS = new Set([
  LIST_MCP_RESOURCES_TOOL,
  LIST_MCP_RESOURCE_TEMPLATES_TOOL,
  READ_MCP_RESOURCE_TOOL,
]);

/** Whether a tool comes from MCP: a server tool (`mcp__<server>__<tool>`) or a resource tool. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__') || MCP_RESOURCE_TOOLS.has(name);
}

const MCP_EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden'];
/** Older exposure names, accepted in configs and replaced by their current name when validated. */
const MCP_EXPOSURE_ALIASES: Record<string, McpExposure> = { 'codemode-deferred': 'codemode' };
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Whether a redirect URI can be served by pi's loopback callback server. */
export function isLoopbackRedirectUri(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname) && url.search === '' && url.hash === '';
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** Namespace of a server's tools: `mcp__<server>` with `-` replaced by `_`, like the tool names. */
export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, '_')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}

function validateOAuth(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return 'oauth must be an object';
  if (value.clientId !== undefined && typeof value.clientId !== 'string') return 'oauth.clientId must be a string';
  if (value.clientSecret !== undefined && typeof value.clientSecret !== 'string') {
    return 'oauth.clientSecret must be a string';
  }
  const port = value.callbackPort;
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return 'oauth.callbackPort must be a port number';
  }
  if (value.callbackUrl !== undefined) {
    if (typeof value.callbackUrl !== 'string' || !isLoopbackRedirectUri(value.callbackUrl)) {
      return 'oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment';
    }
    const urlPort = new URL(value.callbackUrl).port;
    if (urlPort && port !== undefined && Number(urlPort) !== port) {
      return 'oauth.callbackUrl and oauth.callbackPort name different ports';
    }
  }
  if (value.scope !== undefined && typeof value.scope !== 'string') return 'oauth.scope must be a string';
  if (value.clientName !== undefined && (typeof value.clientName !== 'string' || !value.clientName.trim())) {
    return 'oauth.clientName must be a non-empty string';
  }
  if (value.clientRegistration !== undefined && value.clientRegistration !== 'dcr') {
    if (value.clientRegistration !== 'cimd') return 'oauth.clientRegistration must be "dcr" or "cimd"';
    if (value.clientId !== undefined || value.clientName !== undefined) {
      return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
    }
    const callback = typeof value.callbackUrl === 'string' ? new URL(value.callbackUrl) : undefined;
    if (callback && (callback.hostname === '[::1]' || callback.pathname !== '/callback')) {
      return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
    }
  }
  const metadataUrl = value.authServerMetadataUrl;
  if (metadataUrl !== undefined) {
    const url = typeof metadataUrl === 'string' && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
    if (!url || !(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)))) {
      return 'oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]';
    }
  }
  return undefined;
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === 'string' && (MCP_EXPOSURES as string[]).includes(value);
}

/** The exposure an alias stands for; other values are returned unchanged. */
function resolveExposureAlias(value: unknown): unknown {
  return typeof value === 'string' ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

/** A copy of the server entry with exposure aliases replaced by their current names. */
function resolveExposureAliases(value: Record<string, unknown>): Record<string, unknown> {
  const { exposure, toolExposure } = value;
  const resolved = { ...value };
  if (exposure !== undefined) resolved.exposure = resolveExposureAlias(exposure);
  if (isRecord(toolExposure)) {
    resolved.toolExposure = Object.fromEntries(
      Object.entries(toolExposure).map(([tool, entry]) => [tool, resolveExposureAlias(entry)]),
    );
  }
  return resolved;
}

/** Exposure of one tool of a server: its `toolExposure` entry, else the server's `exposure`. */
export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
  const overrides = config.toolExposure ?? {};
  if (Object.hasOwn(overrides, toolName)) {
    const exact = overrides[toolName];
    return isExposure(exact) ? exact : 'hidden';
  }
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes('*') && toolPatternRegExp(pattern).test(toolName)) {
      return isExposure(exposure) ? exposure : 'hidden';
    }
  }
  const exposure = config.exposure ?? 'codemode';
  return isExposure(exposure) ? exposure : 'hidden';
}

/**
 * Validate one server entry of the `mcpServers` shape. Returns a copy of the config with exposure
 * aliases resolved, or an error message.
 */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
  if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  if (!isRecord(raw)) return `server "${name}" must be an object`;
  const value = resolveExposureAliases(raw) as McpServerConfig;
  const { type, exposure, enabled, timeout, toolExposure, description } = value;
  const exposures = MCP_EXPOSURES.map(value => `"${value}"`).join(', ');
  if (exposure !== undefined && !isExposure(exposure)) {
    return `server "${name}": exposure must be one of ${exposures}`;
  }
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
    for (const [tool, entry] of Object.entries(toolExposure)) {
      if (!isExposure(entry)) return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
    }
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') return `server "${name}": enabled must be a boolean`;
  if (description !== undefined && typeof description !== 'string') {
    return `server "${name}": description must be a string`;
  }
  if (timeout !== undefined && (typeof timeout !== 'number' || !(timeout > 0))) {
    return `server "${name}": timeout must be a positive number of seconds`;
  }
  if (type === 'sse') return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
  if (typeof value.url === 'string' && (type === undefined || type === 'http' || type === 'streamable-http')) {
    if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
      return `server "${name}": url must be an http or https URL`;
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      return `server "${name}": headers must map names to strings`;
    }
    const oauthError = validateOAuth(value.oauth);
    if (oauthError) return `server "${name}": ${oauthError}`;
    if (value.auth !== undefined) {
      if (!isRecord(value.auth) || typeof value.auth.provider !== 'string' || !value.auth.provider) {
        return `server "${name}": auth.provider must be a provider name`;
      }
      const url = new URL(value.url);
      if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
        return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
      }
    }
    return value;
  }
  if (typeof value.command === 'string' && (type === undefined || type === 'stdio')) {
    if (
      value.args !== undefined &&
      !(Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string'))
    ) {
      return `server "${name}": args must be an array of strings`;
    }
    if (value.env !== undefined && !isStringRecord(value.env)) return `server "${name}": env must map names to strings`;
    if (value.cwd !== undefined && typeof value.cwd !== 'string') return `server "${name}": cwd must be a string`;
    return value;
  }
  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

/** A server a host extension registered, as `McpServerRegistry` stores it. */
export interface McpServerRegistration {
  name: string;
  config: McpServerConfig;
  extensionPath?: string;
}

/** Servers registered by the extensions of one runtime. */
export class McpServerRegistry {
  servers = new Map<string, McpServerRegistration>();
  changeListener: (() => void) | undefined;

  /** Register or replace a server. The caller checks ownership. */
  register(server: McpServerRegistration): void {
    this.servers.set(server.name, server);
    this.changeListener?.();
  }

  /** Remove a server registered by `extensionPath`. Servers of other extensions are left alone. */
  unregister(name: string, extensionPath: string): void {
    if (this.servers.get(name)?.extensionPath !== extensionPath) return;
    this.servers.delete(name);
    this.changeListener?.();
  }

  get(name: string): McpServerRegistration | undefined {
    return this.servers.get(name);
  }

  /** Copies of the registered servers, in registration order. */
  list(): McpServerRegistration[] {
    return [...this.servers.values()].map(server => ({ ...server, config: structuredClone(server.config) }));
  }

  /** Called after every change. The runner sets it when it binds, to emit `mcp_servers_change`. */
  setChangeListener(listener: () => void): void {
    this.changeListener = listener;
  }
}
