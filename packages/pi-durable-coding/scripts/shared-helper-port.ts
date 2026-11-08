/** Share selected coding algorithms without importing the complete SDK into light entry points. */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { portEditDiff } from './edit-diff-port.ts';
import { portPhotonRuntime } from './asset-runtime-port.ts';
import {
  portCodemodeRuntime, portZipRuntime, portToolArchives, portImageOrientation, portImageResize, portImageMime,
  portAnsi, portChildProcess, portShell, portReadPaths, portTruncation,
} from './shared-runtime-port.ts';

type DeclarationPort = {
  names: string[]; imports: string; hashes?: Record<string, string>; replacements?: Record<string, string>;
  signatures?: Record<string, string>;
};

type SharedHelperPort = {
  change: string;
  dependency?: string;
} & (DeclarationPort | { apply(body: string): string });

const sharedHelperPorts: Record<string, SharedHelperPort> = {
  'utils/photon.ts': {
    change: 'shared-durable-photon-runtime', dependency: '@silvia-odwyer/photon', apply: portPhotonRuntime,
  },
  'extensions/codemode/execute.ts': {
    change: 'shared-durable-codemode-executor', dependency: '@earendil-works/pi-durable', apply: portCodemodeRuntime,
  },
  'utils/zip.ts': {
    change: 'public-fflate-zip-writer', dependency: 'fflate', apply: portZipRuntime,
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
  'core/tools/path-utils.ts': {
    change: 'shared-durable-read-path-variants', dependency: '@earendil-works/pi-durable', apply: portReadPaths,
  },
  'core/tools/truncate.ts': {
    change: 'public-chord-output-truncation', dependency: '@earendil-works/chord', apply: portTruncation,
  },
  'core/tools/edit-diff.ts': {
    change: 'shared-durable-edit-diff', dependency: '@earendil-works/pi-durable', apply: portEditDiff,
  },
  'core/tools/edit.ts': {
    change: 'public-durable-edit-arguments', dependency: '@earendil-works/pi-durable',
    names: ['LegacyEditToolInput', 'SingleEditInput', 'isSingleEditInput', 'prepareEditArguments'],
    imports: 'import { createEditTool as createDurableEditTool } from "@earendil-works/pi-durable/tools";',
    signatures: { prepareEditArguments: 'function prepareEditArguments(input: unknown): EditToolInput' },
    replacements: { prepareEditArguments: 'const prepareEditArguments = createDurableEditTool().prepareArguments;' },
  },
  'core/export-html/ansi-to-html.ts': {
    change: 'public-pi-tui-html-colors', dependency: '@earendil-works/pi-tui',
    names: ['ANSI_COLORS', 'color256ToHex'],
    imports: 'import { colorToHex } from "@earendil-works/pi-tui";\n',
    replacements: {
      ANSI_COLORS: 'const ANSI_COLORS = Array.from({ length: 16 }, (_, index) => color256ToHex(index));',
      color256ToHex: `function color256ToHex(index: number): string {
\t// Native SGR accepts indices above 255; the indexedColor factory rejects them.
\treturn colorToHex({ kind: "indexed", index });
}`,
    },
  },
  'core/models-store.ts': {
    change: 'public-pi-ai-memory-models-store',
    names: ['InMemoryCodingAgentModelsStore'],
    imports: 'import { InMemoryModelsStore } from "@earendil-works/pi-ai";',
    hashes: { InMemoryCodingAgentModelsStore: '93c704e7001cb783e30cf6e696fa6203fea7a9cb6e75648f48988c75a6dfdc67' },
    replacements: { InMemoryCodingAgentModelsStore: 'export class InMemoryCodingAgentModelsStore extends InMemoryModelsStore {}' },
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
  'core/resource-loader.ts': {
    change: 'shared-lightweight-resource-algorithms',
    names: ['loadContextFileFromDir', 'findShadowedContextFile', 'loadProjectContextFiles'],
    imports: 'import { loadContextFileFromDir, findShadowedContextFile, loadProjectContextFiles } from "../../upstream/core/context-files.ts";\n'
      + 'export { loadProjectContextFiles };\nimport { dedupePrompts } from "../../upstream/core/resource-collisions.ts";',
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
      if (path === 'core/export-html/ansi-to-html.ts' &&
          (!ts.isFunctionDeclaration(statement) || statement.name.text !== 'color256ToHex' ||
            statement.modifiers?.length || statement.typeParameters?.length || statement.asteriskToken ||
            statement.parameters.length !== 1 || statement.parameters[0].type?.kind !== ts.SyntaxKind.NumberKeyword ||
            statement.parameters[0].questionToken || statement.parameters[0].initializer || statement.parameters[0].dotDotDotToken ||
            statement.type?.kind !== ts.SyntaxKind.StringKeyword || !statement.body)) {
        throw new Error('HTML color conversion boundary changed');
      }
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
    if ((path === 'extensions/tool-search/tool.ts' || path === 'core/export-html/ansi-to-html.ts') &&
        ts.isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations;
      if (declarations.length === 1 && ts.isIdentifier(declarations[0].name) && rule.names.includes(declarations[0].name.text)) {
        const name = declarations[0].name.text;
        if (!remaining.delete(name)) throw new Error(`Shared declaration repeated: ${path}: ${name}`);
        if (path === 'core/export-html/ansi-to-html.ts' &&
            (name !== 'ANSI_COLORS' || statement.modifiers?.length || !(statement.declarationList.flags & ts.NodeFlags.Const))) {
          throw new Error('HTML palette boundary changed');
        }
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
    if (path === 'core/resource-loader.ts' && ts.isClassDeclaration(statement) &&
        statement.name?.text === 'DefaultResourceLoader') {
      const method = statement.members.find(member => ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) && member.name.text === 'dedupePrompts');
      if (!method || !ts.isMethodDeclaration(method) || !method.body) throw new Error('Prompt deduplication boundary changed');
      edits.push({ start: method.body.getStart(parsed), end: method.body.end, text: '{\n\t\treturn dedupePrompts(prompts);\n\t}' });
    }
  }
  if (path === 'extensions/tool-search/tool.ts' && (!sharedRanker || !sharedDocument)) throw new Error('Tool search public boundary changed');
  if (remaining.size) throw new Error(`Shared declarations changed: ${path}: ${[...remaining].join(', ')}`);
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  if (path === 'core/extensions/pi-ai-extension-view.ts') {
    const original = 'import { type TUnsafe, Type } from "typebox";';
    if (body.split(original).length !== 2) throw new Error('Native TypeBox import changed');
  }
  if (path === 'core/resource-loader.ts') body = body.replace('import { findGitPaths } from "./footer-data-provider.ts";\n', '');
  return rule.imports + '\n' + body;
}
