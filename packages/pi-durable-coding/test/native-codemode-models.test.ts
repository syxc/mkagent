import { describe, expect, test } from 'bun:test';
import { createModels, fauxProvider, type ClassifierModel, type ImageModel, type Models } from '@earendil-works/pi-ai';
import type { ExtensionToolContext } from '../src/pi/core/extensions/types.ts';
import {
  CODEMODE_DOCS_PATH, createCodemodeToolDefinition, type CodemodeToolDetails,
} from '../src/pi/extensions/codemode/tool.ts';

const model: ClassifierModel<'local-classifier'> = {
  id: 'judge', name: 'Judge', type: 'classifier', provider: 'local', api: 'local-classifier',
  baseUrl: 'https://host.invalid', input: ['text'], contextWindow: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const imageModel: ImageModel<'local-image'> = { ...model, id: 'paint', type: 'image', api: 'local-image', output: ['image'] };
const usage = {
  input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const contextCode = '{state:{value:1},questions:{valid:{type:"bool",instructions:"private fixture question",criteria:{true:"Yes",false:"No"}}}}';
const callCode = `models.classify({provider:"local",id:"judge",baseUrl:"https://script.invalid"},${contextCode})`;

function fixture(classify: Models['classify']) {
  const models = createModels();
  models.setProvider({ ...fauxProvider().provider, id: 'local', getModels: () => [], getAllModels: () => [model, imageModel] });
  models.classify = classify;
  // The script uses only the model service; no AgentSession, credential runtime, or native task is fabricated.
  const ctx = {
    tools: [], modelRegistry: models, sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionToolContext;
  return { models, ctx, tool: createCodemodeToolDefinition({ models: true }) };
}

function value(probability: number) {
  return {
    api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop' as const,
    answers: { valid: { type: 'bool' as const, probability } }, usage,
  };
}

describe('native codemode definition with shared model preparation', () => {
  test('image helpers retain structured error values, image counts, usage and receiver binding', async () => {
    const opened = fixture(async () => value(1));
    opened.models.generateImages = async function (resolved, context, options) {
      expect(this).toBe(opened.models);
      expect(resolved.baseUrl).toBe(imageModel.baseUrl);
      expect(context.input).toEqual([{ type: 'text', text: 'private fixture prompt' }]);
      expect(Object.keys(options ?? {})).toEqual(['signal']);
      return {
        api: resolved.api, model: resolved.id, provider: resolved.provider, timestamp: 1,
        output: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
        stopReason: 'error', errorMessage: 'fixture image failure', usage,
      };
    };
    const result = await opened.tool.execute('native-image', {
      code: 'return (await models.generateImages({provider:"local",id:"paint"},{input:[{type:"text",text:"private fixture prompt"}]})).stopReason;',
    }, undefined, undefined, opened.ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content.some(block => block.type === 'text' && block.text.includes('1 image'))).toBe(true);
    expect(result.details?.calls).toMatchObject([{
      id: 'native-image/models.generateImages/1', args: 'local/paint', status: 'error', error: 'fixture image failure',
    }]);
    expect(JSON.stringify(result.details)).not.toContain('private fixture prompt');
    expect(result.usage?.totalTokens).toBe(usage.totalTokens);
  }, 6000);

  test('six rows appear while four providers run, without prompt previews or duplicate usage', async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let ready!: () => void;
    const allRows = new Promise<void>(done => { ready = done; });
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const opened = fixture(async function (resolved, context, options) {
      expect(this).toBe(opened.models);
      expect(resolved.baseUrl).toBe(model.baseUrl);
      expect(context.state).toEqual({ value: 1 });
      expect(Object.keys(options ?? {})).toEqual(['signal']);
      calls++;
      maximum = Math.max(maximum, ++active);
      await gate;
      active--;
      return value(1);
    });
    let queued: CodemodeToolDetails | undefined;
    const running = opened.tool.execute('native-models', {
      code: `// @options: {"timeout_ms":3000}\nreturn await Promise.all(Array.from({length:6},()=>${callCode}));`,
    }, undefined, update => {
      if (update.details?.calls.length === 6 && update.details.calls.every(call => call.status === 'running')) {
        queued = update.details;
        ready();
      }
    }, opened.ctx);
    try {
      await allRows;
      expect(active).toBe(4);
      expect(queued?.calls.map(call => call.args)).toEqual(Array(6).fill('local/judge'));
      expect(JSON.stringify(queued)).not.toContain('private fixture question');
    } finally {
      release();
    }
    const result = await running;
    expect(result.isError).toBeUndefined();
    expect(calls).toBe(6);
    expect(maximum).toBe(4);
    expect(result.details?.calls.map(call => call.id)).toEqual(
      Array.from({ length: 6 }, (_, i) => `native-models/models.classify/${i + 1}`));
    expect(result.details?.calls.every(call => call.status === 'ok')).toBe(true);
    expect(result.usage?.totalTokens).toBe(6 * usage.totalTokens);
  }, 6000);

  test('two concurrent native invocations retain their own model registry', async () => {
    const left = fixture(async () => value(0));
    const right = fixture(async () => value(1));
    const [a, b] = await Promise.all([left, right].map((opened, i) => opened.tool.execute(`concurrent-${i}`, {
      code: `// @options: {"timeout_ms":3000}\nreturn (await ${callCode}).answers.valid.probability;`,
    }, undefined, undefined, opened.ctx)));
    const text = (result: typeof a) => result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    expect(text(a)).toContain('Output:\n0');
    expect(text(b)).toContain('Output:\n1');
    expect(a.usage?.totalTokens).toBe(usage.totalTokens);
    expect(b.usage?.totalTokens).toBe(usage.totalTokens);
  }, 6000);

  test('invalid native helper context keeps the documentation hint and creates no row or provider effect', async () => {
    let effects = 0;
    const opened = fixture(async () => { effects++; return value(1); });
    const result = await opened.tool.execute('invalid-native-model', {
      code: 'await models.classify({provider:"local",id:"judge"},{prompt:"wrong"});',
    }, undefined, undefined, opened.ctx);
    expect(result.isError).toBe(true);
    expect(result.content.some(block => block.type === 'text' && block.text.includes(`See "Classify" in ${CODEMODE_DOCS_PATH}.`)))
      .toBe(true);
    expect(result.details?.calls).toEqual([]);
    expect(effects).toBe(0);
  }, 6000);
});
