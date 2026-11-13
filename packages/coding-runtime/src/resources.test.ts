import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { DefaultPackageManager } from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverCodingSkills, formatSkillsForPrompt, loadCodingResources, loadProjectContextFiles } from './resources.ts';
import { expandCodingSkill, expandCodingTemplate, parseCommandArgs, substituteArgs } from './input.ts';
import { buildSystemPrompt, buildSystemPromptSections, buildSystemPromptState } from './upstream/core/system-prompt.ts';

let root: string;
let cwd: string;
let agentDir: string;

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skill(path: string, name: string, extra = '') {
  put(path, `---\nname: ${name}\ndescription: Work with ${name}\n${extra}---\nInstructions for ${name}.\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'durable-coding-resources-'));
  cwd = join(root, 'project');
  agentDir = join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ported native resource behavior', () => {
  test('keeps legacy .pi discovery when the native installation uses another project directory', () => {
    const installation = join(root, 'alternate-pi');
    put(join(installation, 'package.json'), JSON.stringify({ name: 'fixture', piConfig: { configDir: '.tau' } }));
    skill(join(cwd, '.pi', 'skills', 'pi', 'SKILL.md'), 'pi');
    skill(join(cwd, '.tau', 'skills', 'tau', 'SKILL.md'), 'tau');
    put(join(cwd, '.pi', 'prompts', 'pi.md'), 'Pi prompt');
    put(join(cwd, '.tau', 'prompts', 'tau.md'), 'Tau prompt');
    const code = `
      import { discoverCodingSkills } from ${JSON.stringify(join(import.meta.dir, 'resources.ts'))};
      import { loadPromptTemplates } from ${JSON.stringify(join(import.meta.dir, 'upstream/core/prompt-templates.ts'))};
      import { loadSkills as nativeSkills, loadPromptTemplates as nativePrompts, buildSystemPromptSections as nativeSections, CONFIG_DIR_NAME } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
      import { buildSystemPromptSections as legacySections } from ${JSON.stringify(join(import.meta.dir, 'host-system-prompt.ts'))};
      import { loadSkills as sdkSkills, loadPromptTemplates as sdkPrompts } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
      const options = ${JSON.stringify({ cwd, agentDir, includeDefaults: true, skillPaths: [], promptPaths: [] })};
      const explicit = {
        ...options, includeDefaults: false,
        skillPaths: ['.pi/skills/pi/SKILL.md'], promptPaths: ['.pi/prompts/pi.md'],
      };
      console.log(JSON.stringify({
        configDir: CONFIG_DIR_NAME,
        nativeReadme: nativeSections(options).docs.match(/Main documentation: (.+)/)[1],
        legacyReadme: legacySections(options).docs.match(/Main documentation: (.+)/)[1],
        legacySkills: discoverCodingSkills(options).skills.map(item => item.name),
        legacyPrompts: loadPromptTemplates(options).templates.map(item => item.name),
        nativeSkills: nativeSkills(options).skills.map(item => item.name),
        inheritedNativeSkills: nativeSkills(Object.create(options)).skills.map(item => item.name),
        hiddenNativeSkills: nativeSkills(Object.defineProperties({}, Object.fromEntries(Object.entries(options).map(([key, value]) => [key, { value }])))).skills.map(item => item.name),
        nativePrompts: nativePrompts(options).templates.map(item => item.name),
        explicitNativeSkills: nativeSkills(options, '.pi').skills.map(item => item.name),
        explicitNativePrompts: nativePrompts(options, '.pi').templates.map(item => item.name),
        explicitSDKSkills: sdkSkills(options, '.pi').skills.map(item => item.name),
        explicitSDKPrompts: sdkPrompts(options, '.pi').templates.map(item => item.name),
        skillScopes: discoverCodingSkills(explicit).skills.map(item => item.sourceInfo.scope),
        promptScopes: loadPromptTemplates(explicit).templates.map(item => item.sourceInfo.scope),
      }));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], {
      env: { ...process.env, PI_PACKAGE_DIR: installation }, stdout: 'pipe', stderr: 'pipe',
    });
    expect({ code: child.exitCode, error: child.stderr.toString() }).toEqual({ code: 0, error: '' });
    expect(JSON.parse(child.stdout.toString())).toEqual({
      configDir: '.tau', legacySkills: ['pi'], legacyPrompts: ['pi'], nativeSkills: ['tau'], nativePrompts: ['tau'],
      nativeReadme: join(installation, 'README.md'),
      legacyReadme: 'https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent/README.md',
      inheritedNativeSkills: ['tau'], hiddenNativeSkills: ['tau'],
      explicitNativeSkills: ['pi'], explicitNativePrompts: ['pi'], explicitSDKSkills: ['pi'], explicitSDKPrompts: ['pi'],
      skillScopes: ['project'], promptScopes: ['project'],
    });
  });

  test('keeps legacy documentation URLs in structured and rendered prompts', () => {
    const source = 'https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent';
    const sections = buildSystemPromptSections({ cwd });
    expect(sections.docs).toContain(`Main documentation: ${source}/README.md`);
    expect(sections.docs).toContain(`Additional docs: ${source}/docs`);
    expect(buildSystemPrompt({ cwd })).toContain(`Examples: ${source}/examples`);
  });

  test('keeps custom documentation sections and host prompt behavior', () => {
    expect(buildSystemPromptSections({ cwd, customPrompt: 'Host prompt' }).docs).toBeUndefined();
    const sections = buildSystemPromptSections({ cwd, sections: { docs: 'Custom documentation' } });
    expect(sections.docs).toBe('<docs>\nCustom documentation\n</docs>');
    expect(buildSystemPromptSections({ cwd, sections: { docs: '' } }).docs)
      .toContain('https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent/docs');
  });

  test('keeps forced prompts opaque without generated sections', () => {
    const options = { cwd, forceSystemPrompt: '<docs>Exact replacement</docs>' };
    expect(buildSystemPromptState(options)).toEqual({ content: options.forceSystemPrompt });
    expect(buildSystemPrompt(options)).toBe(options.forceSystemPrompt);
  });

  test('requires the host agent directory before discovering skills', () => {
    skill(join(agentDir, 'skills', 'global', 'SKILL.md'), 'global');
    skill(join(cwd, '.pi', 'skills', 'project', 'SKILL.md'), 'project');
    expect(() => Reflect.apply(discoverCodingSkills, undefined, [{ cwd }]))
      .toThrow('The durable coding host must provide agentDir explicitly.');
    expect(discoverCodingSkills({ cwd, agentDir }).skills.map(value => value.name).sort())
      .toEqual(['global', 'project']);
  });

  test('inherits ignore rules and nested negation while following skill symlinks', () => {
    const skillsDir = join(agentDir, 'skills');
    put(join(skillsDir, '.gitignore'), '**/skip*\n');
    put(join(skillsDir, 'nested', '.ignore'), '!skip-keep/\n');
    skill(join(skillsDir, 'skip-root', 'SKILL.md'), 'skip-root');
    skill(join(skillsDir, 'nested', 'skip-keep', 'SKILL.md'), 'skip-keep');
    skill(join(skillsDir, 'nested', 'skip-drop', 'SKILL.md'), 'skip-drop');
    skill(join(root, 'linked', 'SKILL.md'), 'linked');
    symlinkSync(join(root, 'linked'), join(skillsDir, 'link'));
    const result = discoverCodingSkills({ cwd, agentDir });
    expect(result.skills.map(value => value.name).sort()).toEqual(['linked', 'skip-keep']);
  });

  test('reports invalid YAML, name collisions and hides explicitly invoked skills', () => {
    skill(join(agentDir, 'skills', 'same', 'SKILL.md'), 'same');
    skill(join(cwd, '.pi', 'skills', 'same', 'SKILL.md'), 'same');
    skill(join(agentDir, 'skills', 'manual', 'SKILL.md'), 'manual', 'disable-model-invocation: true\n');
    put(join(agentDir, 'skills', 'invalid', 'SKILL.md'), '---\ndescription: [broken\n---\nbody');
    const result = discoverCodingSkills({ cwd, agentDir });
    expect(result.diagnostics.some(value => value.type === 'collision')).toBe(true);
    expect(result.diagnostics.some(value => value.path?.endsWith('invalid/SKILL.md'))).toBe(true);
    expect(result.skills.find(value => value.name === 'same')?.filePath).toBe(join(agentDir, 'skills', 'same', 'SKILL.md'));
    expect(formatSkillsForPrompt(result.skills)).not.toContain('<name>manual</name>');
  });

  test('preserves template empty arguments, defaults, slices and nonrecursive substitution', () => {
    const args = parseCommandArgs(`"" 'two words' '$1' four`);
    expect(args).toEqual(['', 'two words', '$1', 'four']);
    expect(substituteArgs('${1:-fallback}|${@:2:2}|$4|${@:-none}', args))
      .toBe('fallback|two words $1|four| two words $1 four');
  });

  test('loads manifest glob patterns and project priority without importing extension code', async () => {
    const packageDir = join(root, 'local-package');
    put(join(packageDir, 'package.json'), JSON.stringify({ pi: {
      skills: ['skills/*'], prompts: ['prompts/*.md'], extensions: ['extensions/*.ts'],
    } }));
    skill(join(packageDir, 'skills', 'sample', 'SKILL.md'), 'sample');
    put(join(packageDir, 'prompts', 'review.md'), '---\ndescription: Package review\n---\nPackage $1');
    put(join(packageDir, 'extensions', 'danger.ts'), 'throw new Error("MUST NOT IMPORT WHILE DISCOVERING");');
    put(join(cwd, '.pi', 'prompts', 'review.md'), '---\nargument-hint: <file>\n---\nProject $1');
    const resources = await loadCodingResources({ cwd, agentDir, projectTrusted: true, packagePaths: [packageDir] });
    expect(resources.skills.map(value => value.name)).toContain('sample');
    expect(expandCodingTemplate('/review "two files"', resources.prompts)).toBe('Project two files');
    expect(resources.prompts[0]?.argumentHint).toBe('<file>');
    expect(resources.extensions).toContain(join(packageDir, 'extensions', 'danger.ts'));
    expect(resources.skills.find(value => value.name === 'sample')?.sourceInfo.origin).toBe('package');
    expect(resources.prompts.filter(value => value.name === 'review')).toHaveLength(1);
    expect(resources.diagnostics.find(value => value.collision?.resourceType === 'prompt')?.collision).toEqual({
      resourceType: 'prompt', name: 'review',
      winnerPath: join(cwd, '.pi', 'prompts', 'review.md'),
      loserPath: join(packageDir, 'prompts', 'review.md'),
    });
    expect(resources.extensionSources?.get(join(packageDir, 'extensions', 'danger.ts'))?.origin).toBe('package');
  });

  test('does not load untrusted project resources or fetch a missing git package', async () => {
    using cleanup = new DisposableStack();
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('Unexpected package subprocess'); });
    cleanup.defer(() => spawn.mockRestore());
    put(join(cwd, '.pi', 'extensions', 'blocked.ts'), 'throw new Error("UNTRUSTED");');
    put(join(cwd, '.pi', 'SYSTEM.md'), 'untrusted prompt');
    const resources = await loadCodingResources({
      cwd, agentDir, projectTrusted: false,
      projectSettings: { packages: ['git:https://invalid.example/owner/never-connect'] },
      packagePaths: ['git:https://invalid.example/owner/also-never-connect'],
    });
    expect(resources.extensions).toEqual([]);
    expect(resources.systemPrompt).toBeUndefined();
    expect(existsSync(join(agentDir, 'git'))).toBe(false);
    expect(existsSync(join(cwd, '.pi', 'git'))).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('keeps HOME skills discovery in the legacy resource entry', () => {
    const home = join(root, 'home');
    skill(join(home, '.agents', 'skills', 'home-skill', 'SKILL.md'), 'home-skill');
    const code = `
      import { loadCodingResources } from ${JSON.stringify(join(import.meta.dir, 'resources.ts'))};
      const resources = await loadCodingResources(${JSON.stringify({ cwd, agentDir })});
      console.log(JSON.stringify(resources.skills.map(item => item.name)));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, stdout: 'pipe', stderr: 'pipe',
    });
    expect({ code: child.exitCode, error: child.stderr.toString() }).toEqual({ code: 0, error: '' });
    expect(JSON.parse(child.stdout.toString())).toEqual(['home-skill']);
  });

  test('reports package failures while keeping deliberate skips silent', async () => {
    using cleanup = new DisposableStack();
    const manager = spyOn(DefaultPackageManager.prototype, 'resolve').mockResolvedValue({
      skills: [], prompts: [], extensions: [], themes: [],
      installFailures: [
        { source: 'skipped-package', scope: 'user', skipped: true, message: 'Deliberately skipped' },
        { source: 'failed-package', scope: 'user', message: 'Package resolution failed' },
      ],
    });
    cleanup.defer(() => manager.mockRestore());
    const resources = await loadCodingResources({ cwd, agentDir });
    expect(resources.diagnostics).toEqual([
      { type: 'warning', path: 'failed-package', message: 'Package resolution failed' },
    ]);
    expect(manager).toHaveBeenCalledTimes(1);
  });

  test('preserves global, ancestor, cwd and override precedence', () => {
    put(join(agentDir, 'AGENTS.md'), 'global');
    put(join(root, 'AGENTS.md'), 'ancestor');
    put(join(cwd, 'AGENTS.md'), 'shadowed');
    put(join(cwd, 'AGENTS.override.md'), '\uFEFFoverride');
    const files = loadProjectContextFiles({ cwd, agentDir }).filter(file => file.path.startsWith(root));
    expect(files.map(file => file.content)).toEqual(['global', 'ancestor', 'override']);
  });

  test('does not inherit the main checkout context twice inside a linked worktree', () => {
    const worktree = join(cwd, 'worktrees', 'feature');
    const metadata = join(cwd, '.git', 'worktrees', 'feature');
    put(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    put(join(metadata, 'HEAD'), 'ref: refs/heads/feature\n');
    put(join(metadata, 'commondir'), '../..\n');
    put(join(worktree, '.git'), `gitdir: ${realpathSync(metadata)}\n`);
    put(join(cwd, 'AGENTS.md'), 'main context');
    put(join(worktree, 'AGENTS.md'), 'worktree context');
    const files = loadProjectContextFiles({ cwd: worktree, agentDir });
    expect(files.some(file => file.content === 'main context')).toBe(false);
    expect(files.some(file => file.content === 'worktree context')).toBe(true);
  });

  test('expands the actual skill file and keeps unknown commands unchanged', async () => {
    const skillPath = join(agentDir, 'skills', 'sample', 'SKILL.md');
    skill(skillPath, 'sample');
    const resources = await loadCodingResources({ cwd, agentDir });
    const errors: unknown[] = [];
    const expanded = expandCodingSkill('/skill:sample run checks', resources, error => errors.push(error));
    expect(expanded).toContain('Instructions for sample.');
    expect(expanded).toContain(`References are relative to ${dirname(skillPath)}.`);
    expect(expanded).toEndWith('run checks');
    expect(expandCodingSkill('/skill:missing', resources, error => errors.push(error))).toBe('/skill:missing');
    rmSync(skillPath);
    expect(expandCodingSkill('/skill:sample', resources, error => errors.push(error))).toBe('/skill:sample');
    expect(errors).toHaveLength(1);
  });
});
