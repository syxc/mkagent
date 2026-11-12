import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getThemesDir, getExportTemplateDir } from '@earendil-works/pi-coding-agent';
import { getQuickJSWasmPath } from '@earendil-works/pi-durable/codemode/node';
import { readHtmlVendorSource } from '../../coding-runtime/src/compat/html-assets.ts';

const packageDir = dirname(import.meta.dir);
const outdir = join(packageDir, 'dist');
const durableRequire = createRequire(import.meta.resolveSync('@earendil-works/pi-durable'));

const build = await Bun.build({
  entrypoints: [join(packageDir, 'src/index.ts'), join(packageDir, 'src/tools/codemode-worker.ts')],
  outdir,
  naming: '[name].[ext]',
  target: 'bun',
  format: 'esm',
  external: ['koffi'],
});
if (!build.success) {
  for (const message of build.logs) console.error(message);
  process.exit(1);
}

mkdirSync(outdir, { recursive: true });
copyFileSync(getQuickJSWasmPath(), join(outdir, 'quickjs.wasm'));
// read resolves this beside the bundle; source mode falls back to the package.
copyFileSync(durableRequire.resolve('@silvia-odwyer/photon/photon_rs_bg.wasm'), join(outdir, 'photon_rs_bg.wasm'));
rmSync(join(outdir, 'coding_photon_rs_bg.wasm'), { force: true });
copyFileSync(join(packageDir, '..', 'coding-runtime', 'LICENSE.pi'), join(outdir, 'LICENSE.pi'));
cpSync(getThemesDir(), join(outdir, 'coding-assets', 'theme'), {
  recursive: true, filter: path => !/\.[cm]?[jt]s(?:\.map)?$/.test(path),
});
for (const name of ['template.html', 'template.css', 'template.js', 'vendor/marked-cjk-friendly.min.js']) {
  const target = join(outdir, 'coding-assets', 'export-html', name);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(getExportTemplateDir(), name), target);
}
for (const name of ['marked.min.js', 'highlight.min.js'] as const) {
  writeFileSync(join(outdir, 'coding-assets', 'export-html', 'vendor', name), readHtmlVendorSource(name));
}
