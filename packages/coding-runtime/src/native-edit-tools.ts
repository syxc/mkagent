/** Keep durable argument repair while the SDK owns editing and rendering. */
import {
  createEditTool as sdkEditTool,
  createEditToolDefinition as sdkEditDefinition,
  type EditToolOptions,
} from '@earendil-works/pi-coding-agent';
import { createEditTool as durableEditTool } from '@earendil-works/pi-durable/tools';

export { type EditDiffResult, type EditOperations, type EditToolDetails, type EditToolInput, type EditToolOptions } from '@earendil-works/pi-coding-agent';
export { generateDiffString, generateUnifiedPatch } from '@earendil-works/pi-durable/tools';

const prepareArguments = durableEditTool().prepareArguments;

export function createEditTool(cwd: string, options?: EditToolOptions): ReturnType<typeof sdkEditTool> {
  return Object.assign(sdkEditTool(cwd, options), { prepareArguments });
}

export function createEditToolDefinition(cwd: string, options?: EditToolOptions): ReturnType<typeof sdkEditDefinition> {
  return Object.assign(sdkEditDefinition(cwd, options), { prepareArguments });
}
