import { describe, expect, test } from 'bun:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as native from '../src/native.ts';
import * as compat from '../src/compat.ts';
import { codingSDKImport } from '../scripts/coding-sdk-imports.ts';

describe('published Coding SDK boundary', () => {
  test('native and compatibility entry points share the published implementations', () => {
    expect(native.createEventBus).toBe(sdk.createEventBus);
    expect(compat.createEventBus).toBe(sdk.createEventBus);
    expect(native.parseFrontmatter).toBe(sdk.parseFrontmatter);
    expect(compat.stripFrontmatter).toBe(sdk.stripFrontmatter);
    expect(native.withFileMutationQueue).toBe(sdk.withFileMutationQueue);
    expect(native.SettingsManager).toBe(sdk.SettingsManager);
    expect(native.DefaultPackageManager).toBe(sdk.DefaultPackageManager);
    expect(native.Theme).toBe(sdk.Theme);
    expect(native.initTheme).toBe(sdk.initTheme);
    expect(native.ModelRegistry).toBe(sdk.ModelRegistry);
    expect(native.SessionManager).toBe(sdk.SessionManager);
    expect(native.createExtensionRuntime().mcpServers).toBeInstanceOf(sdk.McpServerRegistry);
    expect(native.parseFrontmatter('﻿---\r\nname: example\r\n---\r\nbody')).toEqual({
      frontmatter: { name: 'example' }, body: 'body',
    });
  });

  test('source generation stops at the SDK boundary without redirecting session adapters', () => {
    expect(codingSDKImport('core/extensions/loader.ts', '../event-bus.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/skills.ts', '../utils/frontmatter.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/sdk.ts', './settings-manager.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('extensions/codemode/index.ts', '../../core/settings-defaults.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/resource-loader.ts', './package-manager.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/extensions/types.ts', '../model-registry.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/extensions/loader.ts', '../mcp-servers.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/extensions/types.ts', '../keybindings.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/resource-loader.ts', '../modes/interactive/theme/theme.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/sdk.ts', './session-manager.ts')).toBe('@earendil-works/pi-coding-agent');
    expect(codingSDKImport('core/sdk.ts', './agent-session.ts')).toBeUndefined();
    expect(codingSDKImport('core/sdk.ts', '@earendil-works/pi-agent-core')).toBeUndefined();
  });
});
