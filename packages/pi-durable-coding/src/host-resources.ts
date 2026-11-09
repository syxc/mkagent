/** Host-owned paths and trust over the complete native Pi resource loader. */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CodingResourceOptions } from './resources.ts';
import { createHostPackageExtension } from './host-package-commands.ts';
import { withHostCompactionPolicy, type HostSettingsManager } from './host-settings.ts';
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { InlineExtension } from './pi/core/extensions/types.ts';
import {
  DefaultResourceLoader,
  loadProjectContextFiles,
  type DefaultResourceLoaderOptions,
  type ResourceLoaderReloadOptions,
} from '@earendil-works/pi-coding-agent';
import * as resourceExtensionLoader from './native-extension-loader.ts';
import {
  FileSettingsStorage,
  SettingsManager,
  type Settings,
  type SettingsScope,
  type SettingsStorage,
} from "@earendil-works/pi-coding-agent";

export interface HostResourceOptions extends Omit<CodingResourceOptions, 'globalSettings' | 'projectSettings'> {
  /** Host-only disables ambient Pi discovery; explicit host paths and factories remain available. */
  resourcePolicy?: 'native' | 'host-only';
  /** A supplied scope replaces that scope's file and keeps native writes in session memory. */
  globalSettings?: Settings;
  projectSettings?: Settings;
  /** Optional host persistence port for scopes not replaced by profile settings. */
  settingsStorage?: SettingsStorage;
  /** Read on each getSystemPrompt() call, so the host can update its base prompt. */
  getSystemPrompt?: () => string | undefined;
  eventBus?: EventBus;
  extensionFactories?: InlineExtension[];
  themePaths?: string[];
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  disabledBuiltinExtensions?: string[];
  /** Re-evaluate host trust before each native reload, including newly added project resources. */
  resolveProjectTrust?: ResourceLoaderReloadOptions['resolveProjectTrust'];
}

/** Keep native settings methods while choosing host files, profile scopes, or a storage port. */
export function createHostSettingsManager(options: Pick<HostResourceOptions,
  'cwd' | 'agentDir' | 'projectTrusted' | 'globalSettings' | 'projectSettings' | 'settingsStorage' | 'resourcePolicy'
>): HostSettingsManager {
  const trust = { projectTrusted: options.projectTrusted === true };
  const hostOnly = options.resourcePolicy === 'host-only';
  if (!hostOnly && !options.settingsStorage && options.globalSettings === undefined && options.projectSettings === undefined) {
    return withHostCompactionPolicy(SettingsManager.create(options.cwd, options.agentDir, trust));
  }
  const files = options.settingsStorage ?? new FileSettingsStorage(options.cwd, options.agentDir);
  const profiles: Partial<Record<SettingsScope, string>> = {};
  for (const scope of ['global', 'project'] as const) {
    const supplied = scope === 'global' ? options.globalSettings : options.projectSettings;
    if (supplied !== undefined) profiles[scope] = JSON.stringify(supplied);
    else if (hostOnly && !options.settingsStorage) profiles[scope] = '{}';
  }
  return withHostCompactionPolicy(SettingsManager.fromStorage({
    withLock(scope, fn) {
      if (profiles[scope] === undefined) return files.withLock(scope, fn);
      const next = fn(profiles[scope]);
      if (next !== undefined) profiles[scope] = next;
    },
  }, trust));
}

class HostResourceLoader extends DefaultResourceLoader {
  private readonly hostSystemPrompt?: () => string | undefined;

  constructor(options: DefaultResourceLoaderOptions, hostSystemPrompt?: () => string | undefined,
    private readonly resolveProjectTrust?: ResourceLoaderReloadOptions['resolveProjectTrust']) {
    super(options);
    this.hostSystemPrompt = hostSystemPrompt;
  }

  override reload(options?: ResourceLoaderReloadOptions): Promise<void> {
    return super.reload(this.resolveProjectTrust ? { ...options, resolveProjectTrust: this.resolveProjectTrust } : options);
  }

  override getSystemPrompt(): string | undefined {
    const parts = [this.hostSystemPrompt?.(), super.getSystemPrompt()].filter(
      (part): part is string => part !== undefined && part !== '',
    );
    return parts.length ? parts.join('\n\n') : undefined;
  }
}

/** Construct without loading; the session owner calls reload() and owns extension lifecycle events. */
export function createHostResources(options: HostResourceOptions): {
  resourceLoader: DefaultResourceLoader;
  settingsManager: HostSettingsManager;
} {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir);
  const discover = options.resourcePolicy !== 'host-only';
  const settingsManager = createHostSettingsManager({ ...options, cwd, agentDir });
  const promptPath = (name: string) => {
    if (!discover) return undefined;
    const directories = [
      ...(settingsManager.isProjectTrusted() ? [join(cwd, '.pi')] : []),
      agentDir,
    ];
    return directories.map(directory => join(directory, name)).find(path => existsSync(path));
  };
  const resourceLoader = new HostResourceLoader({
    cwd, agentDir, settingsManager,
    extensionLoader: resourceExtensionLoader,
    eventBus: options.eventBus,
    extensionFactories: [
      ...(options.extensionFactories ?? []),
      ...(discover ? [createHostPackageExtension({ cwd, agentDir, settingsManager })] : []),
    ],
    additionalPackageSources: options.packagePaths,
    additionalExtensionPaths: options.extensionPaths,
    additionalSkillPaths: options.skillPaths,
    additionalPromptTemplatePaths: options.promptPaths,
    additionalThemePaths: options.themePaths,
    noExtensions: !discover || options.noExtensions,
    noSkills: !discover || options.noSkills,
    noPromptTemplates: !discover || options.noPromptTemplates,
    noThemes: !discover || options.noThemes,
    disabledBuiltinExtensions: options.disabledBuiltinExtensions,
    onMissingPackage: async () => 'skip',
    packageResolutionPolicy: {
      refreshTemporary: false, legacyGlobalPackages: false, includeHomeSkills: false, commandOutput: 'stderr',
    },
    noContextFiles: true,
    agentsFilesOverride: () => ({
      agentsFiles: discover
        ? loadProjectContextFiles({ cwd, agentDir, projectTrusted: settingsManager.isProjectTrusted() }) : [],
    }),
    systemPrompt: '',
    appendSystemPrompt: [],
    promptSources: () => {
      const append = promptPath('APPEND_SYSTEM.md');
      return { systemPrompt: promptPath('SYSTEM.md') ?? '', appendSystemPrompt: append ? [append] : [] };
    },
  }, options.getSystemPrompt, options.resolveProjectTrust);
  return { resourceLoader, settingsManager };
}
