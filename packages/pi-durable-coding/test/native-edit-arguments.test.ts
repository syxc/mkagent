import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditTool as createDurableEditTool } from '@earendil-works/pi-durable/tools';
import { createEditTool, createEditToolDefinition } from '../src/pi/core/tools/edit.ts';

const first = { oldText: 'a', newText: 'A' };
const second = { oldText: 'b', newText: 'B' };
const cases = [
  { name: 'an edits array', input: { edits: [first] }, edits: [first] },
  { name: 'a JSON array', input: { edits: JSON.stringify([first]) }, edits: [first] },
  { name: 'a single object', input: { edits: first }, edits: [first] },
  { name: 'a JSON object', input: { edits: JSON.stringify(first) }, edits: [first] },
  { name: 'legacy fields', input: first, edits: [first] },
  { name: 'array and legacy fields', input: { edits: [first], ...second }, edits: [first, second] },
  { name: 'JSON and legacy fields', input: { edits: JSON.stringify(first), ...second }, edits: [first, second] },
];

for (const row of cases) {
  test(`Native edit prepares ${row.name} without changing the recorded call`, () => {
    const input = Object.freeze({ path: 'sample.txt', ...structuredClone(row.input) });
    const before = structuredClone(input);
    const definition = createEditToolDefinition('/unused');
    expect(definition.prepareArguments!(input)).toEqual({ path: 'sample.txt', edits: row.edits });
    expect(input).toEqual(before);
  });
}

test('the plugin definition and AgentTool wrapper use the public SDK preparation', () => {
  const prepare = createDurableEditTool().prepareArguments;
  expect(typeof prepare).toBe('function');
  expect(createEditToolDefinition('/unused').prepareArguments).toBe(prepare);
  expect(createEditTool('/unused').prepareArguments).toBe(prepare);
});

test('SDK preparation feeds Native file execution and keeps BOM, CRLF, and details', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'native-edit-arguments-'));
  try {
    await writeFile(join(cwd, 'sample.txt'), String.fromCharCode(0xfeff) + 'a\r\nb\r\n');
    const input = Object.freeze({ path: 'sample.txt', edits: JSON.stringify(first), ...second });
    const definition = createEditToolDefinition(cwd);
    const result = await definition.execute('edit-call', definition.prepareArguments!(input));
    expect(await readFile(join(cwd, 'sample.txt'), 'utf8')).toBe(String.fromCharCode(0xfeff) + 'A\r\nB\r\n');
    expect(result.content).toEqual([{ type: 'text', text: 'Successfully replaced 2 block(s) in sample.txt.' }]);
    expect(result.details?.diff).toContain('+1 A');
    expect(result.details?.patch).toContain('+B');
    expect(result.details?.firstChangedLine).toBe(1);
    expect(input.edits).toBe(JSON.stringify(first));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const edits of ['not JSON', [], { oldText: 1, newText: 'A' }]) {
  test(`Native validation rejects ${JSON.stringify(edits)} before file access`, async () => {
    const definition = createEditToolDefinition('/unused', {
      operations: {
        access: async () => { throw new Error('Unexpected file access'); },
        readFile: async () => { throw new Error('Unexpected file read'); },
        writeFile: async () => { throw new Error('Unexpected file write'); },
      },
    });
    const input = { path: 'sample.txt', edits };
    await expect(definition.execute('invalid-edit', definition.prepareArguments!(input)))
      .rejects.toThrow('edits must contain at least one replacement');
  });
}
