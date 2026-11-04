import type { Jiti } from 'jiti';

const prepared = new WeakSet<NonNullable<Jiti['options']['transform']>>();

/** Initialize Babel without replacing the embedding Bun runtime's stack formatter. */
export function preparePluginTranspiler(jiti: Pick<Jiti, 'options'>): void {
  if (!('Bun' in globalThis)) return;
  const transform = jiti.options.transform;
  if (!transform) throw new Error('Plugin transpiler has no embedded transform');
  if (prepared.has(transform)) return;
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
