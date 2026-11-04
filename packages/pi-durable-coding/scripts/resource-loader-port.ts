/** Explicit host resource policies over the pinned native loading algorithms. */
export function portResourceLoader(path: string, source: string): string {
  let body = source;
  const replace = (before: string, after: string, count = 1) => {
    if (body.split(before).length - 1 !== count) throw new Error(`Pinned resource port changed: ${path}: ${before}`);
    body = body.replaceAll(before, after);
  };

  if (path === 'core/resource-loader.ts') {
    replace('\ttype PackageInstallFailure,', '\ttype PackageInstallFailure,\n\ttype MissingSourceAction,\n\ttype PackageResolutionPolicy,');
    replace('import { SettingsManager }', 'import { type PackageSource, SettingsManager }');
    replace('function describePackageInstallFailure(failure: PackageInstallFailure): string {',
      'function describePackageInstallFailure(failure: PackageInstallFailure): string {\n\tif (failure.skipped) return failure.message;');
    replace('/** Describe a package that was skipped because it could not be installed, including how to drop it. */',
      '/** Describe a host-policy skip or installation failure, with recovery guidance when applicable. */');
    replace('export function loadProjectContextFiles(options: {\n\tcwd: string;\n\tagentDir: string;',
      'export function loadProjectContextFiles(options: {\n\tcwd: string;\n\tagentDir: string;\n\tprojectTrusted?: boolean;');
    replace('\tconst ancestorContextFiles: Array<{ path: string; content: string }> = [];',
      '\tif (options.projectTrusted === false) return contextFiles;\n\n\tconst ancestorContextFiles: Array<{ path: string; content: string }> = [];');
    replace('export interface DefaultResourceLoaderOptions {', `export interface DefaultResourceLoaderOptions {
\t/** Host policy applies to configured and explicit sources, including the trust bootstrap pass. */
\tonMissingPackage?: (source: string) => Promise<MissingSourceAction>;
\tpackageResolutionPolicy?: PackageResolutionPolicy;
\tadditionalPackageSources?: PackageSource[];
\t/** Re-evaluate authorized paths after trust resolution, without fallback discovery. */
\tpromptSources?: () => { systemPrompt: string; appendSystemPrompt: string[] };`);
    replace('\tprivate packageManager: DefaultPackageManager;', `\tprivate packageManager: DefaultPackageManager;
\tprivate onMissingPackage?: (source: string) => Promise<MissingSourceAction>;
\tprivate additionalPackageSources: PackageSource[];
\tprivate promptSources?: DefaultResourceLoaderOptions["promptSources"];`);
    replace('\t\tthis.packageManager = new DefaultPackageManager({', `\t\tthis.onMissingPackage = options.onMissingPackage;
\t\tthis.additionalPackageSources = options.additionalPackageSources ?? [];
\t\tthis.promptSources = options.promptSources;
\t\tthis.packageManager = new DefaultPackageManager({`);
    replace('\t\t\tbuiltinExtensions: [...this.builtinExtensions.keys()],',
      '\t\t\tbuiltinExtensions: [...this.builtinExtensions.keys()],\n\t\t\tresolutionPolicy: options.packageResolutionPolicy,');
    replace('await this.packageManager.resolve()', 'await this.packageManager.resolve(this.onMissingPackage, this.additionalPackageSources)', 2);
    replace('this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {\n\t\t\ttemporary: true,',
      'this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {\n\t\t\ttemporary: true,\n\t\t\tonMissing: this.onMissingPackage,', 2);
    replace('\t\tconst systemPromptSource = this.systemPromptSource ?? this.discoverSystemPromptFile();',
      '\t\tconst promptSources = this.promptSources?.();\n\t\tconst systemPromptSource = promptSources?.systemPrompt ?? this.systemPromptSource ?? this.discoverSystemPromptFile();');
    replace('\t\tlet appendSources = this.appendSystemPromptSource;',
      '\t\tlet appendSources = promptSources?.appendSystemPrompt ?? this.appendSystemPromptSource;');
  } else if (path === 'core/package-manager.ts') {
    replace('/** Configured packages that were skipped because installing them failed. */',
      '/** Configured packages omitted by host policy or failed installation. */');
    replace('/** A configured package that could not be installed while resolving resources. */',
      '/** A configured package omitted while resolving resources, with a failure or skip reason. */');
    replace('export interface PackageInstallFailure {', 'export interface PackageInstallFailure {\n\tskipped?: boolean;');
    replace('resolve(onMissing?: (source: string) => Promise<MissingSourceAction>)',
      'resolve(onMissing?: (source: string) => Promise<MissingSourceAction>, additionalSources?: PackageSource[])', 2);
    replace('options?: { local?: boolean; temporary?: boolean },',
      'options?: { local?: boolean; temporary?: boolean; onMissing?: (source: string) => Promise<MissingSourceAction> },', 2);
    replace('interface PackageManagerOptions {', `export interface PackageResolutionPolicy {
\t/** Disable refreshes of cached temporary npm/git sources during discovery. */
\trefreshTemporary?: boolean;
\t/** Disable legacy global npm lookup, which invokes the package manager outside agentDir. */
\tlegacyGlobalPackages?: boolean;
\t/** Disable implicit HOME/.agents/skills discovery. Explicit configured paths still work. */
\tincludeHomeSkills?: boolean;
}

interface PackageManagerOptions {
\tresolutionPolicy?: PackageResolutionPolicy;`);
    replace('\tprivate builtinExtensions: string[];',
      '\tprivate builtinExtensions: string[];\n\tprivate resolutionPolicy: PackageResolutionPolicy;');
    replace('\t\tthis.builtinExtensions = options.builtinExtensions ?? [];',
      '\t\tthis.builtinExtensions = options.builtinExtensions ?? [];\n\t\tthis.resolutionPolicy = options.resolutionPolicy ?? {};');
    replace('\t\tconst packageSources = this.dedupePackages(allPackages);\n\t\tconst installFailures',
      '\t\tfor (const pkg of additionalSources ?? []) allPackages.push({ pkg, scope: "user" });\n\t\tconst packageSources = this.dedupePackages(allPackages);\n\t\tconst installFailures');
    replace('this.resolvePackageSources(packageSources, accumulator);',
      'this.resolvePackageSources(packageSources, accumulator, options?.onMissing);');
    replace('\t\t\t\tif (isOfflineModeEnabled()) return false;\n\t\t\t\tif (onMissing) {',
      '\t\t\t\tif (onMissing) {');
    replace('\t\t\t\t// A source that cannot be installed (no network, missing package, failing git prepare step)',
      '\t\t\t\tif (isOfflineModeEnabled()) return false;\n\t\t\t\t// A source that cannot be installed (no network, missing package, failing git prepare step)');
    replace('\t\t\t\t\tif (action === "skip") return false;', `\t\t\t\t\tif (action === "skip") {
\t\t\t\t\t\tinstallFailures.push({
\t\t\t\t\t\t\tsource: resolvedSource, scope: resolvedScope, skipped: true,
\t\t\t\t\t\t\tmessage: "Package is missing or does not match its configured version; skipped by the host resource policy.",
\t\t\t\t\t\t});
\t\t\t\t\t\treturn false;
\t\t\t\t\t}`);
    replace('\t\t\t\t\t!needsInstall &&', '\t\t\t\t\tthis.resolutionPolicy.refreshTemporary !== false &&\n\t\t\t\t\t!needsInstall &&');
    replace('} else if (resolvedScope === "temporary" && !isOfflineModeEnabled()) {',
      '} else if (this.resolutionPolicy.refreshTemporary !== false && resolvedScope === "temporary" && !isOfflineModeEnabled()) {');
    replace('if (scope !== "user" || existsSync(managedPath)) {',
      'if (this.resolutionPolicy.legacyGlobalPackages === false || scope !== "user" || existsSync(managedPath)) {');
    replace('collectAutoSkillEntries(userAgentsSkillsDir, "agents"),',
      'this.resolutionPolicy.includeHomeSkills === false ? [] : collectAutoSkillEntries(userAgentsSkillsDir, "agents"),');
  }
  return body;
}
