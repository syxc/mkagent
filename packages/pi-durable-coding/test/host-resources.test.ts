import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Agent } from '../src/agent-runtime.ts';
import { createHostResources, createHostSettingsManager } from '../src/host-resources.ts';
import { AgentSession } from '../src/pi/core/agent-session.ts';
import { ModelRuntime } from '../src/pi/core/model-runtime.ts';
import { DefaultResourceLoader } from '../src/pi/core/resource-loader.ts';
import { SessionManager } from '../src/pi/core/session-manager.ts';
import { SettingsManager, type SettingsScope } from '../src/pi/core/settings-manager.ts';

let root: string;
let cwd: string;
let agentDir: string;

function put(path: string, content: string) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, content);
}

function skill(path: string, name: string) {
  put(path, `---\nname: ${name}\ndescription: Fixture ${name}\n---\nUse ${name}.\n`);
}

function theme(path: string, name: string) {
  const body = JSON.parse(fs.readFileSync(new URL('../src/pi/modes/interactive/theme/dark.json', import.meta.url), 'utf8'));
  put(path, JSON.stringify({ ...body, name }));
}

function blockExternalWork() {
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('Unexpected subprocess'); });
  const spawnSync = spyOn(childProcess, 'spawnSync').mockImplementation(() => { throw new Error('Unexpected subprocess'); });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected network'); });
  return () => {
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'host-native-resources-')));
  cwd = join(root, 'project');
  agentDir = join(root, 'agent');
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
});

