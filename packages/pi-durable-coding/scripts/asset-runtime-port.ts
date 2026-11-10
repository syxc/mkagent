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
