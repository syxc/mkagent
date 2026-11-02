import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';

describe('Pi runtime config publication', () => {
  it('preserves a model selection made while a runtime acknowledgement is pending', async () => {
    const agent: any = new PiAgent({
      provider: 'pi', isHeadless: true, model: 'pi/old-main',
      workspace: { id: 'runtime-selection', name: 'Test', rootPath: '/tmp/pi-runtime-test' } as any,
    });
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<{ updated: boolean }>();
    const forwarded: any[] = [];
    agent.subprocess = {};
    agent.ensureSubprocess = async () => {};
    agent.send = (message: any) => forwarded.push(message);
    agent.requestRuntimeConfigUpdate = () => { started.resolve(); return response.promise; };
    const update = agent.updateRuntimeConfig({ model: 'pi/runtime-main' });
    try {
      await started.promise;
      agent.setModel('pi/new-selection');
      expect(agent.getModel()).toBe('pi/new-selection');
      expect(forwarded).toEqual([]);
      response.resolve({ updated: true });
      expect(await update).toBe(true);
      await agent.runtimeConfigUpdateQueue;
      expect(agent.getModel()).toBe('pi/new-selection');
      expect(agent.config.model).toBe('pi/new-selection');
      expect(forwarded).toEqual([{ type: 'set_model', model: 'pi/new-selection' }]);
    } finally {
      response.resolve({ updated: false });
      await update.catch(() => {});
      agent.subprocess = null;
      agent.destroy();
    }
  });

  for (const accepted of [false, true]) it(`publishes host config only after ${accepted ? 'acceptance' : 'rejection'}`, async () => {
    const agent: any = new PiAgent({
      provider: 'pi', isHeadless: true, model: 'pi/old-main',
      workspace: { id: 'runtime-test', name: 'Test', rootPath: '/tmp/pi-runtime-test' } as any,
      runtime: { baseUrl: 'http://old.invalid/v1' },
    });
    const response = Promise.withResolvers<{ updated: boolean }>();
    agent.subprocess = {};
    agent.ensureSubprocess = async () => {};
    agent.requestRuntimeConfigUpdate = () => response.promise;
    const pending = agent.updateRuntimeConfig({ model: 'pi/new-main', runtime: { baseUrl: 'http://new.invalid/v1' } });
    try {
      expect(agent.getModel()).toBe('pi/old-main');
      expect(agent.config.runtime.baseUrl).toBe('http://old.invalid/v1');
      response.resolve({ updated: accepted });
      expect(await pending).toBe(accepted);
      expect(agent.getModel()).toBe(accepted ? 'pi/new-main' : 'pi/old-main');
      expect(agent.config.runtime.baseUrl).toBe(accepted ? 'http://new.invalid/v1' : 'http://old.invalid/v1');
    } finally {
      response.resolve({ updated: false });
      await pending.catch(() => {});
      agent.subprocess = null;
      agent.destroy();
    }
  });

  it('serializes acknowledgements and preserves the last accepted config after an RPC rejection', async () => {
    const agent: any = new PiAgent({
      provider: 'pi', isHeadless: true, model: 'pi/old-main',
      workspace: { id: 'runtime-queue', name: 'Test', rootPath: '/tmp/pi-runtime-test' } as any,
    });
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const firstResponse = Promise.withResolvers<{ updated: boolean; miniModel?: string }>();
    const secondResponse = Promise.withResolvers<{ updated: boolean }>();
    const requests: string[] = [];
    agent.subprocess = {};
    agent.ensureSubprocess = async () => {};
    agent.requestRuntimeConfigUpdate = (update: any) => {
      requests.push(update.model);
      if (requests.length === 1) { firstStarted.resolve(); return firstResponse.promise; }
      secondStarted.resolve();
      return secondResponse.promise;
    };
    const first = agent.updateRuntimeConfig({ model: 'pi/first' });
    const second = agent.updateRuntimeConfig({ model: 'pi/second' });
    try {
      await firstStarted.promise;
      expect(requests).toEqual(['pi/first']);
      expect(agent.getModel()).toBe('pi/old-main');
      firstResponse.resolve({ updated: true, miniModel: 'pi/first-mini' });
      expect(await first).toBe(true);
      await secondStarted.promise;
      expect(agent.config.miniModel).toBe('pi/first-mini');
      expect(agent.getModel()).toBe('pi/first');
      secondResponse.reject(new Error('fixture candidate rejected'));
      expect(await second).toBe(false);
      expect(agent.getModel()).toBe('pi/first');
    } finally {
      firstResponse.resolve({ updated: false });
      secondResponse.resolve({ updated: false });
      await Promise.allSettled([first, second]);
      agent.subprocess = null;
      agent.destroy();
    }
  });
});
