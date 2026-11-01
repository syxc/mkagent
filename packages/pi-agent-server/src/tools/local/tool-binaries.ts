/**
 * Binary resolution for the local grep/find tools.
 *
 * rg and fd first use the Pi agent bin cache or PATH. A bundled rg is also
 * available in packaged builds; missing tools fall back to the official release
 * download unless `PI_OFFLINE` is enabled.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { arch as osArch, homedir, platform as osPlatform } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fetchWithRetry } from './management-http.ts';

const EXECUTABLE_CACHE = new Map<string, string | undefined>();

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First match for `name` on PATH (`.exe`-style suffixes on Windows), cached per process. */
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

/** Vendored `rg` from the root @vscode/ripgrep dependency, walking up from this file. */
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

/** Resolve ripgrep from the Pi cache, PATH, bundled binary, or official release. */
export async function resolveRipgrep(): Promise<string | undefined> {
  return ensureRipgrep(undefined, defaultFdManagerDeps(), vendoredRipgrep());
}

// =============================================================================
// fd install manager (ported from pi-coding-agent 1.1.0)
// =============================================================================

/** pi-coding-agent's package.json had `piConfig.configDir` but no `name`, so APP_NAME was "pi". */
const APP_NAME = 'pi';
const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
const CONFIG_DIR_NAME = '.pi';
const FD_REPO = 'sharkdp/fd';
const RG_REPO = 'BurntSushi/ripgrep';
const FD_TAG_PREFIX = 'v';
/** fd is pinned on darwin/x64 upstream, so that platform skips the version lookup. */
const FD_PINNED_DARWIN_X64_VERSION = '10.3.0';
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface FdStatus {
  type: 'info' | 'warning';
  message: string;
}

export interface CommandResult {
  status: number | null;
  error?: Error | null;
  stderr?: { toString(): string } | null;
  stdout?: { toString(): string } | null;
}

/**
 * Everything the install path touches, injected so tests can simulate the
 * network and archive extraction without a real download, tar/unzip process,
 * or the user's Pi config directory.
 */
export interface FdManagerDeps {
  binDir: string;
  platform: NodeJS.Platform;
  arch: string;
  offline: boolean;
  fetch: typeof fetch;
  runCommand: (command: string, args: string[]) => CommandResult;
  findOnPath: (name: string) => string | undefined;
}

function expandTilde(value: string, homeDir: string, platform: NodeJS.Platform): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))) {
    return join(homeDir, value.slice(2));
  }
  return value;
}

/** `getBinDir()` from pi-coding-agent: `<agentDir>/bin`, where agentDir is PI_CODING_AGENT_DIR or ~/.pi/agent. */
export function getFdBinDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const envDir = env[ENV_AGENT_DIR];
  const agentDir = envDir ? expandTilde(envDir, homeDir, platform) : join(homeDir, CONFIG_DIR_NAME, 'agent');
  return join(agentDir, 'bin');
}

export function isOfflineModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PI_OFFLINE;
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

export function fdAssetName(version: string, platform: string, architecture: string): string | null {
  const archStr = architecture === 'arm64' ? 'aarch64' : 'x86_64';
  if (platform === 'darwin') return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
  if (platform === 'linux') return `fd-v${version}-${archStr}-unknown-linux-musl.tar.gz`;
  if (platform === 'win32') return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
  return null;
}

function defaultFdManagerDeps(): FdManagerDeps {
  return {
    binDir: getFdBinDir(),
    platform: osPlatform(),
    arch: osArch(),
    offline: isOfflineModeEnabled(),
    fetch: globalThis.fetch,
    runCommand: (command, args) => spawnSync(command, args, { stdio: 'pipe' }),
    findOnPath,
  };
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isFile() && entry.name === binaryFileName) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return null;
}

function formatSpawnFailure(result: CommandResult): string {
  if (result.error?.message) return result.error.message;
  const stderr = result.stderr?.toString().trim();
  if (stderr) return stderr;
  const stdout = result.stdout?.toString().trim();
  if (stdout) return stdout;
  return `exit status ${result.status ?? 'unknown'}`;
}