afterEach(() => {
  mock.restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('host native resources', () => {
  test.each([false, true])('host compaction policy delegates native settings and survives reload with profiles=%s', async profile => {
    const global = { compaction: { reserveTokens: 31_000, modelOverrides: { 'test/wide': { reserveTokens: 123 } } } };
    if (!profile) put(join(agentDir, 'settings.json'), JSON.stringify(global));
    const settings = createHostSettingsManager({
      cwd, agentDir, ...(profile ? { globalSettings: global } : {}),
    });
    const model = { provider: 'test', id: 'wide', contextWindow: 1_000_000 };
    expect(settings.getCompactionReserveTokens(model)).toBe(123);
    settings.setHostAutoCompactWindow(100_000);
    expect(settings.getCompactionReserveTokens(model)).toBe(900_000);
    expect(settings.getCompactionSettings(model).reserveTokens).toBe(900_000);
    settings.setTheme('host-policy');
    await settings.flush();
    await settings.reload();
    expect(settings.getCompactionSettings(model).reserveTokens).toBe(900_000);
    expect(settings.getGlobalSettings().compaction?.reserveTokens).toBe(31_000);
    expect(settings.getTheme()).toBe('host-policy');
    settings.setHostAutoCompactWindow(undefined);
    expect(settings.getCompactionReserveTokens(model)).toBe(123);
    expect(settings.getCompactionSettings(model).reserveTokens).toBe(123);
  });

  test('host-only policy isolates native sessions from ambient Pi resources and settings across reloads', async () => {
    for (const directory of [agentDir, join(cwd, '.pi')]) {
      put(join(directory, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
      put(join(directory, 'SYSTEM.md'), 'ambient system');
      put(join(directory, 'APPEND_SYSTEM.md'), 'ambient append');
      put(join(directory, 'AGENTS.md'), 'ambient instructions');
      put(join(directory, 'extensions', 'ambient.ts'), 'throw new Error("AMBIENT EXTENSION EXECUTED");');
      put(join(directory, 'prompts', 'ambient.md'), 'Ambient prompt');
      skill(join(directory, 'skills', 'ambient', 'SKILL.md'), 'ambient');
      theme(join(directory, 'themes', 'ambient.json'), 'ambient');
    }
    put(join(cwd, 'AGENTS.md'), 'ambient project');
    const read = spyOn(fs, 'readFileSync');
    const checkExternalWork = blockExternalWork();
    let prompt = '  host prompt\n';
    const { resourceLoader, settingsManager } = createHostResources({
      cwd, agentDir, projectTrusted: true, resourcePolicy: 'host-only', getSystemPrompt: () => prompt,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await resourceLoader.reload();
      expect(resourceLoader.getExtensions().extensions).toEqual([]);
      expect(resourceLoader.getExtensions().errors).toEqual([]);
      expect(resourceLoader.getSkills().skills).toEqual([]);
      expect(resourceLoader.getPrompts().prompts).toEqual([]);
      expect(resourceLoader.getThemes().themes).toEqual([]);
      expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(resourceLoader.getSystemPrompt()).toBe(prompt);
      expect(resourceLoader.getSystemPromptSource()).toBeUndefined();
      expect(resourceLoader.getAppendSystemPrompt()).toEqual([]);
      expect(settingsManager.getCompactionSettings().enabled).toBe(true);
      settingsManager.setTheme('host-choice');
      await settingsManager.flush();
      prompt = 'updated host prompt';
    }
    expect(settingsManager.getTheme()).toBe('host-choice');
    expect(read.mock.calls.map(call => String(call[0])).filter(path =>
      /(?:settings\.json|SYSTEM\.md|AGENTS\.md|SKILL\.md|ambient\.md|ambient\.json)$/.test(path))).toEqual([]);
    checkExternalWork();
  });

  test('does not read untrusted project settings, modules, prompts or ancestor context', async () => {
    put(join(agentDir, 'settings.json'), '{"theme":"dark"}');
    put(join(agentDir, 'AGENTS.md'), 'global context');
    put(join(agentDir, 'SYSTEM.md'), 'global system');
    put(join(agentDir, 'APPEND_SYSTEM.md'), 'global append');
    put(join(root, 'AGENTS.md'), 'untrusted ancestor');
    put(join(cwd, 'AGENTS.md'), 'untrusted project');
    put(join(cwd, '.pi', 'settings.json'), '{ invalid project settings');
    put(join(cwd, '.pi', 'SYSTEM.md'), 'untrusted system');
    put(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'untrusted append');
    put(join(cwd, '.pi', 'extensions', 'blocked.ts'), 'throw new Error("UNTRUSTED MODULE EXECUTED");');
    skill(join(cwd, '.pi', 'skills', 'blocked', 'SKILL.md'), 'blocked');
    const read = spyOn(fs, 'readFileSync');
    const readdir = spyOn(fs, 'readdirSync');
    const checkExternalWork = blockExternalWork();
    const { resourceLoader, settingsManager } = createHostResources({ cwd, agentDir });
    await resourceLoader.reload();
    expect(resourceLoader).toBeInstanceOf(DefaultResourceLoader);
    expect(settingsManager).toBeInstanceOf(SettingsManager);
    expect(settingsManager.isProjectTrusted()).toBe(false);
    expect(settingsManager.drainErrors()).toEqual([]);
    expect(resourceLoader.getExtensions().extensions.map(extension => [...extension.commands.keys()])).toEqual([['packages']]);
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    expect(resourceLoader.getSkills().skills).toEqual([]);
    expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([{ path: join(agentDir, 'AGENTS.md'), content: 'global context' }]);
    expect(resourceLoader.getSystemPrompt()).toBe('global system');
    expect(resourceLoader.getAppendSystemPrompt()).toEqual(['global append']);
    const reads = [...read.mock.calls, ...readdir.mock.calls].map(call => String(call[0]));
    expect(reads).toContain(join(agentDir, 'SYSTEM.md'));
    expect(reads.filter(path => path.startsWith(cwd) || path === join(root, 'AGENTS.md'))).toEqual([]);
    checkExternalWork();
  });

  test('preserves project collision priority, themes and prompt provenance across trust changes', async () => {
    skill(join(agentDir, 'skills', 'same', 'SKILL.md'), 'same');
    skill(join(cwd, '.pi', 'skills', 'same', 'SKILL.md'), 'same');
    put(join(agentDir, 'prompts', 'review.md'), 'Global $1');
    put(join(cwd, '.pi', 'prompts', 'review.md'), 'Project $1');
    theme(join(agentDir, 'themes', 'same.json'), 'same');
    theme(join(cwd, '.pi', 'themes', 'same.json'), 'same');
    put(join(agentDir, 'SYSTEM.md'), 'global system');
    put(join(cwd, '.pi', 'SYSTEM.md'), '\uFEFFproject system');
    put(join(agentDir, 'APPEND_SYSTEM.md'), 'global append');
    put(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'project append');
    let base = 'host base';
    const { resourceLoader, settingsManager } = createHostResources({
      cwd, agentDir, projectTrusted: true, getSystemPrompt: () => base,
    });
    await resourceLoader.reload();
    expect(resourceLoader.getSkills().skills[0]?.sourceInfo.scope).toBe('project');
    expect(resourceLoader.getSkills().diagnostics.some(value => value.type === 'collision')).toBe(true);
    expect(resourceLoader.getPrompts().prompts[0]).toMatchObject({ content: 'Project $1', sourceInfo: { scope: 'project' } });
    expect(resourceLoader.getPrompts().diagnostics[0]?.collision?.winnerPath).toBe(join(cwd, '.pi', 'prompts', 'review.md'));
    expect(resourceLoader.getThemes().themes[0]?.sourceInfo?.scope).toBe('project');
    expect(resourceLoader.getThemes().diagnostics[0]?.collision?.resourceType).toBe('theme');
    expect(resourceLoader.getSystemPrompt()).toBe('host base\n\nproject system');
    expect(resourceLoader.getSystemPromptSource()).toEqual({ path: join(cwd, '.pi', 'SYSTEM.md') });
    expect(resourceLoader.getAppendSystemPromptSources()).toEqual([{ path: join(cwd, '.pi', 'APPEND_SYSTEM.md') }]);
    base = 'updated host base';
    expect(resourceLoader.getSystemPrompt()).toBe('updated host base\n\nproject system');
    settingsManager.setProjectTrusted(false);
    await resourceLoader.reload();
    expect(resourceLoader.getPrompts().prompts[0]?.content).toBe('Global $1');
    expect(resourceLoader.getSystemPrompt()).toBe('updated host base\n\nglobal system');
    expect(resourceLoader.getSystemPromptSource()).toEqual({ path: join(agentDir, 'SYSTEM.md') });
    expect(resourceLoader.getAppendSystemPrompt()).toEqual(['global append']);
    fs.rmSync(join(agentDir, 'SYSTEM.md'));
    fs.rmSync(join(agentDir, 'APPEND_SYSTEM.md'));
    await resourceLoader.reload();
    expect(resourceLoader.getSystemPrompt()).toBe('updated host base');
    expect(resourceLoader.getSystemPromptSource()).toBeUndefined();
    expect(resourceLoader.getAppendSystemPrompt()).toEqual([]);
  });

  test('does not discover implicit HOME skills outside the supplied agent directory', async () => {
    const isolatedHome = join(root, 'home');
    skill(join(isolatedHome, '.agents', 'skills', 'home-only', 'SKILL.md'), 'home-only');
    skill(join(agentDir, 'skills', 'host-only', 'SKILL.md'), 'host-only');
    const previousHome = process.env.HOME;
    process.env.HOME = isolatedHome;
    const read = spyOn(fs, 'readFileSync');
    const readdir = spyOn(fs, 'readdirSync');
    try {
      const { resourceLoader } = createHostResources({ cwd, agentDir });
      await resourceLoader.reload();
      expect(resourceLoader.getSkills().skills.map(value => value.name)).toEqual(['host-only']);
      const reads = [...read.mock.calls, ...readdir.mock.calls].map(call => String(call[0]));
      expect(reads.filter(path => path.startsWith(isolatedHome))).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('uses profile settings without file reads and retains native session writes on reload', async () => {
    put(join(agentDir, 'settings.json'), '{ invalid file');
    put(join(cwd, '.pi', 'settings.json'), '{ invalid file');
    const read = spyOn(fs, 'readFileSync');
    const { resourceLoader, settingsManager } = createHostResources({
      cwd, agentDir, projectTrusted: true,
      globalSettings: { theme: 'profile', compaction: { enabled: false } },
      projectSettings: { packages: [] },
    });
    await resourceLoader.reload();
    expect(settingsManager.getTheme()).toBe('profile');
    settingsManager.setTheme('changed');
    settingsManager.setProjectPackages(['./profile-package']);
    await settingsManager.flush();
    await resourceLoader.reload();
    expect(settingsManager.getTheme()).toBe('changed');
    expect(settingsManager.getProjectSettings().packages).toEqual(['./profile-package']);
    expect(settingsManager.drainErrors()).toEqual([]);
    const settingsReads = read.mock.calls.map(call => String(call[0])).filter(path => path.endsWith('/settings.json'));
    expect(settingsReads).toEqual([]);
  });

  test('persists native file settings and respects a custom host storage port', async () => {
    const files = createHostSettingsManager({ cwd, agentDir, projectTrusted: true });
    files.setTheme('changed');
    files.setProjectPackages(['./project-package']);
    await files.flush();
    await files.reload();
    expect(JSON.parse(fs.readFileSync(join(agentDir, 'settings.json'), 'utf8')).theme).toBe('changed');
    expect(JSON.parse(fs.readFileSync(join(cwd, '.pi', 'settings.json'), 'utf8')).packages).toEqual(['./project-package']);
    const data: Partial<Record<SettingsScope, string>> = { global: '{"theme":"host"}', project: '{"theme":"blocked"}' };
    const scopes: SettingsScope[] = [];
    const custom = createHostSettingsManager({
      cwd, agentDir, settingsStorage: {
        withLock(scope, fn) {
          scopes.push(scope);
          const next = fn(data[scope]);
          if (next !== undefined) data[scope] = next;
        },
      },
    });
    custom.setTheme('saved');
    await custom.flush();
    await custom.reload();
    expect(custom.getTheme()).toBe('saved');
    expect(JSON.parse(data.global!).theme).toBe('saved');
    expect(scopes.every(scope => scope === 'global')).toBe(true);
    expect(() => custom.setProjectPackages([])).toThrow('not trusted');
  });

  test('skips missing configured and explicit sources during normal and pre-trust reloads without subprocesses', async () => {
    const checkExternalWork = blockExternalWork();
    const configured = 'npm:host-resource-missing@1.0.0';
    const explicit = 'git:https://invalid.example/owner/host-resource-missing';
    const { resourceLoader } = createHostResources({
      cwd, agentDir, globalSettings: { packages: [configured] },
      packagePaths: ['npm:host-extra-missing@1.0.0'], extensionPaths: [explicit],
    });
    for (const reload of [undefined, { resolveProjectTrust: async () => false }]) {
      await resourceLoader.reload(reload);
      const warnings = resourceLoader.getExtensions().warnings ?? [];
      expect(warnings.map(value => value.path).sort()).toEqual([configured, explicit, 'npm:host-extra-missing@1.0.0'].sort());
      expect(warnings.every(value => value.warning.includes('skipped by the host resource policy'))).toBe(true);
      expect(resourceLoader.getExtensions().extensions.map(extension => [...extension.commands.keys()])).toEqual([['packages']]);
    }
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';
    try {
      await resourceLoader.reload();
      expect(resourceLoader.getExtensions().warnings?.map(value => value.path).sort())
        .toEqual([configured, explicit, 'npm:host-extra-missing@1.0.0'].sort());
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
    expect(fs.existsSync(join(agentDir, 'npm'))).toBe(false);
    expect(fs.existsSync(join(agentDir, 'git'))).toBe(false);
    checkExternalWork();
  });

  test('loads matching installed packages, skips wrong versions and never refreshes cached temporary packages', async () => {
    const installed = join(agentDir, 'npm', 'node_modules', 'host-installed');
    put(join(installed, 'package.json'), JSON.stringify({ name: 'host-installed', version: '1.0.0', pi: { prompts: ['review.md'] } }));
    put(join(installed, 'review.md'), 'Installed package');
    const wrongVersion = join(agentDir, 'npm', 'node_modules', 'host-wrong-version');
    put(join(wrongVersion, 'package.json'), '{"version":"1.0.0"}');
    const hash = createHash('sha256').update('npm-').digest('hex').slice(0, 8);
    const cached = join(agentDir, 'tmp', 'extensions', 'npm', hash, 'node_modules', 'host-cached');
    put(join(cached, 'package.json'), JSON.stringify({ name: 'host-cached', version: '1.0.0', pi: { prompts: ['cached.md'] } }));
    put(join(cached, 'cached.md'), 'Cached package');
    const gitHash = createHash('sha256').update('git-invalid.example-owner/host-git-cached').digest('hex').slice(0, 8);
    const gitCached = join(agentDir, 'tmp', 'extensions', 'git-invalid.example', gitHash, 'owner', 'host-git-cached');
    put(join(gitCached, 'package.json'), JSON.stringify({ pi: { prompts: ['git-cached.md'] } }));
    put(join(gitCached, 'git-cached.md'), 'Cached git package');
    const checkExternalWork = blockExternalWork();
    const { resourceLoader } = createHostResources({
      cwd, agentDir,
      packagePaths: ['npm:host-installed@1.0.0', 'npm:host-wrong-version@2.0.0'],
      extensionPaths: ['npm:host-cached', 'git:https://invalid.example/owner/host-git-cached'],
    });
    await resourceLoader.reload();
    expect(resourceLoader.getPrompts().prompts.map(value => value.content).sort())
      .toEqual(['Cached git package', 'Cached package', 'Installed package']);
    expect(resourceLoader.getPrompts().prompts.find(value => value.content === 'Installed package')?.sourceInfo).toMatchObject({
      origin: 'package', scope: 'user', source: 'npm:host-installed@1.0.0',
    });
    expect(resourceLoader.getExtensions().warnings?.map(value => value.path)).toEqual(['npm:host-wrong-version@2.0.0']);
    checkExternalWork();
  });

  test('loads full native extension imports and discovers extension resources again after session reload', async () => {
    const packageRoot = join(root, 'package');
    const extensionPath = join(packageRoot, 'extension.ts');
    put(join(packageRoot, 'package.json'), JSON.stringify({
      scripts: { prepare: 'exit 88', postinstall: 'exit 89' }, pi: { extensions: ['extension.ts'] },
    }));
    skill(join(packageRoot, 'extra', 'SKILL.md'), 'extra');
    put(join(packageRoot, 'extra.md'), 'Extension prompt');
    theme(join(packageRoot, 'extra.json'), 'extra');
    put(extensionPath, `
import { Agent } from '@earendil-works/pi-agent-core';
import { SessionManager, DefaultResourceLoader, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
export default function(pi) {
  const agent = new Agent({
    initialState: { systemPrompt: 'extension-owned agent' },
    streamFn: () => { throw new Error('Unexpected provider call'); },
  });
  if (agent.state.systemPrompt !== 'extension-owned agent' || typeof SessionManager.inMemory !== 'function'
    || typeof DefaultResourceLoader.prototype.extendResources !== 'function'
    || parseFrontmatter('native').body !== 'native') throw new Error('Incomplete native modules');
  pi.registerFlag('native-flag', { description: 'Native flag', type: 'boolean', default: true });
  pi.registerCommand('native-command', { description: 'Native command', handler: async () => {} });
  pi.registerShortcut('ctrl+alt+n', { description: 'Native shortcut', handler: async () => {} });
  pi.registerMessageRenderer('native-message', () => undefined);
  pi.registerTool({
    name: 'native_tool', label: 'Native', description: 'Native fixture', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'native' }], details: {} }),
  });
  pi.on('resources_discover', (event, ctx) => {
    if (!ctx.isProjectTrusted()) throw new Error('Lost native context');
    return {
      skillPaths: [${JSON.stringify(join(packageRoot, 'extra', 'SKILL.md'))}],
      promptPaths: [${JSON.stringify(join(packageRoot, 'extra.md'))}],
      themePaths: [${JSON.stringify(join(packageRoot, 'extra.json'))}],
    };
  });
}
`);
    const checkExternalWork = blockExternalWork();
    const { resourceLoader, settingsManager } = createHostResources({ cwd, agentDir, projectTrusted: true, packagePaths: [packageRoot] });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    const extension = resourceLoader.getExtensions().extensions[0];
    expect(extension.flags.has('native-flag')).toBe(true);
    expect(extension.commands.get('native-command')?.sourceInfo?.origin).toBe('package');
    expect(extension.tools.has('native_tool')).toBe(true);
    expect(extension.shortcuts.has('ctrl+alt+n')).toBe(true);
    expect(extension.messageRenderers.has('native-message')).toBe(true);
    const credentials = ModelRuntime.createCredentials(new InMemoryCredentialStore());
    const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
    const modelRuntime = await ModelRuntime.bind({ models: () => models, credentials });
    const errors: unknown[] = [];
    const session = new AgentSession({
      agent: new Agent({ streamFn: () => { throw new Error('Unexpected provider call'); } }),
      sessionManager: SessionManager.inMemory(cwd), cwd,
      resourceLoader, settingsManager, modelRuntime, baseToolsOverride: {},
    });
    try {
      await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
      expect(resourceLoader.getSkills().skills.map(value => value.name)).toContain('extra');
      expect(resourceLoader.getPrompts().prompts.map(value => value.name)).toContain('extra');
      expect(resourceLoader.getThemes().themes.map(value => value.name)).toContain('extra');
      const sourceInfo = resourceLoader.getSkills().skills.find(value => value.name === 'extra')?.sourceInfo;
      expect(sourceInfo).toMatchObject({ source: 'extension:extension', baseDir: packageRoot });
      put(join(packageRoot, 'extra.md'), 'Updated extension prompt');
      await session.reload();
      expect(resourceLoader.getPrompts().prompts.find(value => value.name === 'extra')?.content).toBe('Updated extension prompt');
      expect(resourceLoader.getSkills().skills.find(value => value.name === 'extra')?.sourceInfo.source).toBe('extension:extension');
      expect(resourceLoader.getThemes().themes.find(value => value.name === 'extra')?.sourceInfo?.source).toBe('extension:extension');
      expect(errors).toEqual([]);
    } finally {
      session.dispose();
    }
    checkExternalWork();
  });
});
