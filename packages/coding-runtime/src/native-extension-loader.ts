/** Bind the native Coding module table without loading its circular barrel at startup. */
import type { ExtensionModuleOverrides } from '@earendil-works/pi-coding-agent';
import { createHostExtensionLoader } from './host-extension-loader.ts';
import { CONFIG_DIR_NAME, getAgentDir } from './native-config.ts';

let modules: Promise<ExtensionModuleOverrides> | undefined;
export const {
  clearExtensionCache, createExtensionRuntime, discoverAndLoadExtensions,
  loadExtensionFromFactory, loadExtensions, loadExtensionsCached,
} = createHostExtensionLoader(
  () => modules ??= Promise.all([import('./pi/index.ts'), import('./agent-runtime.ts')])
    .then(([codingAgent, agentCore]) => ({ codingAgent, agentCore })),
  CONFIG_DIR_NAME, getAgentDir,
);
