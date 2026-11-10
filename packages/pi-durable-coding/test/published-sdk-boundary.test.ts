import { describe, expect, test } from 'bun:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as native from '../src/native.ts';
import * as compat from '../src/compat.ts';
import { codingHostImport, codingSDKImport } from '../scripts/coding-sdk-imports.ts';

describe('published Coding SDK boundary', () => {
  test('native and compatibility entry points share the published implementations', () => {
    expect(native.createEventBus).toBe(sdk.createEventBus);
    expect(compat.createEventBus).toBe(sdk.createEventBus);
    expect(native.parseFrontmatter).toBe(sdk.parseFrontmatter);
    expect(compat.stripFrontmatter).toBe(sdk.stripFrontmatter);
    expect(native.withFileMutationQueue).toBe(sdk.withFileMutationQueue);
    expect(native.createWriteTool).toBe(sdk.createWriteTool);
    expect(native.createWriteToolDefinition).toBe(sdk.createWriteToolDefinition);
    expect(native.SettingsManager).toBe(sdk.SettingsManager);
    expect(native.DefaultPackageManager).toBe(sdk.DefaultPackageManager);
    expect(native.Theme).toBe(sdk.Theme);
    expect(native.initTheme).toBe(sdk.initTheme);
    expect(native.ModelRegistry).toBe(sdk.ModelRegistry);
    expect(native.ModelRuntime).toBe(sdk.ModelRuntime);
    expect(native.CredentialSynchronizationError).toBe(sdk.CredentialSynchronizationError);
    expect(native.SessionManager).toBe(sdk.SessionManager);
    expect(native.DefaultResourceLoader).toBe(sdk.DefaultResourceLoader);
    expect(native.loadProjectContextFiles).toBe(sdk.loadProjectContextFiles);
    expect(native.createExtensionRuntime).toBe(sdk.createExtensionRuntime);
    expect(native.ExtensionRunner).toBe(sdk.ExtensionRunner);
    for (const name of ['calculateContextTokens', 'collectEntriesForBranchSummary', 'compact',
      'estimateTokens', 'findCutPoint', 'findTurnStartIndex', 'generateBranchSummary',
      'generateSummary', 'generateSummaryWithUsage', 'getLastAssistantUsage', 'prepareBranchEntries',
      'serializeConversation', 'shouldCompact', 'DEFAULT_COMPACTION_SETTINGS'] as const) {
      expect(native[name]).toBe(sdk[name]);
    }
    for (const name of ['DEFAULT_MAX_LINES', 'DEFAULT_MAX_BYTES', 'formatSize',
      'truncateHead', 'truncateTail', 'truncateLine'] as const) {
      expect(native[name]).toBe(sdk[name]);
    }
    expect(native.defineTool).toBe(sdk.defineTool);
    expect(native.createExtensionRuntime().mcpServers).toBeInstanceOf(sdk.McpServerRegistry);
    expect(native.parseFrontmatter('﻿---\r\nname: example\r\n---\r\nbody')).toEqual({
      frontmatter: { name: 'example' }, body: 'body',
    });
  });

  test('source generation stops at the SDK boundary without redirecting session adapters', () => {
    expect(codingSDKImport('core/extensions/loader.ts', '../event-bus.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/skills.ts', '../utils/frontmatter.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/tools/index.ts', './write.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/tools/index.ts', './truncate.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('extensions/mcp/tools.ts', '../../core/tools/truncate.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingHostImport('core/tools/index.ts', './read.ts')).toBe('../../../native-read-tools.ts');
    expect(codingHostImport('core/tools/index.ts', './edit.ts')).toBe('../../../native-edit-tools.ts');
    expect(codingHostImport('core/tools/index.ts', './bash.ts')).toBe('../../../native-shell-tools.ts');
    expect(codingHostImport('core/tools/index.ts', './powershell.ts')).toBe('../../../native-shell-tools.ts');
    expect(codingHostImport('index.ts', './core/tools/edit-diff.ts')).toBe('../native-edit-tools.ts');
    expect(codingSDKImport('core/sdk.ts', './settings-manager.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingHostImport('index.ts', './extensions/codemode/index.ts')).toBe('../native-codemode.ts');
    expect(codingHostImport('extensions/mcp/index.ts', '../codemode/tool.ts')).toBe('../../../native-codemode.ts');
    expect(codingSDKImport('extensions/codemode/index.ts', '../../core/settings-defaults.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/resource-loader.ts', './package-manager.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/extensions/types.ts', '../model-registry.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/extensions/loader.ts', '../mcp-servers.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/extensions/types.ts', '../keybindings.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/resource-loader.ts', '../modes/interactive/theme/theme.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/sdk.ts', './session-manager.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/sdk.ts', './resource-loader.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('index.ts', './core/compaction/index.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('modes/rpc/rpc-types.ts', '../../core/compaction/index.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/sdk.ts', './model-runtime.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/sdk.ts', './virtual-models.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/model-runtime.ts', './provider-composer.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingHostImport('core/extensions/index.ts', './loader.ts')).toBe('../../../native-extension-loader.ts');
    expect(codingHostImport('core/sdk.ts', './extensions/loader.ts')).toBe('../../native-extension-loader.ts');
    expect(codingSDKImport('core/sdk.ts', './extensions/runner.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/extensions/index.ts', './types.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingHostImport('core/extensions/index.ts', './runner.ts')).toBeUndefined();
    expect(codingSDKImport('core/sdk.ts', './agent-session.ts')).toBeUndefined();
    expect(codingSDKImport('core/sdk.ts', '@earendil-works/pi-agent-core')).toBeUndefined();
  });
});
