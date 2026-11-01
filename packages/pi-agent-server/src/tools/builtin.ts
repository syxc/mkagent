/**
 * Builtin tool set for the durable kernel.
 *
 * `read`/`write`/`edit`/`bash` come from durable's `coding-tools` extension
 * (env-backed, abort-aware, output windows). `grep`/`find`/`ls` have no
 * durable equivalent: their pi-coding-agent 1.1.0 implementations are adapted
 * under `local/` and exported as durable tools here.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { createPhotonImages } from '@earendil-works/pi-durable/images';
import { createCodingTools, type ImageProcessor } from '@earendil-works/pi-durable/tools';
import { createFindTool } from './local/find.ts';
import { createGrepTool } from './local/grep.ts';
import { createLsTool } from './local/ls.ts';

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
export function createBuiltinTools(cwd: string): ToolRegistration[] {
  return [
    ...(createCodingTools({ images: createLazyImageProcessor() }).tools ?? []),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}
