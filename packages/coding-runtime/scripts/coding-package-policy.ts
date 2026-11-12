/** Add host discovery, scope and ownership options to the published package manager. */
export function codingPackagePolicy(source: string, declarations: boolean): string {
  let body = source;
  const replace = (before: string, after: string, count = 1) => {
    if (body.split(before).length - 1 !== count) throw new Error('Published package policy boundary changed: ' + before);
    body = body.replaceAll(before, after);
  };
  if (declarations) {
    replace('import type { SettingsManager }', 'import type { PackageSource, SettingsManager }');
    replace('export interface PackageInstallFailure {', 'export interface PackageInstallFailure {\n    skipped?: boolean;');
    replace('resolve(onMissing?: (source: string) => Promise<MissingSourceAction>)',
      'resolve(onMissing?: (source: string) => Promise<MissingSourceAction>, additionalSources?: PackageSource[])', 2);
    replace('temporary?: boolean;\n    }', 'temporary?: boolean;\n        onMissing?: (source: string) => Promise<MissingSourceAction>;\n    }', 2);
    replace('update(source?: string)', 'update(source?: string, options?: { local?: boolean })', 2);
    replace('interface PackageManagerOptions {', `export interface PackageResolutionPolicy {
    /** Disable refreshes of cached temporary npm/git sources during discovery. */
    refreshTemporary?: boolean;
    /** Disable legacy global npm lookup outside agentDir. */
    legacyGlobalPackages?: boolean;
    /** Disable implicit HOME/.agents/skills discovery. Explicit paths still work. */
    includeHomeSkills?: boolean;
    /** Keep package subprocess output out of the host protocol stream. */
    commandOutput?: "stderr";
}
type PackageSettings = Pick<SettingsManager,
    "getGlobalSettings" | "getProjectSettings" | "setPackages" | "setProjectPackages" | "isProjectTrusted" | "getNpmCommand">;
interface PackageManagerOptions {
    resolutionPolicy?: PackageResolutionPolicy;`);
    replace('settingsManager: SettingsManager;', 'settingsManager: PackageSettings;');
    replace('constructor(options: PackageManagerOptions);', 'constructor(options: PackageManagerOptions, projectConfigDir?: string);');
    replace('    private builtinExtensions;', '    private builtinExtensions;\n    private projectConfigDir;\n    private resolutionPolicy;');
    replace('    private runWithConcurrency;', '    private settleTasks;\n    private runWithConcurrency;');
    replace('/** Configured packages that were skipped because installing them failed. */',
      '/** Configured packages omitted by host policy or failed installation. */');
    replace('/** A configured package that could not be installed while resolving resources. */',
      '/** A configured package omitted while resolving resources, with a failure or skip reason. */');
  } else {
    replace('    builtinExtensions;', '    builtinExtensions;\n    projectConfigDir;\n    resolutionPolicy;');
    replace('constructor(options) {', `constructor(options, projectConfigDir = CONFIG_DIR_NAME) {
        this.projectConfigDir = projectConfigDir;
        this.resolutionPolicy = options.resolutionPolicy ?? {};`);
    replace('this.cwd, CONFIG_DIR_NAME', 'this.cwd, this.projectConfigDir', 5);
    replace('async resolve(onMissing) {', 'async resolve(onMissing, additionalSources) {');
    replace('        const packageSources = this.dedupePackages(allPackages);\n        const installFailures',
      '        for (const pkg of additionalSources ?? []) allPackages.push({ pkg, scope: "user" });\n        const packageSources = this.dedupePackages(allPackages);\n        const installFailures');
    replace('this.resolvePackageSources(packageSources, accumulator);', 'this.resolvePackageSources(packageSources, accumulator, options?.onMissing);');
    replace('async update(source) {\n        const globalSettings = this.settingsManager.getGlobalSettings();\n        const projectSettings = this.settingsManager.getProjectSettings();',
      `async update(source, options) {
        const globalSettings = options?.local === true ? {} : this.settingsManager.getGlobalSettings();
        if (options?.local) this.assertProjectTrustedForScope("project");
        const projectSettings = options?.local === false ? {} : this.settingsManager.getProjectSettings();`);
    replace('        await Promise.all(tasks);', '        await this.settleTasks(tasks);');
    replace('        await Promise.all(Array.from({ length: workerCount }, () => worker()));',
      '        await this.settleTasks(Array.from({ length: workerCount }, () => worker()));');
    replace('    async runWithConcurrency(tasks, limit) {', `    /** Drain every started installer before reporting a batch failure to its owner. */
    async settleTasks(tasks) {
        for (const result of await Promise.allSettled(tasks)) {
            if (result.status === "rejected") throw result.reason;
        }
    }
    async runWithConcurrency(tasks, limit) {`);
    replace('                if (isOfflineModeEnabled())\n                    return false;\n                if (onMissing) {', '                if (onMissing) {');
    replace('                    if (action === "skip")\n                        return false;', `                    if (action === "skip") {
                        installFailures.push({
                            source: resolvedSource, scope: resolvedScope, skipped: true,
                            message: "Package is missing or does not match its configured version; skipped by the host resource policy.",
                        });
                        return false;
                    }`);
    replace('                // A source that cannot be installed (no network, missing package, failing git prepare step)',
      '                if (isOfflineModeEnabled()) return false;\n                // A source that cannot be installed (no network, missing package, failing git prepare step)');
    replace('                if (!needsInstall &&', '                if (this.resolutionPolicy.refreshTemporary !== false && !needsInstall &&');
    replace('else if (resolvedScope === "temporary" && !isOfflineModeEnabled()) {',
      'else if (this.resolutionPolicy.refreshTemporary !== false && resolvedScope === "temporary" && !isOfflineModeEnabled()) {');
    replace('if (scope !== "user" || existsSync(managedPath)) {',
      'if (this.resolutionPolicy.legacyGlobalPackages === false || scope !== "user" || existsSync(managedPath)) {');
    replace('collectAutoSkillEntries(userAgentsSkillsDir, "agents"),',
      'this.resolutionPolicy.includeHomeSkills === false ? [] : collectAutoSkillEntries(userAgentsSkillsDir, "agents"),');
    replace('stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",',
      'stdio: this.resolutionPolicy.commandOutput === "stderr" || isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",');
  }
  return body;
}
