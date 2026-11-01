import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureFd,
  ensureRipgrep,
  fdAssetName,
  getFdBinDir,
  isOfflineModeEnabled,
  type CommandResult,
  type FdManagerDeps,
  type FdStatus,
} from './tool-binaries.ts';

const LATEST_URL = 'https://github.com/sharkdp/fd/releases/latest';

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'mkagent-fd-test-'));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function createDeps(overrides: Partial<FdManagerDeps> = {}): FdManagerDeps {
  return {
    binDir: join(scratchDir, 'bin'),
    platform: 'linux',
    arch: 'x64',
    offline: false,
    fetch: (async () => {
      throw new Error('unexpected network request');
    }) as unknown as typeof fetch,
    runCommand: () => ({ status: 0 }),
    findOnPath: () => undefined,
    ...overrides,
  };
}

/** Fake fetch that resolves the latest tag and serves a fake archive. */
function fakeDownloadFetch(version: string, options: { latestStatuses?: number[] } = {}) {
  const requests: string[] = [];
  const latestStatuses = [...(options.latestStatuses ?? [])];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    if (url === LATEST_URL) {
      const status = latestStatuses.shift();
      if (status !== undefined && status !== 302) {
        return new Response('retry me', { status });
      }
      return new Response(null, {
        status: 302,
        headers: { location: `https://github.com/sharkdp/fd/releases/tag/v${version}` },
      });
    }
    if (url.startsWith('https://github.com/sharkdp/fd/releases/download/')) {
      return new Response('fake-archive-bytes');
    }
    throw new Error(`unexpected network request to ${url}`);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

/** Simulated extraction: writes the expected binary instead of running tar/unzip. */
function extractingRunCommand(assetName: string, calls: Array<{ command: string; args: string[] }> = []) {
  return (command: string, args: string[]): CommandResult => {
    calls.push({ command, args });
    const extractDir = args[args.indexOf('-C') + 1];
    if (!extractDir) throw new Error(`missing extraction directory in ${args.join(' ')}`);
    const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ''));
    mkdirSync(extractedDir, { recursive: true });
    writeFileSync(join(extractedDir, 'fd'), '#!/bin/sh\nexit 0\n');
    return { status: 0 };
  };
}

describe('ensureRipgrep', () => {
  it('uses the managed cache before PATH and avoids the network', async () => {
    const binDir = join(scratchDir, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'rg'), '');
    expect(await ensureRipgrep(undefined, createDeps({ binDir, findOnPath: () => '/usr/bin/rg' }))).toBe(join(binDir, 'rg'));
  });

  it('downloads ripgrep when no cached or system binary exists', async () => {
    const requests: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      return url.endsWith('/releases/latest')
        ? new Response(null, { status: 302, headers: { location: 'https://github.com/BurntSushi/ripgrep/releases/tag/15.0.0' } })
        : new Response('fake-archive');
    }) as unknown as typeof globalThis.fetch;
    const deps = createDeps({ fetch, runCommand: (_command, args) => {
      const extractDir = args[args.indexOf('-C') + 1]!;
      writeFileSync(join(extractDir, 'rg'), 'fake-binary');
      return { status: 0 };
    } });

    expect(await ensureRipgrep(undefined, deps)).toBe(join(scratchDir, 'bin', 'rg'));
    expect(requests).toEqual([
      'https://github.com/BurntSushi/ripgrep/releases/latest',
      'https://github.com/BurntSushi/ripgrep/releases/download/15.0.0/ripgrep-15.0.0-x86_64-unknown-linux-musl.tar.gz',
    ]);
  });

  it('does not download ripgrep in offline mode', async () => {
    expect(await ensureRipgrep(undefined, createDeps({ offline: true }))).toBeUndefined();
  });
});

