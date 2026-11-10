/** Share selected coding algorithms without importing the complete SDK into light entry points. */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { portShell } from './shared-runtime-port.ts';

export function excludeRunModeEntries(path: string, body: string): string | undefined {
  if (path !== 'index.ts' && path !== 'modes/index.ts') return undefined;
  const removed = path === 'index.ts' ? [
    '\tInteractiveMode,\n', '\ttype InteractiveModeOptions,\n', '\ttype PrintModeOptions,\n',
    '\trunPrintMode,\n', '\trunRpcMode,\n',
  ] : [
    'export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";\n',
    'export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";\n',
    'export { runRpcMode } from "./rpc/rpc-mode.ts";\n',
  ];
  const comment = path === 'index.ts'
    ? ['// Run modes for programmatic SDK usage', '// RPC client and protocol for programmatic SDK usage']
    : [' * Run modes for the coding agent.', ' * RPC client and protocol exports.'];
  for (const before of [...removed, comment[0]]) {
    if (body.split(before).length !== 2) throw new Error(`Pinned run mode export changed: ${path}`);
    body = body.replace(before, before === comment[0] ? comment[1] : '');
  }
  return body;
}

type DeclarationPort = {
  names: string[]; imports: string; hashes?: Record<string, string>; replacements?: Record<string, string>;
  signatures?: Record<string, string>;
};

type SharedHelperPort = {
  change: string;
  dependency?: string;
} & (DeclarationPort | { apply(body: string): string });

const sharedHelperPorts: Record<string, SharedHelperPort> = {
  'utils/shell.ts': {
    change: 'shared-durable-shell-algorithms', dependency: '@earendil-works/pi-durable', apply: portShell,
  },
  'core/extensions/pi-ai-extension-view.ts': {
    change: 'public-pi-ai-typebox-string-enum',
    names: ['StringEnum'],
    imports: 'import { StringEnum as publicStringEnum } from "@earendil-works/pi-ai/compat";',
    signatures: { StringEnum: `export function StringEnum<T extends readonly string[]>(
\tvalues: T,
\toptions?: { description?: string; default?: T[number] },
): TUnsafe<T[number]>` },
    replacements: { StringEnum: `/** Keep TypeBox branding and literal inference at the Native plugin boundary. */
export function StringEnum<T extends readonly string[]>(
\tvalues: T,
\toptions?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
\treturn Type.Unsafe<T[number]>(publicStringEnum(values, options));
}` },
  },
};

export function portSharedHelpers(path: string, body: string): string {
  return applySharedHelperPort(path, body)?.body ?? body;
}

export function applySharedHelperPort(
  path: string, body: string,
): { body: string; change: string; dependency?: string } | undefined {
  if (!Object.hasOwn(sharedHelperPorts, path)) return undefined;
  const rule = sharedHelperPorts[path];
  return {
    body: 'apply' in rule ? rule.apply(body) : portDeclarations(path, body, rule),
    change: rule.change, dependency: rule.dependency,
  };
}

function portDeclarations(path: string, body: string, rule: DeclarationPort): string {
  const parsed = ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true);
  const remaining = new Set(rule.names);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const statement of parsed.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
        statement.name && rule.names.includes(statement.name.text)) {
      if (!remaining.delete(statement.name.text)) throw new Error(`Shared declaration repeated: ${path}: ${statement.name.text}`);
      const signature = rule.signatures?.[statement.name.text];
      if (signature && (!ts.isFunctionDeclaration(statement) || !statement.body ||
          statement.getText(parsed).slice(0, statement.body.getStart(parsed) - statement.getStart(parsed)).trim() !== signature)) {
        throw new Error(`Public helper signature changed: ${path}: ${statement.name.text}`);
      }
      const expected = rule.hashes?.[statement.name.text];
      if (expected && createHash('sha256').update(statement.getText(parsed)).digest('hex') !== expected) {
        throw new Error(`Public helper declaration changed: ${path}: ${statement.name.text}`);
      }
      edits.push({ start: statement.getFullStart(), end: statement.end,
        text: rule.replacements?.[statement.name.text] ? '\n\n' + rule.replacements[statement.name.text] : '' });
    }
  }
  if (remaining.size) throw new Error(`Shared declarations changed: ${path}: ${[...remaining].join(', ')}`);
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  if (path === 'core/extensions/pi-ai-extension-view.ts') {
    const original = 'import { type TUnsafe, Type } from "typebox";';
    if (body.split(original).length !== 2) throw new Error('Native TypeBox import changed');
  }
  return rule.imports + '\n' + body;
}
