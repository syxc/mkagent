/** Bind Native factories; selection, ordering and tool assembly belong to the SDK. */
import { createToolFactories, type ToolFactories } from '@earendil-works/pi-coding-agent';
import { createReadTool, createReadToolDefinition } from './native-read-tools.ts';
import { createEditTool, createEditToolDefinition } from './native-edit-tools.ts';
import { createFindTool, createFindToolDefinition, createGrepTool, createGrepToolDefinition } from './native-search-tools.ts';
import {
  createBashTool, createBashToolDefinition, createPowerShellTool, createPowerShellToolDefinition,
} from './native-shell-tools.ts';

export {
  allToolNames, createLsTool, createLsToolDefinition, createWriteTool, createWriteToolDefinition,
  withFileMutationQueue, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateLine, truncateTail,
  type Tool, type ToolDef, type ToolName, type ToolsOptions,
  type LsOperations, type LsToolDetails, type LsToolInput, type LsToolOptions,
  type WriteOperations, type WriteToolInput, type WriteToolOptions, type TruncationOptions, type TruncationResult,
} from '@earendil-works/pi-coding-agent';
export {
  createBashTool, createBashToolDefinition, createLocalBashOperations,
  createPowerShellTool, createPowerShellToolDefinition, createLocalPowerShellOperations,
  type BashOperations, type BashSpawnContext, type BashSpawnHook, type BashToolDetails, type BashToolInput, type BashToolOptions,
  type PowerShellOperations, type PowerShellSpawnContext, type PowerShellSpawnHook,
  type PowerShellToolDetails, type PowerShellToolInput, type PowerShellToolOptions,
} from './native-shell-tools.ts';
export {
  createReadTool, createReadToolDefinition, type ReadOperations, type ReadToolDetails, type ReadToolInput, type ReadToolOptions,
} from './native-read-tools.ts';
export {
  createEditTool, createEditToolDefinition, type EditOperations, type EditToolDetails, type EditToolInput, type EditToolOptions,
} from './native-edit-tools.ts';
export {
  createFindTool, createFindToolDefinition, type FindOperations, type FindToolDetails, type FindToolInput, type FindToolOptions,
  createGrepTool, createGrepToolDefinition, type GrepOperations, type GrepToolDetails, type GrepToolInput, type GrepToolOptions,
} from './native-search-tools.ts';

const tools = createToolFactories({
  createReadTool, createReadToolDefinition, createEditTool, createEditToolDefinition,
  createFindTool, createFindToolDefinition, createGrepTool, createGrepToolDefinition,
  createBashTool, createBashToolDefinition, createPowerShellTool, createPowerShellToolDefinition,
});
export const createToolDefinition: ToolFactories['createToolDefinition'] = tools.createToolDefinition;
export const createTool: ToolFactories['createTool'] = tools.createTool;
export const createCodingToolDefinitions: ToolFactories['createCodingToolDefinitions'] = tools.createCodingToolDefinitions;
export const createReadOnlyToolDefinitions: ToolFactories['createReadOnlyToolDefinitions'] = tools.createReadOnlyToolDefinitions;
export const createAllToolDefinitions: ToolFactories['createAllToolDefinitions'] = tools.createAllToolDefinitions;
export const createCodingTools: ToolFactories['createCodingTools'] = tools.createCodingTools;
export const createReadOnlyTools: ToolFactories['createReadOnlyTools'] = tools.createReadOnlyTools;
export const createAllTools: ToolFactories['createAllTools'] = tools.createAllTools;
