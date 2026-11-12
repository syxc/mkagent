import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadTool, createReadToolDefinition } from '../src/native.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'native-read-path-'));
  directories.push(directory);
  return directory;
}
const original = "Capturé d'écran 1.00 PM.txt";
const variants = [
  original,
  "Capturé d'écran 1.00 PM.txt",
  "Capturé d'écran 1.00 PM.txt",
  'Capturé d’écran 1.00 PM.txt',
  'Capturé d’écran 1.00 PM.txt',
];

for (const [name, factory] of [['agent', createReadTool], ['definition', createReadToolDefinition]] as const) {
  for (const [index, variant] of variants.entries()) {
    test(`${name} read opens path variant ${index} through the public factory`, async () => {
      const cwd = await scratch();
      await writeFile(join(cwd, variant), 'matched path');
      const result = await factory(cwd).execute('read', { path: original });
      expect(result.content).toEqual([{ type: 'text', text: 'matched path' }]);
      expect(result.structuredContent).toBe('matched path');
    });
  }

  test(`${name} read preserves missing path errors after trying variants`, async () => {
    const cwd = await scratch();
    await expect(factory(cwd).execute('read', { path: original })).rejects.toThrow('ENOENT');
  });

  test(`${name} read preserves malformed file URL errors`, async () => {
    const cwd = await scratch();
    await expect(factory(cwd).execute('read', { path: 'file://remote-host/path' })).rejects.toThrow();
  });
}
