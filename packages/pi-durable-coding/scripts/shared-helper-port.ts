/** Share selected coding algorithms without importing the complete SDK into light entry points. */
import ts from 'typescript';

export function portSharedHelpers(path: string, body: string): string {
  if (path === 'extensions/codemode/execute.ts') return portCodemodeModels(portCodemodeOutput(body));
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

function portCodemodeOutput(body: string): string {
  const parsed = ts.createSourceFile('execute.ts', body, ts.ScriptTarget.Latest, true);
  const functions = new Map([
    ['valueText', 1], ['formatOutput', 1], ['joinAdjacentText', 1], ['formatCallSummary', 1],
    ['formatError', 2], ['spillOutput', 1], ['saveImages', 1], ['truncateOutput', 2],
  ]);
  const constants = new Set(['DEFAULT_MAX_OUTPUT_TOKENS', 'CHARS_PER_TOKEN', 'IMAGE_EXTENSIONS']);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let replaced = false;
  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && functions.has(node.name.text)) {
      if (node.parameters.length !== functions.get(node.name.text)) throw new Error('Codemode formatter signature changed');
      functions.delete(node.name.text);
      edits.push({ start: node.getFullStart(), end: node.end, text: '' });
    }
    if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
      const name = node.declarationList.declarations[0].name;
      if (ts.isIdentifier(name) && constants.delete(name.text)) {
        edits.push({ start: node.getFullStart(), end: node.end, text: '' });
      }
    }
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const imports = node.importClause.namedBindings;
      const kept = imports.elements.filter(item => !['CodemodeOutputItem', 'ImageContent'].includes(item.name.text));
      if (kept.length !== imports.elements.length) {
        edits.push({ start: imports.getStart(parsed), end: imports.end, text: '{ ' + kept.map(item => item.getText(parsed)).join(', ') + ' }' });
      }
    }
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== 'executeCodemode' || !node.body) continue;
    const statements = node.body.statements;
    const nameOf = (statement: ts.Statement) => ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0].name.getText(parsed)
      : ts.isIfStatement(statement) ? 'if' : ts.isReturnStatement(statement) ? 'return' : '';
    const start = statements.findIndex(statement => nameOf(statement) === 'scriptOutput');
    const tail = statements.slice(start);
    const expected = ['scriptOutput', 'if', 'items', 'if', 'if', 'truncated', 'output', 'wallTime', 'header', 'details', 'if', 'return'];
    const store = tail[1];
    if (start < 0 || JSON.stringify(tail.map(nameOf)) !== JSON.stringify(expected) || !ts.isIfStatement(store) ||
        store.expression.getText(parsed) !== 'result.ok' || !ts.isBlock(store.thenStatement) ||
        store.thenStatement.statements.length !== 3) throw new Error('Codemode completion boundary changed');
    const value = store.thenStatement.statements[2];
    if (!ts.isIfStatement(value) || value.expression.getText(parsed) !== 'result.value !== undefined' ||
        !value.getText(parsed).includes('scriptOutput.push')) throw new Error('Codemode returned-value boundary changed');
    const persisted = body.slice(store.getStart(parsed), value.getFullStart()) + body.slice(value.end, store.end);
    const completion = `
	const formatted = await formatCodemodeResult(result, {
		generatedImages,
		wallMs: () => performance.now() - startedAt,
		maxOutputTokens: sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
		calls,
		limits: false,
		imageSize: formatSize,
		write: async (name, data) => {
			try {
				return { path: await writeOutputFile("pi-codemode", extname(name), data) };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	});
	const details = snapshot();
	if (formatted.fullOutputPath) details.fullOutputPath = formatted.fullOutputPath;
	return {
		content: formatted.content,
		details,
		...(modelUsage ? { usage: modelUsage } : {}),
		...(result.ok ? {} : { isError: true }),
	};`;
    edits.push({ start: tail[0].getFullStart(), end: tail.at(-1)!.end, text: '\n\t' + persisted + '\n' + completion });
    replaced = true;
  }
  if (functions.size || constants.size || !replaced) throw new Error('Codemode output declarations changed');
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return 'import { extname } from "node:path";\n'
    + 'import { DEFAULT_MAX_OUTPUT_TOKENS, formatCodemodeResult } from "@earendil-works/pi-durable/codemode";\n' + body;
}

