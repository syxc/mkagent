/** Allow host commands to cancel lock acquisition without cancelling an active token refresh. */
import ts from 'typescript';

export function codingMcpOAuthPolicy(source: string, declaration: boolean): string {
  const replace = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error('Published MCP OAuth boundary changed: ' + before);
    source = source.replace(before, after);
  };
  if (declaration) {
    replace('withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;',
      'withRefreshLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;');
    return source;
  }
  source = 'import { setTimeout as waitForRefreshLock } from "node:timers/promises";\n' + source;
  replace('withRefreshLock: (fn) => this.withRefreshLock(key, fn),',
    'withRefreshLock: (fn, signal) => this.withRefreshLock(key, fn, signal),');
  replace('async withRefreshLock(key, fn) {', 'async withRefreshLock(key, fn, signal) {\n        signal?.throwIfAborted();');
  const ast = ts.createSourceFile('oauth.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const store = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'McpOAuthCredentialStore');
  const method = store && ts.isClassDeclaration(store)
    ? store.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(ast) === 'withRefreshLock') : undefined;
  const acquisition = method && ts.isMethodDeclaration(method) && method.body?.statements.find(n =>
    ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === 'release'));
  if (!acquisition) throw new Error('Published MCP OAuth lock acquisition changed');
  const original = acquisition.getText(ast);
  if (!original.startsWith('const release = await lockfile.lock(') || original.split('retries: {').length !== 2) {
    throw new Error('Published MCP OAuth retry boundary changed');
  }
  const acquire = original.replace('const release =', 'release =').replace('retries: {', 'retries: signal ? 0 : {');
  replace(original, `const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
        let release;
        while (!release) {
            signal?.throwIfAborted();
            try {
                ${acquire.replaceAll('\n', '\n        ')}
            } catch (error) {
                if (!signal || !error || typeof error !== "object" || !("code" in error) ||
                    error.code !== "ELOCKED" || Date.now() >= deadline) throw error;
                await waitForRefreshLock(REFRESH_LOCK_RETRY_MS, undefined, { signal });
            }
        }`);
  replace('try {\n            return await fn();', 'try {\n            signal?.throwIfAborted();\n            return await fn();');
  return source;
}