describe('ensureFd', () => {
  it('prefers the managed bin cache over PATH and the network', async () => {
    const binDir = join(scratchDir, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'fd'), '');
    const deps = createDeps({ binDir, findOnPath: () => '/usr/bin/fd' });

    expect(await ensureFd(undefined, deps)).toBe(join(binDir, 'fd'));
  });

  it('uses fd or fdfind from PATH before downloading', async () => {
    const fdDeps = createDeps({ findOnPath: name => (name === 'fd' ? '/usr/bin/fd' : undefined) });
    expect(await ensureFd(undefined, fdDeps)).toBe('/usr/bin/fd');

    const fdfindDeps = createDeps({ findOnPath: name => (name === 'fdfind' ? '/usr/bin/fdfind' : undefined) });
    expect(await ensureFd(undefined, fdfindDeps)).toBe('/usr/bin/fdfind');
  });

  it('skips the download in offline mode', async () => {
    const statuses: FdStatus[] = [];

    expect(await ensureFd(status => statuses.push(status), createDeps({ offline: true }))).toBeUndefined();
    expect(statuses).toEqual([
      { type: 'warning', message: 'fd not found. Offline mode enabled, skipping download.' },
    ]);
  });

  it('points Android users at pkg instead of downloading', async () => {
    const statuses: FdStatus[] = [];

    expect(await ensureFd(status => statuses.push(status), createDeps({ platform: 'android' }))).toBeUndefined();
    expect(statuses).toEqual([{ type: 'warning', message: 'fd not found. Install with: pkg install fd' }]);
  });

  it('downloads, extracts and caches fd for the current platform', async () => {
    const version = '10.2.0';
    const assetName = 'fd-v10.2.0-aarch64-unknown-linux-musl.tar.gz';
    const { fetch, requests } = fakeDownloadFetch(version);
    const extractionCalls: Array<{ command: string; args: string[] }> = [];
    const statuses: FdStatus[] = [];
    const binDir = join(scratchDir, 'bin');
    const deps = createDeps({
      binDir,
      arch: 'arm64',
      fetch,
      runCommand: extractingRunCommand(assetName, extractionCalls),
    });

    const result = await ensureFd(status => statuses.push(status), deps);

    expect(result).toBe(join(binDir, 'fd'));
    expect(requests).toEqual([
      LATEST_URL,
      `https://github.com/sharkdp/fd/releases/download/v${version}/${assetName}`,
    ]);
    expect(extractionCalls).toHaveLength(1);
    expect(extractionCalls[0]!.command).toBe('tar');
    expect(extractionCalls[0]!.args.slice(0, 3)).toEqual(['xzf', expect.stringContaining(assetName), '-C']);
    expect(existsSync(join(binDir, 'fd'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(join(binDir, 'fd')).mode & 0o777).toBe(0o755);
    }
    expect(readdirSync(binDir)).toEqual(['fd']);
    expect(statuses).toEqual([
      { type: 'info', message: 'fd not found. Downloading...' },
      { type: 'info', message: `fd installed to ${join(binDir, 'fd')}` },
    ]);
  });

  it('retries a retryable status before falling back to the release redirect', async () => {
    const version = '10.2.0';
    const assetName = 'fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz';
    const { fetch, requests } = fakeDownloadFetch(version, { latestStatuses: [503] });
    const deps = createDeps({ fetch, runCommand: extractingRunCommand(assetName) });

    expect(await ensureFd(undefined, deps)).toBe(join(scratchDir, 'bin', 'fd'));
    expect(requests).toEqual([
      LATEST_URL,
      LATEST_URL,
      `https://github.com/sharkdp/fd/releases/download/v${version}/${assetName}`,
    ]);
  });

  it('pins fd 10.3.0 on darwin x64 without a latest-release lookup', async () => {
    const assetName = 'fd-v10.3.0-x86_64-apple-darwin.tar.gz';
    const { fetch, requests } = fakeDownloadFetch('unused');
    const deps = createDeps({
      platform: 'darwin',
      arch: 'x64',
      fetch,
      runCommand: extractingRunCommand(assetName),
    });

    expect(await ensureFd(undefined, deps)).toBe(join(scratchDir, 'bin', 'fd'));
    expect(requests).toEqual([`https://github.com/sharkdp/fd/releases/download/v10.3.0/${assetName}`]);
  });

  it('cleans up the archive when extraction fails', async () => {
    const assetName = 'fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz';
    const { fetch } = fakeDownloadFetch('10.2.0');
    const statuses: FdStatus[] = [];
    const binDir = join(scratchDir, 'bin');
    const deps = createDeps({
      binDir,
      fetch,
      runCommand: () => ({ status: 1, stderr: Buffer.from('corrupt archive') }),
    });

    expect(await ensureFd(status => statuses.push(status), deps)).toBeUndefined();
    expect(statuses.at(-1)!.message).toContain('Failed to download fd');
    expect(statuses.at(-1)!.message).toContain('Failed to extract');
    expect(statuses.at(-1)!.message).toContain('corrupt archive');
    expect(readdirSync(binDir)).toEqual([]);
  });

  it('reports the full error cause chain and never leaves a partial binary', async () => {
    const statuses: FdStatus[] = [];
    let attempts = 0;
    const failingFetch = (async () => {
      attempts++;
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND github.com') });
    }) as unknown as typeof fetch;
    const deps = createDeps({ fetch: failingFetch });

    expect(await ensureFd(status => statuses.push(status), deps)).toBeUndefined();
    expect(attempts).toBe(3);
    expect(statuses).toHaveLength(2);
    expect(statuses.at(-1)!.type).toBe('warning');
    expect(statuses.at(-1)!.message).toContain('Failed to download fd');
    expect(statuses.at(-1)!.message).toContain('fetch failed');
    expect(statuses.at(-1)!.message).toContain('getaddrinfo ENOTFOUND github.com');
    expect(existsSync(join(scratchDir, 'bin', 'fd'))).toBe(false);
  });

  it('fails without downloading on unsupported platforms', async () => {
    const statuses: FdStatus[] = [];
    const { fetch } = fakeDownloadFetch('10.2.0');
    const deps = createDeps({ platform: 'freebsd', fetch });

    expect(await ensureFd(status => statuses.push(status), deps)).toBeUndefined();
    expect(statuses.at(-1)!.message).toContain('Unsupported platform: freebsd/x64');
  });

  it('uses a separate archive per attempt when calls share a binDir', async () => {
    const assetName = 'fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz';
    const { fetch } = fakeDownloadFetch('10.2.0');
    const extractionCalls: Array<{ command: string; args: string[] }> = [];
    const binDir = join(scratchDir, 'bin');
    const deps = createDeps({ binDir, fetch, runCommand: extractingRunCommand(assetName, extractionCalls) });

    const results = await Promise.all([ensureFd(undefined, deps), ensureFd(undefined, deps)]);

    expect(results).toEqual([join(binDir, 'fd'), join(binDir, 'fd')]);
    expect(extractionCalls).toHaveLength(2);
    const archivePaths = extractionCalls.map(call => call.args[1]!);
    expect(new Set(archivePaths).size).toBe(2);
    expect(existsSync(join(binDir, 'fd'))).toBe(true);
    expect(readdirSync(binDir)).toEqual(['fd']);
  });

  it('removes the partial download when the body fails mid-transfer', async () => {
    const statuses: FdStatus[] = [];
    const binDir = join(scratchDir, 'bin');
    const failingBodyFetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === LATEST_URL) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/sharkdp/fd/releases/tag/v10.2.0' },
        });
      }
      if (url.startsWith('https://github.com/sharkdp/fd/releases/download/')) {
        let pulled = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulled) controller.error(new Error('connection reset'));
            else {
              pulled = true;
              controller.enqueue(new TextEncoder().encode('partial-archive'));
            }
          },
        });
        return new Response(body);
      }
      throw new Error(`unexpected network request to ${url}`);
    }) as unknown as typeof fetch;
    const deps = createDeps({ binDir, fetch: failingBodyFetch });

    expect(await ensureFd(status => statuses.push(status), deps)).toBeUndefined();
    expect(statuses.at(-1)!.message).toContain('connection reset');
    expect(readdirSync(binDir)).toEqual([]);
  });
});

