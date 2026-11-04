/** Host-owned paths and trust over the complete native Pi resource loader. */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CodingResourceOptions } from './resources.ts';
import type { EventBus } from './pi/core/event-bus.ts';
import type { InlineExtension } from './pi/core/extensions/types.ts';
import {
  DefaultResourceLoader,
  loadProjectContextFiles,
  type DefaultResourceLoaderOptions,
} from './pi/core/resource-loader.ts';
import {
  FileSettingsStorage,
  SettingsManager,
  type Settings,
  type SettingsScope,
  type SettingsStorage,
} from './pi/core/settings-manager.ts';

export interface HostResourceOptions extends Omit<CodingResourceOptions, 'globalSettings' | 'projectSettings'> {
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
}

/** Keep native settings methods while choosing host files, profile scopes, or a storage port. */
export function createHostSettingsManager(options: Pick<HostResourceOptions,
  'cwd' | 'agentDir' | 'projectTrusted' | 'globalSettings' | 'projectSettings' | 'settingsStorage'
>): SettingsManager {
  const trust = { projectTrusted: options.projectTrusted === true };
  if (!options.settingsStorage && options.globalSettings === undefined && options.projectSettings === undefined) {
    return SettingsManager.create(options.cwd, options.agentDir, trust);
  }
  const files = options.settingsStorage ?? new FileSettingsStorage(options.cwd, options.agentDir);
  const profiles: Partial<Record<SettingsScope, string>> = {};
  if (options.globalSettings !== undefined) profiles.global = JSON.stringify(options.globalSettings);
  if (options.projectSettings !== undefined) profiles.project = JSON.stringify(options.projectSettings);
  return SettingsManager.fromStorage({
    withLock(scope, fn) {
      if (profiles[scope] === undefined) return files.withLock(scope, fn);
      const next = fn(profiles[scope]);
      if (next !== undefined) profiles[scope] = next;
    },
  }, trust);
}

class HostResourceLoader extends DefaultResourceLoader {
  private readonly hostSystemPrompt?: () => string | undefined;

  constructor(options: DefaultResourceLoaderOptions, hostSystemPrompt?: () => string | undefined) {
    super(options);
    this.hostSystemPrompt = hostSystemPrompt;
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
  settingsManager: SettingsManager;
} {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir);
  const settingsManager = createHostSettingsManager({ ...options, cwd, agentDir });
  const promptPath = (name: string) => {
    const directories = [
      ...(settingsManager.isProjectTrusted() ? [join(cwd, '.pi')] : []),
      agentDir,
    ];
    return directories.map(directory => join(directory, name)).find(path => existsSync(path));
  };
  const resourceLoader = new HostResourceLoader({
    cwd, agentDir, settingsManager,
    eventBus: options.eventBus,
    extensionFactories: options.extensionFactories,
    additionalPackageSources: options.packagePaths,
    additionalExtensionPaths: options.extensionPaths,
    additionalSkillPaths: options.skillPaths,
    additionalPromptTemplatePaths: options.promptPaths,
    additionalThemePaths: options.themePaths,
    noExtensions: options.noExtensions,
    noSkills: options.noSkills,
    noPromptTemplates: options.noPromptTemplates,
    noThemes: options.noThemes,
    disabledBuiltinExtensions: options.disabledBuiltinExtensions,
    onMissingPackage: async () => 'skip',
    packageResolutionPolicy: {
      refreshTemporary: false, legacyGlobalPackages: false, includeHomeSkills: false,
    },
    noContextFiles: true,
    agentsFilesOverride: () => ({
      agentsFiles: loadProjectContextFiles({ cwd, agentDir, projectTrusted: settingsManager.isProjectTrusted() }),
    }),
    systemPrompt: '',
    appendSystemPrompt: [],
    promptSources: () => {
      const append = promptPath('APPEND_SYSTEM.md');
      return { systemPrompt: promptPath('SYSTEM.md') ?? '', appendSystemPrompt: append ? [append] : [] };
    },
  }, options.getSystemPrompt);
  return { resourceLoader, settingsManager };
}
