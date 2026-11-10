/** Bind image dependencies per instance while keeping the SDK conversion and registration lifecycle. */
export function codingImagePolicy(source: string, declarations: boolean): string {
  const edit = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error('Published image boundary changed: ' + before);
    source = source.replace(before, after);
  };
  const names = ['convertImageBytesToPng', 'convertToPng', 'loadPngTranscoder', 'ensurePngTranscoder'];
  if (declarations) {
    edit('export declare function convertImageBytesToPng',
      'export interface ImageConversionDependencies {\n'
      + '    loadPhoton?: typeof import("./photon.ts").loadPhoton;\n'
      + '    applyExifOrientation?: typeof import("./exif-orientation.ts").applyExifOrientation;\n'
      + '}\n'
      + 'export declare function createImageConverters(dependencies?: ImageConversionDependencies): {\n'
      + names.map(name => `    ${name}: typeof ${name};`).join('\n') + '\n};\n'
      + 'export declare function convertImageBytesToPng');
    return source;
  }
  edit('import { loadPhoton }', 'import { loadPhoton as defaultLoadPhoton }');
  edit('import { applyExifOrientation }', 'import { applyExifOrientation as defaultApplyExifOrientation }');
  edit('function encodePng(photon, bytes) {',
    'export function createImageConverters({ loadPhoton = defaultLoadPhoton, applyExifOrientation = defaultApplyExifOrientation } = {}) {\n'
    + 'function encodePng(photon, bytes) {');
  for (const name of names) {
    const prefix = name === 'ensurePngTranscoder' ? 'function ' : 'async function ';
    edit('export ' + prefix + name + '(', prefix + name + '(');
  }
  edit('//# sourceMappingURL=',
    'return { ' + names.join(', ') + ' };\n}\n'
    + 'export const { ' + names.join(', ') + ' } = createImageConverters();\n'
    + '//# sourceMappingURL=');
  return source;
}
