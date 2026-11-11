/** Bind durable execution to the public SDK session factory. */
import {
  createAgentSession as createSDKSession,
  type CreateAgentSessionOptions as SDKOptions,
  type CreateAgentSessionResult as SDKResult,
} from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { Agent, setDefaultStreamFn } from './agent-runtime.ts';
import type { DurableLoopBinding } from './durable-coding/engine.ts';
import { AgentSession } from './native-agent-session.ts';
import * as extensionLoader from './native-extension-loader.ts';
import { convertToLlm } from './native-messages.ts';
import { VERSION } from './native-config.ts';

// Extensions that construct agents directly still need the native fallback stream.
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions extends SDKOptions {
  durable?: DurableLoopBinding;
  /** Commit auxiliary writes before their events reach the host. */
  onBackgroundAction?: <T>(work: () => Promise<T>) => Promise<T>;
}
export interface CreateAgentSessionResult extends SDKResult {
  session: AgentSession;
}

export function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
  return createSDKSession(options, {
    createAgent: config => new Agent({ ...config, durable: options.durable }),
    createSession: config => new AgentSession(config),
    extensionLoader,
    convertToLlm,
    cacheWarmingAction: options.onBackgroundAction ?? (work => work()),
    identityVersion: VERSION,
  });
}

export * from './native-session-runtime.ts';
export type {
  ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionFactory,
  InlineExtension, SlashCommandInfo, SlashCommandSource, ToolDefinition,
  PromptTemplate, Skill,
} from '@earendil-works/pi-coding-agent';
export type { Tool } from './pi/core/tools/index.ts';
export {
  withFileMutationQueue, createCodingTools, createReadOnlyTools, createReadTool,
  createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool,
  createLsTool, createPowerShellTool,
} from './pi/core/tools/index.ts';
