import { CLOUDFLARE_AI_GATEWAY_PROVIDER, parseCloudflareGatewayUrl } from '../../shared/src/config/cloudflare-gateway.ts';

/**
 * Environment the Pi SDK reads a tenant-specific endpoint from, derived from the
 * connection's base URL (Pi provider ids, after `toPiProviderId`):
 *
 * - `azure`: AZURE_OPENAI_BASE_URL.
 * - `cloudflare-ai-gateway`: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_GATEWAY_ID, which the
 *   SDK substitutes into every gateway model URL.
 *
 * Empty for other providers or an unusable URL.
 */
export function providerEndpointEnv(provider: string | undefined, baseUrl: string | undefined): Record<string, string> {
  const url = baseUrl?.trim();
  if (!provider || !url) return {};
  if (provider === 'azure') {
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) return {};
      return { AZURE_OPENAI_BASE_URL: url };
    } catch { return {}; }
  }
  if (provider === CLOUDFLARE_AI_GATEWAY_PROVIDER) {
    const ids = parseCloudflareGatewayUrl(url);
    return ids ? { CLOUDFLARE_ACCOUNT_ID: ids.accountId, CLOUDFLARE_GATEWAY_ID: ids.gatewayId } : {};
  }
  return {};
}

/** Remove only endpoint values previously installed by this subprocess. */
export class ProviderEndpointEnvironment {
  private managed = new Set<string>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  apply(values: Record<string, string>): void {
    for (const key of this.managed) {
      if (!Object.hasOwn(values, key)) delete this.env[key];
    }
    for (const [key, value] of Object.entries(values)) this.env[key] = value;
    this.managed = new Set(Object.keys(values));
  }
}
