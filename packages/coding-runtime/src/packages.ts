/** Resolve Pi's package/resource conventions without installing missing sources. */
import { resolve } from 'node:path';
import { DefaultPackageManager } from '@earendil-works/pi-coding-agent';
import type { PackageSource, ResourceSettings, SettingsManager } from './upstream/core/settings-manager.ts';

export type { PackageSource, ResourceSettings } from './upstream/core/settings-manager.ts';

export interface CodingPackageOptions {
  cwd: string;
  agentDir: string;
  projectTrusted?: boolean;
  packagePaths?: PackageSource[];
  skillPaths?: string[];
  extensionPaths?: string[];
  promptPaths?: string[];
  globalSettings?: ResourceSettings;
  projectSettings?: ResourceSettings;
}

export async function resolveCodingPackages(options: CodingPackageOptions) {
  const absolute = (paths: string[] = []) => paths.map(path => resolve(options.cwd, path));
  const globalSettings: ResourceSettings = {
    ...options.globalSettings,
    packages: [...(options.globalSettings?.packages ?? []), ...(options.packagePaths ?? [])],
    skills: [...(options.globalSettings?.skills ?? []), ...absolute(options.skillPaths)],
    extensions: [...(options.globalSettings?.extensions ?? []), ...absolute(options.extensionPaths)],
    prompts: [...(options.globalSettings?.prompts ?? []), ...absolute(options.promptPaths)],
  };
  const readOnly = () => { throw new Error('Resource loading cannot change package settings.'); };
  const settingsManager: SettingsManager = {
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => options.projectTrusted ? options.projectSettings ?? {} : {},
    setPackages: readOnly,
    setProjectPackages: readOnly,
    isProjectTrusted: () => options.projectTrusted === true,
    getNpmCommand: () => undefined,
  };
  const manager = new DefaultPackageManager({ cwd: options.cwd, agentDir: options.agentDir, settingsManager }, '.pi');
  const result = await manager.resolve(async () => 'skip');
  return { ...result, installFailures: result.installFailures?.filter(failure => !failure.skipped) };
}
