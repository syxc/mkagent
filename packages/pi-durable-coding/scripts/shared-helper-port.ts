/** Share selected coding algorithms without importing the complete SDK into light entry points. */
import ts from 'typescript';

export function portSharedHelpers(path: string, body: string): string {
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
