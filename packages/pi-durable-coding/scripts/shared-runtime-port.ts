/** Preserve Native forwarding boundaries while reusing public implementations. */
import { createHash } from 'node:crypto';
import ts from 'typescript';

export function portChildProcess(body: string): string {
  const parsed = ts.createSourceFile('child-process.ts', body, ts.ScriptTarget.Latest, true);
  const functions = parsed.statements.filter(ts.isFunctionDeclaration)
    .filter(node => node.name?.text === 'waitForChildProcess');
  const wait = functions[0];
  const constants = parsed.statements.filter(ts.isVariableStatement)
    .filter(node => node.declarationList.declarations.some(declaration =>
      declaration.name.getText(parsed) === 'EXIT_STDIO_GRACE_MS'));
  const grace = constants[0];
  if (functions.length !== 1 || !wait?.body || wait.typeParameters?.length || wait.asteriskToken ||
      wait.modifiers?.length !== 1 || wait.modifiers[0].kind !== ts.SyntaxKind.ExportKeyword ||
      wait.parameters.length !== 1 || wait.parameters[0].name.getText(parsed) !== 'child' ||
      wait.parameters[0].type?.getText(parsed) !== 'ChildProcess' || wait.parameters[0].questionToken ||
      wait.parameters[0].initializer || wait.parameters[0].dotDotDotToken ||
      wait.type?.getText(parsed).replace(/\s/g, '') !== 'Promise<number|null>' ||
      constants.length !== 1 || !grace || grace.declarationList.declarations.length !== 1 ||
      !(grace.declarationList.flags & ts.NodeFlags.Const) ||
      grace.declarationList.declarations[0].initializer?.getText(parsed) !== '100') {
    throw new Error('Native child process wait boundary changed');
  }
  const edits = [
    { start: grace.getFullStart(), end: grace.end, text: '' },
    { start: wait.getStart(parsed), end: wait.end,
      text: 'export { waitForChildProcess } from "../../compat/child-process.ts";' },
  ];
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return body;
}

export function portShell(body: string): string {
  const parsed = ts.createSourceFile('shell.ts', body, ts.ScriptTarget.Latest, true);
  const expected: Record<string, string> = {
    isLegacyWslBashPath: 'function isLegacyWslBashPath(path: string): boolean',
    getBashShellConfig: 'function getBashShellConfig(shell: string): ShellConfig',
    killProcessTree: 'export function killProcessTree(pid: number): void',
    sanitizeBinaryOutput: 'export function sanitizeBinaryOutput(str: string): string',
  };
  const imports: Record<string, string> = {
    'import { delimiter, join, win32 } from "node:path";': 'import { delimiter, win32 } from "node:path";',
    'import { spawn, spawnSync } from "child_process";': 'import { spawnSync } from "child_process";',
  };
  const remaining = new Set([...Object.keys(expected), ...Object.keys(imports)]);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && Object.hasOwn(expected, node.name.text)) {
      if (!remaining.delete(node.name.text) || !node.body ||
          node.getText(parsed).slice(0, node.body.getStart(parsed) - node.getStart(parsed)).trim() !== expected[node.name.text]) {
        throw new Error('Native shell algorithm boundary changed');
      }
      edits.push({ start: node.getFullStart(), end: node.end, text: '' });
    } else if (ts.isImportDeclaration(node) && Object.hasOwn(imports, node.getText(parsed))) {
      const text = node.getText(parsed);
      remaining.delete(text);
      edits.push({ start: node.getStart(parsed), end: node.end, text: imports[text] });
    }
  }
  if (remaining.size) throw new Error('Native shell declarations changed');
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return 'import { getBashShellConfig, killProcessTree } from "../../compat/shell.ts";\n'
    + 'export { killProcessTree };\n' + body;
}
