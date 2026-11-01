/**
 * Path helpers for the local file tools.
 *
 * Behavior-aligned with @earendil-works/pi-coding-agent 1.1.0
 * `core/tools/path-utils.js` and `utils/paths.js` (the branches the tools
 * actually reach): Unicode-space normalization, `@` prefix stripping, tilde
 * expansion, `file://` URLs, and Windows shell drive paths.
 */
import { accessSync, constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join as pathJoin, resolve as pathResolve } from 'node:path';

const UNICODE_SPACES = /[  -   　]/g;

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs accept. */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll('/', '\\');
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ''}`;
}

function normalizePath(input: string, options: { normalizeUnicodeSpaces?: boolean; stripAtPrefix?: boolean } = {}): string {
  let normalized = input;
  if (options.normalizeUnicodeSpaces) {
    normalized = normalized.replace(UNICODE_SPACES, ' ');
  }
  if (options.stripAtPrefix && normalized.startsWith('@')) {
    normalized = normalized.slice(1);
  }
  if (process.platform === 'win32') {
    normalized = normalizeWindowsShellPath(normalized);
  }
  const home = homedir();
  if (normalized === '~') return home;
  if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) {
    return pathJoin(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
  }
  return normalized;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a path relative to the given cwd; handles ~ expansion and absolute paths. */
export function resolveToCwd(filePath: string, cwd: string): string {
  const normalized = normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
  const normalizedBaseDir = normalizePath(cwd);
  return isAbsolute(normalized) ? pathResolve(normalized) : pathResolve(normalizedBaseDir, normalized);
}

/** Variants macOS produces for typed-in paths (screenshot AM/PM space, NFD, curly quotes). */
function pathVariants(resolved: string): string[] {
  const NARROW_NO_BREAK_SPACE = ' ';
  const variants: Array<[string, string]> = [
    ['am/pm', resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`)],
    ['nfd', resolved.normalize('NFD')],
    ['curly', resolved.replace(/'/g, '’')],
    ['nfd+curly', resolved.normalize('NFD').replace(/'/g, '’')],
  ];
  return variants.filter(([label, variant]) => variant !== resolved && fileExists(variant)).map(([, variant]) => variant);
}

/** Resolve for read-like tools: falls back to macOS filename variants when the exact path misses. */
export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);
  if (fileExists(resolved)) {
    return resolved;
  }
  for (const variant of pathVariants(resolved)) {
    if (fileExists(variant)) return variant;
  }
  return resolved;
}
