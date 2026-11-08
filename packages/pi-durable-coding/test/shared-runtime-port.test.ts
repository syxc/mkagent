import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { portChildProcess, portReadPaths, portShell } from '../scripts/shared-runtime-port.ts';

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
  {
    name: 'read path', port: portReadPaths,
    source: `const NARROW_NO_BREAK_SPACE = "\\u202F";
function tryMacOSScreenshotPath(filePath: string): string { return filePath; }
function tryNFDVariant(filePath: string): string { return filePath; }
function tryCurlyQuoteVariant(filePath: string): string { return filePath; }
export function resolveReadPath(filePath: string, cwd: string): string { return filePath; }
export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> { return filePath; }
`,
  },
];

for (const { name, source, port } of fixtures) {
  const parsed = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  const functions = parsed.statements.filter(ts.isFunctionDeclaration);
  for (const fn of functions) {
    const start = fn.getStart(parsed);
    const bodyStart = fn.body!.getStart(parsed);
    const header = source.slice(start, bodyStart);
    test(`${name}: discarded ${fn.name!.text} body cannot change the generated module`, () => {
      const changed = source.slice(0, bodyStart) + '{ throw new Error("changed upstream algorithm"); }' + source.slice(fn.end);
      assert.notEqual(changed, source);
      assert.equal(port(changed), port(source));
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

test('read path: retained normalization constant remains guarded', () => {
  const fixture = fixtures[2];
  const changed = fixture.source.replace('\\u202F', '\\u00A0');
  assert.notEqual(changed, fixture.source);
  assert.throws(() => fixture.port(changed));
});
