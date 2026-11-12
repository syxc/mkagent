import { afterEach, describe, expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import {
  createRegistry, Harness, MemoryStorage, ToolTask,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { DurableLoopBinding, currentCodingHostToolApi, currentCodingToolInvocation } from '../src/durable-coding/engine.ts';
import { NATIVE_CODEMODE_FORWARD, type NativeCodemodeForwardInput } from '../src/durable-coding/codemode-forward.ts';
import { hostToolToAgent } from '../src/host-tools.ts';

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function kernel() {
  const registry = createRegistry(), models = createModels();
  models.setProvider(fauxProvider().provider);
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
  cleanups.push(() => harness.close(context));
  const create = async () => {
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    const binding = new DurableLoopBinding({ kernel: { harness, conversation, registry } });
    cleanups.push(() => binding.close());
    const execute = async (registration: ToolRegistration) => {
      const tool = hostToolToAgent(registration);
      return binding.runTool({ type: 'toolCall', id: 'native-parent', name: tool.name, arguments: {} }, {
        tools: [tool], assistantMessage: fauxAssistantMessage([]), context: { messages: [], tools: [tool] },
      });
    };
    return { binding, conversation, execute };
  };
  return { registry, harness, create };
}

describe('native codemode official forwarding', () => {
  test('concurrent registration under one owner admits only the durable memo winner', async () => {
    const opened = await kernel(), owner = await opened.create();
    const result = await owner.execute({
      name: 'concurrent-owner', description: 'Register a single active forwarding lease', parameters: { type: 'object' },
      execute: async () => {
        const scope = currentCodingHostToolApi()!;
        const attempts = await Promise.allSettled([
          scope.registerCodemodeForward(async () => ({ output: [] })),
          scope.registerCodemodeForward(async () => ({ output: [] })),
        ]);
        try {
          expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
          expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1);
        } finally {
          for (const attempt of attempts) if (attempt.status === 'fulfilled') attempt.value.dispose();
        }
        return { output: [] };
      },
    });
    if (result.isError) throw new Error(JSON.stringify(result.result));
  });

  for (const official of [false, true]) {
    test(`${official ? 'an official' : 'a native'} parent dispatches under its own child task and restores its API`, async () => {
      const opened = await kernel(), owner = await opened.create();
      let effects = 0;
      const dispatch: ToolRegistration['execute'] = async (_args, parent, ctx) => {
        const captured = currentCodingHostToolApi();
        expect(captured?.api.taskId).toBe(parent.taskId);
        if (!captured) throw Error('Missing actual host API');
        const lease = await captured.registerCodemodeForward(async (input, child, childContext) => {
          effects++;
          expect(input).toMatchObject({ vmId: 1, name: 'echo', args: { value: 'owned' } });
          expect(child.taskId).not.toBe(parent.taskId);
          expect(currentCodingHostToolApi()?.api).toBe(child);
          expect(() => currentCodingToolInvocation()).toThrow();
          const record = await child.getTask(child.taskId, childContext);
          expect(record).toMatchObject({ kind: ToolTask.definition.name, owner: parent.taskId });
          return { structuredOutput: { value: 'owned' } };
        });
        try {
          const result = await lease.execute(1, 'echo', { value: 'owned' }, ctx);
          expect(result.isError).toBe(false);
          expect(result.structuredOutput).toEqual({ value: 'owned' });
          expect(currentCodingHostToolApi()?.api.taskId).toBe(parent.taskId);
          await lease.join();
          return { output: [{ type: 'text', text: 'forwarded' }] };
        } finally {
          lease.dispose();
        }
      };
      if (official) opened.registry.install({
        name: 'official-test',
        tools: [{
          name: 'official-parent', description: 'Official forwarding parent', parameters: { type: 'object' },
          callers: ['tools'],
          execute: (args, api, ctx) => owner.binding.withHostToolScope(api, ctx, () => dispatch(args, api, ctx)),
        }],
      });
      const result = await owner.execute({
        name: 'bootstrap', description: 'Native forwarding parent', parameters: { type: 'object' },
        execute: official
          ? async (_args, api, ctx) => {
            expect((await api.executeTool('official-parent', {}, ctx)).isError).toBe(false);
            return { output: [] };
          }
          : dispatch,
      });
      expect(result.isError).toBe(false);
      expect(effects).toBe(1);
    });
  }

  test('a bound token cannot cross conversations in a shared registry', async () => {
    const opened = await kernel(), a = await opened.create(), b = await opened.create();
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { finish = done; });
    let input!: NativeCodemodeForwardInput;
    let effects = 0;
    const running = a.execute({
      name: 'owner-a', description: 'First owner', parameters: { type: 'object' },
      execute: async (_args, _api, ctx) => {
        const captured = currentCodingHostToolApi()!;
        const lease = await captured.registerCodemodeForward(async value => {
          input = value;
          effects++;
          entered();
          await gate;
          return { structuredOutput: 'done' };
        });
        try {
          await lease.execute(1, 'echo', {}, ctx);
          return { output: [] };
        } finally { lease.dispose(); }
      },
    });
    try {
      await ready;
      const result = await b.execute({
        name: 'owner-b', description: 'Second owner', parameters: { type: 'object' },
        execute: async (_args, api, ctx) => {
          const attempted = await api.executeTool(NATIVE_CODEMODE_FORWARD, { ...input }, ctx, { key: 'c1' });
          expect(attempted.isError).toBe(true);
          return { output: [] };
        },
      });
      expect(result.isError).toBe(false);
      expect(effects).toBe(1);
    } finally { finish(); await running; }
  });

  test('a different nested key cannot reuse an issued call', async () => {
    const opened = await kernel(), owner = await opened.create();
    let input!: NativeCodemodeForwardInput;
    let effects = 0;
    const result = await owner.execute({
      name: 'key-owner', description: 'Check nested identity', parameters: { type: 'object' },
      execute: async (_args, api, ctx) => {
        const lease = await currentCodingHostToolApi()!.registerCodemodeForward(async value => {
          input = value;
          effects++;
          return { structuredOutput: 'done' };
        });
        try {
          await lease.execute(1, 'echo', {}, ctx);
          const attempted = await api.executeTool(NATIVE_CODEMODE_FORWARD, { ...input }, ctx, { key: 'wrong-key' });
          expect(attempted.isError).toBe(true);
          return { output: [] };
        } finally { lease.dispose(); }
      },
    });
    expect(result.isError).toBe(false);
    expect(effects).toBe(1);
  });

  test('registering again under the same real parent reuses a completed receipt', async () => {
    const opened = await kernel(), owner = await opened.create();
    let effects = 0;
    const result = await owner.execute({
      name: 'receipt-owner', description: 'Reattach a completed call', parameters: { type: 'object' },
      execute: async (_args, _api, ctx) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const lease = await currentCodingHostToolApi()!.registerCodemodeForward(async () => {
            effects++;
            return { structuredOutput: 'once' };
          });
          try {
            expect((await lease.execute(1, 'echo', {}, ctx)).structuredOutput).toBe('once');
            await lease.join();
          } finally { lease.dispose(); }
        }
        return { output: [] };
      },
    });
    expect(result.isError).toBe(false);
    expect(effects).toBe(1);
  });

  test('join reports an official wait rejection that occurred before cleanup', async () => {
    const opened = await kernel(), owner = await opened.create();
    const result = await owner.execute({
      name: 'failed-wait-owner', description: 'Join a rejected official call', parameters: { type: 'object' },
      execute: async (_args, api, ctx) => {
        await api.executeTool(NATIVE_CODEMODE_FORWARD,
          { token: 'unbound', vmId: 1, name: 'echo' }, ctx, { key: 'c1' });
        const lease = await currentCodingHostToolApi()!.registerCodemodeForward(async () => ({ output: [] }));
        try {
          await expect(lease.execute(1, 'echo', {}, ctx)).rejects.toThrow('another tool or other arguments');
          await expect(lease.join()).rejects.toThrow('another tool or other arguments');
        } finally { lease.dispose(); }
        return { output: [] };
      },
    });
    expect(result.isError).toBe(false);
  });
});
