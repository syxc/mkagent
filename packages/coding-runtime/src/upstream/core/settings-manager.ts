/** Structural port boundary used by Pi's package manager; the host owns settings. */
export type PackageSource = string | {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
};

export interface ResourceSettings {
  packages?: PackageSource[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

export interface SettingsManager {
  getGlobalSettings(): ResourceSettings;
  getProjectSettings(): ResourceSettings;
  setPackages(packages: PackageSource[]): void;
  setProjectPackages(packages: PackageSource[]): void;
  isProjectTrusted(): boolean;
  getNpmCommand(): string[] | undefined;
}
