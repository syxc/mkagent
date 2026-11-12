/** Keep SDK processing and worker algorithms while binding the host's durable image policy. */
export function codingImageProcessingPolicy(source: string, declarations: boolean, module: string): string {
  const edit = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error('Published image processing boundary changed: ' + before);
    source = source.replace(before, after);
  };
  if (module === 'image-process') {
    if (declarations) {
      edit('export declare function processImage',
        'export interface ImageProcessingDependencies {\n'
        + '    convertImageBytesToPng?: typeof import("./image-convert.ts").convertImageBytesToPng;\n'
        + '    resizeImage?: typeof import("./image-resize.ts").resizeImage;\n'
        + '}\nexport declare function createImageProcessor(dependencies?: ImageProcessingDependencies): typeof processImage;\n'
        + 'export declare function processImage');
    } else {
      edit('import { convertImageBytesToPng }', 'import { convertImageBytesToPng as defaultConvertImageBytesToPng }');
      edit('import { formatDimensionNote, resizeImage }', 'import { formatDimensionNote, resizeImage as defaultResizeImage }');
      edit('function baseMimeType(',
        'export function createImageProcessor({ convertImageBytesToPng = defaultConvertImageBytesToPng, resizeImage = defaultResizeImage } = {}) {\nfunction baseMimeType(');
      edit('export async function processImage(', 'async function processImage(');
      edit('//# sourceMappingURL=', 'return processImage;\n}\nexport const processImage = createImageProcessor();\n//# sourceMappingURL=');
    }
  } else if (module === 'image-resize') {
    if (declarations) {
      edit('/**\n * Resize an image', 'export interface ImageResizeDependencies {\n'
        + '    resizeImageInProcess?: typeof import("./image-resize-core.ts").resizeImageInProcess;\n'
        + '    /** Installed host module used by the SDK worker; never resolved from the working directory. */\n'
        + '    resizeModule?: URL;\n'
        + '}\nexport declare function createImageResizer(dependencies?: ImageResizeDependencies): typeof resizeImage;\n/**\n * Resize an image');
    } else {
      edit('resizeImageInProcess, }', 'resizeImageInProcess as defaultResizeImageInProcess, }');
      edit('function toTransferableBytes(',
        'export function createImageResizer({ resizeImageInProcess = defaultResizeImageInProcess, resizeModule } = {}) {\nfunction toTransferableBytes(');
      edit('return new Worker(workerSpecifier);',
        'return new Worker(workerSpecifier, { workerData: { imageResizeModule: resizeModule?.href } });');
      edit('export async function resizeImage(', 'async function resizeImage(');
      edit('/**\n * Format a dimension note',
        'return resizeImage;\n}\nexport const resizeImage = createImageResizer();\n/**\n * Format a dimension note');
    }
  } else if (module === 'image-resize-worker' && !declarations) {
    edit('import { parentPort }', 'import { parentPort, workerData }');
    edit('resizeImageInProcess, }', 'resizeImageInProcess as defaultResizeImageInProcess, }');
    edit('const port = parentPort;',
      'const resizeImageInProcess = workerData?.imageResizeModule\n'
      + '    ? (await import(workerData.imageResizeModule)).resizeImageInProcess\n'
      + '    : defaultResizeImageInProcess;\nconst port = parentPort;');
  } else {
    throw new Error('Unexpected image processing module: ' + module);
  }
  return source;
}
