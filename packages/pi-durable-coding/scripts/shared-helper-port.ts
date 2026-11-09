/** Share selected coding algorithms without importing the complete SDK into light entry points. */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { portPhotonRuntime } from './asset-runtime-port.ts';
import {
  portCodemodeRuntime, portToolArchives, portImageOrientation, portImageResize, portImageMime,
  portAnsi, portChildProcess, portShell, portTruncation,
} from './shared-runtime-port.ts';

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

export function excludePrivateHostComponents(path: string, body: string): string | undefined {
  if (path !== 'modes/interactive/components/index.ts') return undefined;
  const removed = [
    'export {\n\tFirstTimeSetupComponent,\n\ttype FirstTimeSetupOptions,\n\ttype FirstTimeSetupResult,\n} from "./first-time-setup.ts";\n',
    'export { type ModelsCallbacks, type ModelsConfig, ScopedModelsSelectorComponent } from "./scoped-models-selector.ts";\n',
    'export { TrustSelectorComponent } from "./trust-selector.ts";\n',
  ];
  for (const before of removed) {
    if (body.split(before).length !== 2) throw new Error('Pinned private host component export changed');
    body = body.replace(before, '');
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
  'cli/args.ts': {
    change: 'exclude-upstream-cli-helpers',
    apply(body) {
      const parsed = ts.createSourceFile('args.ts', body, ts.ScriptTarget.Latest, true);
      const functions = ['printHelp', 'normalizeSessionName'];
      const imports = ['chalk', '../config.ts'];
      const flagImport = 'import type { ExtensionFlag } from "@earendil-works/pi-coding-agent";';
      const removed = parsed.statements.filter(node =>
        ts.isFunctionDeclaration(node) && functions.includes(node.name?.text ?? '') ||
        ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
          (imports.includes(node.moduleSpecifier.text) || node.getText(parsed) === flagImport));
      if (removed.filter(node => node.getText(parsed) === flagImport).length !== 1 ||
          functions.some(name => removed.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name).length !== 1) ||
          imports.some(path => removed.filter(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === path).length !== 1)) {
        throw new Error('Pinned CLI helper boundary changed');
      }
      return parsed.statements.filter(node => !removed.includes(node)).map(node => node.getFullText(parsed)).join('')
        .replace('CLI argument parsing and help display', 'CLI argument parsing').trimEnd() + '\n';
    },
  },
  'utils/photon.ts': {
    change: 'shared-durable-photon-runtime', dependency: '@silvia-odwyer/photon', apply: portPhotonRuntime,
  },
  'extensions/codemode/execute.ts': {
    change: 'shared-durable-codemode-executor', dependency: '@earendil-works/pi-durable', apply: portCodemodeRuntime,
  },
  'utils/tools-manager.ts': {
    change: 'public-jszip-tool-archives', dependency: 'jszip', apply: portToolArchives,
  },
  'utils/exif-orientation.ts': {
    change: 'shared-durable-image-orientation', dependency: '@earendil-works/pi-durable', apply: portImageOrientation,
  },
  'utils/image-resize-core.ts': {
    change: 'shared-durable-image-encoding', dependency: '@earendil-works/pi-durable', apply: portImageResize,
  },
  'utils/mime.ts': {
    change: 'shared-durable-image-mime', dependency: '@earendil-works/pi-durable', apply: portImageMime,
  },
  'utils/ansi.ts': {
    change: 'public-ansi-regex-complete-matcher', dependency: 'ansi-regex', apply: portAnsi,
  },
  'utils/child-process.ts': {
    change: 'shared-durable-child-process-wait', dependency: '@earendil-works/pi-durable', apply: portChildProcess,
  },
  'utils/shell.ts': {
    change: 'shared-durable-shell-algorithms', dependency: '@earendil-works/pi-durable', apply: portShell,
  },
  'core/tools/truncate.ts': {
    change: 'public-chord-output-truncation', dependency: '@earendil-works/chord', apply: portTruncation,
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
  'core/compaction/compaction.ts': {
    change: 'public-pi-ai-context-token-total',
    names: ['calculateContextTokens'],
    imports: 'import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";\nexport { calculateContextTokens };',
    signatures: { calculateContextTokens: 'export function calculateContextTokens(usage: Usage): number' },
  },
  'core/footer-data-provider.ts': {
    change: 'shared-lightweight-resource-algorithms',
    names: ['GitPaths', 'findGitPaths'],
    imports: 'import { findGitPaths, type GitPaths } from "../../upstream/core/git-paths.ts";\nexport { findGitPaths, type GitPaths };',
  },
  'extensions/tool-search/tool.ts': {
    change: 'shared-durable-tool-search-ranking', dependency: '@earendil-works/pi-durable',
    names: ['TOOL_SEARCH_TOOL_NAME', 'DEFAULT_TOOL_SEARCH_LIMIT', 'TOOL_SEARCH_DESCRIPTION',
      'wordSegmenter', 'STOP_WORDS', 'stem', 'tokenize', 'normalizeName', 'isExactNameQuery',
      'IndexedDocument', 'indexDocument', 'NAME_WEIGHT', 'NAMESPACE_WEIGHT', 'isObject', 'schemaText'],
    imports: 'import { createToolSearchText, createToolSearchTool, rankToolSearchDocuments, DEFAULT_TOOL_SEARCH_LIMIT, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";\n'
      + 'export { DEFAULT_TOOL_SEARCH_LIMIT, TOOL_SEARCH_TOOL_NAME, tokenizeToolSearch as tokenize } from "@earendil-works/pi-durable/tool-search";\n'
      + 'export const TOOL_SEARCH_DESCRIPTION = createToolSearchTool().description;',
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
  let sharedRanker = false;
  let sharedDocument = false;
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
      if (path === 'extensions/tool-search/tool.ts' && statement.name.text === 'tokenize' &&
          (!ts.isFunctionDeclaration(statement) || statement.parameters.length !== 1 ||
            statement.parameters[0].type?.kind !== ts.SyntaxKind.StringKeyword || statement.type?.getText(parsed) !== 'string[]')) {
        throw new Error('Tool search tokenizer boundary changed');
      }
      edits.push({ start: statement.getFullStart(), end: statement.end,
        text: rule.replacements?.[statement.name.text] ? '\n\n' + rule.replacements[statement.name.text] : '' });
    }
    if (path === 'extensions/tool-search/tool.ts' && ts.isFunctionDeclaration(statement) &&
        statement.name?.text === 'createToolSearchDocument') {
      if (!statement.body || statement.parameters.length !== 2 || statement.type?.getText(parsed) !== 'ToolSearchDocument') {
        throw new Error('Tool search document boundary changed');
      }
      edits.push({ start: statement.body.getStart(parsed), end: statement.body.end,
        text: '{\n\tconst namespaceText = namespace\n\t\t? [namespace.name, namespace.description ?? "", namespace.instructions ?? ""].join(" ")\n\t\t: "";\n\treturn { name: tool.name, text: createToolSearchText(tool), namespaceText };\n}' });
      sharedDocument = true;
    }
    if (path === 'extensions/tool-search/tool.ts' &&
        ts.isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations;
      if (declarations.length === 1 && ts.isIdentifier(declarations[0].name) && rule.names.includes(declarations[0].name.text)) {
        const name = declarations[0].name.text;
        if (!remaining.delete(name)) throw new Error(`Shared declaration repeated: ${path}: ${name}`);
        const replacement = rule.replacements?.[name];
        edits.push({ start: replacement ? statement.getStart(parsed) : statement.getFullStart(), end: statement.end,
          text: replacement ?? '' });
      }
    }
    if (path === 'extensions/tool-search/tool.ts' && ts.isClassDeclaration(statement) && statement.name?.text === 'Bm25Ranker') {
      const method = statement.members.find(member => ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) && member.name.text === 'rank');
      const fields = statement.members.filter(ts.isPropertyDeclaration).map(member => member.name.getText(parsed));
      if (!method || !ts.isMethodDeclaration(method) || !method.body || method.parameters.length !== 3 ||
          method.type?.getText(parsed) !== 'ToolSearchMatch[]' || !fields.includes('k1') || !fields.includes('b')) {
        throw new Error('Tool search ranker boundary changed');
      }
      edits.push({ start: method.body.getStart(parsed), end: method.body.end,
        text: '{\n\t\treturn rankToolSearchDocuments(query, documents, limit, { k1: this.k1, b: this.b });\n\t}' });
      sharedRanker = true;
    }

  }
  if (path === 'extensions/tool-search/tool.ts' && (!sharedRanker || !sharedDocument)) throw new Error('Tool search public boundary changed');
  if (remaining.size) throw new Error(`Shared declarations changed: ${path}: ${[...remaining].join(', ')}`);
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  if (path === 'core/extensions/pi-ai-extension-view.ts') {
    const original = 'import { type TUnsafe, Type } from "typebox";';
    if (body.split(original).length !== 2) throw new Error('Native TypeBox import changed');
  }
  return rule.imports + '\n' + body;
}
