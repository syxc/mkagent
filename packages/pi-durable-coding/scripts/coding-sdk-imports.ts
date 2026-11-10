/** Stop source traversal where the published Coding SDK supplies the complete contract. */
import { posix } from 'node:path';

export const CODING_SDK_PACKAGE = '@earendil-works/pi-coding-agent';

export const CODING_SDK_MODULES = new Set([
  'core/diagnostics.ts',
  'core/event-bus.ts',
  'core/exec.ts',
  'core/extensions/runner.ts',
  'core/extensions/types.ts',
  'core/keybindings.ts',
  'core/mcp-servers.ts',
  'core/model-registry.ts',
  'core/model-runtime.ts',
  'core/models-store.ts',
  'core/provider-composer.ts',
  'core/virtual-models.ts',
  'core/package-manager.ts',
  'core/session-manager.ts',
  'core/resource-loader.ts',
  'core/settings-manager.ts',
  'core/settings-defaults.ts',
  'core/tools/file-mutation-queue.ts',
  'core/tools/ls.ts',
  'core/tools/tool-definition-wrapper.ts',
  'core/tools/write.ts',
  'modes/interactive/theme/theme.ts',
  'utils/frontmatter.ts',
]);

/** Keep host module resolution in an authored adapter, outside the generated SDK closure. */
export function codingHostImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const module = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const host = module === 'core/extensions/loader.ts' ? 'native-extension-loader.ts'
    : module === 'core/agent-session.ts' ? 'native-agent-session.ts'
    : module === 'core/tools/grep.ts' || module === 'core/tools/find.ts' ? 'native-search-tools.ts'
    : module === 'core/tools/read.ts' ? 'native-read-tools.ts'
    : module === 'core/tools/edit.ts' || module === 'core/tools/edit-diff.ts' ? 'native-edit-tools.ts'
    : module === 'core/tools/bash.ts' || module === 'core/tools/powershell.ts' ? 'native-shell-tools.ts'
    : module === 'extensions/codemode/index.ts' || module === 'extensions/codemode/tool.ts' ? 'native-codemode.ts' : undefined;
  if (!host) return undefined;
  const target = posix.relative(posix.dirname('pi/' + importer), host);
  return target.startsWith('.') ? target : './' + target;
}

export function codingSDKImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(importer), specifier));
  return CODING_SDK_MODULES.has(target) ? CODING_SDK_PACKAGE : undefined;
}
