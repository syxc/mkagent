/** Reproduce and type-check the durable coding boundary patch from pinned inputs. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { codingHook, patchGeneration, replaceOnce } from './durable-boundary-source.ts';

const revision = 'f9a26365568127461c47a07a37dcb42c140a3ac5';
const [checkout, installed, pristine, ...flags] = process.argv.slice(2);
if (!checkout || !installed || !pristine) throw new Error('Usage: bun patch-durable.ts /pi-checkout /installed-durable /pristine-durable [--check]');
const upstream = resolve(checkout);
const target = resolve(installed);
const baseline = resolve(pristine);
const checking = flags.includes('--check');
const head = Bun.spawnSync(['git', '-C', upstream, 'rev-parse', 'HEAD']);
const dirty = Bun.spawnSync(['git', '-C', upstream, 'status', '--porcelain', '--', 'packages/durable/src']);
if (head.exitCode || head.stdout.toString().trim() !== revision || dirty.exitCode || dirty.stdout.toString().trim()) {
  throw new Error('Expected clean Pi v1.5.0 durable sources');
}
for (const directory of [target, baseline]) {
  if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version !== '1.5.0') {
    throw new Error('This patch supports pi-durable 1.5.0 only');
  }
}
const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, skipLibCheck: true, declaration: true, emitDeclarationOnly: true,
  allowImportingTsExtensions: true, esModuleInterop: true, types: ['node'],
};
const javascript = (source: string) => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
} }).outputText;
const original = readFileSync(join(upstream, 'packages/durable/src/harness/generation.ts'), 'utf8');
const originalJS = readFileSync(join(baseline, 'dist/harness/generation.js'), 'utf8');
if (javascript(original).trim() !== originalJS.replace(/\n\/\/# sourceMappingURL=.*$/, '').trim()) {
  throw new Error('Pristine generation differs from pinned source and compiler output');
}
const batchSource = readFileSync(join(import.meta.dir, '../src/entry-batch.ts'), 'utf8');
const parsedBatch = ts.createSourceFile('entry-batch.ts', batchSource, ts.ScriptTarget.Latest, true);
const batchImplementation = parsedBatch.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getFullText(parsedBatch)).join('\n');
const source = patchGeneration(original, batchImplementation);
const stripMap = (value: string) => value.replace(/\n\/\/# sourceMappingURL=.*$/, '');
const originals = new Map(['generation.js', 'generation.d.ts', 'types.d.ts', 'live.d.ts'].map(name => [
  `dist/harness/${name}`, readFileSync(join(baseline, 'dist/harness', name), 'utf8'),
]));
const outputs = new Map<string, string>([
  ['dist/harness/generation.js', javascript(source)],
  ['dist/harness/types.d.ts', stripMap(replaceOnce(replaceOnce(originals.get('dist/harness/types.d.ts')!,
    'Api, AssistantMessage,', 'Api, AssistantMessage, AssistantMessageEvent,'),
    'export interface GenerationHooks {', 'export interface GenerationHooks {' + codingHook))],
  ['dist/harness/live.d.ts', stripMap(replaceOnce(originals.get('dist/harness/live.d.ts')!, 'export type LiveRun = {', 'export type LiveRun = {\n    /** Native coding turn index, independent of the durable tool-round limit. */\n    codingTurn?: number;\n    codingStarted?: boolean;\n    codingLastMessage?: EntryId;\n    codingPreparation?: { taskId: TaskId; attempt: number };'))],
]);
// Type-check the actual patched source against the installed package declarations.
const virtual = join(target, 'dist/harness/generation.ts');
const host = ts.createCompilerHost(compilerOptions);
const readFile = host.readFile.bind(host);
const fileExists = host.fileExists.bind(host);
host.fileExists = path => path === virtual || fileExists(path);
host.readFile = path => path === virtual ? source : outputs.get(path.slice(target.length + 1)) ?? readFile(path);
const program = ts.createProgram([virtual], compilerOptions, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => target, getCanonicalFileName: path => path, getNewLine: () => '\n',
  }));
  throw new Error('Patched durable source failed type checking');
}
program.emit(undefined, (path, content) => {
  if (path.endsWith('/generation.d.ts')) outputs.set('dist/harness/generation.d.ts', content);
}, undefined, true);
if (!outputs.has('dist/harness/generation.d.ts')) throw new Error('Missing generation declaration');
const staging = mkdtempSync(join(tmpdir(), 'durable-boundary-patch-'));
let patch = '';
try {
  for (const [path, content] of outputs) {
    const temp = join(staging, path.split('/').at(-1)!);
    writeFileSync(temp, content);
    const diff = Bun.spawnSync(['git', 'diff', '--no-index', '--no-color', '--', join(baseline, path), temp]);
    if (diff.exitCode === 0) continue;
    if (diff.exitCode !== 1) throw new Error(diff.stderr.toString());
    const lines = diff.stdout.toString().split('\n');
    const start = lines.findIndex(line => line.startsWith('@@'));
    if (start < 0) throw new Error('Missing patch hunks');
    patch += `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${lines.slice(start).join('\n')}`;
  }
} finally { rmSync(staging, { recursive: true, force: true }); }
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const manifest = JSON.stringify({
  repository: 'https://github.com/earendil-works/pi', revision, version: '1.5.0',
  patch: 'coding-boundary-v1', generationTaskVersion: 4, typescript: ts.version,
  sourceSha256: sha256(original), patchedSourceSha256: sha256(source),
  batchSourceSha256: sha256(batchSource),
  files: [...outputs].map(([path, value]) => ({ path, originalSha256: sha256(originals.get(path)!), sha256: sha256(value) })),
  policy: 'One durable scheduler. Commit each native event decision with its next checkpoint; replay its memo after restart.',
}, null, 2) + '\n';
const files = [...outputs].map(([path, value]) => [join(target, path), value]);
files.push(
  [join(import.meta.dir, '../DURABLE-PATCH.json'), manifest],
  [join(import.meta.dir, '../../../patches/@earendil-works%2Fpi-durable@1.5.0.patch'), patch],
);
for (const [path, content] of files) {
  if (checking) {
    if (readFileSync(path, 'utf8') !== content) throw new Error(`Patch output differs: ${path}`);
  } else writeFileSync(path, content);
}
console.log(`${checking ? 'Verified' : 'Prepared'} durable coding-boundary-v1 with semantic TypeScript validation`);