function portCodemodeModels(body: string): string {
  const parsed = ts.createSourceFile('execute.ts', body, ts.ScriptTarget.Latest, true);
  const functions = new Map([['withArticle', 1], ['checkClassifierContext', 1], ['checkImagesContext', 1]]);
  const declarations = new Set(['ScriptValue', 'CLASSIFIER_CONTEXT_SHAPE', 'ModelCallResult']);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let replaced = false;
  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && functions.has(node.name.text)) {
      if (node.parameters.length !== functions.get(node.name.text)) throw new Error('Codemode model validation signature changed');
      functions.delete(node.name.text);
      edits.push({ start: node.getFullStart(), end: node.end, text: '' });
    }
    const named = ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
      ? node.declarationList.declarations[0].name
      : ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) ? node.name : undefined;
    if (named && ts.isIdentifier(named) && declarations.delete(named.text)) {
      edits.push({ start: node.getFullStart(), end: node.end, text: '' });
    }
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const imports = node.importClause.namedBindings;
      const kept = imports.elements.filter(item => !['ClassifierContext', 'ImagesContext', 'ModelTypeMap'].includes(item.name.text));
      if (kept.length !== imports.elements.length) {
        edits.push({ start: imports.getStart(parsed), end: imports.end, text: '{ ' + kept.map(item => item.getText(parsed)).join(', ') + ' }' });
      }
    }
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== 'createModelGlobals' || !node.body) continue;
    const variables = node.body.statements.filter(ts.isVariableStatement);
    const names = variables.map(item => item.declarationList.declarations[0].name.getText(parsed));
    if (node.parameters.length !== 6 || JSON.stringify(names) !== JSON.stringify(['limit', 'callCount', 'runModelCall', 'implementations'])) {
      throw new Error('Codemode model globals boundary changed');
    }
    const dispatch = variables[2];
    const arrow = dispatch.declarationList.declarations[0].initializer;
    if (!arrow || !ts.isArrowFunction(arrow) || arrow.parameters.length !== 5 || arrow.typeParameters?.length !== 3) {
      throw new Error('Codemode model dispatcher changed');
    }
    edits.push({ start: dispatch.getFullStart(), end: dispatch.end, text: `

	const source = {
		getModelOfType: models.getModelOfType.bind(models),
		classify: (...[model, context, options]: Parameters<CodemodeModelRuntime["classify"]>) =>
			models.classify(model, context, { signal: options?.signal }),
		generateImages: (...[model, context, options]: Parameters<CodemodeModelRuntime["generateImages"]>) =>
			models.generateImages(model, context, { signal: options?.signal }),
	};
	const runModelCall = async (
		name: "models.classify" | "models.generateImages",
		[model, context]: unknown[],
		signal: AbortSignal,
	): Promise<unknown> => {
		const prepared = prepareCodemodeModelCall(name, { model, context }, source, { docsPath: CODEMODE_DOCS_PATH });
		const record: CodemodeNestedCall = {
			id: \`\${toolCallId}/\${name}/\${++callCount}\`,
			name,
			args: \`\${prepared.model.provider}/\${prepared.model.id}\`,
			status: "running",
		};
		calls.push(record);
		publish();
		const startedAt = performance.now();
		const execution = await limit(() => prepared.execute(withAbortSignal(signal, BACKGROUND_CONTEXT)));
		const result = execution.structuredOutput;
		if (name === "models.generateImages" && "output" in result && Array.isArray(result.output)) {
			addGeneratedImages(result.output.filter((block) =>
				typeof block === "object" && block !== null && "type" in block && block.type === "image").length);
		}
		record.durationMs = performance.now() - startedAt;
		record.status = result.stopReason === "stop" ? "ok" : result.stopReason === "aborted" ? "cancelled" : "error";
		if (result.errorMessage) record.error = truncateText(result.errorMessage, ERROR_PREVIEW_CHARS);
		if (result.usage) {
			record.cost = result.usage.cost.total;
			addUsage(result.usage);
		}
		publish();
		return result;
	};` });
    const object = variables[3].declarationList.declarations[0].initializer;
    if (!object || !ts.isObjectLiteralExpression(object) || object.properties.length !== 5) throw new Error('Codemode model globals changed');
    const remaining = new Set(['models.classify', 'models.generateImages']);
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !remaining.delete(property.name.text)) continue;
      const name = property.name.text;
      edits.push({ start: property.getStart(parsed), end: property.end,
        text: JSON.stringify(name) + ': (args, { signal }) => runModelCall(' + JSON.stringify(name) + ', args as unknown[], signal)' });
    }
    if (remaining.size) throw new Error('Codemode model helper names changed');
    replaced = true;
  }
  if (functions.size || declarations.size || !replaced) throw new Error('Codemode model declarations changed');
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  const imported = 'import { DEFAULT_MAX_OUTPUT_TOKENS, formatCodemodeResult } from "@earendil-works/pi-durable/codemode";';
  if (!body.includes(imported)) throw new Error('Codemode shared formatter import changed');
  return body.replace(imported,
    'import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";\n'
    + 'import { DEFAULT_MAX_OUTPUT_TOKENS, formatCodemodeResult, prepareCodemodeModelCall } from "@earendil-works/pi-durable/codemode";');
}
