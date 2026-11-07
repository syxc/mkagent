/** Explicit MCP authorization commands and their owner-scoped cancellation. */
import type { ExtensionCommandContext, ExtensionFactory } from '@mkagent/pi-durable-coding/native';
import {
  McpSignInCancelledError, signInMcpServer, type McpOAuthCredentialStore,
} from '@mkagent/pi-durable-coding/mcp-oauth';
import type { McpServerConnection } from './runtime.ts';

export interface McpAuthorizationOptions {
  credentials: McpOAuthCredentialStore;
  connections(): McpServerConnection[];
  assertOwner(): void;
}

export class McpAuthorization {
  private readonly pending = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(private readonly options: McpAuthorizationOptions) {}

  async cancelServer(name: string): Promise<void> {
    const operation = this.pending.get(name);
    operation?.controller.abort();
    await operation?.done.catch(() => undefined);
  }

  extension(): ExtensionFactory {
    return pi => {
      pi.registerCommand('mcp', {
        description: 'MCP server status, login, logout, and reconnect',
        handler: (args, ctx) => this.command(args, ctx),
      });
    };
  }

  /** Cancel before kernel close or reload waits for native command actions. */
  async cancelAll(): Promise<void> {
    const pending = [...this.pending.values()];
    for (const operation of pending) operation.controller.abort();
    await Promise.allSettled(pending.map(operation => operation.done));
  }

  private async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    try {
      this.options.assertOwner();
      let [action, name, ...rest] = args.trim().split(/\s+/);
      if (!action && ctx.hasUI) {
        const chosen = await ctx.ui.select('MCP', ['Status', 'Sign in', 'Sign out', 'Reconnect']);
        if (!chosen) return;
        action = ({ Status: 'status', 'Sign in': 'login', 'Sign out': 'logout', Reconnect: 'reconnect' })[chosen];
      }
      if (!action || action === 'status') {
        const lines = this.options.connections().map(connection =>
          `${connection.name}: ${connection.state}${connection.error ? ` (${connection.error})` : ''}`);
        ctx.ui.setWidget('mcp-status', lines.length ? lines : ['No MCP servers configured.']);
        return;
      }
      if (rest.length || !['login', 'logout', 'reconnect'].includes(action)) {
        throw new Error('Use /mcp [status|login|logout|reconnect] [server]');
      }
      const candidates = this.options.connections().filter(connection =>
        !connection.closed && (action === 'reconnect' || connection.oauthUrl !== undefined));
      if (!name) {
        if (!ctx.hasUI) throw new Error('Choose an MCP server by name');
        name = await ctx.ui.select(`MCP ${action}`, candidates.map(connection => connection.name));
        if (!name) return;
      }
      this.options.assertOwner();
      const connection = candidates.find(connection => connection.name === name);
      if (!connection) throw new Error('The MCP server is unavailable or does not support this action');
      if (action === 'login' && !ctx.hasUI) throw new Error('MCP sign-in requires an attached UI');
      if (action === 'logout') {
        const current = this.pending.get(connection.name);
        current?.controller.abort();
        await current?.done.catch(() => undefined);
      }
      if (this.pending.has(connection.name)) throw new Error(`An MCP operation is already running for "${connection.name}"`);
      const controller = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const check = () => {
        this.options.assertOwner();
        signal.throwIfAborted();
        if (connection.closed || !this.options.connections().includes(connection)) throw new McpSignInCancelledError();
      };
      const done = Promise.resolve().then(async () => {
        check();
        if (action === 'login') await this.login(connection, ctx, signal, check);
        else if (action === 'logout') {
          await connection.signOut();
          await this.options.credentials.forServer(connection.name, connection.oauthUrl!).withRefreshLock(async () => {
            check();
            this.options.credentials.remove(connection.name, connection.oauthUrl!);
          }, signal);
          check();
          ctx.ui.notify(`Signed out of MCP server "${connection.name}".`, 'info');
        } else {
          await connection.reconnect(signal);
          check();
          ctx.ui.notify(`Reconnected to MCP server "${connection.name}".`, 'info');
        }
      });
      const operation = { controller, done };
      this.pending.set(connection.name, operation);
      try { await done; }
      finally { if (this.pending.get(connection.name) === operation) this.pending.delete(connection.name); }
    } catch (error) {
      if (error instanceof McpSignInCancelledError || (error instanceof Error && error.name === 'AbortError')) {
        ctx.ui.notify('MCP operation cancelled.', 'info');
      } else {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    }
  }

  private async login(connection: McpServerConnection, ctx: ExtensionCommandContext,
    signal: AbortSignal, check: () => void): Promise<void> {
    const widget = `mcp-login-${connection.name}`;
    try {
      await connection.authProvider?.settled();
      check();
      const store = this.options.credentials.forServer(connection.name, connection.oauthUrl!);
      await store.withRefreshLock(async () => {
        check();
        await signInMcpServer({
          serverUrl: connection.oauthUrl!,
          store,
          settings: connection.oauthSettings(), challenge: connection.challenge, signal,
          prompt: {
            showAuthorizationUrl(url) {
              check();
              ctx.ui.setWidget(widget, [`Sign in to MCP server "${connection.name}":`, url.href]);
            },
            promptForRedirectUrl: signal => ctx.ui.input(
              `MCP sign-in: ${connection.name}`, 'Open the sign-in link, or paste the full redirect URL here', { signal },
            ),
          },
        });
      }, signal);
      check();
      connection.challenge = undefined;
      try {
        await connection.reconnect(signal);
        check();
      } catch (error) {
        check();
        throw new Error(`Signed in, but the MCP connection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      ctx.ui.notify(`Signed in to MCP server "${connection.name}".`, 'info');
    } finally {
      ctx.ui.setWidget(widget, undefined);
    }
  }
}
