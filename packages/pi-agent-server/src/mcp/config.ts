/**
 * MCP server configuration.
 *
 * Servers are read from `mcp.json` in the agent directory and, for trusted projects, from
 * `<project>/.mkagent/mcp.json`. Both use the `mcpServers` shape shared by other MCP clients, so
 * existing configurations can be copied over. Project entries replace global entries with the
 * same name.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
 *   }
 * }
 * ```
 *
 * Vendored 1:1 from @earendil-works/pi-coding-agent 1.1.0 extensions/mcp/config.js — behavior must
 * stay identical. Deviations: the project config directory is an option (mkagent's `.mkagent`,
 * defaulting per call), and the `mcp.json` writer helpers (`updateMcpServerConfig`,
 * `addMcpServerConfig`, `removeMcpServerConfig`) are omitted — they only serve the CLI/UI server
 * manager this kernel does not carry.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpNamespace, validateMcpServerConfig, type McpServerConfig, type McpServerScope } from './mcp-servers.ts';

export { getMcpToolExposure } from './mcp-servers.ts';

const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'];

/** Whether an entry overrides a server defined elsewhere instead of defining one. */
function isOverride(value: Record<string, unknown>): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ConfigLoadState {
  servers: Map<
    string,
    { name: string; config: McpServerConfig; source: string; scope: McpServerScope; override?: string }
  >;
  errors: string[];
  autoEnableCodemode: boolean | undefined;
}

function readConfigFile(path: string, scope: McpServerScope, state: ConfigLoadState): void {
  const { servers, errors } = state;
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    errors.push(`${path}: expected an object with an "mcpServers" object`);
    return;
  }
  if (typeof parsed.autoEnableCodemode === 'boolean') state.autoEnableCodemode = parsed.autoEnableCodemode;
  else if (parsed.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
  for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
    if (scope === 'project' && isRecord(value) && isOverride(value)) {
      const base = servers.get(name);
      const extra = Object.keys(value).filter(key => !OVERRIDE_KEYS.includes(key));
      if (!base) {
        errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
      } else if (extra.length > 0) {
        errors.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(', ')}`);
      } else {
        const config = validateMcpServerConfig(name, { ...base.config, ...value });
        if (typeof config === 'string') errors.push(`${path}: ${config}`);
        else servers.set(name, { ...base, config, override: path });
      }
      continue;
    }
    const config = validateMcpServerConfig(name, value);
    if (typeof config === 'string') {
      errors.push(`${path}: ${config}`);
      continue;
    }
    // Names that differ only in `-` and `_` would share a namespace.
    const clash = [...servers.keys()].find(other => other !== name && mcpNamespace(other) === mcpNamespace(name));
    if (clash) {
      errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
      continue;
    }
    // A project config must not route a host credential to a project-chosen URL.
    if (scope === 'project' && 'url' in config && config.auth) {
      errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
      continue;
    }
    servers.set(name, { name, config, source: path, scope });
  }
}

export interface McpConfigOptions {
  /** Agent directory holding the global `mcp.json`. */
  agentDir: string;
  /** Working directory of the session, for the trusted project's `mcp.json`. */
  cwd: string;
  /** Whether `<cwd>/<projectConfigDirName>/mcp.json` is read. */
  projectTrusted?: boolean;
  /** Directory name of the project-level config. Default: `.mkagent`. */
  projectConfigDirName?: string;
}

export interface LoadedMcpConfig {
  servers: Array<{ name: string; config: McpServerConfig; source: string; scope: McpServerScope; override?: string }>;
  autoEnableCodemode?: boolean;
  errors: string[];
  projectConfig?: string;
}

/**
 * Load global and (when trusted) project MCP configuration. Disabled servers are included with
 * `enabled: false`, so they can be enabled again.
 */
export function loadMcpConfig(options: McpConfigOptions): LoadedMcpConfig {
  const state: ConfigLoadState = { servers: new Map(), errors: [], autoEnableCodemode: undefined };
  readConfigFile(join(options.agentDir, 'mcp.json'), 'global', state);
  const projectDirName = options.projectConfigDirName ?? '.mkagent';
  const projectConfig = options.projectTrusted ? join(options.cwd, projectDirName, 'mcp.json') : undefined;
  if (projectConfig) readConfigFile(projectConfig, 'project', state);
  return {
    servers: [...state.servers.values()],
    ...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
    errors: state.errors,
    ...(projectConfig ? { projectConfig } : {}),
  };
}
