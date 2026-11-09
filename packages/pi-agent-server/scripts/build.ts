import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getThemesDir } from '@earendil-works/pi-coding-agent';
import { readHtmlVendorSource } from '../../pi-durable-coding/src/compat/html-assets.ts';

const packageDir = dirname(import.meta.dir);
const outdir = join(packageDir, 'dist');
const codemodeRequire = createRequire(import.meta.resolveSync('@earendil-works/pi-codemode'));
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
copyFileSync(codemodeRequire.resolve('quickjs-wasi/quickjs.wasm'), join(outdir, 'quickjs.wasm'));
// read resolves this beside the bundle; source mode falls back to the package.
copyFileSync(durableRequire.resolve('@silvia-odwyer/photon/photon_rs_bg.wasm'), join(outdir, 'photon_rs_bg.wasm'));
rmSync(join(outdir, 'coding_photon_rs_bg.wasm'), { force: true });
copyFileSync(join(packageDir, '..', 'pi-durable-coding', 'LICENSE.pi'), join(outdir, 'LICENSE.pi'));
for (const [source, target] of [
  [getThemesDir(), 'theme'],
  [join(packageDir, '..', 'pi-durable-coding', 'src', 'pi', 'core/export-html'), 'export-html'],
]) {
  cpSync(source, join(outdir, 'coding-assets', target), {
    recursive: true, filter: path => target === 'theme' ? !/\.[cm]?[jt]s(?:\.map)?$/.test(path) : !path.endsWith('.ts'),
  });
}
for (const name of ['marked.min.js', 'highlight.min.js'] as const) {
  writeFileSync(join(outdir, 'coding-assets', 'export-html', 'vendor', name), readHtmlVendorSource(name));
}
