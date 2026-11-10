/** Keep shared image processing while the SDK owns reading and rendering. */
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import {
  createReadTool as sdkReadTool,
  createReadToolDefinition as sdkReadDefinition,
  type ReadOperations,
  type ReadToolOptions,
} from '@earendil-works/pi-coding-agent';
import { detectSupportedImageMimeTypeFromFile } from './compat/image-mime.ts';
import { getReadmePath } from './pi/config.ts';
import { processImage } from './native-image-process.ts';

export { type ReadOperations, type ReadToolDetails, type ReadToolInput, type ReadToolOptions } from '@earendil-works/pi-coding-agent';

const operations: ReadOperations = {
  readFile: path => readFile(path),
  access: path => access(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

function readOptions(options?: ReadToolOptions): ReadToolOptions {
  return {
    autoResizeImages: options?.autoResizeImages,
    resizeOptions: options?.resizeOptions,
    operations: options?.operations ?? operations,
    processImage: options?.processImage ?? processImage,
    getReadmePath: options?.getReadmePath ?? getReadmePath,
  };
}

export function createReadTool(cwd: string, options?: ReadToolOptions): ReturnType<typeof sdkReadTool> {
  return sdkReadTool(cwd, readOptions(options));
}

export function createReadToolDefinition(cwd: string, options?: ReadToolOptions): ReturnType<typeof sdkReadDefinition> {
  return sdkReadDefinition(cwd, readOptions(options));
}
