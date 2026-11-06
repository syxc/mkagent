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
  } else if (path === 'core/session-manager.ts') {
    replace('export interface SessionContext {', `/** Optional context policy for hosts with a separate durable entry model. */
export interface SessionProjectionOptions {
\tselectContextEntries?: (path: SessionEntry[]) => SessionEntry[] | undefined;
\tprojectContextEntry?: typeof projectContextEntry;
\tfinalizeProjection?: (entries: ProjectedSessionEntry[], path: SessionEntry[]) => AgentMessage[];
}

export interface SessionContext {`);
    const signature = (name: string) => `export function ${name}(
\tentries: SessionEntry[],
\tleafId?: string | null,
\tbyId?: Map<string, SessionEntry>,
)`;
    replace(signature('buildContextEntries'), signature('buildContextEntries').replace('\n)', '\n\tselectContextEntries?: SessionProjectionOptions["selectContextEntries"],\n)'));
    replace('const path = buildSessionPath(entries, leafId, byId);\n\tlet compaction:',
      'const path = buildSessionPath(entries, leafId, byId);\n\tconst selected = selectContextEntries?.(path);\n\tif (selected !== undefined) return selected;\n\tlet compaction:');
    replace('export function projectContextEntry(entry: SessionEntry, edit: ContextEditEntry | undefined): AgentMessage[] {\n\tconst messages = sessionEntryToContextMessages(entry);',
      `export function projectContextEntry(
\tentry: SessionEntry,
\tedit: ContextEditEntry | undefined,
\tmessages: AgentMessage[] = sessionEntryToContextMessages(entry),
): AgentMessage[] {`);
    replace(signature('buildSessionProjection'), signature('buildSessionProjection').replace('\n)', '\n\toptions: SessionProjectionOptions = {},\n)'));
    replace('buildContextEntries(entries, leafId, byId);', 'buildContextEntries(entries, leafId, byId, options.selectContextEntries);');
    replace(': projectContextEntry(sourceEntry, edits.get(sourceEntry.id))',
      ': (options.projectContextEntry ?? projectContextEntry)(sourceEntry, edits.get(sourceEntry.id))');
    replace('messages: projectedEntries.flatMap((entry) => entry.messages),',
      'messages: options.finalizeProjection\n\t\t\t? options.finalizeProjection(projectedEntries, path)\n\t\t\t: projectedEntries.flatMap((entry) => entry.messages),');
    const start = body.indexOf('export class SessionManager {');
    if (start < 0) throw new Error('SessionManager class changed');
    const prefix = body.slice(0, start);
    body = body.slice(start);
    replace('private constructor(', 'protected constructor(');
    replace('return new SessionManager(', 'return new (this ?? SessionManager)(', 6);
    replace('getDefaultSessionDir(cwd)', 'getDefaultSessionDir(cwd, (this ?? SessionManager).getDefaultAgentDir())', 4);
    replace('getDefaultSessionDir(resolvedTargetCwd)', 'getDefaultSessionDir(resolvedTargetCwd, (this ?? SessionManager).getDefaultAgentDir())');
    replace('getDefaultSessionDirPath(cwd)', 'getDefaultSessionDirPath(cwd, (this ?? SessionManager).getDefaultAgentDir())', 3);
    replace('const sessionsDir = getSessionsDir();', 'const sessionsDir = (this ?? SessionManager).getSessionsDir();');
    replace('${APP_NAME}', '${this.getAppName()}');
    replace('\tgetSessionId(): string {', `\tprotected getAppName(): string {
\t\treturn APP_NAME;
\t}

\tprotected static getDefaultAgentDir(): string {
\t\treturn getDefaultAgentDir();
\t}

\tprotected static getSessionsDir(): string {
\t\treturn getSessionsDir();
\t}

\tgetSessionId(): string {`);
    body = prefix + body;
  }
  return body;
}
