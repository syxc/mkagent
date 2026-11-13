/** Bind durable process policies while the SDK owns shell execution and rendering. */
import {
  createBashTool as sdkBashTool, createBashToolDefinition as sdkBashDefinition,
  createPowerShellTool as sdkPowerShellTool, createPowerShellToolDefinition as sdkPowerShellDefinition,
  createLocalBashOperations as sdkBashOperations, createLocalPowerShellOperations as sdkPowerShellOperations,
  type BashToolOptions, type PowerShellToolOptions, type ShellDependencies,
} from '@earendil-works/pi-coding-agent';
import { waitForChildProcess } from './compat/child-process.ts';
import {
  getShellConfig, getPowerShellConfig, getShellEnv, killProcessTree,
  trackDetachedChildPid, untrackDetachedChildPid,
} from './compat/shell.ts';

export type {
  BashOperations, BashSpawnContext, BashSpawnHook, BashToolDetails, BashToolInput, BashToolOptions,
  PowerShellOperations, PowerShellSpawnContext, PowerShellSpawnHook, PowerShellToolDetails,
  PowerShellToolInput, PowerShellToolOptions,
} from '@earendil-works/pi-coding-agent';

const dependencies: ShellDependencies = {
  getShellConfig, getPowerShellConfig, getShellEnv, killProcessTree,
  trackDetachedChildPid, untrackDetachedChildPid, waitForChildProcess,
};

export function createLocalBashOperations(options?: { shellPath?: string }): ReturnType<typeof sdkBashOperations> {
  return sdkBashOperations(options, dependencies);
}
export function createLocalPowerShellOperations(): ReturnType<typeof sdkPowerShellOperations> {
  return sdkPowerShellOperations(dependencies);
}
export function createBashTool(cwd: string, options?: BashToolOptions): ReturnType<typeof sdkBashTool> {
  return sdkBashTool(cwd, options, dependencies);
}
export function createBashToolDefinition(cwd: string, options?: BashToolOptions): ReturnType<typeof sdkBashDefinition> {
  return sdkBashDefinition(cwd, options, dependencies);
}
export function createPowerShellTool(cwd: string, options?: PowerShellToolOptions): ReturnType<typeof sdkPowerShellTool> {
  return sdkPowerShellTool(cwd, options, dependencies);
}
export function createPowerShellToolDefinition(cwd: string, options?: PowerShellToolOptions): ReturnType<typeof sdkPowerShellDefinition> {
  return sdkPowerShellDefinition(cwd, options, dependencies);
}
