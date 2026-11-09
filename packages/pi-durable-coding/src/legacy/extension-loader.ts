/** Preserve the legacy module surface and explicit host directory requirement. */
import { createHostExtensionLoader } from '../host-extension-loader.ts';
import { getExtensionModules } from '../extension-modules.ts';
import { CONFIG_DIR_NAME, getAgentDir } from '../upstream/config.ts';

export const {
  clearExtensionCache, createExtensionRuntime, discoverAndLoadExtensions,
  loadExtensionFromFactory, loadExtensions, loadExtensionsCached,
} = createHostExtensionLoader(getExtensionModules, CONFIG_DIR_NAME, getAgentDir);