describe('getFdBinDir', () => {
  it('defaults to <home>/.pi/agent/bin', () => {
    expect(getFdBinDir({}, '/home/user', 'linux')).toBe(join('/home/user', '.pi', 'agent', 'bin'));
  });

  it('honors PI_CODING_AGENT_DIR like pi-coding-agent 1.1.0', () => {
    expect(getFdBinDir({ PI_CODING_AGENT_DIR: '/custom/agent' }, '/home/user', 'linux'))
      .toBe(join('/custom/agent', 'bin'));
  });

  it('expands a tilde in PI_CODING_AGENT_DIR', () => {
    expect(getFdBinDir({ PI_CODING_AGENT_DIR: '~/custom-agent' }, '/home/user', 'linux'))
      .toBe(join('/home/user', 'custom-agent', 'bin'));
  });
});

describe('isOfflineModeEnabled', () => {
  it('accepts the upstream truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'Yes']) {
      expect(isOfflineModeEnabled({ PI_OFFLINE: value })).toBe(true);
    }
  });

  it('treats everything else as online', () => {
    for (const value of [undefined, '', '0', 'false', 'no']) {
      expect(isOfflineModeEnabled(value === undefined ? {} : { PI_OFFLINE: value })).toBe(false);
    }
  });
});

describe('fdAssetName', () => {
  it('maps supported platforms and architectures', () => {
    expect(fdAssetName('1.2.3', 'darwin', 'arm64')).toBe('fd-v1.2.3-aarch64-apple-darwin.tar.gz');
    expect(fdAssetName('1.2.3', 'darwin', 'x64')).toBe('fd-v1.2.3-x86_64-apple-darwin.tar.gz');
    expect(fdAssetName('1.2.3', 'linux', 'arm64')).toBe('fd-v1.2.3-aarch64-unknown-linux-musl.tar.gz');
    expect(fdAssetName('1.2.3', 'linux', 'x64')).toBe('fd-v1.2.3-x86_64-unknown-linux-musl.tar.gz');
    expect(fdAssetName('1.2.3', 'win32', 'arm64')).toBe('fd-v1.2.3-aarch64-pc-windows-msvc.zip');
    expect(fdAssetName('1.2.3', 'freebsd', 'x64')).toBeNull();
  });
});
