import { exifOrientation, transposeExifPixels } from '@earendil-works/pi-durable/images';
import type { PhotonImage } from '@silvia-odwyer/photon-node';

type Photon = typeof import('@silvia-odwyer/photon-node');

/** Keep Native's Photon ownership while durable owns metadata and pixel layout. */
export function applyExifOrientation(photon: Photon, image: PhotonImage, originalBytes: Uint8Array): PhotonImage {
  const orientation = exifOrientation(originalBytes, true);
  if (orientation >= 5) {
    const { pixels, width, height } = transposeExifPixels(image, orientation);
    return new photon.PhotonImage(pixels, width, height);
  }
  if (orientation === 2 || orientation === 3) photon.fliph(image);
  if (orientation === 3 || orientation === 4) photon.flipv(image);
  return image;
}
