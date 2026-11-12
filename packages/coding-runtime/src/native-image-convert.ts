/** Use SDK image algorithms with the existing shared Photon and durable orientation policy. */
import { createImageConverters } from '@earendil-works/pi-coding-agent';
import { applyExifOrientation } from './compat/image-orientation.ts';
import { loadPhoton } from './compat/photon.ts';

type ImageConverters = ReturnType<typeof createImageConverters>;
const images = createImageConverters({ loadPhoton, applyExifOrientation });

export const convertImageBytesToPng: ImageConverters['convertImageBytesToPng'] = images.convertImageBytesToPng;
export const convertToPng: ImageConverters['convertToPng'] = images.convertToPng;
export const loadPngTranscoder: ImageConverters['loadPngTranscoder'] = images.loadPngTranscoder;
export const ensurePngTranscoder: ImageConverters['ensurePngTranscoder'] = images.ensurePngTranscoder;
