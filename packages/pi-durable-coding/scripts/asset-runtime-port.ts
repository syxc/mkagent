/** Resolve executable image workers and WASM only from the installed coding runtime. */
export function portImageAssets(path: string, source: string): string {
  const edit = (before: string, after: string) => {
    if (!source.includes(before)) throw new Error('Pinned image asset boundary changed: ' + path);
    source = source.replace(before, after);
  };
  if (path === 'utils/image-resize.ts') edit(
    `\t// Bun compiled executables resolve worker entrypoints by string path, not via
\t// new URL(..., import.meta.url). Try the string path first under Bun so the
\t// release binary uses the embedded worker instead of falling back in-process.
\tif (typeof process.versions.bun === "string") {
\t\ttry {
\t\t\treturn await resizeImageInWorker("./src/utils/image-resize-worker.ts", inputBytes, mimeType, options);
\t\t} catch {}
\t}
`,
    '\t// A project directory cannot supply executable image workers. Use the module URL or process locally.\n',
  );
  if (path === 'utils/photon.ts') {
    edit('import { fileURLToPath } from "url";', 'import { fileURLToPath } from "url";\nimport { isBunBinary } from "../config.ts";');
    edit(
    `\tconst execDir = path.dirname(process.execPath);
\treturn [
\t\tpath.join(execDir, WASM_FILENAME),
\t\tpath.join(execDir, "photon", WASM_FILENAME),
\t\tpath.join(process.cwd(), WASM_FILENAME),
\t];`,
    `\tconst moduleDir = path.dirname(fileURLToPath(import.meta.url));
\treturn [
\t\tpath.join(moduleDir, "coding_photon_rs_bg.wasm"),
\t\t...(isBunBinary
\t\t\t? [path.join(path.dirname(process.execPath), "coding_photon_rs_bg.wasm")] : []),
\t];`,
    );
  }
  return source;
}

/** Bundles carry the same non-code assets as the source package. */
export function portBundledAssets(source: string): string {
  for (const [name, directory] of [
    ['getThemesDir', 'theme'], ['getExportTemplateDir', 'export-html'], ['getInteractiveAssetsDir', 'assets'],
  ]) {
    const signature = `export function ${name}(): string {`;
    if (!source.includes(signature)) throw new Error('Pinned asset resolver changed: ' + name);
    source = source.replace(signature, `${signature}
\tconst bundled = join(isBunBinary ? dirname(process.execPath) : __dirname, "coding-assets", "${directory}");
\tif (existsSync(bundled)) return bundled;`);
  }
  return source;
}
