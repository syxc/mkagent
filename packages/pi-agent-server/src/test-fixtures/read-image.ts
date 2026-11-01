/**
 * Runs from a single-file bundle in a directory without node_modules: proves the
 * read tool loads Photon's wasm beside the bundle. Prints one JSON line.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createBuiltinTools } from '../tools/builtin.ts';

/** A 24-bit BMP, a format providers do not take inline, so read must convert it. */
function bmp(width: number, height: number): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const file = Buffer.alloc(54 + pixelBytes);
  file.write('BM', 0, 'ascii');
  file.writeUInt32LE(file.length, 2);
  file.writeUInt32LE(54, 10);
  file.writeUInt32LE(40, 14);
  file.writeInt32LE(width, 18);
  file.writeInt32LE(height, 22);
  file.writeUInt16LE(1, 26);
  file.writeUInt16LE(24, 28);
  file.writeUInt32LE(pixelBytes, 34);
  for (let index = 0; index < pixelBytes; index++) file[54 + index] = index % 2 === 0 ? 0xc0 : 0x40;
  return file;
}

const directory = mkdtempSync(join(tmpdir(), 'mkagent-bundled-read-'));
writeFileSync(join(directory, 'pixel.bmp'), bmp(2, 2));
const env = new NodeExecutionEnv({ cwd: directory });
const read = createBuiltinTools(directory).find(tool => tool.name === 'read');
if (!read) throw new Error('read tool is missing');
const context = {
  abortSignal: new AbortController().signal,
  telemetry: BACKGROUND_CONTEXT.telemetry,
  value: () => undefined,
  toString: () => 'bundled-read-image',
};
const api = {
  env,
  callId: 'call-1',
  agent: async () => ({ model: undefined }),
  models: { getModel: () => undefined },
};
const result = await read.execute({ path: 'pixel.bmp' }, api as never, context as never);
const image = result.output?.find((part: { type: string }) => part.type === 'image') as { mimeType?: string } | undefined;
console.log(JSON.stringify({ isError: result.isError ?? false, mimeType: image?.mimeType ?? null }));
if (result.isError || image?.mimeType !== 'image/png') process.exit(1);
