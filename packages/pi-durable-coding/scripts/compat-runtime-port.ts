/** Add default-preserving seams for legacy policies over one coding implementation. */
export function portCompatRuntime(path: string, source: string): string {
  let body = source;
  const replace = (before: string, after: string, expected = 1) => {
    const count = body.split(before).length - 1;
    if (count !== expected) throw new Error(`Compatibility boundary changed: ${path}: ${before}: ${count} != ${expected}`);
    body = body.replaceAll(before, after);
  };
  if (path === 'core/extensions/runner.ts') {
    replace('\tprivate uiContext: ExtensionUIContext;', `\tprivate uiContext: ExtensionUIContext;
\tprivate readonly noOpUIContext: ExtensionUIContext;
\tprivate readonly renderSystemPrompt: typeof buildSystemPrompt;`);
    replace('\t\tmodelRegistry: ModelRegistry,\n\t) {',
      '\t\tmodelRegistry: ModelRegistry,\n\t\tdependencies: { getTheme?: () => Theme; buildSystemPrompt?: typeof buildSystemPrompt } = {},\n\t) {');
    replace('\t\tthis.uiContext = noOpUIContext;', `\t\tconst getTheme = dependencies.getTheme;
\t\tthis.noOpUIContext = getTheme
\t\t\t? {
\t\t\t\t\t...noOpUIContext,
\t\t\t\t\tget theme() {
\t\t\t\t\t\treturn getTheme();
\t\t\t\t\t},
\t\t\t\t}
\t\t\t: noOpUIContext;
\t\tthis.uiContext = this.noOpUIContext;
\t\tthis.renderSystemPrompt = dependencies.buildSystemPrompt ?? buildSystemPrompt;`);
    replace('this.wrapUIPromptContext(uiContext) : noOpUIContext', 'this.wrapUIPromptContext(uiContext) : this.noOpUIContext');
    replace('this.uiContext !== noOpUIContext', 'this.uiContext !== this.noOpUIContext');
    replace('(): string => buildSystemPrompt(currentOptions)', '(): string => this.renderSystemPrompt(currentOptions)');
  }
  return body;
}
