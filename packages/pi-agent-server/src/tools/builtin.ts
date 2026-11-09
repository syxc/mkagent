/**
 * Builtin tool set for the durable kernel.
 *
 * `read`/`write`/`edit`/`bash` come from durable's `coding-tools` extension
 * (env-backed, abort-aware, output windows). `grep`/`find`/`ls` use the
 * public Coding SDK with the host's binary policy and durable tool bridge.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { createPhotonImages } from '@earendil-works/pi-durable/images';
import { createCodingTools, createPowerShellTool, type ImageProcessor } from '@earendil-works/pi-durable/tools';
import { createSearchTools } from './search.ts';

/**
 * The wasm sits beside the bundle in dev and packaged builds; source mode falls
 * back to the installed package.
 */
async function loadPhotonWasm(): Promise<Uint8Array> {
  try {
    return await readFile(new URL('./photon_rs_bg.wasm', import.meta.url));
  } catch {
    return await readFile(createRequire(import.meta.url).resolve('@silvia-odwyer/photon/photon_rs_bg.wasm'));
  }
}

/** Initializes Photon on the first image, so text-only sessions never load it. */
function createLazyImageProcessor(): ImageProcessor {
  let processor: Promise<ImageProcessor> | undefined;
  return {
    async prepare(bytes, mimeType, limits) {
      processor ??= loadPhotonWasm().then(createPhotonImages);
      return (await processor).prepare(bytes, mimeType, limits);
    },
  };
}

/**
 * All builtin coding tools, unwrapped. The caller wraps them with permission
 * hooks and registers them on the kernel extension.
 */
export function createBuiltinTools(cwd: string, options?: { powerShell?: boolean }): ToolRegistration[] {
  return [
    ...(createCodingTools({ images: createLazyImageProcessor() }).tools ?? []),
    // Native Pi also keeps PowerShell outside its default active coding tools.
    ...(options?.powerShell ? [{ ...createPowerShellTool(), deferred: true as const }] : []),
    ...createSearchTools(cwd),
  ];
}
