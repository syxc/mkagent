/** Host policy around the SDK's MCP configuration and tool naming algorithms. */
import {
  getMcpToolExposure as sdkToolExposure, validateMcpServerConfig as sdkValidate,
  type McpExposure, type McpHttpServerConfig, type McpServerConfig as SdkMcpServerConfig,
  type McpServerEntry as SdkMcpServerEntry, type McpStdioServerConfig,
} from '@mkagent/pi-durable-coding/mcp-servers';

export {
  LIST_MCP_RESOURCES_TOOL, LIST_MCP_RESOURCE_TEMPLATES_TOOL, READ_MCP_RESOURCE_TOOL, mcpNamespace,
} from '@mkagent/pi-durable-coding/mcp-servers';
export type { McpExposure } from '@mkagent/pi-durable-coding/mcp-servers';

/** Host overrides and transport dispatch allow partial entries of either SDK shape. */
export type McpServerConfig = Partial<Omit<McpStdioServerConfig, 'type'> & Omit<McpHttpServerConfig, 'type'>> & {
  type?: string;
  [key: string]: unknown;
};

export type McpServerScope = NonNullable<SdkMcpServerEntry['scope']>;
export interface McpServerEntry extends Omit<SdkMcpServerEntry, 'config' | 'scope' | 'source'> {
  config: McpServerConfig;
  source?: string;
  scope: McpServerScope;
}

/** Credentials may use plaintext HTTP only for loopback development servers. */
export function isSecureMcpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

function safeExposure(value: unknown): McpExposure {
  return value === 'codemode' || value === 'deferred' || value === 'direct' || value === 'hidden' ? value : 'hidden';
}

export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
  const overrides = config.toolExposure ?? {};
  if (Object.hasOwn(overrides, toolName)) return safeExposure(overrides[toolName]);
  // The SDK's exact lookup must not see Object.prototype or inherited overrides.
  const ownOverrides = { ...overrides };
  Object.setPrototypeOf(ownOverrides, null);
  const exposure = sdkToolExposure({ exposure: config.exposure, toolExposure: ownOverrides } as SdkMcpServerConfig, toolName);
  return safeExposure(exposure);
}

export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
  const value = sdkValidate(name, raw);
  if (typeof value === 'string') return value;
  const config = value as McpServerConfig;
  // The SDK validates OAuth fields; the host also restricts the credential destination.
  if (typeof config.url === 'string' && (config.type === undefined || config.type === 'http' || config.type === 'streamable-http')
    && config.oauth !== undefined && !isSecureMcpUrl(config.url)) {
    return `server "${name}": oauth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
  }
  return config;
}
