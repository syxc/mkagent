/** Explicit host resource policies over the pinned native loading algorithms. */
export function portResourceLoader(path: string, source: string): string {
  let body = source;
  const replace = (before: string, after: string, count = 1) => {
    if (body.split(before).length - 1 !== count) throw new Error(`Pinned resource port changed: ${path}: ${before}`);
    body = body.replaceAll(before, after);
  };

  if (path === 'core/skills.ts' || path === 'core/prompt-templates.ts') {
    const name = path === 'core/skills.ts' ? 'loadSkills' : 'loadPromptTemplates';
    const options = path === 'core/skills.ts' ? 'LoadSkillsOptions' : 'LoadPromptTemplatesOptions';
    const result = path === 'core/skills.ts' ? 'LoadSkillsResult' : 'LoadPromptTemplatesResult';
    replace(`export function ${name}(options: ${options}): ${result} {`,
      `export function ${name}(options: ${options}, projectConfigDir = CONFIG_DIR_NAME): ${result} {`);
    replace('resolve(resolvedCwd, CONFIG_DIR_NAME,', 'resolve(resolvedCwd, projectConfigDir,', path === 'core/skills.ts' ? 2 : 1);
  } else if (path === 'core/resource-loader.ts') {
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
  }
  return body;
}
