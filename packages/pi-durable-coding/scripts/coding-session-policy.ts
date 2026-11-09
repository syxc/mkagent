/** Keep host context projection and legacy factories over the published session algorithms. */
export function codingSessionPolicy(source: string, declarations: boolean): string {
  let body = source;
  const replace = (before: string, after: string, count = 1) => {
    if (body.split(before).length - 1 !== count) throw new Error('Published session policy boundary changed: ' + before);
    body = body.replaceAll(before, after);
  };
  if (declarations) {
    replace('export interface SessionContext {', `/** Optional context policy for hosts with a separate durable entry model. */
export interface SessionProjectionOptions {
    selectContextEntries?: (path: SessionEntry[]) => SessionEntry[] | undefined;
    projectContextEntry?: typeof projectContextEntry;
    finalizeProjection?: (entries: ProjectedSessionEntry[], path: SessionEntry[]) => AgentMessage[];
}
export interface SessionContext {`);
    replace('export declare function buildContextEntries(entries: SessionEntry[], leafId?: string | null, byId?: Map<string, SessionEntry>)',
      'export declare function buildContextEntries(entries: SessionEntry[], leafId?: string | null, byId?: Map<string, SessionEntry>, selectContextEntries?: SessionProjectionOptions["selectContextEntries"])');
    replace('export declare function projectContextEntry(entry: SessionEntry, edit: ContextEditEntry | undefined)',
      'export declare function projectContextEntry(entry: SessionEntry, edit: ContextEditEntry | undefined, messages?: AgentMessage[])');
    replace('export declare function buildSessionProjection(entries: SessionEntry[], leafId?: string | null, byId?: Map<string, SessionEntry>)',
      'export declare function buildSessionProjection(entries: SessionEntry[], leafId?: string | null, byId?: Map<string, SessionEntry>, options?: SessionProjectionOptions)');
    replace('    private constructor();',
      '    protected constructor(cwd: string, sessionDir: string, sessionFile: string | undefined, persist: boolean, newSessionOptions?: NewSessionOptions, preloadedFileEntries?: FileEntry[]);');
    replace('    getSessionId(): string;', `    protected getAppName(): string;
    protected static getDefaultAgentDir(): string;
    protected static getSessionsDir(): string;
    getSessionId(): string;`);
  } else {
    replace('export function buildContextEntries(entries, leafId, byId) {',
      'export function buildContextEntries(entries, leafId, byId, selectContextEntries) {');
    replace('const path = buildSessionPath(entries, leafId, byId);\n    let compaction =',
      'const path = buildSessionPath(entries, leafId, byId);\n    const selected = selectContextEntries?.(path);\n    if (selected !== undefined) return selected;\n    let compaction =');
    replace('export function projectContextEntry(entry, edit) {\n    const messages = sessionEntryToContextMessages(entry);',
      'export function projectContextEntry(entry, edit, messages = sessionEntryToContextMessages(entry)) {');
    replace('export function buildSessionProjection(entries, leafId, byId) {',
      'export function buildSessionProjection(entries, leafId, byId, options = {}) {');
    replace('buildContextEntries(entries, leafId, byId);',
      'buildContextEntries(entries, leafId, byId, options.selectContextEntries);');
    replace(': projectContextEntry(sourceEntry, edits.get(sourceEntry.id))',
      ': (options.projectContextEntry ?? projectContextEntry)(sourceEntry, edits.get(sourceEntry.id))');
    replace('messages: projectedEntries.flatMap((entry) => entry.messages),',
      'messages: options.finalizeProjection\n            ? options.finalizeProjection(projectedEntries, path)\n            : projectedEntries.flatMap((entry) => entry.messages),');
    const start = body.indexOf('export class SessionManager {');
    if (start < 0) throw new Error('Published SessionManager class changed');
    const prefix = body.slice(0, start);
    body = body.slice(start);
    replace('return new SessionManager(', 'return new (this ?? SessionManager)(', 6);
    replace('getDefaultSessionDir(cwd)', 'getDefaultSessionDir(cwd, (this ?? SessionManager).getDefaultAgentDir())', 4);
    replace('getDefaultSessionDir(resolvedTargetCwd)', 'getDefaultSessionDir(resolvedTargetCwd, (this ?? SessionManager).getDefaultAgentDir())');
    replace('getDefaultSessionDirPath(cwd)', 'getDefaultSessionDirPath(cwd, (this ?? SessionManager).getDefaultAgentDir())', 3);
    replace('const sessionsDir = getSessionsDir();', 'const sessionsDir = (this ?? SessionManager).getSessionsDir();');
    replace('${APP_NAME}', '${this.getAppName()}');
    replace('    getSessionId() {', `    getAppName() {
        return APP_NAME;
    }
    static getDefaultAgentDir() {
        return getDefaultAgentDir();
    }
    static getSessionsDir() {
        return getSessionsDir();
    }
    getSessionId() {`);
    body = prefix + body;
  }
  return body;
}
