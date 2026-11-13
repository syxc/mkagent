import { encodePhotonImageWithin } from '@earendil-works/pi-durable/images';
import { applyExifOrientation } from './image-orientation.ts';
import { loadPhoton } from './photon.ts';

import type { ImageResizeOptions, ResizedImage } from '@earendil-works/pi-coding-agent';
export type { ImageResizeOptions, ResizedImage } from '@earendil-works/pi-coding-agent';

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
  maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, jpegQuality: 80,
};

/** Retain Native input and result policy while durable selects encodings and smaller sizes. */
export async function resizeImageInProcess(
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;
  const photon = await loadPhoton();
  if (!photon) return null;
  let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
  try {
    const raw = photon.PhotonImage.new_from_byteslice(inputBytes);
    image = applyExifOrientation(photon, raw, inputBytes);
    if (image !== raw) raw.free();
    const originalWidth = image.get_width(), originalHeight = image.get_height();
    const format = mimeType.split('/')[1] ?? 'png';
    if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight &&
        inputBase64Size < opts.maxBytes) {
      return {
        data: Buffer.from(inputBytes).toString('base64'),
        mimeType: mimeType || `image/${format}`,
        originalWidth, originalHeight, width: originalWidth, height: originalHeight, wasResized: false,
      };
    }
    // Native rounds after each dimension limit, which can differ from one combined scale.
    let width = originalWidth, height = originalHeight;
    if (width > opts.maxWidth) {
      height = Math.round(height * opts.maxWidth / width);
      width = opts.maxWidth;
    }
    if (height > opts.maxHeight) {
      width = Math.round(width * opts.maxHeight / height);
      height = opts.maxHeight;
    }
    const source = image;
    const encoded = encodePhotonImageWithin(source, { width, height }, opts.maxBytes,
      (w, h) => photon.resize(source, w, h, photon.SamplingFilter.Lanczos3),
      { native: { jpegQuality: opts.jpegQuality } });
    return encoded ? { ...encoded, originalWidth, originalHeight, wasResized: true } : null;
  } catch {
    return null;
  } finally {
    image?.free();
  }
}
