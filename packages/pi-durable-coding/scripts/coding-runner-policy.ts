/** Keep host presentation dependencies outside the SDK runner algorithms. */
export function codingRunnerPolicy(source: string, declarations: boolean): string {
  let body = source;
  const replace = (before: string, after: string) => {
    if (body.split(before).length !== 2) throw new Error('Published runner boundary changed: ' + before);
    body = body.replace(before, after);
  };
  if (declarations) {
    body = 'import type { Theme } from "../../modes/interactive/theme/theme.ts";\n' + body;
    replace('    private uiContext;', `    private uiContext;
    private readonly noOpUIContext;
    private readonly renderSystemPrompt;`);
    replace('modelRegistry: ModelRegistry);', `modelRegistry: ModelRegistry, dependencies?: {
        getTheme?: () => Theme;
        buildSystemPrompt?: (options: BuildSystemPromptOptions) => string;
    });`);
    return body;
  }
  replace('    uiContext;', `    uiContext;
    noOpUIContext;
    renderSystemPrompt;`);
  replace('constructor(extensions, runtime, cwd, sessionManager, modelRegistry) {',
    'constructor(extensions, runtime, cwd, sessionManager, modelRegistry, dependencies = {}) {');
  replace('        this.uiContext = noOpUIContext;', `        const getTheme = dependencies.getTheme;
        this.noOpUIContext = getTheme
            ? { ...noOpUIContext, get theme() { return getTheme(); } }
            : noOpUIContext;
        this.uiContext = this.noOpUIContext;
        this.renderSystemPrompt = dependencies.buildSystemPrompt ?? buildSystemPrompt;`);
  replace('this.wrapUIPromptContext(uiContext) : noOpUIContext',
    'this.wrapUIPromptContext(uiContext) : this.noOpUIContext');
  replace('this.uiContext !== noOpUIContext', 'this.uiContext !== this.noOpUIContext');
  replace('() => buildSystemPrompt(currentOptions)', '() => this.renderSystemPrompt(currentOptions)');
  return body;
}
