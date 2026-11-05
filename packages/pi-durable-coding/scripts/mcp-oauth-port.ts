/** Keep the pinned refresh lock while allowing explicit host commands to cancel before acquiring it. */
import ts from 'typescript';

export function portMcpOAuth(source: string): string {
  const replacements = [
    [
      'withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;',
      'withRefreshLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;',
    ],
    [
      'withRefreshLock: (fn) => this.withRefreshLock(key, fn),',
      'withRefreshLock: (fn, signal) => this.withRefreshLock(key, fn, signal),',
    ],
    [
      'private async withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T>',
      'private async withRefreshLock<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>',
    ],
  ];
  for (const [before, after] of replacements) {
    if (!before || !after || source.split(before).length !== 2) throw new Error('MCP OAuth lock signature changed');
    source = source.replace(before, after);
  }
  const ast = ts.createSourceFile('oauth.ts', source, ts.ScriptTarget.Latest, true);
  const store = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'McpOAuthCredentialStore');
  const method = store && ts.isClassDeclaration(store)
    ? store.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'withRefreshLock')
    : undefined;
  if (!method || !ts.isMethodDeclaration(method) || !method.body) throw new Error('MCP OAuth lock body changed');
  const body = `{
		signal?.throwIfAborted();
		if (!this.lockDir) return fn();
		mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
		let release: (() => Promise<void>) | undefined;
		while (!release) {
			signal?.throwIfAborted();
			try {
				release = await lockfile.lock(join(this.lockDir, \`mcp-auth-refresh-\${hash}\`), {
					realpath: false,
					stale: REFRESH_LOCK_STALE_MS,
					retries: signal ? 0 : {
						retries: REFRESH_LOCK_WAIT_MS / REFRESH_LOCK_RETRY_MS,
						factor: 1,
						minTimeout: REFRESH_LOCK_RETRY_MS,
						maxTimeout: REFRESH_LOCK_RETRY_MS,
					},
					onCompromised: () => {},
				});
			} catch (error) {
				if (!signal || !error || typeof error !== "object" || !("code" in error) ||
					error.code !== "ELOCKED" || Date.now() >= deadline) throw error;
				await waitForRefreshLock(REFRESH_LOCK_RETRY_MS, undefined, { signal });
			}
		}
		try {
			signal?.throwIfAborted();
			return await fn();
		} finally {
			await release().catch(() => undefined);
		}
	}`;
  return 'import { setTimeout as waitForRefreshLock } from "node:timers/promises";\n'
    + source.slice(0, method.body.getStart(ast)) + body + source.slice(method.body.end);
}
