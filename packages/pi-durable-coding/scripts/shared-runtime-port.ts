/** Preserve Native forwarding boundaries while reusing public implementations. */
import { createHash } from 'node:crypto';
import ts from 'typescript';

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
