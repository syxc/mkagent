/** Reuse SDK configuration loading and keep MCP commands on the platform default shell. */
export { loadMcpConfig } from '@earendil-works/pi-coding-agent';
import { resolveConfigValueOrThrow as resolveValue, resolveHeadersOrThrow as resolveHeaders } from '@earendil-works/pi-coding-agent';

export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
  return resolveValue(config, description, env, { shell: 'default' });
}

export function resolveHeadersOrThrow(headers: Record<string, string> | undefined, description: string, env?: Record<string, string>): Record<string, string> | undefined {
  return resolveHeaders(headers, description, env, { shell: 'default' });
}
