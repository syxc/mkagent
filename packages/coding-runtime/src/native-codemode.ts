/** Bind durable execution while the Coding SDK owns tool presentation and registration. */
import {
  createCodemodeExtension as sdkExtension, createCodemodeTool as sdkTool,
  createCodemodeToolDefinition as sdkDefinition, type CodemodeDependencies,
  type CodemodeExtensionOptions, type CodemodeToolOptions,
} from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-coding-agent';

export {
  CODEMODE_DOCS_PATH, CODEMODE_STORE_ENTRY_TYPE, CODEMODE_TOOL_NAME,
  DEFAULT_CODEMODE_INLINE_BUDGET, codemodeSchema, codemodeToolSystemPromptContribution,
  createCodemodeDescription, getCodemodeCallableTools, toCodemodeDeclaration,
} from '@earendil-works/pi-coding-agent';
export type {
  CodemodeDescriptionOptions, CodemodeExtensionOptions, CodemodeModelRuntime,
  CodemodeNestedCall, CodemodeNestedCallStatus, CodemodeStoreEntryData,
  CodemodeToolDetails, CodemodeToolInput, CodemodeToolOptions,
} from '@earendil-works/pi-coding-agent';

const dependencies: CodemodeDependencies = {
  executeCodemode: async (...args) => (await import('./compat/codemode-native.ts')).executeNativeCodemode(...args),
};

export function createCodemodeToolDefinition(options?: CodemodeToolOptions): ReturnType<typeof sdkDefinition> {
  return sdkDefinition(options, dependencies);
}
export function createCodemodeTool(tools?: readonly AgentTool<any>[], options?: CodemodeToolOptions): ReturnType<typeof sdkTool> {
  return sdkTool(tools, options, dependencies);
}
export function createCodemodeExtension(options?: CodemodeExtensionOptions): ReturnType<typeof sdkExtension> {
  return sdkExtension(options, dependencies);
}
