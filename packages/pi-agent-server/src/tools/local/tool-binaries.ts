/**
 * Binary resolution for the local grep/find tools.
 *
 * pi-coding-agent 1.1.0 auto-downloaded rg/fd from GitHub on first use; that
 * download is deliberately not carried over (supply-chain surface). Binaries
 * resolve from PATH instead, with the Debian `fdfind` fallback for fd. rg
 * additionally falls back to the vendored copy from the root @vscode/ripgrep
 * dependency, so packaged environments without a system rg still work. A
 * missing binary surfaces as the tool's normal error.
 */
import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

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

/** Absolute path of ripgrep (`rg`), or undefined when not installed. */
export function resolveRipgrep(): string | undefined {
  return findOnPath('rg') ?? vendoredRipgrep();
}

/** Absolute path of fd (`fd`, Debian fallback `fdfind`), or undefined when not installed. */
export function resolveFd(): string | undefined {
  return findOnPath('fd') ?? findOnPath('fdfind');
}
