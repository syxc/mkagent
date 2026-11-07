import type { Jiti } from 'jiti';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pluginImportMeta } from './plugin-import-meta.ts';

const prepared = new WeakSet<NonNullable<Jiti['options']['transform']>>();
const metadata = new WeakSet<Jiti['options']>();

/** Initialize Babel without replacing the embedding Bun runtime's stack formatter. */
export function preparePluginTranspiler(jiti: Pick<Jiti, 'options'>): void {
  if (metadata.has(jiti.options)) return;
  const transform = jiti.options.transform;
  if (!transform) throw new Error('Plugin transpiler has no embedded transform');
  if ('Bun' in globalThis && !prepared.has(transform)) initializeBabel(transform);

  // Jiti's cache key ignores transform configuration, including Babel plugins.
  if (typeof jiti.options.fsCache === 'string') {
    const cache = join(jiti.options.fsCache, 'mkagent-import-meta-v1');
    try {
      mkdirSync(cache, { recursive: true });
      jiti.options.fsCache = cache;
    } catch {
      jiti.options.fsCache = false;
    }
  }
  jiti.options.transform = options => transform({
    ...options,
    babel: {
      ...options.babel,
      plugins: [...(options.babel?.plugins ?? []), [pluginImportMeta, { filename: options.filename }]],
    },
  });
  metadata.add(jiti.options);
}

function initializeBabel(transform: NonNullable<Jiti['options']['transform']>): void {
  const previous = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  const formatter = Error.prepareStackTrace;
  const stackLimit = Error.stackTraceLimit;
  try {
    // Bypass Jiti's disk cache so a fresh process always initializes this Babel instance.
    const result = transform({ source: 'export {};', filename: 'pi-extension-bootstrap.ts', ts: true });
    if (result.error) throw result.error;
    prepared.add(transform);
  } finally {
    // Bun caches assignments separately; restoring the descriptor alone leaves Babel's formatter active.
    if (Error.prepareStackTrace !== formatter) Error.prepareStackTrace = formatter;
    if (Error.stackTraceLimit !== stackLimit) Error.stackTraceLimit = stackLimit;
    if (!previous) Reflect.deleteProperty(Error, 'prepareStackTrace');
  }
}
