import { describe, expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { adaptCredentialForPiSdk } from './adapt-credential.ts';

/** Models collection backed by a store holding the adapted credential (null adaptations store nothing). */
async function modelsWithAdaptedCredential(
  provider: string,
  credential: Parameters<typeof adaptCredentialForPiSdk>[1],
) {
  const credentials = new InMemoryCredentialStore();
  const adapted = adaptCredentialForPiSdk(provider, credential);
  if (adapted) {
    await credentials.modify(provider, async () => adapted);
  }
  return builtinModels({ credentials });
}

/**
 * These tests run against the real Pi SDK provider catalog on purpose: they pin
 * the auth-handler contract the adaptation depends on. If an SDK bump changes
 * which providers are OAuth-only, a failure here says the adaptation rules (not
 * the SDK) need a second look.
 */
describe('adaptCredentialForPiSdk', () => {
  it('rewraps a ChatGPT Plus bearer token as an oauth credential for openai-codex (OAuth-only provider)', () => {
    const adapted = adaptCredentialForPiSdk('openai-codex', { type: 'api_key', key: 'chatgpt-jwt' });
    expect(adapted).toEqual({
      type: 'oauth',
      access: 'chatgpt-jwt',
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
    });
  });

  it('keeps the rewrapped expiry ahead of the SDK refresh check so pi never self-refreshes', () => {
    const adapted = adaptCredentialForPiSdk('openai-codex', { type: 'api_key', key: 'chatgpt-jwt' });
    // resolveStoredOAuth refreshes when Date.now() >= expires; the main process
    // owns refresh (token_update), so this must never trigger.
    expect(adapted.type).toBe('oauth');
    if (adapted.type === 'oauth') {
      expect(Date.now()).toBeLessThan(adapted.expires);
    }
  });

  it('passes anthropic api_key credentials through unchanged (Claude Max bearer resolves via envApiKeyAuth)', () => {
    const credential = { type: 'api_key' as const, key: 'sk-ant-oat-token' };
    expect(adaptCredentialForPiSdk('anthropic', credential)).toEqual(credential);
  });

  it('passes plain API key credentials through for providers with an apiKey handler', () => {
    const credential = { type: 'api_key' as const, key: 'sk-real-api-key' };
    expect(adaptCredentialForPiSdk('openai', credential)).toEqual(credential);
    expect(adaptCredentialForPiSdk('moonshotai', credential)).toEqual(credential);
  });

  it('passes canonical OAuth credentials through unchanged', () => {
    const credential = {
      type: 'oauth' as const,
      access: 'oauth-access-token',
      refresh: 'oauth-refresh-token',
      expires: 1234567890,
    };
    expect(adaptCredentialForPiSdk('anthropic', credential)).toEqual(credential);
  });

  it('returns null for iam credentials so bedrock resolves ambiently from AWS env vars', () => {
    // A stored credential shadows ambient resolution in pi SDK ≥0.81, and 'iam'
    // matches no SDK handler — storing it makes the provider unconfigured.
    const credential = {
      type: 'iam' as const,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      region: 'eu-west-1',
    };
    expect(adaptCredentialForPiSdk('amazon-bedrock', credential)).toBeNull();
  });

  it('passes api_key through for unknown providers (custom endpoints are not in the builtin catalog)', () => {
    const credential = { type: 'api_key' as const, key: 'whatever' };
    expect(adaptCredentialForPiSdk('custom-endpoint', credential)).toEqual(credential);
  });
});

/**
 * End-to-end resolution through the real SDK Models collection — the exact
 * checks the agent-session prompt preflight and request-auth paths perform.
 * These are the assertions that would have caught the 0.81.1 breakage before release.
 */
describe('adapted credentials resolve through the Pi SDK Models collection', () => {
  it('openai-codex: adapted bearer token authenticates and models become available', async () => {
    const models = await modelsWithAdaptedCredential('openai-codex', { type: 'api_key', key: 'chatgpt-jwt' });
    const auth = await models.getAuth('openai-codex');
    expect(auth?.auth.apiKey).toBe('chatgpt-jwt');
    expect(await models.checkAuth('openai-codex')).toMatchObject({ type: 'oauth' });
    expect((await models.getAvailable('openai-codex')).length).toBeGreaterThan(0);
  });

  it('amazon-bedrock: iam credential is not stored, so ambient AWS env vars keep resolving', async () => {
    const priorAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const priorSecret = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    try {
      const models = await modelsWithAdaptedCredential('amazon-bedrock', {
        type: 'iam',
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'test-secret',
        region: 'eu-west-1',
      });
      // Storing the iam credential verbatim would flip these to undefined/empty
      // (a stored credential shadows ambient resolution in pi SDK ≥0.81).
      expect(await models.checkAuth('amazon-bedrock')).toBeDefined();
      expect((await models.getAvailable('amazon-bedrock')).length).toBeGreaterThan(0);
    } finally {
      if (priorAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = priorAccessKey;
      if (priorSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = priorSecret;
    }
  });
});
