/** Connect the native plugin registry through the host MCP runtime. */
import type { ExtensionFactory } from '@mkagent/pi-durable-coding/native';
import type { McpToolsLoadResult } from './extension.ts';

export function createNativeMcpExtension(options: {
  runtime(): McpToolsLoadResult;
  assertOwner(): void;
}): ExtensionFactory {
  return pi => {
    let active = false;
    const sync = async () => {
      options.assertOwner();
      await options.runtime().updateRegisteredServers(pi.getMcpServers());
      options.assertOwner();
    };
    pi.on('session_start', async () => { active = true; await sync(); });
    pi.on('mcp_servers_change', async () => { if (active) await sync(); });
    pi.on('before_agent_start', async () => { if (active) await sync(); });
    pi.on('session_shutdown', async () => {
      active = false;
      const runtime = options.runtime();
      if (!runtime.closed) await runtime.updateRegisteredServers([]);
    });
  };
}
