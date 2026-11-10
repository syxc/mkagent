/** Rebuild the complete SDK patch, preserving every unrelated patch section. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { patchGeneration, replaceOnce } from './durable-boundary-source.ts';
import { patchGenerationResponse } from './generation-response-source.ts';
import { durableCodemodeExports } from './durable-codemode-exports.ts';

const [checkout, installed, pristine, mode] = process.argv.slice(2);
if (!checkout || !installed || !pristine || !['--write', '--check'].includes(mode!)) {
  throw new Error('Usage: bun patch-generation-response.ts /pi-checkout /installed-durable /pristine-durable --write|--check');
}
const revision = 'f9a26365568127461c47a07a37dcb42c140a3ac5';
const upstream = resolve(checkout);
const target = resolve(installed);
const baseline = resolve(pristine);
const run = (args: string[]) => {
  const result = Bun.spawnSync(args);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
};
if (run(['git', '-C', upstream, 'rev-parse', 'HEAD']).trim() !== revision ||
    run(['git', '-C', upstream, 'status', '--porcelain', '--', 'packages/durable/src']).trim()) {
  throw new Error('Expected clean Pi v1.5.0 durable sources');
}
for (const directory of [target, baseline]) {
  if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version !== '1.5.0') {
    throw new Error('Expected pi-durable 1.5.0');
  }
}
const patchPath = join(import.meta.dir, '../../../patches/@earendil-works%2Fpi-durable@1.5.0.patch');
const manifestPath = join(import.meta.dir, '../DURABLE-PATCH.json');
const originalPatch = readFileSync(patchPath, 'utf8');
const original = readFileSync(join(upstream, 'packages/durable/src/harness/generation.ts'), 'utf8');
const batch = readFileSync(join(import.meta.dir, '../src/entry-batch.ts'), 'utf8');
const batchAst = ts.createSourceFile('entry-batch.ts', batch, ts.ScriptTarget.Latest, true);
const batchImplementation = batchAst.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getFullText(batchAst)).join('\n');
const javascript = (source: string) => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
} }).outputText;
const stripMap = (value: string) => value.replace(/\n\/\/# sourceMappingURL=.*$/, '');
if (javascript(original).trim() !== stripMap(readFileSync(join(baseline, 'dist/harness/generation.js'), 'utf8')).trim()) {
  throw new Error('Pristine generation differs from the pinned compiler output');
}
const boundary = patchGeneration(original, batchImplementation);
const source = patchGenerationResponse(boundary);
const current = readFileSync(join(target, 'dist/harness/generation.js'), 'utf8');
if (current !== javascript(boundary) && current !== javascript(source)) {
  throw new Error('Installed generation has changes outside the reproducible source transformations');
}
const outputs = new Map<string, string>([['dist/harness/generation.js', javascript(source)]]);
const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, skipLibCheck: true, declaration: true, emitDeclarationOnly: true,
  allowImportingTsExtensions: true, esModuleInterop: true, types: ['node'],
};
const virtual = join(target, 'dist/harness/generation.ts');
const host = ts.createCompilerHost(compilerOptions);
const read = host.readFile.bind(host);
const exists = host.fileExists.bind(host);
host.fileExists = path => path === virtual || exists(path);
host.readFile = path => path === virtual ? source : read(path);
const program = ts.createProgram([virtual], compilerOptions, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => target, getCanonicalFileName: path => path, getNewLine: () => '\n',
  }));
  throw new Error('Response task source failed semantic TypeScript validation');
}
program.emit(undefined, (path, content) => {
  if (path.endsWith('/generation.d.ts')) outputs.set('dist/harness/generation.d.ts', content);
}, undefined, true);
if (!outputs.has('dist/harness/generation.d.ts')) throw new Error('Missing response task declarations');
outputs.set('dist/index.js', replaceOnce(readFileSync(join(baseline, 'dist/index.js'), 'utf8'),
  'export { GenerationTask, }', 'export { GenerationTask, GenerationResponseTask, }'));
outputs.set('dist/index.d.ts', replaceOnce(readFileSync(join(baseline, 'dist/index.d.ts'), 'utf8'),
  'GenerationTask, } from "./harness/generation.ts";',
  'GenerationTask, type GenerationResponseInput, type GenerationResponseCheckpoint, type GenerationResponseResult, GenerationResponseTask, } from "./harness/generation.ts";'));
for (const [path, content] of durableCodemodeExports(baseline)) outputs.set(path, content);
// Only generated candidates live here. Keep them when a check fails for diagnosis.
const staging = mkdtempSync(join(tmpdir(), 'durable-response-patch-'));
const sections = new Map<string, string>();
for (const [path, content] of outputs) {
  const candidate = join(staging, path.replaceAll('/', '-'));
  writeFileSync(candidate, content);
  const original = join(baseline, path);
  const added = !existsSync(original);
  const diff = Bun.spawnSync(['git', 'diff', '--no-index', '--no-color', '--', added ? '/dev/null' : original, candidate]);
  if (diff.exitCode !== 1) throw new Error(`Expected a patch for ${path}: ${diff.stderr}`);
  const lines = diff.stdout.toString().split('\n');
  const start = lines.findIndex(line => line.startsWith('@@'));
  if (start < 0) throw new Error('Missing patch hunks');
  const index = added ? lines.find(line => line.startsWith('index ')) : undefined;
  if (added && !index) throw new Error('Missing new-file blob header');
  sections.set(path, `diff --git a/${path} b/${path}\n${added ? `new file mode 100644\n${index}\n` : ''}--- ${added ? '/dev/null' : 'a/' + path}\n+++ b/${path}\n${lines.slice(start).join('\n')}`);
}
let patch = originalPatch.split(/(?=^diff --git )/m).map(section => {
  const path = /^diff --git a\/(\S+) b\//.exec(section)?.[1];
  if (!path || !sections.has(path)) return section;
  const replacement = sections.get(path)!;
  sections.delete(path);
  return replacement;
}).join('');
patch += [...sections.values()].join('');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const paths = [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map(match => match[1]!);
if (new Set(paths).size !== paths.length) throw new Error('Duplicate patch sections');
const body = patch.replace(/^# Content SHA-256: [a-f0-9]{64}\n/, '');
patch = `# Content SHA-256: ${sha(body)}\n${body}`;
// Replay the entire patch: hashes alone do not detect invalid hunks in preserved sections.
const replay = join(staging, 'replay');
const replayPatch = join(staging, 'complete.patch');
cpSync(baseline, replay, { recursive: true, dereference: true });
writeFileSync(replayPatch, patch);
run(['git', '-C', replay, 'apply', '--check', replayPatch]);
run(['git', '-C', replay, 'apply', replayPatch]);
for (const path of paths) {
  const expected = outputs.get(path) ?? readFileSync(join(target, path), 'utf8');
  if (readFileSync(join(replay, path), 'utf8') !== expected) throw new Error(`Replayed output differs: ${path}`);
}
const manifest = JSON.stringify({
  repository: 'https://github.com/earendil-works/pi', revision, version: '1.5.0',
  patch: 'coding-boundary-v1+generation-response-v1', generationTaskVersion: 4, generationResponseTaskVersion: 1,
  typescript: ts.version, sourceSha256: sha(original), patchedSourceSha256: sha(source), batchSourceSha256: sha(batch),
  responseSourceSha256: sha(readFileSync(join(import.meta.dir, 'generation-response-source.ts'), 'utf8')),
  files: paths.map(path => ({ path, originalSha256: existsSync(join(baseline, path)) ? sha(readFileSync(join(baseline, path), 'utf8')) : null,
    sha256: sha(outputs.get(path) ?? readFileSync(join(target, path), 'utf8')) })),
  policy: 'One durable scheduler. Native response delivery, SDK receipt, journal, and next checkpoint commit together. Interrupted requests are not repeated.',
}, null, 2) + '\n';
if (mode === '--check') {
  if (patch !== originalPatch || manifest !== readFileSync(manifestPath, 'utf8')) throw new Error('SDK patch or manifest differs');
  for (const [path, value] of outputs) if (value !== readFileSync(join(target, path), 'utf8')) throw new Error(`Installed output differs: ${path}`);
} else {
  writeFileSync(patchPath, patch);
  writeFileSync(manifestPath, manifest);
}
console.log(`Validated ${paths.length} SDK patch sections; ${mode === '--check' ? 'verified' : 'wrote'} generation-response-v1. Candidates: ${staging}`);
