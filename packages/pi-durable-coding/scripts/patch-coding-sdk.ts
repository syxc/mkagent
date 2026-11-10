/** Rebuild narrow SDK exports and host package policy options from pristine releases. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codingPackagePolicy } from './coding-package-policy.ts';
import { codingSessionPolicy } from './coding-session-policy.ts';
import { codingResourcePolicy } from './coding-resource-policy.ts';
import { codingExtensionPolicy } from './coding-extension-policy.ts';
import { codingModelRuntimePolicy } from './coding-model-runtime-policy.ts';
import { codingRunnerPolicy } from './coding-runner-policy.ts';
import { codingAgentSessionPolicy } from './coding-agent-session-policy.ts';
import { codingToolPolicy } from './coding-tool-policy.ts';
import { codingShellPolicy } from './coding-shell-policy.ts';
import { codingCodemodePolicy } from './coding-codemode-policy.ts';
import { codingUIPolicy } from './coding-ui-policy.ts';
import { codingImagePolicy } from './coding-image-policy.ts';

const [published, mode] = process.argv.slice(2);
if (!published || !['--write', '--check'].includes(mode!)) {
  throw new Error('Usage: bun patch-coding-sdk.ts /pristine-coding-sdk --write|--check');
}
const baseline = resolve(published);
const info = JSON.parse(readFileSync(join(baseline, 'package.json'), 'utf8'));
if (info.name !== '@earendil-works/pi-coding-agent' || info.version !== '1.5.0') {
  throw new Error('Expected published pi-coding-agent 1.5.0');
}
const root = resolve(import.meta.dir, '../../..');
const patchPath = join(root, 'patches/@earendil-works%2Fpi-coding-agent@1.5.0.patch');
const manifestPath = join(import.meta.dir, '../CODING-PATCH.json');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const replace = (source: string, before: string, after: string) => {
  if (source.split(before).length !== 2) throw new Error('Published settings boundary changed: ' + before);
  return source.replace(before, after);
};
const outputs = new Map<string, string>();
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/index.${suffix}`;
  let original = readFileSync(join(baseline, path), 'utf8');
  if (suffix === 'd.ts') original = replace(original, ' KeybindingsManager,', '');
  if (original.includes('export * from "./core/settings-manager.')) throw new Error('Expected unpatched SDK');
  const extension = suffix === 'js' ? 'js' : 'ts';
  const exports = [
    `export * from "./core/agent-session.${extension}";`,
    `export * from "./core/settings-manager.${extension}";`,
    `export { SETTINGS_DEFAULTS } from "./core/settings-defaults.${extension}";`,
    `export * from "./core/package-manager.${extension}";`,
    `export * from "./core/model-registry.${extension}";`,
    `export * from "./core/model-runtime.${extension}";`,
    `export * from "./core/models-store.${extension}";`,
    `export { composeModelProvider, resolveCompatibilityRequestConfig, validateExtensionProvider } from "./core/provider-composer.${extension}";`,
    `export * from "./core/virtual-models.${extension}";`,
    `export * from "./core/session-manager.${extension}";`,
    `export * from "./core/resource-loader.${extension}";`,
    `export * from "./core/extensions/loader.${extension}";`,
    `export * from "./core/extensions/runner.${extension}";`,
    `export * from "./core/extensions/types.${extension}";`,
    `export * from "./core/exec.${extension}";`,
    `export * from "./core/tools/tool-definition-wrapper.${extension}";`,
    `export * from "./extensions/codemode/tool.${extension}";`,
    ...['grep', 'find', 'ls'].map(name => `export * from "./core/tools/${name}.${extension}";`),
    `export * from "./core/export-html/index.${extension}";`,
    `export * from "./core/export-html/ansi-to-html.${extension}";`,
    `export * from "./core/export-html/tool-renderer.${extension}";`,
    `export * from "./utils/sleep.${extension}";`,
    `export * from "./utils/zip.${extension}";`,
    `export * from "./core/mcp-servers.${extension}";`,
    `export * from "./core/keybindings.${extension}";`,
    `export { KeybindingsManager } from "./core/keybindings.${extension}";`,
    `export * from "./modes/interactive/theme/theme.${extension}";`,
    `export { AuthUrlComponent } from "./modes/interactive/components/auth-url.${extension}";`,
    `export { VisualLinePreview } from "./modes/interactive/components/visual-truncate.${extension}";`,
    `export { createImageConverters } from "./utils/image-convert.${extension}";`,
    `export { getThemesDir, getExportTemplateDir } from "./config.${extension}";`,
  ].join('\n') + '\n';
  const marker = '//# sourceMappingURL=';
  const position = original.indexOf(marker);
  if (position < 0) throw new Error('Published index source map marker changed');
  outputs.set(path, original.slice(0, position) + exports + original.slice(position));
  if (suffix === 'd.ts') outputs.set(path, outputs.get(path)!.replace(marker,
    'export type { ShellDependencies } from "./core/tools/bash.ts";\n' + marker));
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/utils/image-convert.${suffix}`;
  outputs.set(path, codingImagePolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
}
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/modes/interactive/components/tool-execution.${suffix}`;
  outputs.set(path, codingUIPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
}
for (const name of ['tool', 'index']) for (const suffix of ['js', 'd.ts']) {
  const path = `dist/extensions/codemode/${name}.${suffix}`;
  outputs.set(path, codingCodemodePolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts', name === 'index'));
}
for (const name of ['bash', 'powershell']) for (const suffix of ['js', 'd.ts']) {
  const path = `dist/core/tools/${name}.${suffix}`;
  outputs.set(path, codingShellPolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts', name === 'powershell'));
}
const managerPath = 'dist/core/settings-manager.js';
outputs.set(managerPath, replace(readFileSync(join(baseline, managerPath), 'utf8'),
  'function deepMergeSettings(base, overrides) {', 'export function deepMergeSettings(base, overrides) {'));
const typesPath = 'dist/core/settings-manager.d.ts';
outputs.set(typesPath, replace(readFileSync(join(baseline, typesPath), 'utf8'),
  'export type SettingsScope =',
  'export declare function deepMergeSettings(base: Settings, overrides: Settings): Settings;\nexport type SettingsScope ='));
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/core/package-manager.${suffix}`;
  outputs.set(path, codingPackagePolicy(readFileSync(join(baseline, path), 'utf8'), suffix === 'd.ts'));
  const sessionPath = `dist/core/session-manager.${suffix}`;
  outputs.set(sessionPath, codingSessionPolicy(readFileSync(join(baseline, sessionPath), 'utf8'), suffix === 'd.ts'));
  const resourcePath = `dist/core/resource-loader.${suffix}`;
  outputs.set(resourcePath, codingResourcePolicy(readFileSync(join(baseline, resourcePath), 'utf8'), suffix === 'd.ts'));
  const extensionPath = `dist/core/extensions/loader.${suffix}`;
  outputs.set(extensionPath, codingExtensionPolicy(readFileSync(join(baseline, extensionPath), 'utf8'), suffix === 'd.ts'));
  const runtimePath = `dist/core/model-runtime.${suffix}`;
  outputs.set(runtimePath, codingModelRuntimePolicy(readFileSync(join(baseline, runtimePath), 'utf8'), suffix === 'd.ts'));
  const agentSessionPath = `dist/core/agent-session.${suffix}`;
  outputs.set(agentSessionPath, codingAgentSessionPolicy(readFileSync(join(baseline, agentSessionPath), 'utf8'), suffix === 'd.ts'));
  const runnerPath = `dist/core/extensions/runner.${suffix}`;
  outputs.set(runnerPath, codingRunnerPolicy(readFileSync(join(baseline, runnerPath), 'utf8'), suffix === 'd.ts'));
  const toolPath = `dist/core/tools/tool-definition-wrapper.${suffix}`;
  outputs.set(toolPath, codingToolPolicy(readFileSync(join(baseline, toolPath), 'utf8'), suffix === 'd.ts'));
}
for (const name of ['grep', 'find']) {
  const tool = name === 'grep' ? 'rg' : 'fd';
  const type = name === 'grep' ? 'GrepToolOptions' : 'FindToolOptions';
  const jsPath = `dist/core/tools/${name}.js`;
  let implementation = replace(readFileSync(join(baseline, jsPath), 'utf8'),
    `await ensureTool("${tool}")`, `await (options?.ensureTool ?? ensureTool)("${tool}")`);
  if (name === 'grep') {
    const abort = `                        if (signal?.aborted) {
                            settle(() => reject(new Error("Operation aborted")));
                            return;
                        }
`;
    // An asynchronous host resolver or directory operation can outlive cancellation.
    implementation = replace(implementation, '                        if (!rgPath) {', abort + '                        if (!rgPath) {');
    implementation = replace(implementation, '                        const contextValue =', abort + '                        const contextValue =');
  }
  outputs.set(jsPath, implementation);
  const declarationPath = `dist/core/tools/${name}.d.ts`;
  const declaration = replace(readFileSync(join(baseline, declarationPath), 'utf8'),
    `export interface ${type} {`, `export interface ${type} {\n    /** Resolve binaries with the host's installation and offline policy. */\n    ensureTool?: typeof ensureTool;`);
  outputs.set(declarationPath, 'import type { ensureTool } from "../../utils/tools-manager.ts";\n' + declaration);
}
const readPath = 'dist/core/tools/read.js';
let read = replace(readFileSync(join(baseline, readPath), 'utf8'),
  'await processImage(buffer, mimeType, {', 'await (options?.processImage ?? processImage)(buffer, mimeType, {');
read = replace(read, 'import { readRenderers }', 'import { createReadRenderers, readRenderers }');
read = replace(read, '    const ops = options?.operations ?? defaultReadOperations;',
  '    const ops = options?.operations ?? defaultReadOperations;\n    const getReadmePath = options?.getReadmePath;');
outputs.set(readPath, replace(read, '        ...readRenderers,',
  '        ...(getReadmePath ? createReadRenderers(getReadmePath) : readRenderers),'));
const readTypesPath = 'dist/core/tools/read.d.ts';
outputs.set(readTypesPath, 'import type { processImage } from "../../utils/image-process.ts";\n' + replace(
  readFileSync(join(baseline, readTypesPath), 'utf8'), 'export interface ReadToolOptions {',
  'export interface ReadToolOptions {\n    /** Process images with the host shared image runtime. */\n    processImage?: typeof processImage;\n    /** Locate host documentation for compact read presentation. */\n    getReadmePath?: () => string;'));
const readRendererPath = 'dist/core/tools/renderers/read.js';
let readRenderer = replace(readFileSync(join(baseline, readRendererPath), 'utf8'),
  'import { getReadmePath }', 'import { getReadmePath as defaultGetReadmePath }');
readRenderer = replace(readRenderer, 'function getPiDocsClassification(absolutePath) {',
  'export function createReadRenderers(getReadmePath = defaultGetReadmePath) {\nfunction getPiDocsClassification(absolutePath) {');
readRenderer = replace(readRenderer, 'export const readRenderers = {', 'return {');
outputs.set(readRendererPath, replace(readRenderer, '};\n//# sourceMappingURL=',
  '};\n}\nexport const readRenderers = createReadRenderers();\n//# sourceMappingURL='));
const readRendererTypesPath = 'dist/core/tools/renderers/read.d.ts';
outputs.set(readRendererTypesPath, replace(readFileSync(join(baseline, readRendererTypesPath), 'utf8'),
  'export declare const readRenderers:',
  'export declare function createReadRenderers(getReadmePath?: () => string): typeof readRenderers;\nexport declare const readRenderers:'));
const extensionTypesPath = 'dist/core/extensions/types.d.ts';
outputs.set(extensionTypesPath, replace(readFileSync(join(baseline, extensionTypesPath), 'utf8'),
  'export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {',
  'export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {\n    /** Only tools explicitly safe to repeat may resume an uncertain durable execution. */\n    replay?: "safe" | "never";'));
const composerPath = 'dist/core/provider-composer.d.ts';
outputs.set(composerPath, replace(readFileSync(join(baseline, composerPath), 'utf8'),
  'modelConfig: ModelConfig,', 'modelConfig: Pick<ModelConfig, "getProvider">,'));
// Registry implementations only call public runtime operations; host ownership stays structural.
const registryPath = 'dist/core/model-registry.d.ts';
outputs.set(registryPath, replace(readFileSync(join(baseline, registryPath), 'utf8'),
  'constructor(runtime: ModelRuntime);', 'constructor(runtime: Pick<ModelRuntime, keyof ModelRuntime>);'));
const themeValidationComment = ` * Install full theme validation. Without it, documents are accepted as-is, which is what built-in
 * themes already do: validating user-authored JSON needs typebox, and a presentation that only uses
 * built-in themes should not pay ~17 MB of module graph for it.`;
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/modes/interactive/theme/theme.${suffix}`;
  let body = replace(readFileSync(join(baseline, path), 'utf8'), themeValidationComment,
    ' * Replace the default full theme validator. File loading validates without CLI initialization.');
  if (suffix === 'js') {
    body = replace(body, 'let themeJsonValidator;',
      'let themeJsonValidator = validateThemeJson;');
    body = 'import { validateThemeJson } from "./theme-schema.js";\n' + body;
  }
  outputs.set(path, body);
}
const schemaComment = ` * Theme JSON validation, kept out of \`theme.ts\` on purpose.
 *
 * Validating user-authored theme files needs typebox, which costs ~17 MB of module graph to import.
 * Palette lookup does not, so a presentation that only uses built-in themes should never pay for it.
 * \`main.ts\` installs this validator before runtime resource loading; other consumers can opt in with
 * \`setThemeJsonValidator()\`. Built-in themes do not need validation.`;
