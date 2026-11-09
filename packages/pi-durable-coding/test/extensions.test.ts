import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadExtensions } from '../src/legacy/extension-loader.ts';
import type { ExtensionAPI } from '../src/pi/core/extensions/types.ts';
import { ExtensionRunner } from '../src/upstream/core/extensions/runner.js';
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { CodingSessionView } from '../src/session-view.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'durable-coding-extensions-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const fixture = (name: string) => resolve(import.meta.dir, 'fixtures/upstream', name);

describe('native extension loading and dispatch', () => {
  test('loads the unchanged official hello plugin with independent pi-ai and the port', async () => {
    const loaded = await loadExtensions([fixture('hello.ts')], root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const definition = loaded.extensions[0].tools.get('hello').definition;
    expect(definition.parameters.properties.name.type).toBe('string');
    const result = await definition.execute('call-1', { name: 'Durable' });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Hello, Durable!' }],
      details: { greeted: 'Durable' },
    });
  });

  test('runs official input transforms, short-circuits handled input and preserves images', async () => {
    const loaded = await loadExtensions([fixture('input-transform.ts')], root);
    expect(loaded.errors).toEqual([]);
    const session = new CodingSessionView({
      id: crypto.randomUUID(), cwd: root, sessionPath: root,
      read: async () => [], append: async () => {},
    });
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, session.view, {});
    const notifications: string[] = [];
    runner.setUIContext({
      ...runner.getUIContext(),
      notify: (message: string) => notifications.push(message),
    });
    const images = [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }];
    expect(await runner.emitInput('?quick Explain durability', images, 'interactive'))
      .toEqual({ action: 'transform', text: 'Respond briefly in 1-2 sentences: Explain durability', images });
    expect(await runner.emitInput('ping', undefined, 'interactive')).toEqual({ action: 'handled' });
    expect(notifications).toEqual(['pong']);
    expect(await runner.emitInput('ping', undefined, 'extension')).toEqual({ action: 'continue' });
  });

  test('rejects legacy Agent execution and does not fall back for missing exports', async () => {
    const path = join(root, 'legacy.ts');
    writeFileSync(path, `
      import { Agent } from '@earendil-works/pi-agent-core';
      export default function () { new Agent(); }
    `);
    const loaded = await loadExtensions([path], root);
    expect(loaded.extensions).toEqual([]);
    expect(loaded.errors[0].error).toContain('pi-durable');
    writeFileSync(path, `
      import { createAgentSession } from '@earendil-works/pi-coding-agent';
      export default async function () { await createAgentSession(); }
    `);
    const missing = await loadExtensions([path], root);
    expect(missing.extensions).toEqual([]);
    expect(missing.errors[0].error).toContain('createAgentSession');
  });

  test('keeps cached factories and Coding module mappings separate across loaders', async () => {
    const legacy = await import('../src/legacy/extension-loader.ts');
    const native = await import('../src/native-extension-loader.ts');
    const path = join(root, 'cached.ts');
    writeFileSync(path, `
      import * as coding from '@earendil-works/pi-coding-agent';
      let calls = 0;
      export default function (pi) {
        pi.registerFlag('surface', { type: 'string', default: typeof coding.createAgentSession });
        pi.registerFlag('calls', { type: 'string', default: String(++calls) });
      }
    `);
    const observe = async (loader: Pick<typeof native, 'loadExtensionsCached'>, surface: string, calls: number) => {
      const loaded = await loader.loadExtensionsCached([path], root);
      expect(loaded.errors).toEqual([]);
      expect(loaded.extensions[0].flags.get('surface')?.default).toBe(surface);
      expect(loaded.extensions[0].flags.get('calls')?.default).toBe(String(calls));
    };
    try {
      await observe(legacy, 'undefined', 1);
      await observe(native, 'function', 1);
      await observe(legacy, 'undefined', 2);
      await observe(native, 'function', 2);
      legacy.clearExtensionCache();
      await observe(legacy, 'undefined', 1);
      await observe(native, 'function', 3);
    } finally {
      legacy.clearExtensionCache();
      native.clearExtensionCache();
    }
  });

  test.each(['../src/legacy/extension-loader.ts', '../src/native-extension-loader.ts'])(
    'commits inline registrations and invalidates captured APIs through %s', async loaderPath => {
      const { createExtensionRuntime, loadExtensionFromFactory } = await import(loaderPath);
      const runtime = createExtensionRuntime();
      const events = createEventBus();
      let captured: ExtensionAPI | undefined;
      let calls = 0;
      const extension = await loadExtensionFromFactory(async (pi: ExtensionAPI) => {
        captured = pi;
        pi.registerFlag('accepted', { type: 'boolean', default: true });
        pi.registerProvider('test-provider', { models: [] });
        pi.registerCommand('accepted', { handler: async () => {} });
        pi.events.on('accepted', () => { calls++; });
        await Promise.resolve();
      }, root, events, runtime);
      expect(runtime.flagValues.get('accepted')).toBe(true);
      expect(runtime.pendingProviderRegistrations).toHaveLength(1);
      expect(extension.commands.get('accepted')?.sourceInfo).toBe(extension.sourceInfo);
      events.emit('accepted', {});
      expect(calls).toBe(1);
      runtime.invalidate();
      events.emit('accepted', {});
      expect(calls).toBe(1);
      expect(() => captured!.registerFlag('stale', { type: 'boolean' })).toThrow('stale');
      expect(() => captured!.events.on('accepted', () => {})).toThrow('stale');
    },
  );

  test.each(['../src/legacy/extension-loader.ts', '../src/native-extension-loader.ts'])(
    'rolls back failed registrations and event listeners through %s', async loaderPath => {
      const { createExtensionRuntime, loadExtensions } = await import(loaderPath);
      const path = join(root, 'failed.ts');
      writeFileSync(path, `
        export default function (pi) {
          pi.registerFlag('test-flag', { type: 'boolean', default: true });
          pi.registerProvider('test-provider', { models: [] });
          pi.events.on('test-channel', () => { throw new Error('leaked listener'); });
          throw new Error('factory failed');
        }
      `);
      const runtime = createExtensionRuntime();
      const events = createEventBus();
      const loaded = await loadExtensions([path], root, events, runtime);
      expect(loaded.extensions).toEqual([]);
      expect(loaded.errors[0].error).toContain('factory failed');
      expect(runtime.flagValues.size).toBe(0);
      expect(runtime.pendingProviderRegistrations).toEqual([]);
      expect(() => events.emit('test-channel', {})).not.toThrow();
    },
  );

  test('rejects unsupported legacy subpaths even when a plugin supplies an installed package', async () => {
    const directory = join(root, 'node_modules/@earendil-works/pi-coding-agent');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-coding-agent', type: 'module',
      exports: { './rpc-entry': './rpc-entry.js' },
    }));
    const marker = join(root, 'loaded');
    writeFileSync(join(directory, 'rpc-entry.js'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'loaded');
      export default function () {}
    `);
    const plugin = join(root, 'subpath.ts');
    writeFileSync(plugin, `
      import start from '@earendil-works/pi-coding-agent/rpc-entry';
      export default function () { start(); }
    `);
    const loaded = await loadExtensions([plugin], root);
    expect(loaded.extensions).toHaveLength(0);
    expect(loaded.errors[0].error).toContain('Unsupported legacy runtime subpath');
    expect(existsSync(marker)).toBe(false);
    writeFileSync(plugin, `
      import start from ${JSON.stringify(join(directory, 'rpc-entry.js'))};
      export default function () { start(); }
    `);
    expect((await loadExtensions([plugin], root)).errors).toEqual([]);
    expect(existsSync(marker)).toBe(true);
  });
});