function runExtractionCommand(deps: FdManagerDeps, command: string, args: string[]): string | null {
  const result = deps.runCommand(command, args);
  if (!result.error && result.status === 0) return null;
  return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(deps: FdManagerDeps, archivePath: string, extractDir: string, assetName: string): void {
  const failure = runExtractionCommand(deps, 'tar', ['xzf', archivePath, '-C', extractDir]);
  if (failure) throw new Error(`Failed to extract ${assetName}: ${failure}`);
}

function getWindowsTarCommand(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot) {
    const systemTar = join(systemRoot, 'System32', 'tar.exe');
    if (existsSync(systemTar)) return systemTar;
  }
  return 'tar.exe';
}

function extractZipArchive(deps: FdManagerDeps, archivePath: string, extractDir: string, assetName: string): void {
  const failures: string[] = [];
  if (deps.platform === 'win32') {
    // Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
    // System32 binary over Git Bash's GNU tar, which does not handle zip archives.
    const tarFailure = runExtractionCommand(deps, getWindowsTarCommand(), ['xf', archivePath, '-C', extractDir]);
    if (!tarFailure) return;
    failures.push(tarFailure);
    const script =
      "& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
    const powershellFailure = runExtractionCommand(deps, 'powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
      archivePath,
      extractDir,
    ]);
    if (!powershellFailure) return;
    failures.push(powershellFailure);
  } else {
    const unzipFailure = runExtractionCommand(deps, 'unzip', ['-q', archivePath, '-d', extractDir]);
    if (!unzipFailure) return;
    failures.push(unzipFailure);
    const tarFailure = runExtractionCommand(deps, 'tar', ['xf', archivePath, '-C', extractDir]);
    if (!tarFailure) return;
    failures.push(tarFailure);
  }
  throw new Error(`Failed to extract ${assetName}: ${failures.join('; ')}`);
}

/** Resolve the latest release version from the release page redirect (no GitHub API quota). */
async function getLatestVersion(deps: FdManagerDeps, repo: string): Promise<string> {
  const response = await fetchWithRetry(
    `https://github.com/${repo}/releases/latest`,
    {
      headers: { 'User-Agent': `${APP_NAME}-coding-agent` },
      redirect: 'manual',
    },
    { timeoutMs: NETWORK_TIMEOUT_MS, fetch: deps.fetch },
  );
  // Only the status and headers matter here. Discard the body so the
  // connection can be reused.
  try {
    await response.body?.cancel();
  } catch {
    // Discarding the body is best-effort.
  }
  const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
  if (!location) {
    throw new Error(`Failed to resolve latest ${repo} release: HTTP ${response.status} without redirect`);
  }
  const tag = new URL(location, 'https://github.com').pathname.split('/').pop();
  if (!tag || !location.includes('/releases/tag/')) {
    throw new Error(`Failed to resolve latest ${repo} release: unexpected redirect to ${location}`);
  }
  return decodeURIComponent(tag).replace(/^v/, '');
}

async function downloadFile(deps: FdManagerDeps, url: string, dest: string): Promise<void> {
  const response = await fetchWithRetry(url, undefined, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    fetch: deps.fetch,
  });
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  }
  if (!response.body) {
    throw new Error('No response body');
  }
  const file = await open(dest, 'w');
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.writeFile(value);
    }
  } finally {
    reader.releaseLock();
    await file.close();
  }
}

