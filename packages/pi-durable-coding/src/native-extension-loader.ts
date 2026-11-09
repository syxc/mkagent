/** Bind the native Coding module table without loading its circular barrel at startup. */
import { createHostExtensionLoader } from './host-extension-loader.ts';
import { CONFIG_DIR_NAME, getAgentDir } from './pi/config.ts';

let modules: Promise<Record<string, unknown>> | undefined;
export const {
  clearExtensionCache, createExtensionRuntime, discoverAndLoadExtensions,
  loadExtensionFromFactory, loadExtensions, loadExtensionsCached,
} = createHostExtensionLoader(
  () => modules ??= import('./pi/core/extensions/virtual-modules.ts').then(module => module.VIRTUAL_MODULES),
  CONFIG_DIR_NAME, getAgentDir,
);
