/** Keep host module resolution while the SDK owns resource discovery and lifecycle. */
import type { ResourceExtensionLoader } from '@earendil-works/pi-coding-agent';
import {
  clearExtensionCache,
  createExtensionRuntime,
  loadExtensionFromFactory,
  loadExtensionsCached,
} from './pi/core/extensions/loader.ts';

export const resourceExtensionLoader = {
  clearExtensionCache, createExtensionRuntime, loadExtensionFromFactory, loadExtensionsCached,
} satisfies ResourceExtensionLoader;
