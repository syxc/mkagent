import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import { createHostExtensionLoader } from '../src/host-extension-loader.ts';

test('SDK owns default plugin modules and isolates durable runtime overrides', async () => {
  const baseline = await sdk.getExtensionModules();
  const codingAgent = { marker: 'durable' };
  const agentCore = { marker: 'durable-core' };
  const modules = await sdk.getExtensionModules({ codingAgent, agentCore });
  for (const namespace of ['@earendil-works', '@mariozechner']) {
    expect(modules[`${namespace}/pi-coding-agent`]).toBe(codingAgent);
    expect(modules[`${namespace}/pi-agent-core`]).toBe(agentCore);
    expect(modules[`${namespace}/pi-tui`]).toBe(tui);
    expect(modules[`${namespace}/pi-ai`]).toBe(baseline[`${namespace}/pi-ai`]);
  }
  expect((baseline['@earendil-works/pi-agent-core'] as { Agent: typeof sdk.Agent }).Agent).toBe(sdk.Agent);
  expect((await sdk.getExtensionModules())['@earendil-works/pi-coding-agent']).not.toBe(codingAgent);
  expect(() => '@earendil-works/pi-coding-agent/private-runtime' in modules).toThrow('Unsupported legacy runtime subpath');
  const ai = modules['@earendil-works/pi-ai'] as { StringEnum: typeof sdk.StringEnum };
  const values = [''] as const;
  const schema = ai.StringEnum(values, { default: '' });
  expect(schema).toMatchObject({ type: 'string', enum: [''] });
  expect(schema).not.toHaveProperty('default');
  expect(schema.enum).not.toBe(values);
  expect(ai.StringEnum).toBe(sdk.StringEnum);
});

test('SDK importer preserves host preparation and isolates cached factories by module owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coding-sdk-modules-'));
  try {
    const path = join(directory, 'extension.ts');
    writeFileSync(path, `import { marker } from '@earendil-works/pi-coding-agent';
export default function (api) {
  api.registerCommand('marker', { description: marker, handler: async () => {} });
}
`);
    const loaders = ['first', 'second'].map(marker => createHostExtensionLoader(
      () => ({ codingAgent: { marker } }), '.pi', () => directory,
    ));
    for (const [index, loader] of loaders.entries()) {
      const first = await loader.loadExtensionsCached([path], directory);
      expect(first.errors).toEqual([]);
      expect(first.extensions[0]!.commands.get('marker')!.description).toBe(['first', 'second'][index]);
      const again = await loader.loadExtensionsCached([path], directory);
      expect(again.errors).toEqual([]);
      expect(again.extensions[0]!.commands.get('marker')!.description).toBe(['first', 'second'][index]);
    }
    loaders[0]!.clearExtensionCache();
    const untouched = await loaders[1]!.loadExtensionsCached([path], directory);
    expect(untouched.extensions[0]!.commands.get('marker')!.description).toBe('second');
  } finally {
    // Some test sandboxes cannot access the system Trash; fixture cleanup must not hide assertions.
    if (Bun.spawnSync(['trash', directory]).exitCode) console.warn(`Temporary fixture retained: ${directory}`);
  }
});
