/** Run an explicit MCP login in another process while sharing only the temporary credential store. */
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@mkagent/coding-runtime/native';
import { FileAuthStorageBackend, McpOAuthCredentialStore } from '@mkagent/coding-runtime/mcp-oauth';
import { McpAuthorization } from '../mcp/authorization.ts';
import { McpServerConnection, createDefaultTransport } from '../mcp/runtime.ts';

const [root, url] = Bun.argv.slice(2);
if (!root || !url) throw new Error('Expected temporary directory and local server URL');
const emit = (value: unknown) => console.log(JSON.stringify(value));
class ObservedCredentials extends McpOAuthCredentialStore {
  override forServer(...args: Parameters<McpOAuthCredentialStore['forServer']>) {
    const store = super.forServer(...args);
    const withLock = store.withRefreshLock.bind(store);
    store.withRefreshLock = (operation, signal) => {
      const pending = withLock(async () => {
        emit({ type: 'lock-acquired' });
        return operation();
      }, signal);
      emit({ type: 'lock-requested' });
      return pending;
    };
    return store;
  }
}
const credentials = new ObservedCredentials(new FileAuthStorageBackend(join(root, 'mcp-auth.json')), root);
const connection = new McpServerConnection({
  entry: { name: 'issues', config: { url }, scope: 'global' }, cwd: root, credentials,
  version: 'test', log: undefined, onTools() {}, onChange() {}, createTransport: createDefaultTransport,
});
let handler: Parameters<ExtensionAPI['registerCommand']>[1]['handler'] | undefined;
const controller = new AbortController();
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line === 'cancel') controller.abort(); });
new McpAuthorization({ credentials, connections: () => [connection], assertOwner() {} })
  .extension()({ registerCommand(_name, command) { handler = command.handler; } } as ExtensionAPI);
const context = {
  hasUI: true, signal: controller.signal,
  ui: {
    setWidget(_key: string, lines?: string[]) { if (lines) emit({ type: 'prompt', url: lines[1] }); },
    notify(text: string, level: string) { emit({ type: 'notice', text, level }); },
    input: (_title: string, _placeholder: string, options: { signal: AbortSignal }) => new Promise(resolve =>
      options.signal.addEventListener('abort', () => resolve(undefined), { once: true })),
  },
} as ExtensionCommandContext;
try {
  emit({ type: 'ready' });
  await handler!('login issues', context);
} finally {
  await connection.close();
  input.close();
  process.stdin.destroy();
}
