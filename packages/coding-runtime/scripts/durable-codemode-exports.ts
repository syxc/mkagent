/** Expose durable's existing sandbox dependency without copying its implementation. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function durableCodemodeExports(baseline: string): Map<string, string> {
  const info = JSON.parse(readFileSync(join(baseline, 'package.json'), 'utf8'));
  if (info.sideEffects !== false || info.exports['./codemode/node'] || info.exports['./codemode/worker']) {
    throw new Error('Published durable codemode exports changed');
  }
  for (const name of ['node', 'worker']) info.exports[`./codemode/${name}`] = {
    types: `./codemode-${name}.d.ts`, import: `./codemode-${name}.js`, default: `./codemode-${name}.js`,
  };
  // Flat paths avoid Bun 1.3.14 creating parent directories with the file's 0644 mode.
  // Bundlers must retain the worker's initialization import.
  info.sideEffects = ['./codemode-worker.js'];
  const outputs = new Map<string, string>([['package.json', JSON.stringify(info, null, '\t') + '\n']]);
  for (const suffix of ['js', 'd.ts']) {
    const path = `dist/codemode/index.${suffix}`;
    const original = readFileSync(join(baseline, path), 'utf8');
    if (original.includes('parseCodemodeSource')) throw new Error('Expected pristine durable codemode index');
    const entry = suffix === 'd.ts' ? original.replace(
      'type CodemodeNestedCall, CodemodeStoreDoc,',
      'type CodemodeNestedCall, type CodemodeResultInfo, type CodemodeSandboxLease, type CodemodeStoreAdapter, CodemodeStoreDoc,',
    ) : original;
    if (suffix === 'd.ts' && entry === original) throw new Error('Published durable codemode declarations changed');
    outputs.set(path, entry + '\n'
      + (suffix === 'd.ts'
        ? 'export { DEFAULT_MAX_OUTPUT_TOKENS, formatResult as formatCodemodeResult, type CodemodeFormatOptions, type OutputFile } from "./output.js";\n'
          + 'export { type CodemodeModelSource, type CodemodePreparedModelCall, createModelTools, prepareCodemodeModelCall } from "./models.js";\n'
        : 'export { DEFAULT_MAX_OUTPUT_TOKENS, formatResult as formatCodemodeResult } from "./output.js";\n'
          + 'export { createModelTools, prepareCodemodeModelCall } from "./models.js";\n')
      + 'export { parseCodemodeSource } from "@earendil-works/pi-codemode/source";\n'
      + 'export { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";\n'
      + (suffix === 'd.ts' ? 'export type { CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode/portable";\n' : ''));
  }
  const node = 'export { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";\n';
  outputs.set('codemode-node.js', 'import { createRequire } from "node:module";\n' + node
    + 'export function getQuickJSWasmPath() {\n'
    + '    return createRequire(import.meta.resolve("@earendil-works/pi-codemode")).resolve("quickjs-wasi/quickjs.wasm");\n}\n');
  outputs.set('codemode-node.d.ts', node + 'export declare function getQuickJSWasmPath(): string;\n');
  outputs.set('codemode-worker.js', 'import "@earendil-works/pi-codemode/worker";\n');
  outputs.set('codemode-worker.d.ts', 'export {};\n');
  return outputs;
}
