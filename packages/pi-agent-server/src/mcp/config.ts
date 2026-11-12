/** Bind host configuration paths and credential policy to the SDK loader. */
import { join } from 'node:path';
import { loadMcpConfig as loadSdkMcpConfig } from '@mkagent/coding-runtime/mcp-config';
import { validateMcpServerConfig, type McpServerConfig, type McpServerScope } from './mcp-servers.ts';

export { getMcpToolExposure } from './mcp-servers.ts';

export interface McpConfigOptions {
  /** Agent directory holding the global `mcp.json`. */
  agentDir: string;
  /** Native coding resources, loaded before the existing host configuration. */
  nativeAgentDir?: string;
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

export function loadMcpConfig(options: McpConfigOptions): LoadedMcpConfig {
  const configFiles: Array<{ path: string; scope: 'global' | 'project' }> = [];
  if (options.nativeAgentDir && options.nativeAgentDir !== options.agentDir) {
    configFiles.push({ path: join(options.nativeAgentDir, 'mcp.json'), scope: 'global' });
  }
  configFiles.push({ path: join(options.agentDir, 'mcp.json'), scope: 'global' });
  const projectDirName = options.projectConfigDirName ?? '.mkagent';
  if (options.projectTrusted) {
    if (options.nativeAgentDir && projectDirName !== '.pi') {
      configFiles.push({ path: join(options.cwd, '.pi', 'mcp.json'), scope: 'project' });
    }
    configFiles.push({ path: join(options.cwd, projectDirName, 'mcp.json'), scope: 'project' });
  }
  // The SDK loader always assigns a scope, unlike extension registrations.
  return loadSdkMcpConfig({ agentDir: options.agentDir, cwd: options.cwd,
    projectTrusted: options.projectTrusted ?? false, configFiles, validateServerConfig: validateMcpServerConfig }) as LoadedMcpConfig;
}
