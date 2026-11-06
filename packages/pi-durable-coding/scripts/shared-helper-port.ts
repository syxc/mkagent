/** Share selected coding algorithms without importing the complete SDK into light entry points. */
import ts from 'typescript';

export function portSharedHelpers(path: string, body: string): string {
  if (path === 'extensions/codemode/execute.ts') return portCodemodeRuntime(body);
  if (path === 'utils/zip.ts') return portZipRuntime(body);
  if (path === 'utils/tools-manager.ts') return portToolArchives(body);
  const files: Record<string, { names: string[]; imports: string }> = {
    'core/footer-data-provider.ts': {
      names: ['GitPaths', 'findGitPaths'],
      imports: 'import { findGitPaths, type GitPaths } from "../../upstream/core/git-paths.ts";\nexport { findGitPaths, type GitPaths };',
    },
    'core/resource-loader.ts': {
      names: ['loadContextFileFromDir', 'findShadowedContextFile', 'loadProjectContextFiles'],
      imports: 'import { loadContextFileFromDir, findShadowedContextFile, loadProjectContextFiles } from "../../upstream/core/context-files.ts";\n'
        + 'export { loadProjectContextFiles };\nimport { dedupePrompts } from "../../upstream/core/resource-collisions.ts";',
    },
    'extensions/tool-search/tool.ts': {
      names: ['TOOL_SEARCH_TOOL_NAME', 'DEFAULT_TOOL_SEARCH_LIMIT', 'TOOL_SEARCH_DESCRIPTION',
        'wordSegmenter', 'STOP_WORDS', 'stem', 'tokenize', 'normalizeName', 'isExactNameQuery',
        'IndexedDocument', 'indexDocument', 'NAME_WEIGHT', 'NAMESPACE_WEIGHT', 'isObject', 'schemaText'],
      imports: 'import { createToolSearchText, createToolSearchTool, rankToolSearchDocuments, DEFAULT_TOOL_SEARCH_LIMIT, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";\n'
        + 'export { DEFAULT_TOOL_SEARCH_LIMIT, TOOL_SEARCH_TOOL_NAME, tokenizeToolSearch as tokenize } from "@earendil-works/pi-durable/tool-search";\n'
        + 'export const TOOL_SEARCH_DESCRIPTION = createToolSearchTool().description;',
    },
  };
  const rule = files[path];
  if (!rule) return body;
  const parsed = ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true);
  const remaining = new Set(rule.names);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let sharedRanker = false;
  let sharedDocument = false;
  for (const statement of parsed.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
        statement.name && remaining.delete(statement.name.text)) {
      if (path === 'extensions/tool-search/tool.ts' && statement.name.text === 'tokenize' &&
          (!ts.isFunctionDeclaration(statement) || statement.parameters.length !== 1 ||
            statement.parameters[0].type?.kind !== ts.SyntaxKind.StringKeyword || statement.type?.getText(parsed) !== 'string[]')) {
        throw new Error('Tool search tokenizer boundary changed');
      }
      edits.push({ start: statement.getFullStart(), end: statement.end, text: '' });
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
    if (path === 'extensions/tool-search/tool.ts' && ts.isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations;
      if (declarations.length === 1 && ts.isIdentifier(declarations[0].name) && remaining.delete(declarations[0].name.text)) {
        edits.push({ start: statement.getFullStart(), end: statement.end, text: '' });
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
  if (path === 'core/resource-loader.ts') body = body.replace('import { findGitPaths } from "./footer-data-provider.ts";\n', '');
  return rule.imports + '\n' + body;
}

function portCodemodeRuntime(body: string): string {
  const parsed = ts.createSourceFile('execute.ts', body, ts.ScriptTarget.Latest, true);
  const functions = new Map(parsed.statements.filter(ts.isFunctionDeclaration)
    .flatMap(node => node.name ? [[node.name.text, node] as const] : []));
  const execute = functions.get('executeCodemode'), store = functions.get('readCodemodeStore');
  if (!execute || execute.parameters.length !== 6 ||
      execute.parameters.map(parameter => parameter.name.getText(parsed)).join(',') !== 'toolCallId,input,signal,onUpdate,ctx,options' ||
      execute.type?.getText(parsed) !== 'Promise<AgentToolResult<CodemodeToolDetails>>' ||
      !store || store.parameters.length !== 1 || store.parameters[0].name.getText(parsed) !== 'branch' ||
      store.type?.getText(parsed) !== 'Record<string, unknown>') {
    throw new Error('Native codemode public boundary changed');
  }
  return '/** Native policy over the public durable codemode executor. */\n'
    + 'export { executeNativeCodemode as executeCodemode, readCodemodeStore } from "../../../compat/codemode-native.ts";\n';
}

function portZipRuntime(body: string): string {
  const parsed = ts.createSourceFile('zip.ts', body, ts.ScriptTarget.Latest, true);
  const exports = parsed.statements.filter(node => ts.isExportDeclaration(node) || ts.isExportAssignment(node) ||
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const entry = parsed.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'ZipEntry');
  const write = exports[0];
  if (exports.length !== 1 || !write || !ts.isFunctionDeclaration(write) || write.name?.text !== 'writeZipArchive' ||
      write.modifiers?.some(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword) ||
      write.parameters.some(parameter => parameter.questionToken || parameter.initializer || parameter.dotDotDotToken) ||
      write.parameters.map(parameter => parameter.name.getText(parsed)).join(',') !== 'filePath,entries' ||
      write.parameters.map(parameter => parameter.type?.getText(parsed)).join(',') !== 'string,readonly ZipEntry[]' ||
      write.type?.getText(parsed) !== 'Promise<void>' || !entry || !ts.isInterfaceDeclaration(entry) ||
      entry.members.map(member => member.getText(parsed)).join('') !== 'name: string;data: string | Uint8Array;') {
    throw new Error('Native ZIP writer boundary changed');
  }
  return '/** Native archive policy over the public ZIP implementation. */\n'
    + 'export { writeZipArchive } from "../../compat/archive.ts";\n';
}

function portToolArchives(body: string): string {
  const parsed = ts.createSourceFile('tools-manager.ts', body, ts.ScriptTarget.Latest, true);
  const names = new Set(['extractZipArchive', 'getWindowsTarCommand']);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let calls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === 'getWindowsTarCommand' ||
        (node.text === 'extractZipArchive' && (!ts.isCallExpression(node.parent) || node.parent.expression !== node)))) {
      throw new Error('Native ZIP extraction reference changed');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'extractZipArchive') {
      if (!ts.isExpressionStatement(node.parent) ||
          node.arguments.map(argument => argument.getText(parsed)).join(',') !== 'archivePath,extractDir,assetName') {
        throw new Error('Native ZIP extraction call changed');
      }
      edits.push({ start: node.getStart(parsed), end: node.getStart(parsed), text: 'await ' });
      calls++;
    }
    ts.forEachChild(node, visit);
  };
  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && names.delete(node.name.text)) {
      const parameters = node.name.text === 'extractZipArchive' ? 'archivePath,extractDir,assetName' : '';
      const result = node.name.text === 'extractZipArchive' ? 'void' : 'string';
      if (node.parameters.map(parameter => parameter.name.getText(parsed)).join(',') !== parameters ||
          node.parameters.some(parameter => parameter.type?.kind !== ts.SyntaxKind.StringKeyword) ||
          node.type?.getText(parsed) !== result || node.modifiers?.length) {
        throw new Error('Native ZIP extraction boundary changed');
      }
      edits.push({ start: node.getFullStart(), end: node.end, text: '' });
    } else visit(node);
  }
  if (names.size || calls !== 1) throw new Error('Native ZIP extraction declarations changed');
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return 'import { extractZipArchive } from "../../compat/archive.ts";\n' + body;
}
