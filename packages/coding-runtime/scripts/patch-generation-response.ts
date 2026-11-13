/** Rebuild the complete SDK patch, preserving every unrelated patch section. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { patchGeneration, replaceOnce } from './durable-boundary-source.ts';
import { patchGenerationResponse } from './generation-response-source.ts';
import { durableCodemodeExports } from './durable-codemode-exports.ts';

const [installed, pristine, mode] = process.argv.slice(2);
if (!installed || !pristine || !['--write', '--check'].includes(mode!)) {
  throw new Error('Usage: bun patch-generation-response.ts /installed-durable /pristine-durable --write|--check');
}
const revision = 'f9a26365568127461c47a07a37dcb42c140a3ac5';
const target = resolve(installed);
const baseline = resolve(pristine);
const run = (args: string[]) => {
  const result = Bun.spawnSync(args);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
};
for (const directory of [target, baseline]) {
  if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version !== '1.5.0') {
    throw new Error('Expected pi-durable 1.5.0');
  }
}
const patchPath = join(import.meta.dir, '../../../patches/@earendil-works%2Fpi-durable@1.5.0.patch');
const manifestPath = join(import.meta.dir, '../DURABLE-PATCH.json');
const originalPatch = readFileSync(patchPath, 'utf8');
const original = publishedSource(baseline, 'harness/generation').source;
const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (previous.version !== '1.5.0' || previous.revision !== revision
  || createHash('sha256').update(original).digest('hex') !== previous.sourceSha256) {
  throw new Error('Published generation source differs from the pinned source digest');
}
const batch = readFileSync(join(import.meta.dir, '../src/entry-batch.ts'), 'utf8');
const batchAst = ts.createSourceFile('entry-batch.ts', batch, ts.ScriptTarget.Latest, true);
const batchImplementation = batchAst.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getFullText(batchAst)).join('\n');
function javascript(source: string): string {
  return ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
  } }).outputText;
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
const primitives = contextExports(baseline, outputs);
for (const [path, content] of primitives) outputs.set(path, content);
// Only generated candidates live here. Keep them when a check fails for diagnosis.
const staging = mkdtempSync(join(tmpdir(), 'durable-response-patch-'));
const sections = new Map<string, string>();
for (const [path, content] of outputs) {
  const candidate = join(staging, path.replaceAll('/', '-'));
  writeFileSync(candidate, content);
  const original = join(baseline, path);
  if (primitives.has(path)) {
    sections.set(path, contextSection(path, original, candidate));
    continue;
  }
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

/** Verify published source bytes against their compiled SDK module before transforming them. */
function publishedSource(baseline: string, module: string): { source: string; code: string } {
  const path = 'dist/' + module + '.js';
  const code = readFileSync(join(baseline, path), 'utf8');
  const map = JSON.parse(readFileSync(join(baseline, path + '.map'), 'utf8'));
  if (map.sources?.length !== 1 || map.sources[0] !== '../../src/' + module + '.ts'
    || typeof map.sourcesContent?.[0] !== 'string') throw new Error(`Expected published ${module}.ts source map`);
  const source: string = map.sourcesContent[0];
  if (javascript(source).trim() !== code.replace(/\n\/\/# sourceMappingURL=.*$/, '').trim()) {
    throw new Error(`Published ${module}.ts source map does not reproduce its JavaScript`);
  }
  return { source, code };
}

/** Expose the SDK algorithms with structural inputs for Native context projections. */
function contextExports(baseline: string, roots: ReadonlyMap<string, string>): Map<string, string> {
  const path = 'dist/harness/context';
  const { source, code: original } = publishedSource(baseline, 'harness/context');
  const ast = ts.createSourceFile('context.ts', source, ts.ScriptTarget.Latest, true);
  let javascript = original;
  const declarations: string[] = [];
  for (const name of ['findBaseline', 'leadWithSystem', 'contribute']) {
    const functions = ast.statements.filter((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    const node = functions[0];
    if (functions.length !== 1 || !node?.body || !node.type || node.parameters.some(parameter => !parameter.type)
      || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      throw new Error(`Expected private, explicitly typed context primitive: ${name}`);
    }
    javascript = replaceOnce(javascript, `\nfunction ${name}(`, `\nexport function ${name}(`);
    let declaration = 'export declare ' + source.slice(node.getStart(ast), node.body.getStart(ast)).trimEnd() + ';';
    if (name === 'findBaseline') declaration = replaceOnce(declaration, 'head: ContextBounds["head"]',
      'head: Pick<NonNullable<ContextBounds["head"]>, "id"> | undefined');
    if (name === 'contribute') declaration = replaceOnce(declaration, 'entry: EntryRecord', 'entry: Pick<EntryRecord, "model">');
    declarations.push(declaration);
  }
  let types = replaceOnce(readFileSync(join(baseline, path + '.d.ts'), 'utf8'),
    'ConversationId, EntryId, EntryRecord, Storage', 'ContextEdit, ConversationId, EntryId, EntryRecord, Storage');
  types = replaceOnce(types, 'export {};', declarations.join('\n') + '\nexport {};');
  const outputs = new Map<string, string>([[path + '.js', javascript], [path + '.d.ts', types]]);
  for (const suffix of ['js', 'd.ts']) {
    const path = 'dist/index.' + suffix;
    const extension = suffix === 'js' ? 'js' : 'ts';
    const root = roots.get(path) ?? readFileSync(join(baseline, path), 'utf8');
    const anchor = `export { defineExtension, defineTool, hook, runEndTask, section, wrapSection, wrapTool } from "./harness/define.${extension}";`;
    outputs.set(path, replaceOnce(root, anchor,
      `export { findBaseline, leadWithSystem, contribute, orderToolResults } from "./harness/context.${extension}";\n` + anchor));
  }
  return outputs;
}

function contextSection(path: string, original: string, candidate: string): string {
  const result = Bun.spawnSync(['diff', '-u', '--label', 'a/' + path, '--label', 'b/' + path, original, candidate]);
  if (result.exitCode !== 1) throw new Error(`Expected context export diff: ${path}`);
  return `diff --git a/${path} b/${path}\n${result.stdout}`;
}
