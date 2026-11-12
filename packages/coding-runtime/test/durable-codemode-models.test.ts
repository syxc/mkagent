import { describe, expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxProvider, type ClassifierContext, type ClassifierModel, type ImageModel } from '@earendil-works/pi-ai';
import { prepareCodemodeModelCall } from '@earendil-works/pi-durable/codemode';

const classifier: ClassifierModel<'local-classifier'> = {
  id: 'judge', name: 'Judge', type: 'classifier', provider: 'local', api: 'local-classifier',
  baseUrl: 'https://host.invalid', headers: { 'X-Test': 'host-value' }, input: ['text'], contextWindow: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const image: ImageModel<'local-image'> = {
  ...classifier, id: 'paint', name: 'Paint', type: 'image', api: 'local-image', output: ['image'],
};
const request: ClassifierContext = {
  state: { value: 1 }, questions: { valid: { type: 'bool', instructions: 'Check', criteria: { true: 'Yes', false: 'No' } } },
};
const usage = {
  input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixture() {
  const models = createModels();
  const seen: Array<{ model: unknown; context: unknown; signal: AbortSignal | undefined }> = [];
  models.setProvider({
    ...fauxProvider().provider, id: 'local', getModels: () => [], getAllModels: () => [classifier, image],
    classify: async (model, context, options) => {
      seen.push({ model, context, signal: options?.signal });
      return {
        api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop',
        answers: { valid: { type: 'bool', probability: 1 } }, usage,
      };
    },
    generateImages: async (model, context, options) => {
      seen.push({ model, context, signal: options?.signal });
      return {
        api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'error',
        output: [], errorMessage: 'local image failure', usage,
      };
    },
  });
  return { models, seen };
}

describe('shared codemode model preparation', () => {
  test('resolves the host model, retains the helper value and usage, and does no effect until execution', async () => {
    const { models, seen } = fixture();
    const prepared = prepareCodemodeModelCall('models.classify', {
      model: { provider: 'local', id: 'judge', baseUrl: 'https://script.invalid', headers: { 'X-Test': 'script-value' } },
      context: request,
    }, models);
    expect(prepared.model).toMatchObject({ baseUrl: classifier.baseUrl, headers: classifier.headers });
    expect(seen).toEqual([]);
    const result = await prepared.execute(BACKGROUND_CONTEXT);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toMatchObject({ baseUrl: classifier.baseUrl, headers: classifier.headers });
    expect(seen[0]!.context).toEqual(request);
    expect(result.isError).toBeUndefined();
    expect(result.structuredOutput).toMatchObject({ answers: { valid: { type: 'bool', probability: 1 } }, usage });
    expect(result.usage).toEqual(usage);
  });

  test('preserves image error values and accounting instead of discarding the structured result', async () => {
    const { models, seen } = fixture();
    const prepared = prepareCodemodeModelCall('models.generateImages', {
      model: image, context: { input: [{ type: 'text', text: 'A local fixture' }] },
    }, models);
    const result = await prepared.execute(BACKGROUND_CONTEXT);
    expect(seen).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.structuredOutput).toMatchObject({ output: [], stopReason: 'error', errorMessage: 'local image failure', usage });
    expect(result.usage).toEqual(usage);
  });

  test('validates model kind and context before a provider can run, with optional native documentation', () => {
    const { models, seen } = fixture();
    expect(() => prepareCodemodeModelCall('models.classify', { model: image, context: request }, models))
      .toThrow('"local/paint" is an image model, not a classifier model');
    for (const context of [null, {}, { state: [] }, { state: {}, questions: {} },
      { state: {}, questions: { q: { type: 'bool', instructions: 'Check', criteria: {} } } }]) {
      expect(() => prepareCodemodeModelCall('models.classify', { model: classifier, context }, models, { docsPath: '/docs/codemode.md' }))
        .toThrow('See "Classify" in /docs/codemode.md.');
    }
    expect(() => prepareCodemodeModelCall('models.generateImages', { model: image, context: { prompt: 'wrong' } }, models,
      { docsPath: '/docs/codemode.md' })).toThrow('See "Generate images" in /docs/codemode.md.');
    expect(() => prepareCodemodeModelCall('models.classify', { model: classifier, context: {} }, models))
      .toThrow('Expected context:');
    expect(seen).toEqual([]);
  });
});
