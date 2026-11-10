/** Bind host plugin imports and durable sessions to the public service factories. */
import {
  createAgentSessionServices as createSDKServices,
  createAgentSessionFromServices as createSDKSession,
  type CreateAgentSessionServicesOptions,
  type CreateAgentSessionFromServicesOptions,
} from '@earendil-works/pi-coding-agent';
import * as extensionLoader from './native-extension-loader.ts';
import { createAgentSession } from './native-sdk.ts';

export type {
  AgentSessionRuntimeDiagnostic, AgentSessionServices,
  CreateAgentSessionServicesOptions, CreateAgentSessionFromServicesOptions,
} from '@earendil-works/pi-coding-agent';

export function createAgentSessionServices(options: CreateAgentSessionServicesOptions) {
  return createSDKServices({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime,
    modelRuntimeSignal: options.modelRuntimeSignal,
    settingsManager: options.settingsManager,
    extensionFlagValues: options.extensionFlagValues,
    resourceLoaderReloadOptions: options.resourceLoaderReloadOptions,
    resourceLoaderOptions: { extensionLoader, ...options.resourceLoaderOptions },
  });
}

export function createAgentSessionFromServices(options: CreateAgentSessionFromServicesOptions) {
  return createSDKSession(options, createAgentSession);
}
