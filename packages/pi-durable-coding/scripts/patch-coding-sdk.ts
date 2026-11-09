/** Rebuild narrow SDK exports and host package policy options from pristine releases. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codingPackagePolicy } from './coding-package-policy.ts';
import { codingSessionPolicy } from './coding-session-policy.ts';
import { codingResourcePolicy } from './coding-resource-policy.ts';

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
    `export * from "./core/settings-manager.${extension}";`,
    `export { SETTINGS_DEFAULTS } from "./core/settings-defaults.${extension}";`,
    `export * from "./core/package-manager.${extension}";`,
    `export * from "./core/model-registry.${extension}";`,
    `export * from "./core/session-manager.${extension}";`,
    `export * from "./core/resource-loader.${extension}";`,
    `export * from "./core/mcp-servers.${extension}";`,
    `export * from "./core/keybindings.${extension}";`,
    `export * from "./modes/interactive/theme/theme.${extension}";`,
    `export { getThemesDir } from "./config.${extension}";`,
  ].join('\n') + '\n';
  const marker = '//# sourceMappingURL=';
  const position = original.indexOf(marker);
  if (position < 0) throw new Error('Published index source map marker changed');
  outputs.set(path, original.slice(0, position) + exports + original.slice(position));
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
}
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
outputs.set(configPath, replace(readFileSync(join(baseline, configPath), 'utf8'),
  'export function getThemesDir() {', `export function getThemesDir() {
    // The host distributes SDK theme assets beside its worker bundle.
    const bundled = join(isBunBinary ? dirname(process.execPath) : __dirname, "coding-assets", "theme");
    if (existsSync(bundled)) return bundled;`));
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
  policy: 'Export existing settings, package, keybinding, theme, registry, session and resource contracts. Preserve published algorithms; add host package policies, structural runtime constructor typing, context projection callbacks, legacy session factories, resource trust and extension bindings, default full theme validation and installed worker theme asset lookup.',
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
