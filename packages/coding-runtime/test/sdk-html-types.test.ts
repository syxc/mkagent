import { expect, test } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('SDK root exposes one compatible HTML renderer contract', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const declaration = fileURLToPath(new URL('./index.d.ts', import.meta.resolve('@earendil-works/pi-coding-agent')));
  const consumer = join(import.meta.dir, 'sdk-html-consumer.ts');
  const source = `
import { createToolHtmlRenderer, type ExportOptions, type ToolHtmlRenderer, type ToolHtmlRendererDeps } from '@earendil-works/pi-coding-agent';
type Assert<T extends true> = T;
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type ExportRenderer = Assert<Same<ToolHtmlRenderer, NonNullable<ExportOptions['toolRenderer']>>>;
type FactoryRenderer = Assert<Same<ToolHtmlRenderer, ReturnType<typeof createToolHtmlRenderer>>>;
type FactoryDependencies = Assert<Same<ToolHtmlRendererDeps, Parameters<typeof createToolHtmlRenderer>[0]>>;
declare const dependencies: ToolHtmlRendererDeps;
const renderer: NonNullable<ExportOptions['toolRenderer']> = createToolHtmlRenderer(dependencies);
const call: string | undefined = renderer.renderCall('call', 'fixture', {});
// @ts-expect-error HTML renderers cannot return numbers for tool calls.
const invalid: ToolHtmlRenderer = { renderCall: () => 42, renderResult: () => undefined };
`;
  const options: ts.CompilerOptions = {
    noEmit: true, strict: true, skipLibCheck: false, allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['bun', 'node'], typeRoots: [join(repo, 'node_modules/@types')],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const excluded = (path: string) => path.split(/[\\/]/).includes('legacy')
    || /(?:^|[\\/])(?:context-tokens\.js|\.env[^/]*|settings[^/]*\.json|auth\.json|credentials?\.json)$/.test(path);
  host.readFile = path => {
    if (path === consumer) return source;
    // Type checks must stop before reading a protected source or its symlink target.
    for (const candidate of [resolve(path), ...(existsSync(path) ? [realpathSync(path)] : [])]) {
      if (excluded(candidate)) throw new Error('Protected type input: ' + candidate);
    }
    return read(path);
  };
  const program = ts.createProgram([declaration, consumer], options, host);
  const sdk = program.getSourceFile(declaration)!;
  const fixture = program.getSourceFile(consumer)!;
  expect(sdk).toBeDefined();
  expect(fixture).toBeDefined();
  // Check the root itself even when other suites skip library declarations.
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(sdk), ...program.getSemanticDiagnostics(sdk),
    ...program.getSyntacticDiagnostics(fixture), ...program.getSemanticDiagnostics(fixture),
  ];
  expect(ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => repo, getNewLine: () => '\n',
  })).toBe('');
}, 20_000);
