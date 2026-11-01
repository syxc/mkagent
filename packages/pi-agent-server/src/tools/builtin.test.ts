import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createBuiltinTools } from './builtin';

const context: Context = {
  abortSignal: new AbortController().signal,
  telemetry: BACKGROUND_CONTEXT.telemetry,
  value: () => undefined,
  toString: () => 'read-image-test',
};

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

describe('builtin read tool images', () => {
  it('rescales large images to the model limits and reports the change', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mkagent-read-image-'));
    try {
      writeFileSync(join(directory, 'large.bmp'), bmp(300, 180));
      const read = createBuiltinTools(directory).find(tool => tool.name === 'read');
      if (!read) throw new Error('read tool is missing');
      const api = {
        env: new NodeExecutionEnv({ cwd: directory }),
        callId: 'call-1',
        agent: async () => ({ model: { provider: 'test', modelId: 'test' } }),
        models: { getModel: () => ({ input: ['image'], inputLimits: { images: { resize: { maxWidth: 100, maxHeight: 100 } } } }) },
      } as unknown as ToolExecutionApi;

      const result = await read.execute({ path: 'large.bmp' }, api, context);
      const image = result.output?.find(part => part.type === 'image');
      expect(result.isError).toBeFalsy();
      expect(image?.type).toBe('image');
      if (image?.type !== 'image') throw new Error('read returned no image');
      const png = Buffer.from(image.data, 'base64');
      expect(png.readUInt32BE(16)).toBeLessThanOrEqual(100);
      expect(png.readUInt32BE(20)).toBeLessThanOrEqual(100);
      expect(JSON.stringify(result.diagnostics)).toContain('300x180');
      expect(JSON.stringify(result.diagnostics)).toContain('100x60');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('converts a BMP to an inline image instead of rejecting it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mkagent-read-image-'));
    try {
      writeFileSync(join(directory, 'pixel.bmp'), bmp(2, 2));
      const env = new NodeExecutionEnv({ cwd: directory });
      const read = createBuiltinTools(directory).find(tool => tool.name === 'read');
      if (!read) throw new Error('read tool is missing');
      const api = {
        env,
        callId: 'call-1',
        agent: async () => ({ model: undefined }),
        models: { getModel: () => undefined },
      } as unknown as ToolExecutionApi;

      const result = await read.execute({ path: 'pixel.bmp' }, api, context);
      const image = result.output?.find(part => part.type === 'image');

      expect(result.isError).toBeFalsy();
      expect(image?.type).toBe('image');
      if (image?.type === 'image') expect(image.mimeType).toBe('image/png');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
