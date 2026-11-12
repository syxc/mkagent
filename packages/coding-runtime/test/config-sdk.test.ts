import { afterEach, expect, test } from 'bun:test';
import { trashFixture } from './fixtures/trash-fixture.ts';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as config from '../src/native-config.ts';
import { leaseNativeCodemodeSandbox } from '../src/compat/codemode-sandbox.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    trashFixture(directory);
  }
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'coding-config-sdk-'));
  temporary.push(path);
  return path;
}
function run(path: string, code: string, extra: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, '--no-env-file', '--config=/dev/null', '-e', code], {
    cwd: path,
    env: { PATH: process.env.PATH!, HOME: path, USERPROFILE: path, TMPDIR: path,
      XDG_CONFIG_HOME: path, XDG_CACHE_HOME: path, PI_OFFLINE: '1', ...extra },
    stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
}

test('default Native documentation belongs to the installed Coding SDK', () => {
  const sdkRoot = dirname(dirname(Bun.resolveSync('@earendil-works/pi-coding-agent', import.meta.dir)));
  expect(config.getPackageDir()).toBe(sdkRoot);
  expect(config.getReadmePath()).toBe(join(sdkRoot, 'README.md'));
  expect(existsSync(config.getReadmePath())).toBe(true);
  expect(config.VERSION).toBe('1.5.0');
});

test('SDK metadata and home expansion keep custom Native directories separate from the pinned version', () => {
  const path = directory(), installation = join(path, 'installation');
  mkdirSync(installation);
  writeFileSync(join(installation, 'package.json'), JSON.stringify({ version: '9.9.9', piConfig: { name: 'tau', configDir: '.tau' } }));
  const result = run(path, `
    import * as config from ${JSON.stringify(join(import.meta.dir, '../src/native-config.ts'))};
    console.log(JSON.stringify({ name: config.CONFIG_DIR_NAME, env: config.ENV_AGENT_DIR,
      agent: config.getAgentDir(), bin: config.getBinDir(), root: config.getPackageDir(),
      readme: config.getReadmePath(), docs: config.getDocsPath(), examples: config.getExamplesPath(), version: config.VERSION }));
  `, { PI_PACKAGE_DIR: installation, TAU_CODING_AGENT_DIR: '~/chosen-agent' });
  expect(result).toEqual({ name: '.tau', env: 'TAU_CODING_AGENT_DIR',
    agent: join(path, 'chosen-agent'), bin: join(path, 'chosen-agent', 'bin'), root: installation,
    readme: join(installation, 'README.md'), docs: join(installation, 'docs'), examples: join(installation, 'examples'), version: '1.5.0' });
});

for (const bundledNode of [false, true]) test(`bundled Native configuration preserves version and worker policy: ${bundledNode}`, () => {
  const path = directory(), entry = join(path, 'entry.ts'), output = join(path, 'artifact');
  writeFileSync(entry, `
    import { VERSION, getCodemodeWorkerSpecifier } from ${JSON.stringify(join(import.meta.dir, '../src/native-config.ts'))};
    const worker = getCodemodeWorkerSpecifier();
    console.log(JSON.stringify({ version: VERSION, worker: worker?.toString() ?? null }));
  `);
  // Build each release mode in a fresh process, as the release scripts do.
  const build: { success: boolean; logs: string[] } = run(path, `
    const result = await Bun.build(${JSON.stringify({ entrypoints: [entry], outdir: output, naming: 'config.js', target: 'bun', format: 'esm', define: { PI_BUNDLED_NODE: String(bundledNode) } })});
    console.log(JSON.stringify({ success: result.success, logs: result.logs.map(log => log.message) }));
  `);
  expect(build.success, build.logs.join('\n')).toBe(true);
  writeFileSync(join(output, 'codemode-worker.js'), 'worker fixture');
  for (const metadata of [undefined, { name: 'host-fixture', version: '0.2.6', type: 'module' }]) {
    if (metadata) writeFileSync(join(output, 'package.json'), JSON.stringify(metadata));
    const result = run(output, `await import(${JSON.stringify(join(output, 'config.js'))});`);
    expect(result.version).toBe('1.5.0');
    expect(result.worker).toBe(bundledNode ? 'data:text/javascript;base64,' + Buffer.from('worker fixture').toString('base64') : null);
  }
}, 20_000);

test('SDK resource defaults preserve the separate legacy directory and documentation policy', () => {
  const path = directory(), installation = join(path, 'installation'), cwd = join(path, 'project'), agentDir = join(path, 'agent');
  mkdirSync(installation);
  mkdirSync(agentDir);
  writeFileSync(join(installation, 'package.json'), JSON.stringify({ piConfig: { configDir: '.tau' } }));
  for (const name of ['pi', 'tau']) {
    const skills = join(cwd, '.' + name, 'skills', name), prompts = join(cwd, '.' + name, 'prompts');
    mkdirSync(skills, { recursive: true });
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(skills, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture ${name}\n---\nInstructions\n`);
    writeFileSync(join(prompts, name + '.md'), name);
  }
  const result = run(path, `
    import { loadSkills, loadPromptTemplates, buildSystemPromptSections } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
    import { loadSkills as legacySkills } from ${JSON.stringify(new URL('../src/upstream/core/skills.ts', import.meta.url).href)};
    import { loadPromptTemplates as legacyPrompts } from ${JSON.stringify(new URL('../src/upstream/core/prompt-templates.ts', import.meta.url).href)};
    import { buildSystemPromptSections as legacySections } from ${JSON.stringify(new URL('../src/upstream/core/system-prompt.ts', import.meta.url).href)};
    const options = ${JSON.stringify({ cwd, agentDir, includeDefaults: true, skillPaths: [], promptPaths: [] })};
    console.log(JSON.stringify({ skills: loadSkills(Object.create(options)).skills.map(x => x.name),
      prompts: loadPromptTemplates(options).templates.map(x => x.name),
      legacySkills: legacySkills(options).skills.map(x => x.name), legacyPrompts: legacyPrompts(options).templates.map(x => x.name),
      docs: buildSystemPromptSections(options).docs, legacyDocs: legacySections(options).docs }));
  `, { PI_PACKAGE_DIR: installation });
  expect(result.skills).toEqual(['tau']);
  expect(result.prompts).toEqual(['tau']);
  expect(result.legacySkills).toEqual(['pi']);
  expect(result.legacyPrompts).toEqual(['pi']);
  expect(result.docs).toContain(join(installation, 'README.md'));
  expect(result.legacyDocs).toContain('https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent/README.md');
});

test('Native codemode obtains QuickJS from the durable SDK and executes a real worker', async () => {
  const lease = await leaseNativeCodemodeSandbox({ now: Date.now });
  try {
    const result = await lease.sandbox.start('return "durable 中文";', {
      startedAt: Date.now(), seed: 1, onCall: () => { throw new Error('Unexpected tool'); },
    }).result;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toBe('durable 中文');
  } finally { await lease.release(); }
}, 10_000);
