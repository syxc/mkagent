/** Bind host tool factories while the published SDK retains tool selection and assembly. */
import ts from 'typescript';

const tools = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];
const factories = tools.flatMap(name => {
  const title = name === 'powershell' ? 'PowerShell' : name[0].toUpperCase() + name.slice(1);
  return [`create${title}Tool`, `create${title}ToolDefinition`];
});
const aggregates = ['createToolDefinition', 'createTool', 'createCodingToolDefinitions',
  'createReadOnlyToolDefinitions', 'createAllToolDefinitions', 'createCodingTools',
  'createReadOnlyTools', 'createAllTools'];

export function codingToolFactoriesPolicy(source: string, declarations: boolean): string {
  const marker = '//# sourceMappingURL=';
  if (source.split(marker).length !== 2) throw new Error('Published tool index boundary changed');
  if (declarations) {
    return source.replace(marker, 'export interface ToolFactoryDependencies {\n'
      + tools.flatMap((name, index) => factories.slice(index * 2, index * 2 + 2)
        .map(factory => `    ${factory}?: typeof import("./${name}.ts").${factory};\n`)).join('')
      + '}\nexport interface ToolFactories {\n'
      + aggregates.map(name => `    ${name}: typeof ${name};\n`).join('')
      + '}\nexport declare function createToolFactories(dependencies?: ToolFactoryDependencies): ToolFactories;\n' + marker);
  }
  const parsed = ts.createSourceFile('tools/index.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const remaining = new Set(aggregates), used = new Set<string>();
  const selected: Array<{ start: number; end: number; body: string }> = [];
  for (const node of parsed.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !remaining.has(node.name.text)) continue;
    remaining.delete(node.name.text);
    const start = node.getFullStart();
    let body = source.slice(start, node.end);
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const visit = (child: ts.Node) => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && factories.includes(child.expression.text)) {
        used.add(child.expression.text);
        edits.push({ start: child.expression.getStart(parsed) - start, end: child.expression.end - start,
          text: 'factories.' + child.expression.text });
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    for (const edit of edits.reverse()) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
    const signature = `export function ${node.name.text}(`;
    if (body.split(signature).length !== 2) throw new Error('Published tool factory changed: ' + node.name.text);
    selected.push({ start, end: node.end, body: body.replace(signature, `function ${node.name.text}(`) });
  }
  if (remaining.size || used.size !== factories.length) throw new Error('Published tool aggregation changed');
  let body = source;
  for (const node of [...selected].reverse()) body = body.slice(0, node.start) + body.slice(node.end);
  return body.replace(marker, 'export function createToolFactories(dependencies = {}) {\n    const factories = {\n'
    + factories.map(name => `        ${name}: dependencies.${name} ?? ${name},\n`).join('')
    + '    };' + selected.map(node => node.body).join('')
    + '\n    return { ' + aggregates.join(', ') + ' };\n}\n'
    + 'export const { ' + aggregates.join(', ') + ' } = createToolFactories();\n' + marker);
}
