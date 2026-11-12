/** Keep host binary policy while the published SDK owns search and rendering. */
import {
  createFindTool as sdkFindTool,
  createFindToolDefinition as sdkFindDefinition,
  createGrepTool as sdkGrepTool,
  createGrepToolDefinition as sdkGrepDefinition,
  createToolManager,
  type FindToolOptions,
  type GrepToolOptions,
} from '@earendil-works/pi-coding-agent';
import { extractZipArchive } from './compat/archive.ts';
import { writeDownload } from './compat/download.ts';
import { getBinDir, VERSION } from './native-config.ts';

const { ensureTool } = createToolManager({ getBinDir, version: VERSION, extractZipArchive, writeDownload });

export {
  type FindOperations, type FindToolDetails, type FindToolInput, type FindToolOptions,
  type GrepOperations, type GrepToolDetails, type GrepToolInput, type GrepToolOptions,
  findToolSystemPromptContribution, grepToolSystemPromptContribution, relativizeFindResultPath,
} from '@earendil-works/pi-coding-agent';

export function createFindTool(cwd: string, options?: FindToolOptions): ReturnType<typeof sdkFindTool> {
  return sdkFindTool(cwd, { operations: options?.operations, ensureTool: options?.ensureTool ?? ensureTool });
}

export function createFindToolDefinition(cwd: string, options?: FindToolOptions): ReturnType<typeof sdkFindDefinition> {
  return sdkFindDefinition(cwd, { operations: options?.operations, ensureTool: options?.ensureTool ?? ensureTool });
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): ReturnType<typeof sdkGrepTool> {
  return sdkGrepTool(cwd, { operations: options?.operations, ensureTool: options?.ensureTool ?? ensureTool });
}

export function createGrepToolDefinition(cwd: string, options?: GrepToolOptions): ReturnType<typeof sdkGrepDefinition> {
  return sdkGrepDefinition(cwd, { operations: options?.operations, ensureTool: options?.ensureTool ?? ensureTool });
}
