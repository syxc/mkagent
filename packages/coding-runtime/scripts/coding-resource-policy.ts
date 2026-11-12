/** Preserve host trust and extension bindings over published resource algorithms. */
export function codingResourcePolicy(source: string, declarations: boolean): string {
  let body = source;
  const replace = (before: string, after: string, count = 1) => {
    if (body.split(before).length - 1 !== count) throw new Error('Published resource boundary changed: ' + before);
    body = body.replaceAll(before, after);
  };
  if (declarations) {
    body = 'import type { MissingSourceAction, PackageResolutionPolicy } from "./package-manager.js";\n'
      + 'import type { PackageSource } from "./settings-manager.js";\n' + body;
    replace('    agentDir: string;\n}): Array<{', '    agentDir: string;\n    projectTrusted?: boolean;\n}): Array<{');
    replace('export interface DefaultResourceLoaderOptions {', `export type ResourceExtensionLoader = Pick<typeof import("./extensions/loader.js"),
    "clearExtensionCache" | "createExtensionRuntime" | "loadExtensionFromFactory" | "loadExtensionsCached">;
export interface DefaultResourceLoaderOptions {
    /** Host extension bindings; defaults to the published loader. */
    extensionLoader?: ResourceExtensionLoader;
    onMissingPackage?: (source: string) => Promise<MissingSourceAction>;
    packageResolutionPolicy?: PackageResolutionPolicy;
    additionalPackageSources?: PackageSource[];
    /** Resolve authorized prompt paths after project trust is known. */
    promptSources?: () => { systemPrompt: string; appendSystemPrompt: string[] };`);
    replace('    private packageManager;', `    private packageManager;
    private extensionLoader;
    private onMissingPackage;
    private additionalPackageSources;
    private promptSources;`);
    body += '\nexport declare const dedupePrompts: (prompts: PromptTemplate[]) => { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };\n';
  } else {
    replace('function describePackageInstallFailure(failure) {',
      'function describePackageInstallFailure(failure) {\n    if (failure.skipped) return failure.message;');
    replace('/** Describe a package that was skipped because it could not be installed, including how to drop it. */',
      '/** Describe a host-policy skip or installation failure, with recovery guidance when applicable. */');
    replace('    const ancestorContextFiles = [];', '    if (options.projectTrusted === false) return contextFiles;\n    const ancestorContextFiles = [];');
    replace('    packageManager;', `    packageManager;
    extensionLoader;
    onMissingPackage;
    additionalPackageSources;
    promptSources;`);
    replace('        this.packageManager = new DefaultPackageManager({', `        this.extensionLoader = options.extensionLoader ?? { clearExtensionCache, createExtensionRuntime, loadExtensionFromFactory, loadExtensionsCached };
        this.onMissingPackage = options.onMissingPackage;
        this.additionalPackageSources = options.additionalPackageSources ?? [];
        this.promptSources = options.promptSources;
        this.packageManager = new DefaultPackageManager({`);
    replace('            builtinExtensions: [...this.builtinExtensions.keys()],',
      '            builtinExtensions: [...this.builtinExtensions.keys()],\n            resolutionPolicy: options.packageResolutionPolicy,');
    replace('await this.packageManager.resolve()', 'await this.packageManager.resolve(this.onMissingPackage, this.additionalPackageSources)', 2);
    replace('this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {\n            temporary: true,',
      'this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {\n            temporary: true,\n            onMissing: this.onMissingPackage,', 2);
    replace('        const systemPromptSource = this.systemPromptSource ?? this.discoverSystemPromptFile();',
      '        const promptSources = this.promptSources?.();\n        const systemPromptSource = promptSources?.systemPrompt ?? this.systemPromptSource ?? this.discoverSystemPromptFile();');
    replace('        let appendSources = this.appendSystemPromptSource;',
      '        let appendSources = promptSources?.appendSystemPrompt ?? this.appendSystemPromptSource;');
    const start = body.indexOf('export class DefaultResourceLoader {');
    if (start < 0) throw new Error('Published resource class changed');
    const prefix = body.slice(0, start);
    body = body.slice(start);
    for (const [name, count] of [['clearExtensionCache', 1], ['createExtensionRuntime', 1],
      ['loadExtensionFromFactory', 2], ['loadExtensionsCached', 2]] as const) {
      replace(name + '(', 'this.extensionLoader.' + name + '(', count);
    }
    body = prefix + body;
    // The published method is independent of instance state; expose its existing binding.
    const method = body.slice(body.indexOf('    dedupePrompts(prompts) {'), body.indexOf('    dedupeThemes(themes) {'));
    if (!method || /\bthis\b/.test(method)) throw new Error('Prompt deduplication now needs instance state');
    body += '\nexport const dedupePrompts = DefaultResourceLoader.prototype.dedupePrompts;\n';
  }
  return body;
}
