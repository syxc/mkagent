import { describe, expect, it } from 'bun:test';
import { createModelRuntime } from './model-runtime.ts';
import { resolveRuntimeMiniModel } from './runtime-models.ts';

describe('runtime model candidates', () => {
  it('does not reuse a removed custom mini model from the builtin provider catalog', async () => {
    const config = {
      model: 'pi/new-main', miniModel: 'pi/gpt-4.1-mini',
      baseUrl: 'http://fixture.invalid/v1', customEndpoint: { api: 'openai-completions' as const },
      customModels: ['new-main', 'new-mini'],
      piAuth: { provider: 'openai', credential: { type: 'api_key' as const, key: 'fixture' } },
    };
    const runtime = await createModelRuntime(config, () => {});
    expect(runtime.models.getModel('openai', 'gpt-4.1-mini')).toBeDefined();
    expect(resolveRuntimeMiniModel(runtime, config)).toBe('pi/new-mini');
  });

  for (const provider of [undefined, 'openai']) {
    for (const miniModel of ['old-mini', 'pi/old-mini', 'pi/missing-mini']) {
      for (const retain of [false, true]) it(`selects a usable mini model (${provider ?? 'keyless'}, ${miniModel}, retain=${retain})`, async () => {
        const config = {
          apiKey: 'fixture', model: 'pi/new-main', miniModel,
          baseUrl: 'http://fixture.invalid/v1', customEndpoint: { api: 'openai-completions' as const },
          customModels: ['new-main', 'new-mini', ...(retain ? ['old-mini'] : [])],
          ...(provider ? { piAuth: { provider, credential: { type: 'api_key' as const, key: 'fixture' } } } : {}),
        };
        const runtime = await createModelRuntime(config, () => {});
        expect(resolveRuntimeMiniModel(runtime, config)).toBe(retain && miniModel !== 'pi/missing-mini' ? miniModel : 'pi/new-mini');
      });
    }
  }

  it('rebuilds an isolated catalog while retaining the live credential store', async () => {
    const first = await createModelRuntime({}, () => {});
    await first.credentials.seed('fixture', { type: 'api_key', key: 'first' });
    const second = await createModelRuntime({
      baseUrl: 'http://fixture.invalid', customEndpoint: { api: 'openai-completions' }, customModels: ['candidate-only'],
    }, () => {}, first.credentials);
    await first.credentials.seed('fixture', { type: 'api_key', key: 'latest' });
    expect(second.credentials).toBe(first.credentials);
    await second.credentials.modify('fixture', async current => {
      expect(current).toEqual({ type: 'api_key', key: 'latest' });
      return current;
    });
    expect(first.models.getModel('custom-endpoint', 'candidate-only')).toBeUndefined();
    expect(second.models.getModel('custom-endpoint', 'candidate-only')).toBeDefined();
  });
});
