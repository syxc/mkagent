import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { applySharedHelperPort, excludeRunModeEntries } from '../scripts/shared-helper-port.ts';
import { portChildProcess, portShell } from '../scripts/shared-runtime-port.ts';

const declarationFixtures = [
  {
    name: 'context tokens',
    port: (body: string) => applySharedHelperPort('core/compaction/compaction.ts', body)!.body,
    source: `export function calculateContextTokens(usage: Usage): number {
\treturn usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
`,
  },
  {
    name: 'string enum',
    port: (body: string) => applySharedHelperPort('core/extensions/pi-ai-extension-view.ts', body)!.body,
    source: `import { type TUnsafe, Type } from "typebox";
export function StringEnum<T extends readonly string[]>(
\tvalues: T,
\toptions?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
\treturn Type.Unsafe<T[number]>({
\t\ttype: "string",
\t\tenum: values as unknown as T[number][],
\t\t...(options?.description && { description: options.description }),
\t\t...(options?.default && { default: options.default }),
\t});
}
`,
  },
];

const fixtures = [
  {
    name: 'child process', port: portChildProcess,
    source: `const EXIT_STDIO_GRACE_MS = 100;
export function waitForChildProcess(child: ChildProcess): Promise<number | null> { throw new Error("unused wait body"); }
`,
  },
  {
    name: 'shell', port: portShell,
    source: `import { delimiter, join, win32 } from "node:path";
import { spawn, spawnSync } from "child_process";
function isLegacyWslBashPath(path: string): boolean { return false; }
function getBashShellConfig(shell: string): ShellConfig { throw new Error("unused shell body"); }
export function killProcessTree(pid: number): void { throw new Error("unused cleanup body"); }
`,
  },
  ...declarationFixtures,
];

for (const { name, source, port } of fixtures) {
  const parsed = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  const functions = parsed.statements.filter(ts.isFunctionDeclaration);
  for (const fn of functions) {
    const start = fn.getStart(parsed);
    const bodyStart = fn.body!.getStart(parsed);
    const header = source.slice(start, bodyStart);
    test(`${name}: discarded ${fn.name!.text} body cannot change the generated module`, () => {
      const baseline = port(source);
      const changed = source.slice(0, bodyStart) + '{ throw new Error("changed upstream algorithm"); }' + source.slice(fn.end);
      assert.notEqual(changed, source);
      assert.equal(port(changed), baseline);
    });
    test(`${name}: ${fn.name!.text} parameter and return types remain guarded`, () => {
      for (const changedHeader of [header.replace(/: [^,)]+/, ': never'), header.replace(/\): [^{]+$/, '): never ')]) {
        assert.notEqual(changedHeader, header);
        assert.throws(() => port(source.slice(0, start) + changedHeader + source.slice(bodyStart)));
      }
    });
    test(`${name}: ${fn.name!.text} duplicates remain rejected`, () => {
      assert.throws(() => port(source + '\n' + fn.getText(parsed)));
    });
  }
  test(`${name}: missing declarations remain rejected`, () => {
    assert.throws(() => port(''));
  });
}

for (const { name, source, port } of declarationFixtures) {
  const parsed = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  const fn = parsed.statements.find(ts.isFunctionDeclaration)!;
  const header = source.slice(fn.getStart(parsed), fn.body!.getStart(parsed));
  test(`${name}: function kind, export and calling convention remain guarded`, () => {
    const changedDeclarations = [
      `export const ${fn.name!.text} = () => 0;`,
      `export class ${fn.name!.text} {}`,
      `export type ${fn.name!.text} = number;`,
      `export interface ${fn.name!.text} {}`,
      header + ';',
      fn.getText(parsed).replace('export function', 'function'),
      fn.getText(parsed).replace('export function', 'export async function'),
      fn.getText(parsed).replace('export function', 'export function*'),
    ];
    for (const changed of changedDeclarations) {
      assert.throws(() => port(source.slice(0, fn.getStart(parsed)) + changed + source.slice(fn.end)));
    }
  });
}

test('string enum: generic bounds, optional options and TypeBox branding remain guarded', () => {
  const { source, port } = declarationFixtures[1];
  for (const [from, to] of [
    ['T extends readonly string[]', 'T extends readonly number[]'],
    ['options?:', 'options:'],
    ['default?: T[number]', 'default?: string'],
    ['TUnsafe<T[number]>', 'T[number]'],
  ]) {
    const changed = source.replace(from, to);
    assert.notEqual(changed, source);
    assert.throws(() => port(changed));
  }
});

