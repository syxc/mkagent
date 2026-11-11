/** Bind product binary lookup and directories to the Coding SDK installer. */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { arch as osArch, homedir, platform as osPlatform } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createToolManager, writeDownload, type ToolManagerDependencies, type ToolStatus } from '@mkagent/pi-durable-coding/compat';

export type FdStatus = ToolStatus;
export type CommandResult = ReturnType<NonNullable<ToolManagerDependencies['runCommand']>>;
export interface FdManagerDeps {
  binDir: string;
  platform: NodeJS.Platform;
  arch: string;
  offline?: boolean;
  fetch: typeof fetch;
  runCommand: (command: string, args: string[]) => CommandResult;
  findOnPath: (name: string) => string | undefined;
}

const EXECUTABLE_CACHE = new Map<string, string | undefined>();

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Product lookup returns an absolute path and never executes a candidate. */
export function findOnPath(name: string): string | undefined {
  if (EXECUTABLE_CACHE.has(name)) return EXECUTABLE_CACHE.get(name);
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  let resolved: string | undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix);
      if (isExecutable(candidate)) {
        resolved = candidate;
        break;
      }
    }
    if (resolved) break;
  }
  EXECUTABLE_CACHE.set(name, resolved);
  return resolved;
}

/** Packaged builds locate the product's @vscode/ripgrep binary from this module. */
function vendoredRipgrep(): string | undefined {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
  let dir = import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'node_modules', '@vscode', 'ripgrep', 'bin', binary);
    if (isExecutable(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Keep the server's Pi cache location independent of the Native installation. */
export function getFdBinDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.PI_CODING_AGENT_DIR;
  const agentDir = !configured ? join(homeDir, '.pi', 'agent')
    : configured === '~' ? homeDir
    : configured.startsWith('~/') || (platform === 'win32' && configured.startsWith('~\\'))
      ? join(homeDir, configured.slice(2)) : configured;
  return join(agentDir, 'bin');
}

function defaultFdManagerDeps(): FdManagerDeps {
  return {
    binDir: getFdBinDir(), platform: osPlatform(), arch: osArch(), fetch: globalThis.fetch,
    runCommand: (command, args) => spawnSync(command, args, { stdio: 'pipe' }), findOnPath,
  };
}

function manager(deps: FdManagerDeps, bundledPath?: string): ReturnType<typeof createToolManager> {
  return createToolManager({
    getBinDir: () => deps.binDir,
    platform: () => deps.platform,
    arch: () => deps.arch,
    isOfflineModeEnabled: deps.offline === undefined ? undefined : () => deps.offline!,
    fetch: deps.fetch,
    writeDownload,
    runCommand: deps.runCommand,
    getToolPath: tool => {
      const cached = join(deps.binDir, tool + (deps.platform === 'win32' ? '.exe' : ''));
      if (existsSync(cached)) return cached;
      return deps.findOnPath(tool) ?? (tool === 'fd' ? deps.findOnPath('fdfind') : bundledPath) ?? null;
    },
  });
}

export async function ensureFd(
  onStatus?: (status: FdStatus) => void,
  deps: FdManagerDeps = defaultFdManagerDeps(),
  signal?: AbortSignal,
): Promise<string | undefined> {
  return manager(deps).ensureTool('fd', onStatus, signal);
}

export async function ensureRipgrep(
  onStatus?: (status: FdStatus) => void,
  deps: FdManagerDeps = defaultFdManagerDeps(),
  bundledPath?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return manager(deps, bundledPath).ensureTool('rg', onStatus, signal);
}

export async function resolveFd(onStatus?: (status: FdStatus) => void, signal?: AbortSignal): Promise<string | undefined> {
  return ensureFd(onStatus, undefined, signal);
}

export async function resolveRipgrep(signal?: AbortSignal): Promise<string | undefined> {
  return ensureRipgrep(undefined, defaultFdManagerDeps(), vendoredRipgrep(), signal);
}