async function downloadTool(deps: FdManagerDeps, tool: 'fd' | 'rg'): Promise<string> {
  const repo = tool === 'fd' ? FD_REPO : RG_REPO;
  const version = tool === 'fd' && deps.platform === 'darwin' && deps.arch === 'x64'
    ? FD_PINNED_DARWIN_X64_VERSION
    : await getLatestVersion(deps, repo);
  const fdAsset = fdAssetName(version, deps.platform, deps.arch);
  const assetName = tool === 'fd' ? fdAsset : fdAsset?.replace(`fd-v${version}`, `ripgrep-${version}`);
  if (!assetName) {
    throw new Error(`Unsupported platform: ${deps.platform}/${deps.arch}`);
  }

  mkdirSync(deps.binDir, { recursive: true });
  const downloadUrl = `https://github.com/${repo}/releases/download/${tool === 'fd' ? FD_TAG_PREFIX : ''}${version}/${assetName}`;
  const binaryExt = deps.platform === 'win32' ? '.exe' : '';
  const binaryPath = join(deps.binDir, tool + binaryExt);

  // Each download and extraction needs its own directory to avoid concurrent writes.
  const extractDir = join(
    deps.binDir,
    `extract_tmp_${tool}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(extractDir, { recursive: true });
  const archivePath = join(extractDir, assetName);
  try {
    await downloadFile(deps, downloadUrl, archivePath);
    if (assetName.endsWith('.tar.gz')) {
      extractTarGzArchive(deps, archivePath, extractDir, assetName);
    } else if (assetName.endsWith('.zip')) {
      extractZipArchive(deps, archivePath, extractDir, assetName);
    } else {
      throw new Error(`Unsupported archive format: ${assetName}`);
    }

    // Some archives contain files directly at root, others nest under a
    // versioned subdirectory.
    const binaryFileName = tool + binaryExt;
    const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ''));
    const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
    let extractedBinary = extractedBinaryCandidates.find(candidate => existsSync(candidate));
    if (!extractedBinary) {
      extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
    }
    if (extractedBinary) {
      renameSync(extractedBinary, binaryPath);
    } else {
      throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
    }

    // Make executable (Unix only).
    if (deps.platform !== 'win32') chmodSync(binaryPath, 0o755);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
  return binaryPath;
}

/**
 * Ensure fd is available: managed bin cache, PATH, then an official download.
 * Reports progress through `onStatus`; status messages are otherwise silent.
 * Returns the tool path, or undefined if unavailable.
 */
export async function ensureFd(
  onStatus?: (status: FdStatus) => void,
  deps: FdManagerDeps = defaultFdManagerDeps(),
): Promise<string | undefined> {
  const cachedPath = join(deps.binDir, deps.platform === 'win32' ? 'fd.exe' : 'fd');
  if (existsSync(cachedPath)) return cachedPath;

  const pathBinary = deps.findOnPath('fd') ?? deps.findOnPath('fdfind');
  if (pathBinary) return pathBinary;

  if (deps.offline) {
    onStatus?.({ type: 'warning', message: 'fd not found. Offline mode enabled, skipping download.' });
    return undefined;
  }

  // On Android/Termux, Linux binaries don't work due to Bionic libc
  // incompatibility. Users must install via pkg.
  if (deps.platform === 'android') {
    onStatus?.({ type: 'warning', message: 'fd not found. Install with: pkg install fd' });
    return undefined;
  }

  onStatus?.({ type: 'info', message: 'fd not found. Downloading...' });
  try {
    const installedPath = await downloadTool(deps, 'fd');
    onStatus?.({ type: 'info', message: `fd installed to ${installedPath}` });
    return installedPath;
  } catch (error) {
    // Include the error cause chain: fetch failures surface as a bare
    // "fetch failed" TypeError with the actionable detail (DNS, TLS,
    // timeout) hidden in the cause. Depth-capped against circular chains.
    const messages: string[] = [];
    for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
      if (!messages.includes(current.message)) messages.push(current.message);
    }
    onStatus?.({
      type: 'warning',
      message: `Failed to download fd: ${messages.length > 0 ? messages.join(': ') : String(error)}`,
    });
    return undefined;
  }
}

export async function ensureRipgrep(
  onStatus?: (status: FdStatus) => void,
  deps: FdManagerDeps = defaultFdManagerDeps(),
  bundledPath?: string,
): Promise<string | undefined> {
  const cachedPath = join(deps.binDir, deps.platform === 'win32' ? 'rg.exe' : 'rg');
  if (existsSync(cachedPath)) return cachedPath;
  const available = deps.findOnPath('rg') ?? bundledPath;
  if (available) return available;
  if (deps.offline) {
    onStatus?.({ type: 'warning', message: 'ripgrep not found. Offline mode enabled, skipping download.' });
    return undefined;
  }
  if (deps.platform === 'android') {
    onStatus?.({ type: 'warning', message: 'ripgrep not found. Install with: pkg install ripgrep' });
    return undefined;
  }

  onStatus?.({ type: 'info', message: 'ripgrep not found. Downloading...' });
  try {
    const path = await downloadTool(deps, 'rg');
    onStatus?.({ type: 'info', message: `ripgrep installed to ${path}` });
    return path;
  } catch (error) {
    onStatus?.({ type: 'warning', message: `Failed to download ripgrep: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
}

/** Absolute path of fd (`fd`, Debian fallback `fdfind`), or undefined when unavailable. */
export async function resolveFd(onStatus?: (status: FdStatus) => void): Promise<string | undefined> {
  return ensureFd(onStatus);
}