for (const suffix of ['js', 'd.ts']) {
  const path = `dist/modes/interactive/theme/theme-schema.${suffix}`;
  outputs.set(path, replace(readFileSync(join(baseline, path), 'utf8'), schemaComment,
    ' * Full theme JSON validation. The SDK theme module enables it by default.\n * Hosts can replace it with setThemeJsonValidator().'));
}
const configPath = 'dist/config.js';
let config = readFileSync(join(baseline, configPath), 'utf8');
for (const [name, directory] of [['getThemesDir', 'theme'], ['getExportTemplateDir', 'export-html']]) {
  config = replace(config, `export function ${name}() {`, `export function ${name}() {
    // The host distributes SDK assets beside its worker bundle.
    const bundled = join(isBunBinary ? dirname(process.execPath) : __dirname, "coding-assets", "${directory}");
    if (existsSync(bundled)) return bundled;`);
}
outputs.set(configPath, config);
const sleepPath = 'dist/utils/sleep.js';
let sleep = readFileSync(join(baseline, sleepPath), 'utf8');
sleep = replace(sleep, '        const timeout = setTimeout(resolve, ms);', `        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const timeout = setTimeout(() => { cleanup(); resolve(); }, ms);`);
sleep = replace(sleep, '        signal?.addEventListener("abort", () => {', '        const onAbort = () => {\n            cleanup();');
sleep = replace(sleep, '        });\n    });', '        };\n        signal?.addEventListener("abort", onAbort, { once: true });\n    });');
outputs.set(sleepPath, sleep);
const imagePath = 'dist/utils/image-resize.js';
outputs.set(imagePath, replace(readFileSync(join(baseline, imagePath), 'utf8'), `    // Bun compiled executables resolve worker entrypoints by string path, not via
    // new URL(..., import.meta.url). Try the string path first under Bun so the
    // release binary uses the embedded worker instead of falling back in-process.
    if (typeof process.versions.bun === "string") {
        try {
            return await resizeImageInWorker("./src/utils/image-resize-worker.ts", inputBytes, mimeType, options);
        }
        catch { }
    }
`, '    // A project directory cannot supply executable image workers. Use the module URL or process locally.\n'));
const staging = mkdtempSync(join(tmpdir(), 'coding-sdk-exports-'));
let patch = '';
for (const [path, output] of outputs) {
  const candidate = join(staging, path.replaceAll('/', '-'));
  writeFileSync(candidate, output);
  const diff = Bun.spawnSync(['git', 'diff', '--no-index', '--no-color', '--unified=3', '--', join(baseline, path), candidate]);
  if (diff.exitCode !== 1) throw new Error('Cannot create export patch: ' + diff.stderr.toString());
  const lines = diff.stdout.toString().split('\n');
  const start = lines.findIndex(line => line.startsWith('@@'));
  if (start < 0) throw new Error('Missing export patch hunk');
  patch += `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${lines.slice(start).join('\n')}`;
}
patch = `# Content SHA-256: ${hash(patch)}\n${patch}`;
const manifest = JSON.stringify({
  repository: 'https://github.com/earendil-works/pi',
  revision: 'f9a26365568127461c47a07a37dcb42c140a3ac5',
  version: '1.5.0',
  patch: 'coding-sdk-host-boundaries-v1',
  policy: 'Export existing settings, package, keybinding, theme, registry, session and resource contracts. Preserve published algorithms; add host package policies, structural runtime constructor typing, context projection callbacks, legacy session factories, resource trust and extension bindings, per-importer plugin caches and module import hooks, host discovery paths, live host model and shared credential binding with memory-only overlays, structural provider config typing, per-runner theme and prompt bindings, session tool and action callbacks, protected durable execution and input admission hooks, optional nested tool executor, internal model message projection and prompt and read-tool image processing bindings and host read-renderer documentation paths, host input metadata and summary stream bindings, optional durable tool replay typing and tool conversion metadata with symbol descriptors, module-relative executable image workers, default full theme validation, existing HTML, sleep and ZIP module exports, optional host search binary resolution, post-await grep cancellation checks and existing search tool exports, optional codemode executor binding and existing codemode presentation exports, optional host shell configuration, environment, process waiting, termination and tracking dependencies, sleep listener cleanup, and installed worker theme and HTML asset lookup.',
  files: [...outputs].map(([path, output]) => ({
    path, originalSha256: hash(readFileSync(join(baseline, path), 'utf8')), sha256: hash(output),
  })),
}, null, 2) + '\n';
if (mode === '--check') {
  if (readFileSync(patchPath, 'utf8') !== patch || readFileSync(manifestPath, 'utf8') !== manifest) {
    throw new Error('Coding SDK export patch or inventory differs');
  }
} else {
  writeFileSync(patchPath, patch);
  writeFileSync(manifestPath, manifest);
}
console.log(`Validated ${outputs.size} Coding SDK patch files; ${mode}.`);
