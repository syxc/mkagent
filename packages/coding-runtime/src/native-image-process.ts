/** Bind SDK image processing and worker transport to the shared durable encoding policy. */
import { createImageProcessor, createImageResizer } from '@earendil-works/pi-coding-agent';
import { resizeImageInProcess } from './compat/image-resize.ts';
import { convertImageBytesToPng } from './native-image-convert.ts';

export { formatDimensionNote, type ImageResizeOptions, type ResizedImage, type ProcessImageOptions, type ProcessImageResult } from '@earendil-works/pi-coding-agent';

export const resizeImage: ReturnType<typeof createImageResizer> = createImageResizer({
  resizeImageInProcess,
  resizeModule: new URL(import.meta.url.endsWith('.ts') ? './compat/image-resize.ts' : './compat/image-resize.js', import.meta.url),
});
export const processImage: ReturnType<typeof createImageProcessor> = createImageProcessor({ convertImageBytesToPng, resizeImage });