const wait = fixtures[0];
for (const [name, from, to] of [
  ['optional argument', 'child: ChildProcess', 'child?: ChildProcess'],
  ['extra argument', 'child: ChildProcess', 'child: ChildProcess, extra: number'],
  ['async modifier', 'export function', 'export async function'],
  ['removed export', 'export function', 'function'],
  ['mutable grace', 'const EXIT_STDIO_GRACE_MS', 'let EXIT_STDIO_GRACE_MS'],
  ['changed grace', '= 100', '= 101'],
] as const) {
  test(`child process: ${name} remains rejected`, () => {
    const changed = wait.source.replace(from, to);
    assert.notEqual(changed, wait.source);
    assert.throws(() => wait.port(changed));
  });
}

test('CLI helper removal retains the parser and guards missing or duplicate boundaries', () => {
  const removed = [
    'import chalk from "chalk";',
    'import { APP_NAME } from "../config.ts";',
    'import type { ExtensionFlag } from "@earendil-works/pi-coding-agent";',
    'export function normalizeSessionName(value: string) { return value.trim(); }',
    'export function printHelp() { console.log(chalk.bold(APP_NAME)); }',
  ];
  const retained = 'export function parseArgs(args: string[]) { return args; }\n';
  const source = removed.join('\n') + '\n' + retained;
  const port = (body: string) => applySharedHelperPort('cli/args.ts', body)!.body;
  assert.equal(port(source), '\n' + retained);
  for (const declaration of removed) {
    assert.throws(() => port(source.replace(declaration, '')), /CLI helper boundary changed/);
    assert.throws(() => port(source + '\n' + declaration), /CLI helper boundary changed/);
  }
});

test('run mode exclusion preserves plugin components and RPC while guarding both entry points', () => {
  const fixtures = [
    {
      path: 'index.ts',
      removed: ['\tInteractiveMode,\n', '\ttype InteractiveModeOptions,\n', '\ttype PrintModeOptions,\n', '\trunPrintMode,\n', '\trunRpcMode,\n'],
      source: '// Run modes for programmatic SDK usage\nexport {\n\tInteractiveMode,\n\ttype InteractiveModeOptions,\n\ttype PrintModeOptions,\n\trunPrintMode,\n\trunRpcMode,\n\tRpcClient,\n} from "./modes/index.ts";\nexport { CustomEditor, Theme } from "./components.ts";\n',
      targets: ['./modes/index.ts', './components.ts'],
    },
    {
      path: 'modes/index.ts',
      removed: [
        'export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";\n',
        'export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";\n',
        'export { runRpcMode } from "./rpc/rpc-mode.ts";\n',
      ],
      source: '/**\n * Run modes for the coding agent.\n */\nexport { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";\nexport { type PrintModeOptions, runPrintMode } from "./print-mode.ts";\nexport { runRpcMode } from "./rpc/rpc-mode.ts";\nexport { RpcClient } from "./rpc/rpc-client.ts";\nexport type { RpcResponse } from "./rpc/rpc-types.ts";\nexport type { JsonAgentSessionEvent } from "./json-event.ts";\n',
      targets: ['./rpc/rpc-client.ts', './rpc/rpc-types.ts', './json-event.ts'],
    },
  ];
  for (const { path, source, removed, targets } of fixtures) {
    const body = excludeRunModeEntries(path, source)!;
    const parsed = ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true);
    const exports = parsed.statements.filter(ts.isExportDeclaration);
    assert.deepEqual(exports.map(node => (node.moduleSpecifier as ts.StringLiteral).text), targets);
    assert(body.includes('RpcClient'));
    if (path === 'index.ts') assert(body.includes('CustomEditor, Theme'));
    for (const declaration of removed) {
      assert(!body.includes(declaration));
      assert.throws(() => excludeRunModeEntries(path, source.replace(declaration, '')), /run mode export changed/);
      assert.throws(() => excludeRunModeEntries(path, source + declaration), /run mode export changed/);
    }
  }
  assert.equal(excludeRunModeEntries('modes/rpc/rpc-types.ts', 'protocol'), undefined);
});
