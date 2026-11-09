/** Keep host module identities and transpilation over the SDK loader lifecycle. */
import {
  clearExtensionCache, createExtensionRuntime, discoverAndLoadExtensions,
  loadExtensionFromFactory, loadExtensions, loadExtensionsCached,
  type EventBus, type ExtensionLoaderOptions, type ExtensionRuntime,
} from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti/static';
import { preparePluginTranspiler } from './plugin-transpiler.ts';

export function createHostExtensionLoader(
  modules: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  projectConfigDir: string,
  getAgentDir: () => string,
) {
  const options: ExtensionLoaderOptions = {
    projectConfigDir,
    async importModule(extensionPath) {
      const jiti = createJiti(import.meta.url, {
        moduleCache: false, virtualModules: await modules(), tryNative: false,
      });
      preparePluginTranspiler(jiti);
      return jiti.import(extensionPath, { default: true });
    },
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
