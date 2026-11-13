/** Keep Coding presentation in the SDK and bind only the script executor. */
export function codingCodemodePolicy(source: string, declarations: boolean, extension: boolean): string {
  const edit = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error('Published codemode boundary changed: ' + before);
    source = source.replace(before, after);
  };
  if (extension) {
    if (declarations) {
      source = 'import type { CodemodeDependencies } from "./tool.ts";\n' + source;
      edit('options?: CodemodeExtensionOptions)', 'options?: CodemodeExtensionOptions, dependencies?: CodemodeDependencies)');
    } else {
      edit('export function createCodemodeExtension(options = {}) {', 'export function createCodemodeExtension(options = {}, dependencies) {');
      edit('            }),\n            defaultActive:', '            }, dependencies),\n            defaultActive:');
    }
  } else if (declarations) {
    source = 'import type { executeCodemode } from "./execute.ts";\n' + source;
    edit('export interface CodemodeToolOptions {', 'export interface CodemodeDependencies {\n    executeCodemode?: typeof executeCodemode;\n}\nexport interface CodemodeToolOptions {');
    edit('options?: CodemodeToolOptions): ToolDefinition', 'options?: CodemodeToolOptions, dependencies?: CodemodeDependencies): ToolDefinition');
    edit('options?: CodemodeToolOptions): TypeBoxAgentTool', 'options?: CodemodeToolOptions, dependencies?: CodemodeDependencies): TypeBoxAgentTool');
  } else {
    edit('export function createCodemodeToolDefinition(options = {}) {', 'export function createCodemodeToolDefinition(options = {}, dependencies) {');
    edit('(await loadCodemodeExecutor()).executeCodemode(', '(dependencies?.executeCodemode ?? (await loadCodemodeExecutor()).executeCodemode)(');
    edit('export function createCodemodeTool(tools = [], options = {}) {', 'export function createCodemodeTool(tools = [], options = {}, dependencies) {');
    edit('const definition = createCodemodeToolDefinition(options);', 'const definition = createCodemodeToolDefinition(options, dependencies);');
  }
  return source;
}
