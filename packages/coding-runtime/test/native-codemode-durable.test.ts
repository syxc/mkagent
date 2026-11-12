import { describe, expect, test } from 'bun:test';
import { createModels, fauxProvider, type ClassifierModel } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-coding-agent';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { executeNativeCodemode } from '../src/compat/codemode-native.ts';
import type { CodemodeStoreEntryData } from '../src/native-codemode.ts';
import { currentCodingHostToolApi } from '../src/durable-coding/engine.ts';

const text = (result: Awaited<ReturnType<typeof executeNativeCodemode>>) =>
  result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
const echo: AgentTool = {
  name: 'echo', label: 'echo', description: 'Echo a value',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  execute: async () => ({ content: [], details: {} }),
};

function context(execute: ExtensionToolContext['executeTool'], tools = [echo]): ExtensionToolContext {
  return {
    tools, executeTool: execute, sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionToolContext;
}

describe('native codemode through durable execution', () => {
  // Expected values follow upstream execute.ts:toScriptValue, independently of this adapter.
  test.each([
    { schema: false, error: true, texts: [], structured: undefined, expected: { error: 'Tool "echo" failed' } },
    { schema: true, error: true, texts: ['schema failure'], structured: undefined, expected: { error: 'schema failure' } },
    { schema: true, error: false, texts: ['schema fallback'], structured: undefined, expected: { value: 'schema fallback' } },
    { schema: true, error: true, texts: ['error text'], structured: { answer: 1 }, expected: { value: { answer: 1 } } },
    { schema: false, error: false, texts: ['first', 'second'], structured: { ignored: true }, expected: { value: 'first\nsecond' } },
  ])('Native tool values retain the independent upstream projection (%s)', async sample => {
    const tool = { ...echo, ...(sample.schema ? { outputSchema: { type: 'object' as const } } : {}) };
    const result = await executeNativeCodemode('empty-error', {
      code: 'try { return {value:await tools.echo({})}; } catch(error) { return {error:error.message}; }',
    }, undefined, undefined, context(async (name, args) => ({
      toolCall: { type: 'toolCall', id: 'empty-error-child', name, arguments: args },
      result: { content: sample.texts.map(text => ({ type: 'text' as const, text })), details: {},
        ...(sample.structured === undefined ? {} : { structuredContent: sample.structured }) },
      isError: sample.error,
    }), [tool]));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result).split('Output:\n')[1])).toEqual(sample.expected);
  }, 6000);

  test('public names overlapping private registrations retain distinct targets', async () => {
    const names: string[] = [];
    const result = await executeNativeCodemode('overlapping-names', {
      code: 'return [await tools.echo({}), await tools.mkagent_native_echo({})];',
    }, undefined, undefined, context(async (name, args) => {
      names.push(name);
      return { toolCall: { type: 'toolCall', id: name, name, arguments: args },
        result: { content: [{ type: 'text', text: name }], details: {} }, isError: false };
    }, [echo, { ...echo, name: 'mkagent.native:echo' }]));
    if (result.isError) throw new Error(text(result));
    expect(names).toEqual(['echo', 'mkagent.native:echo']);
  }, 6000);

  test('observer and effect cleanup failures both survive lease release', async () => {
    const executionError = new Error('fixture observer execution failed');
    const cleanupError = new Error('fixture cancellation cleanup failed');
    let entered!: () => void;
    const ready = new Promise<void>(done => { entered = done; });
    let cleaned = 0, observed = false;
    const running = executeNativeCodemode('two-failures', {
      code: 'const pending=tools.echo({}); await tools.ready({}); await tools.last({}); await pending;',
    }, undefined, update => {
      if (!observed && update.details.calls.some(call => call.name === 'last')) {
        observed = true;
        throw executionError;
      }
    }, context(async (name, args, options) => {
      if (name === 'echo') {
        entered();
        await new Promise<void>(done => {
          if (options?.signal?.aborted) done();
          else options?.signal?.addEventListener('abort', () => done(), { once: true });
        });
        cleaned++;
        throw cleanupError;
      }
      await ready;
      return { toolCall: { type: 'toolCall', id: name, name, arguments: args },
        result: { content: [], details: {} }, isError: false };
    }, [echo, { ...echo, name: 'ready' }, { ...echo, name: 'last' }]));
    let failure: unknown;
    try { await running; } catch (error) { failure = error; }
    const flatten = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error];
    expect(cleaned).toBe(1);
    expect(observed).toBe(true);
    expect(flatten(failure)).toContain(executionError);
    expect(flatten(failure)).toContain(cleanupError);
  }, 6000);

  test.each(['pi.codemode.custom', 'pi.codemode.models.classify'])('Native reserved name %s retains its script identifier', async name => {
    let effects = 0;
    const named = { ...echo, name };
    const ctx = context(async (name, args) => {
      effects++;
      expect(name).toBe(named.name);
      return {
        toolCall: { type: 'toolCall', id: 'prefix-child', name, arguments: args },
        result: { content: [{ type: 'text', text: 'prefix result' }], details: {} }, isError: false,
      };
    }, [named]);
    const result = await executeNativeCodemode('prefix', {
      code: `return [await tools.${name.replaceAll('.', '_')}({}), ALL_TOOLS];`,
    }, undefined, undefined, ctx, { models: true });
    if (result.isError) throw new Error(text(result));
    expect(effects).toBe(1);
    expect(result.details.calls[0]).toMatchObject({ name: named.name, id: 'prefix-child', status: 'ok' });
    expect(text(result)).toContain('prefix result');
    expect(text(result)).toContain(name.replaceAll('.', '_'));
  }, 6000);

  test('the SDK context runs inside its actual official child scope and keeps native IDs and raw store writes', async () => {
    const writes: CodemodeStoreEntryData[] = [];
    let effects = 0;
    const ctx = context(async (name, args) => {
      effects++;
      const scope = currentCodingHostToolApi()!;
      const record = await scope.api.getTask(scope.api.taskId, scope.context);
      expect(record?.kind).toBe('pi.tool');
      expect(record?.owner).toBeDefined();
      return {
        toolCall: { type: 'toolCall', id: 'native-child', name, arguments: args },
        result: { content: [{ type: 'text', text: 'hello' }], details: {} }, isError: false,
      };
    });
    const code = 'store("kept",1); store("missing",undefined); return await tools.echo({value:"hello"});';
    const result = await executeNativeCodemode('script', { code }, undefined, undefined, ctx, {
      appendEntry: (_kind, data) => { writes.push(data); },
    });
    if (result.isError) throw new Error(text(result));
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Output:\nhello');
    expect(result.details.calls).toMatchObject([{ id: 'native-child', name: 'echo', status: 'ok' }]);
    expect(writes).toEqual([{ set: { kept: 1 }, delete: ['missing'] }]);
    expect(effects).toBe(1);
  }, 6000);

  test('undefined SDK contexts retain script output and discard later-call state', async () => {
    const code = 'store("ephemeral",7); text("first"); return [1,2];';
    const shared = await executeNativeCodemode('shared', { code }, undefined, undefined, undefined);
    expect(text(shared)).toContain('Script completed');
    expect(text(shared)).toContain('first');
    expect(text(shared)).toContain('==> text 2/2 <==');
    const next = await executeNativeCodemode('next', { code: 'return load("ephemeral");' }, undefined, undefined, undefined);
    expect(next.content).toHaveLength(1);
  }, 6000);

  test('models use the native registry once and reject invalid calls before any live row', async () => {
    const model: ClassifierModel<'fixture'> = {
      id: 'judge', name: 'Judge', type: 'classifier', provider: 'local', api: 'fixture',
      baseUrl: 'https://host.invalid', input: ['text'], contextWindow: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const models = createModels();
    models.setProvider({ ...fauxProvider().provider, id: 'local', getAllModels: () => [model], getModels: () => [] });
    let effects = 0;
    models.classify = async function (resolved) {
      expect(this).toBe(models);
      expect(resolved.baseUrl).toBe(model.baseUrl);
      effects++;
      return {
        api: model.api, model: model.id, provider: model.provider, timestamp: 0, stopReason: 'stop',
        answers: { valid: { type: 'bool', probability: 1 } },
        usage: { input: 2, output: 3, totalTokens: 5, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
    };
    const ctx = { ...context(async () => { throw new Error('No ordinary tools'); }, []), modelRegistry: models };
    const result = await executeNativeCodemode('models', {
      code: `try { await models.classify({provider:"local",id:"judge"},{prompt:"invalid"}); }
      catch(e) { text(e.message); }
      return (await models.classify({provider:"local",id:"judge"},
        {state:{},questions:{valid:{type:"bool",instructions:"private fixture",criteria:{true:"yes",false:"no"}}}})).answers.valid.probability;`,
    }, undefined, undefined, ctx as unknown as ExtensionToolContext, { models: true });
    expect(result.isError).toBeUndefined();
    expect(effects).toBe(1);
    expect(result.details.calls).toMatchObject([{ id: 'models/models.classify/1', args: 'local/judge', status: 'ok' }]);
    expect(JSON.stringify(result.details)).not.toContain('private fixture');
    expect(text(result)).toContain('See "Classify"');
    expect(result.usage?.totalTokens).toBe(5);
  }, 6000);

  for (const ending of ['return', 'throw', 'deadline', 'cancel', 'cleanup-error'] as const) {
    test(`${ending} joins an effect that the script has already started`, async () => {
      const controller = new AbortController();
      let entered!: () => void;
      const ready = new Promise<void>(done => { entered = done; });
      let active = 0;
      let cleaned = 0;
      const cleanupError = new Error('fixture effect cleanup failed');
      const ctx = context(async (name, args, options) => {
        if (name === 'ready') {
          await ready;
          return {
            toolCall: { type: 'toolCall', id: 'native-ready', name, arguments: args },
            result: { content: [], details: {} }, isError: false,
          };
        }
        active++;
        entered();
        const signal = options?.signal;
        await new Promise<void>(done => {
          if (signal?.aborted) done();
          else signal?.addEventListener('abort', () => done(), { once: true });
        });
        active--;
        cleaned++;
        if (ending === 'cleanup-error') throw cleanupError;
        return {
          toolCall: { type: 'toolCall', id: 'native-effect', name, arguments: args },
          result: { content: [{ type: 'text', text: 'effect stopped' }], details: {} }, isError: true,
        };
      }, [echo, { ...echo, name: 'ready' }]);
      const tail = ending === 'return' ? 'return "finished";'
        : ending === 'throw' ? 'throw new Error("script failure");' : 'await running;';
      const running = executeNativeCodemode(`ending-${ending}`, {
        code: `${ending === 'deadline' ? '// @options: {"timeout_ms":200}\n' : ''}
          text("partial before ending");
          const running = tools.echo({value:"fixture"});
          await tools.ready({});
          ${tail}`,
      }, controller.signal, undefined, ctx);
      await ready;
      if (ending === 'cancel' || ending === 'cleanup-error') controller.abort(new Error('fixture caller cancelled'));
      if (ending === 'cleanup-error') await expect(running).rejects.toBe(cleanupError);
      else {
        const result = await running;
        expect(result.isError).toBe(ending === 'return' ? undefined : true);
        expect(text(result)).toContain('partial before ending');
        expect(result.details.calls.find(call => call.name === 'echo')?.status).toBe('cancelled');
      }
      expect(active).toBe(0);
      expect(cleaned).toBe(1);
    }, 6000);
  }
});
