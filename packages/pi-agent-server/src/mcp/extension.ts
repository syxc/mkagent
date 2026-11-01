/**
 * Startup glue between the MCP modules and the kernel: load `mcp.json`, connect the configured
 * servers, and turn each server's tools into durable `ToolRegistration`s plus the codemode
 * namespaces scripts see them through.
 *
 * Mirrors the startup path of pi-coding-agent 1.1.0 extensions/mcp/index.js, reduced to a one-shot
 * load: tools are registered once at kernel open, so `notifications/tools/list_changed` refreshes
 * the connection's tool list (visible to `getClient` availability checks) but does not re-register
 * tools. OAuth exposure is deferred — those servers fail loudly in the runtime.
 */
import { join } from 'node:path';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import type { CodemodeNamespace } from '@earendil-works/pi-durable/codemode';
import { loadMcpConfig } from './config.ts';
import { getMcpToolExposure, mcpNamespace, type McpServerEntry } from './mcp-servers.ts';
import { McpServerConnection, createDefaultTransport } from './runtime.ts';
import { McpServerLog } from './log.ts';
import { createMcpResourceToolDefinitions } from './resources.ts';
import { createMcpToolDefinition, createMcpToolName } from './tools.ts';

export interface McpToolsLoadOptions {
  /** Agent directory holding the global `mcp.json` and `mcp.log`. */
  agentDir: string;
  cwd: string;
  /** Whether the trusted project's `<cwd>/.mkagent/mcp.json` is read. */
  projectTrusted?: boolean;
  /** Client version reported to servers at `initialize`. */
  version: string;
  debugLog: (message: string) => void;
}

export interface McpToolsLoadResult {
  tools: ToolRegistration[];
  /** Codemode namespaces of the servers with codemode-exposed tools, for `createCodemodeExtension`. */
  namespaces: CodemodeNamespace[];
  /** Live connections, for status surfaces and graceful shutdown. */
  connections: McpServerConnection[];
  /** Whether the config enables the codemode tool for MCP tools (default true). */
  autoEnableCodemode: boolean;
  errors: string[];
}

/** Server-level exposure of an entry, before per-tool overrides. */
function exposureOf(entry: McpServerEntry): string {
  return entry.config.exposure ?? 'codemode';
}

/**
 * Connect every enabled server and build its tool registrations. One server failing to connect or
 * exposing no tools never blocks the others: its error is logged and returned.
 */
export async function loadMcpTools(options: McpToolsLoadOptions): Promise<McpToolsLoadResult> {
  const config = loadMcpConfig({ agentDir: options.agentDir, cwd: options.cwd, projectTrusted: options.projectTrusted });
  for (const error of config.errors) options.debugLog(`MCP config: ${error}`);
  const log = new McpServerLog(join(options.agentDir, 'mcp.log'));
  const enabled = config.servers.filter(entry => entry.config.enabled !== false);

  const connections: McpServerConnection[] = [];
  const errors: string[] = [];
  await Promise.all(
    enabled.map(async entry => {
      const connection = new McpServerConnection({
        entry,
        cwd: options.cwd,
        createTransport: createDefaultTransport,
        onTools: () => {},
        onChange: () => {},
        log,
        version: options.version,
      });
      try {
        await connection.getClient();
        connections.push(connection);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`MCP server "${entry.name}": ${message}`);
        options.debugLog(`MCP server "${entry.name}" unavailable: ${message}`);
        await connection.close().catch(() => undefined);
      }
    }),
  );
  connections.sort((a, b) => a.name.localeCompare(b.name));

  const connectionsByName = new Map(connections.map(connection => [connection.name, connection]));
  /** pi tool name to the `<server>\0<tool>` it was assigned to, so names stay unique and stable. */
  const toolOwners = new Map<string, string>();
  const tools: ToolRegistration[] = [];
  const namespaces: CodemodeNamespace[] = [];

  for (const connection of connections) {
    const server = connection.name;
    const entry = connection.entry;
    const description = entry.config.description?.trim();
    const namespace: CodemodeNamespace = {
      name: mcpNamespace(server),
      prefix: `${mcpNamespace(server)}__`,
      ...(description ? { description } : {}),
      ...(connection.instructions ? { instructions: connection.instructions } : {}),
    };
    const current = new Set<string>();
    // Like Codex, all tools whose names sanitize to the same name get the hash suffix, so which
    // one would keep the plain name does not depend on the order of the list.
    const plain = [...new Set(connection.tools.map(tool => tool.name))].map(tool => createMcpToolName(server, tool));
    let codemodeToolCount = 0;
    for (const tool of connection.tools) {
      const owner = `${server}\0${tool.name}`;
      const name = createMcpToolName(server, tool.name, candidate => {
        const existing = toolOwners.get(candidate);
        return (
          (existing !== undefined && existing !== owner) ||
          current.has(candidate) ||
          plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
        );
      });
      toolOwners.set(name, owner);
      current.add(name);
      const exposure = getMcpToolExposure(entry.config, tool.name);
      if (exposure === 'codemode') codemodeToolCount++;
      tools.push(
        createMcpToolDefinition({
          server,
          tool,
          name,
          exposure,
          timeoutMs: connection.timeoutMs,
          getClient: async () => {
            // Resolve the live connection at execution time, so reconnects apply.
            const live = connectionsByName.get(server);
            if (!live || live.closed) throw new Error(`MCP server "${server}" is disabled.`);
            if (
              getMcpToolExposure(live.entry.config, tool.name) === 'hidden' ||
              (live.state === 'connected' && !live.tools.some(offered => offered.name === tool.name))
            ) {
              throw new Error(`MCP tool "${server}/${tool.name}" is no longer available.`);
            }
            return live;
          },
          readableResources: () =>
            connections.some(candidate => candidate.name === server && candidate.hasResources && exposureOf(candidate.entry) !== 'hidden'),
        }),
      );
    }
    if (codemodeToolCount > 0) {
      namespaces.push(namespace);
    }
  }

  // Resource tools reach every connected server with resources, with the widest exposure of the
  // servers they reach: `direct` when one of them is direct, and so on.
  const serversWithResources = connections.filter(connection => connection.hasResources && exposureOf(connection.entry) !== 'hidden');
  if (serversWithResources.length > 0) {
    const exposures = new Set(serversWithResources.map(connection => exposureOf(connection.entry)));
    const exposure = (['direct', 'codemode', 'deferred'] as const).find(candidate => exposures.has(candidate));
    if (exposure) {
      const resourceConnections = () => [...serversWithResources];
      tools.push(...createMcpResourceToolDefinitions({ exposure, servers: resourceConnections }));
    }
  }

  return {
    tools,
    namespaces,
    connections,
    autoEnableCodemode: config.autoEnableCodemode ?? true,
    errors,
  };
}

/** Close every connection; used at kernel shutdown. */
export async function closeMcpConnections(connections: McpServerConnection[]): Promise<void> {
  await Promise.allSettled(connections.map(connection => connection.close()));
}
