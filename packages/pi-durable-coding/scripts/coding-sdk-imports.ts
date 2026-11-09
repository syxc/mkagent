/** Stop source traversal where the published Coding SDK supplies the complete contract. */
import { posix } from 'node:path';

export const CODING_SDK_PACKAGE = '@earendil-works/pi-coding-agent';

export const CODING_SDK_MODULES = new Set([
  'core/diagnostics.ts',
  'core/event-bus.ts',
  'core/keybindings.ts',
  'core/mcp-servers.ts',
  'core/model-registry.ts',
  'core/package-manager.ts',
  'core/session-manager.ts',
  'core/settings-manager.ts',
  'core/settings-defaults.ts',
  'core/tools/file-mutation-queue.ts',
  'modes/interactive/theme/theme.ts',
  'utils/frontmatter.ts',
]);

export function codingSDKImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(importer), specifier));
  return CODING_SDK_MODULES.has(target) ? CODING_SDK_PACKAGE : undefined;
}
