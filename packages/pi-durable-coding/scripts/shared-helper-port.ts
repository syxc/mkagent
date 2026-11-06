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
  };
  const rule = files[path];
  if (!rule) return body;
  const parsed = ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true);
  const remaining = new Set(rule.names);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const statement of parsed.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        statement.name && remaining.delete(statement.name.text)) {
      edits.push({ start: statement.getFullStart(), end: statement.end, text: '' });
    }
    if (path === 'core/resource-loader.ts' && ts.isClassDeclaration(statement) &&
        statement.name?.text === 'DefaultResourceLoader') {
      const method = statement.members.find(member => ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) && member.name.text === 'dedupePrompts');
      if (!method || !ts.isMethodDeclaration(method) || !method.body) throw new Error('Prompt deduplication boundary changed');
      edits.push({ start: method.body.getStart(parsed), end: method.body.end, text: '{\n\t\treturn dedupePrompts(prompts);\n\t}' });
    }
  }
  if (remaining.size) throw new Error(`Shared declarations changed: ${path}: ${[...remaining].join(', ')}`);
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  if (path === 'core/resource-loader.ts') body = body.replace('import { findGitPaths } from "./footer-data-provider.ts";\n', '');
  return rule.imports + '\n' + body;
}
