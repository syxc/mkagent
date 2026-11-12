/** Keep host module identities and transpilation over the SDK loader lifecycle. */
import {
  clearExtensionCache, createExtensionRuntime, discoverAndLoadExtensions,
  loadExtensionFromFactory, loadExtensions, loadExtensionsCached,
  type EventBus, type ExtensionLoaderOptions, type ExtensionModuleOverrides, type ExtensionRuntime,
} from '@earendil-works/pi-coding-agent';
import { preparePluginTranspiler } from './plugin-transpiler.ts';

export function createHostExtensionLoader(
  modules: () => ExtensionModuleOverrides | Promise<ExtensionModuleOverrides>,
  projectConfigDir: string,
  getAgentDir: () => string,
) {
  const options: ExtensionLoaderOptions = {
    projectConfigDir,
    modules,
    prepareImporter: preparePluginTranspiler,
  };
  return {
    clearExtensionCache: () => clearExtensionCache(options),
    createExtensionRuntime,
    loadExtensionFromFactory,
    loadExtensions: (paths: string[], cwd: string, eventBus?: EventBus, runtime?: ExtensionRuntime) =>
      loadExtensions(paths, cwd, eventBus, runtime, options),
    loadExtensionsCached: (paths: string[], cwd: string, eventBus?: EventBus, runtime?: ExtensionRuntime) =>
      loadExtensionsCached(paths, cwd, eventBus, runtime, options),
    discoverAndLoadExtensions: (paths: string[], cwd: string, agentDir = getAgentDir(), eventBus?: EventBus) =>
      discoverAndLoadExtensions(paths, cwd, agentDir, eventBus, options),
  };
}
