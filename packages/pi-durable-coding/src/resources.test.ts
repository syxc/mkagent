import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverCodingSkills, formatSkillsForPrompt, loadCodingResources, loadProjectContextFiles } from './resources.ts';
import { expandCodingSkill, expandCodingTemplate, parseCommandArgs, substituteArgs } from './input.ts';

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
    put(join(cwd, '.pi', 'extensions', 'blocked.ts'), 'throw new Error("UNTRUSTED");');
    put(join(cwd, '.pi', 'SYSTEM.md'), 'untrusted prompt');
    const resources = await loadCodingResources({
      cwd, agentDir, projectTrusted: false,
      projectSettings: { packages: ['git:https://invalid.example/never-connect'] },
      packagePaths: ['git:https://invalid.example/also-never-connect'],
    });
    expect(resources.extensions).toEqual([]);
    expect(resources.systemPrompt).toBeUndefined();
    expect(existsSync(join(agentDir, 'git'))).toBe(false);
    expect(existsSync(join(cwd, '.pi', 'git'))).toBe(false);
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
