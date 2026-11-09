import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as native from '../src/native-extension-loader.ts';
import * as legacy from '../src/legacy/extension-loader.ts';
import { CONFIG_DIR_NAME } from '../src/pi/config.ts';
import { createHostExtensionLoader } from '../src/host-extension-loader.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'coding-extension-sdk-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const flagFactory = (value: string): sdk.ExtensionFactory => pi => {
  pi.registerFlag('value', { type: 'string', default: value });
};
const value = (loaded: sdk.LoadExtensionsResult) => {
  expect(loaded.errors).toEqual([]);
  return loaded.extensions[0].flags.get('value')?.default;
};

describe('SDK extension module import boundary', () => {
  test('keeps published lifecycle functions and the default file importer', async () => {
    for (const host of [native, legacy]) {
      expect(host.createExtensionRuntime).toBe(sdk.createExtensionRuntime);
      expect(host.loadExtensionFromFactory).toBe(sdk.loadExtensionFromFactory);
    }
    const path = join(root, 'default.ts');
    writeFileSync(path, `export default pi => pi.registerFlag('value', { type: 'string', default: 'sdk-default' });`);
    expect(value(await sdk.loadExtensions([path], root))).toBe('sdk-default');
  });

  test('shares a cache only for the same importer and bypasses it for uncached loads', async () => {
    let imports = 0;
    const importModule = async (path: string) => {
      expect(path).toBe(resolve(root, 'plugin.ts'));
      return flagFactory(String(++imports));
    };
    const options = { importModule };
    const load = (cwd = root) => sdk.loadExtensionsCached(['plugin.ts'], cwd, undefined, undefined, { importModule });
    try {
      expect(value(await load())).toBe('1');
      expect(value(await load())).toBe('1');
      expect(value(await sdk.loadExtensions(['plugin.ts'], root, undefined, undefined, options))).toBe('2');
      expect(value(await load())).toBe('1');
      const other = { importModule: async () => flagFactory('other') };
      expect(value(await sdk.loadExtensionsCached(['plugin.ts'], root, undefined, undefined, other))).toBe('other');
      sdk.clearExtensionCache(other);
      expect(value(await load())).toBe('1');
      sdk.clearExtensionCache(options);
      expect(value(await load())).toBe('3');
    } finally {
      sdk.clearExtensionCache(options);
    }
  });

  test.each(['clear', 'cwd'])('does not cache a late import after %s invalidation', async invalidation => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let complete!: (factory: sdk.ExtensionFactory) => void;
    const pending = new Promise<sdk.ExtensionFactory>(resolve => { complete = resolve; });
    let imports = 0;
    const options = { importModule: async () => {
      imports++;
      if (imports === 1) { entered(); return pending; }
      return flagFactory('current');
    } };
    const path = join(root, 'plugin.ts');
    const nextCwd = invalidation === 'cwd' ? join(root, 'next') : root;
    const load = (cwd: string) => sdk.loadExtensionsCached([path], cwd, undefined, undefined, options);
    try {
      const old = load(root);
      await started;
      if (invalidation === 'clear') sdk.clearExtensionCache(options);
      expect(value(await load(nextCwd))).toBe('current');
      complete(flagFactory('late'));
      expect(value(await old)).toBe('late');
      expect(value(await load(nextCwd))).toBe('current');
      expect(imports).toBe(2);
    } finally {
      complete(flagFactory('late'));
      sdk.clearExtensionCache(options);
    }
  });

  test('reports invalid factories and importer failures through SDK diagnostics', async () => {
    const invalid = await sdk.loadExtensions(['invalid.ts'], root, undefined, undefined, {
      importModule: async () => ({}),
    });
    expect(invalid.extensions).toEqual([]);
    expect(invalid.errors[0].error).toContain('does not export a valid factory');
    const failed = await sdk.loadExtensions(['failed.ts'], root, undefined, undefined, {
      importModule: async () => { throw new Error('host import failed'); },
    });
    expect(failed.extensions).toEqual([]);
    expect(failed.errors[0].error).toContain('Failed to load extension: host import failed');
  });

  test('uses SDK discovery with host directories, manifests and explicit-directory guards', async () => {
    const agentDir = join(root, 'agent');
    const local = join(root, CONFIG_DIR_NAME, 'extensions');
    const global = join(agentDir, 'extensions');
    const declared = join(root, 'declared');
    for (const directory of [local, global, declared]) mkdirSync(directory, { recursive: true });
    const put = (path: string, label: string) => writeFileSync(path,
      `export default pi => pi.registerFlag('value', { type: 'string', default: '${label}' });`);
    put(join(local, 'local.ts'), 'local');
    put(join(global, 'global.ts'), 'global');
    put(join(declared, 'entry.ts'), 'declared');
    writeFileSync(join(declared, 'package.json'), JSON.stringify({ pi: { extensions: ['entry.ts'] } }));
    const loaded = await native.discoverAndLoadExtensions([declared, join(local, 'local.ts')], root, agentDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.map(extension => extension.flags.get('value')?.default)).toEqual(['local', 'global', 'declared']);
    expect(() => legacy.discoverAndLoadExtensions([], root)).toThrow('provide agentDir explicitly');
    const legacyLoaded = await legacy.discoverAndLoadExtensions([declared], root, agentDir);
    expect(legacyLoaded.errors).toEqual([]);
    expect(legacyLoaded.extensions.map(extension => extension.flags.get('value')?.default)).toEqual(['local', 'global', 'declared']);
    const host = createHostExtensionLoader(() => ({}), '.host', () => agentDir);
    mkdirSync(join(root, '.host/extensions'), { recursive: true });
    put(join(root, '.host/extensions/host.ts'), 'host');
    const custom = await host.discoverAndLoadExtensions([], root);
    expect(custom.errors).toEqual([]);
    expect(custom.extensions.map(extension => extension.flags.get('value')?.default)).toEqual(['host', 'global']);
  });
});
