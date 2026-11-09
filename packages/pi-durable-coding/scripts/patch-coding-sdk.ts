/** Rebuild narrow SDK exports and host package policy options from pristine releases. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codingPackagePolicy } from './coding-package-policy.ts';

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
  const original = readFileSync(join(baseline, path), 'utf8');
  if (original.includes('export * from "./core/settings-manager.')) throw new Error('Expected unpatched SDK');
  const extension = suffix === 'js' ? 'js' : 'ts';
  const exports = `export * from "./core/settings-manager.${extension}";\nexport { SETTINGS_DEFAULTS } from "./core/settings-defaults.${extension}";\nexport * from "./core/package-manager.${extension}";\n`;
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
}
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
  patch: 'settings-exports-and-package-policy-v1',
  policy: 'Export existing settings and package contracts. Preserve published settings algorithms and package algorithms; add only host discovery, project directory, update scope, protocol output and installer drain options.',
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
