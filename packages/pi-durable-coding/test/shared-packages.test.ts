import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let root: string;
let cwd: string;
let agentDir: string;
let installation: string;

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shared-coding-packages-'));
  cwd = join(root, 'project');
  agentDir = join(root, 'agent');
  installation = join(root, 'installation');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  put(join(installation, 'package.json'), JSON.stringify({ name: 'fixture', piConfig: { configDir: '.tau' } }));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function probe(action: string, offline = '') {
  const source = join(import.meta.dir, '../src');
  const code = `
    import { DefaultPackageManager as Legacy } from ${JSON.stringify(join(source, 'upstream/core/package-manager.ts'))};
    import { DefaultPackageManager as Native } from '@earendil-works/pi-coding-agent';
    import { resolveCodingPackages } from ${JSON.stringify(join(source, 'packages.ts'))};
    import { loadProjectContextFiles } from ${JSON.stringify(join(source, 'upstream/core/context-files.ts'))};
    const options = ${JSON.stringify({ cwd, agentDir })};
    const empty = {
      getGlobalSettings: () => ({}), getProjectSettings: () => ({}),
      setPackages: () => { throw new Error("Unexpected settings write"); },
      setProjectPackages: () => { throw new Error("Unexpected settings write"); },
      isProjectTrusted: () => true, getNpmCommand: () => undefined,
    };
    ${action}
  `;
  const child = Bun.spawnSync([process.execPath, '-e', code], {
    // No package command can run if a regression reaches an installation path.
    env: { ...process.env, PATH: join(root, 'no-commands'), PI_PACKAGE_DIR: installation, PI_OFFLINE: offline },
    stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
  });
  expect({ exit: child.exitCode, error: child.stderr.toString() }).toEqual({ exit: 0, error: '' });
  return JSON.parse(child.stdout.toString());
}

describe('shared package implementation through existing entry points', () => {
  test('keeps legacy project discovery and managed npm paths at .pi with a .tau native installation', () => {
    for (const directory of ['.pi', '.tau']) {
      put(join(cwd, directory, 'prompts', `${directory.slice(1)}.md`), directory);
      put(join(cwd, directory, 'npm', 'node_modules', 'fixture', 'package.json'), '{"version":"1.0.0"}');
    }
    expect(probe(`
      const legacy = new Legacy({ ...options, settingsManager: empty });
      const native = new Native({ ...options, settingsManager: empty });
      console.log(JSON.stringify({
        legacy: (await resolveCodingPackages({ ...options, projectTrusted: true })).prompts.map(p => p.path),
        native: (await native.resolve()).prompts.map(p => p.path),
        legacyNpm: legacy.getInstalledPath("npm:fixture", "project"),
        nativeNpm: native.getInstalledPath("npm:fixture", "project"),
        shared: legacy instanceof Native,
      }));
    `)).toEqual({
      legacy: [join(cwd, '.pi', 'prompts', 'pi.md')], native: [join(cwd, '.tau', 'prompts', 'tau.md')],
      legacyNpm: join(cwd, '.pi', 'npm', 'node_modules', 'fixture'),
      nativeNpm: join(cwd, '.tau', 'npm', 'node_modules', 'fixture'), shared: true,
    });
  });

  test.each(['', '1', 'TRUE', 'yes', '0'])('preserves legacy missing-source callbacks and diagnostics in offline mode %s', offline => {
    const result = probe(`
      const settingsManager = { ...empty,
        getGlobalSettings: () => ({ packages: ["git:https://invalid.example/owner/missing"] }),
      };
      let legacyCalls = 0;
      let nativeCalls = 0;
      const legacy = await new Legacy({ ...options, settingsManager }).resolve(async () => { legacyCalls++; return "skip"; });
      const native = await new Native({ ...options, settingsManager }).resolve(async () => { nativeCalls++; return "skip"; });
      console.log(JSON.stringify({ legacyCalls, nativeCalls, legacyFailures: legacy.installFailures, nativeFailures: native.installFailures }));
    `, offline);
    expect(result.legacyCalls).toBe(['1', 'true', 'yes'].includes(offline.toLowerCase()) ? 0 : 1);
    expect(result.nativeCalls).toBe(1);
    expect(result.legacyFailures).toEqual([]);
    expect(result.nativeFailures).toHaveLength(1);
    expect(result.nativeFailures[0]).toMatchObject({ source: 'git:https://invalid.example/owner/missing', scope: 'user', skipped: true });
  });

  test('retains native missing-source errors while legacy offline resolution skips the callback', () => {
    expect(probe(`
      const settingsManager = { ...empty,
        getGlobalSettings: () => ({ packages: ["git:https://invalid.example/owner/missing"] }),
      };
      const legacy = await new Legacy({ ...options, settingsManager }).resolve(async () => { throw new Error("Must not run offline"); });
      let nativeError = "";
      try { await new Native({ ...options, settingsManager }).resolve(async () => "error"); }
      catch (error) { nativeError = error.message; }
      console.log(JSON.stringify({ legacy: legacy.installFailures, nativeError }));
    `, '1')).toEqual({ legacy: [], nativeError: 'Missing source: git:https://invalid.example/owner/missing' });
  });

  test('keeps project trust in package discovery and the shared context function', () => {
    put(join(agentDir, 'AGENTS.md'), 'global');
    put(join(cwd, 'AGENTS.md'), 'project');
    put(join(cwd, '.pi', 'prompts', 'private.md'), 'private');
    expect(probe(`
      const packages = await resolveCodingPackages({ ...options, projectTrusted: false });
      console.log(JSON.stringify({
        prompts: packages.prompts,
        context: loadProjectContextFiles({ ...options, projectTrusted: false }).map(item => item.content),
      }));
    `)).toEqual({ prompts: [], context: ['global'] });
  });
});
