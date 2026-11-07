/** Synthetic native and compatibility providers. Never contacts a model or an auth service. */
import { writeFileSync } from 'node:fs';
import { createProvider, type Api, type Model } from '@earendil-works/pi-ai';
import type { ExtensionFactory } from '@mkagent/pi-durable-coding/native';

export const syntheticAccess = 'synthetic-provider-login-access';

export function providerLoginExtension(resultPath: string, mcpUrl?: string): ExtensionFactory {
  return pi => {
    let mode = 'normal';
    const model: Model<Api> = {
      id: 'fixture-model', provider: 'fixture-login', name: 'Fixture login', api: 'openai-completions',
      baseUrl: 'https://unused.invalid', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1024,
    };
    const stream = () => { throw new Error('Unexpected synthetic provider model request'); };
    pi.registerProvider(createProvider({
      id: 'fixture-login', name: 'Fixture provider', models: [model],
      api: { 'openai-completions': { stream, streamSimple: stream } },
      auth: {
        apiKey: {
          name: 'Fixture key',
          login: async interaction => ({
            type: 'api_key', key: await interaction.prompt({ type: 'secret', message: 'Fixture API key' }),
          }),
          resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined,
        },
        oauth: {
          name: 'Fixture OAuth',
          login: async interaction => {
            interaction.notify({ type: 'auth_url', url: 'https://unused.invalid/login', instructions: 'Fixture sign-in' });
            interaction.notify({ type: 'device_code', userCode: 'SYNTHETIC-CODE', verificationUri: 'https://unused.invalid/device' });
            interaction.notify({ type: 'info', message: 'Fixture account', links: [{ label: 'Help', url: 'https://unused.invalid/help' }] });
            const name = await interaction.prompt({ type: 'text', message: 'Fixture name' });
            const account = await interaction.prompt({ type: 'select', message: 'Fixture account',
              options: [{ id: 'first', label: 'Account', description: 'First account' },
                { id: 'second', label: 'Account', description: 'Second account' }] });
            const promptController = new AbortController();
            const manual = interaction.prompt({ type: 'manual_code', message: 'Fixture code', signal: promptController.signal });
            if (mode === 'callback') promptController.abort();
            const code = await manual.catch(error => {
              if (!promptController.signal.aborted) throw error;
              return 'callback';
            });
            const key = await interaction.prompt({ type: 'secret', message: 'Fixture secret' });
            if (mode === 'fail') throw new Error(key);
            if (mode === 'wait') {
              interaction.notify({ type: 'progress', message: 'Waiting for fixture callback' });
              await new Promise<void>((_resolve, reject) => {
                if (interaction.signal?.aborted) reject(interaction.signal.reason);
                else interaction.signal?.addEventListener('abort', () => reject(interaction.signal?.reason), { once: true });
              });
            }
            writeFileSync(resultPath, JSON.stringify({
              name: name === 'fixture-user', account, code: code === 'local-code' || code === 'callback',
              secret: key === syntheticAccess,
            }));
            return { type: 'oauth', access: key, refresh: 'synthetic-provider-login-refresh', expires: Number.MAX_SAFE_INTEGER };
          },
          refresh: async credential => credential,
          toAuth: async credential => ({ apiKey: credential.access }),
        },
      },
    }));
    pi.registerProvider('fixture-legacy', {
      api: 'openai-completions', baseUrl: 'https://unused.invalid', models: [{ ...model }],
      oauth: {
        name: 'Fixture legacy OAuth',
        login: async callbacks => {
          callbacks.onAuth({ url: 'https://unused.invalid/legacy', instructions: 'Legacy sign-in' });
          const code = await callbacks.onPrompt({ message: 'Legacy code' });
          if (code !== 'local-code') throw new Error('Invalid synthetic code');
          return { access: syntheticAccess, refresh: 'synthetic-provider-login-refresh', expires: Number.MAX_SAFE_INTEGER };
        },
        refreshToken: async credential => credential,
        getApiKey: credential => credential.access,
      },
    });
    if (mcpUrl) pi.registerMcpServer('provider-login', { url: mcpUrl, auth: { provider: 'fixture-login' }, exposure: 'direct' });
    pi.registerCommand('provider-mode', { handler: async args => { mode = args.trim(); } });
    pi.registerCommand('provider-reload', { handler: (_, ctx) => ctx.reload() });
    pi.registerCommand('provider-idle', { handler: (_, ctx) => ctx.waitForIdle() });
    pi.registerCommand('provider-probe', { handler: async (_, ctx) => {
      const selected = ctx.modelRegistry.find('fixture-login', 'fixture-model')!;
      writeFileSync(resultPath, JSON.stringify({
        authenticated: ctx.modelRegistry.getAvailable().some(model => model.provider === 'fixture-login'),
        oauth: ctx.modelRegistry.isUsingOAuth(selected),
        tools: pi.getAllTools().map(tool => tool.name),
      }));
    } });
  };
}
