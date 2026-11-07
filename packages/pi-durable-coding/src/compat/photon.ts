import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type { PhotonImage as PhotonImageType } from '@silvia-odwyer/photon/photon_rs.js';
type Photon = typeof import('@silvia-odwyer/photon/photon_rs.js');
let loading: Promise<Photon | null> | undefined;

/** Native policy and durable's image processor share one public Photon instance. */
export async function loadPhoton(): Promise<Photon | null> {
  return loading ??= (async () => {
    const photon = await import('@silvia-odwyer/photon/photon_rs.js');
    const standalone = ['$bunfs', '~BUN', '%7EBUN'].some(marker => import.meta.url.includes(marker));
    let wasmPath: string | undefined;
    if (!standalone) {
      try {
        wasmPath = createRequire(import.meta.url).resolve('@silvia-odwyer/photon/photon_rs_bg.wasm');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'MODULE_NOT_FOUND') throw error;
      }
    }
    // Installed assets and relocated bundles never search the caller's project.
    wasmPath ??= join(standalone ? dirname(process.execPath) : dirname(fileURLToPath(import.meta.url)), 'photon_rs_bg.wasm');
    photon.initSync({ module: await readFile(wasmPath) });
    return photon;
  })().catch(() => null);
}
