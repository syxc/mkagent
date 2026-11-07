/** Connect the native plugin registry through the host MCP runtime. */
import type { ExtensionContext, ExtensionFactory } from '@mkagent/pi-durable-coding/native';
import type { McpToolsLoadResult } from './extension.ts';

export function createNativeMcpExtension(options: {
  runtime(): McpToolsLoadResult;
  assertOwner(): void;
  bindModelRegistry(registry: ExtensionContext['modelRegistry'] | undefined): void;
}): ExtensionFactory {
  return pi => {
    let active = false;
    const sync = async () => {
      options.assertOwner();
      await options.runtime().updateRegisteredServers(pi.getMcpServers());
      options.assertOwner();
    };
    pi.on('session_start', async (_event, ctx) => {
      options.bindModelRegistry(ctx.modelRegistry);
      active = true;
      await sync();
      // Configured servers connect before the native registry has its plugin providers.
      await Promise.allSettled(options.runtime().connections.filter(connection =>
        connection.entry.config.auth?.provider && connection.state === 'needs-auth')
        .map(connection => connection.reconnect()));
      options.assertOwner();
    });
    pi.on('mcp_servers_change', async () => { if (active) await sync(); });
    pi.on('before_agent_start', async () => { if (active) await sync(); });
    pi.on('session_shutdown', async () => {
      active = false;
      options.bindModelRegistry(undefined);
      const runtime = options.runtime();
      if (!runtime.closed) await runtime.updateRegisteredServers([]);
    });
  };
}
