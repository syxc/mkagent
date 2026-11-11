/** Stop source traversal where the published Coding SDK supplies the complete contract. */
import { posix } from 'node:path';

export const CODING_SDK_PACKAGE = '@earendil-works/pi-coding-agent';

export const CODING_SDK_MODULES = new Set([
  'cli/args.ts',
  'core/auth-storage.ts',
  'core/cache-warmer.ts',
  'core/compaction/index.ts',
  'core/diagnostics.ts',
  'core/event-bus.ts',
  'core/exec.ts',
  'core/extensions/runner.ts',
  'core/extensions/types.ts',
  'core/footer-data-provider.ts',
  'core/keybindings.ts',
  'core/mcp-servers.ts',
  'core/model-registry.ts',
  'core/model-resolver.ts',
  'core/model-runtime.ts',
  'core/models-store.ts',
  'core/provider-composer.ts',
  'core/virtual-models.ts',
  'core/package-manager.ts',
  'core/session-manager.ts',
  'core/resource-loader.ts',
  'core/settings-manager.ts',
  'core/settings-defaults.ts',
  'core/skills.ts',
  'core/prompt-templates.ts',
  'core/system-prompt.ts',
  'core/slash-commands.ts',
  'core/source-info.ts',
  'core/timings.ts',
  'core/trust-manager.ts',
  'core/usage-totals.ts',
  'core/tools/file-mutation-queue.ts',
  'core/tools/ls.ts',
  'core/tools/render-utils.ts',
  'core/tools/tool-definition-wrapper.ts',
  'core/tools/truncate.ts',
  'core/tools/write.ts',
  'extensions/mcp/config.ts',
  'extensions/mcp/index.ts',
  'extensions/mcp/oauth.ts',
  'modes/json-event.ts',
  'modes/rpc/rpc-types.ts',
  'modes/interactive/components/auth-url.ts',
  'modes/interactive/components/dynamic-border.ts',
  'modes/interactive/components/keybinding-hints.ts',
  'modes/interactive/components/visual-truncate.ts',
  'modes/interactive/theme/theme.ts',
  'utils/clipboard.ts',
  'utils/frontmatter.ts',
  'utils/output-files.ts',
  'utils/paths.ts',
  'utils/text.ts',
]);

/** Keep host module resolution in an authored adapter, outside the generated SDK closure. */
export function codingHostImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const module = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const host = module === 'config.ts' ? 'native-config.ts'
    : module === 'core/extensions/loader.ts' ? 'native-extension-loader.ts'
    : module === 'core/agent-session-services.ts' ? 'native-session-services.ts'
    : module === 'core/agent-session-runtime.ts' ? 'native-session-runtime.ts'
    : module === 'core/sdk.ts' ? 'native-sdk.ts'
    : module === 'core/messages.ts' ? 'native-messages.ts'
    : module === 'core/agent-session.ts' ? 'native-agent-session.ts'
    : module === 'core/tools/grep.ts' || module === 'core/tools/find.ts' ? 'native-search-tools.ts'
    : module === 'core/tools/read.ts' ? 'native-read-tools.ts'
    : module === 'core/tools/edit.ts' || module === 'core/tools/edit-diff.ts' ? 'native-edit-tools.ts'
    : module === 'core/tools/bash.ts' || module === 'core/tools/powershell.ts' ? 'native-shell-tools.ts'
    : module === 'extensions/codemode/index.ts' || module === 'extensions/codemode/tool.ts' ? 'native-codemode.ts'
    : module === 'extensions/tool-search/index.ts' || module === 'extensions/tool-search/tool.ts' ? 'native-tool-search.ts'
    : module === 'modes/index.ts' || module === 'modes/rpc/rpc-client.ts' ? 'compat/rpc-client.ts'
    : module === 'utils/shell.ts' ? 'compat/shell.ts'
    : module === 'utils/child-process.ts' ? 'compat/child-process.ts'
    : module === 'utils/mime.ts' ? 'compat/image-mime.ts'
    : module === 'utils/image-convert.ts' ? 'native-image-convert.ts'
    : module === 'utils/image-process.ts' || module === 'utils/image-resize.ts' ? 'native-image-process.ts'
    : module === 'modes/interactive/components/index.ts' || module === 'modes/interactive/components/tool-execution.ts' ? 'native-ui.ts' : undefined;
  if (!host) return undefined;
  const target = posix.relative(posix.dirname('pi/' + importer), host);
  return target.startsWith('.') ? target : './' + target;
}

export function codingSDKImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(importer), specifier));
  return CODING_SDK_MODULES.has(target) ? CODING_SDK_PACKAGE : undefined;
}
