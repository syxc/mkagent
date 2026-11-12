/** Host injection for the resource algorithms ported from Pi v1.5.0. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCodingPackages, type CodingPackageOptions } from './packages.ts';
import { loadProjectContextFiles, dedupePrompts, type LoadSkillsResult } from '@earendil-works/pi-coding-agent';
import { loadSkills, formatSkillsForPrompt, type Skill } from './upstream/core/skills.ts';
import { loadPromptTemplates, type PromptTemplate } from './upstream/core/prompt-templates.ts';
import { createSourceInfo, type SourceInfo } from '@earendil-works/pi-coding-agent';
import { canonicalizePath, isPathWithin, pathsEqual, stripBom } from '@earendil-works/pi-coding-agent';
import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type { ResolvedResource } from '@earendil-works/pi-coding-agent';

export { loadProjectContextFiles, formatSkillsForPrompt };
export { parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";
export type { PromptTemplate, ResourceDiagnostic };
export type CodingSkill = Skill;
export type CodingResourceOptions = CodingPackageOptions;

export interface CodingResources {
  skills: Skill[];
  prompts: PromptTemplate[];
  contextFiles: Array<{ path: string; content: string }>;
  extensions: string[];
  extensionSources?: Map<string, SourceInfo>;
  themes: ResolvedResource[];
  systemPrompt?: string;
  appendSystemPrompt: string[];
  diagnostics: ResourceDiagnostic[];
}

export function discoverCodingSkills(options: {
  cwd: string; agentDir: string; skillPaths?: string[]; includeDefaults?: boolean;
}): LoadSkillsResult {
  return loadSkills({ ...options, skillPaths: options.skillPaths ?? [], includeDefaults: options.includeDefaults ?? true });
}

export async function loadCodingResources(options: CodingResourceOptions): Promise<CodingResources> {
  const resolved = await resolveCodingPackages(options);
  const enabled = (resources: ResolvedResource[]) => resources.filter(resource => resource.enabled);
  const skills = loadSkills({ ...options, skillPaths: enabled(resolved.skills).map(resource => resource.path), includeDefaults: false });
  const prompts = loadPromptTemplates({ ...options, promptPaths: enabled(resolved.prompts).map(resource => resource.path), includeDefaults: false });
  const sources = [...resolved.skills, ...resolved.prompts, ...resolved.extensions];
  const sourceInfo = (path: string) => {
    const normalized = canonicalizePath(path);
    const source = sources.find(resource => pathsEqual(canonicalizePath(resource.path), normalized))
      ?? sources.find(resource => isPathWithin(canonicalizePath(resource.path), normalized));
    return source && createSourceInfo(path, source.metadata);
  };
  for (const resource of [...skills.skills, ...prompts.templates]) {
    const info = sourceInfo(resource.filePath);
    if (info) resource.sourceInfo = info;
  }
  const deduped = dedupePrompts(prompts.templates);
  const extensionSources = new Map<string, SourceInfo>();
  for (const resource of enabled(resolved.extensions)) {
    const info = sourceInfo(resource.path);
    if (info) extensionSources.set(resource.path, info);
  }
  const directories = [options.agentDir, ...(options.projectTrusted ? [join(options.cwd, '.pi')] : [])];
  const findPrompt = (name: string) => {
    for (const directory of [...directories].reverse()) {
      const path = join(directory, name);
      if (existsSync(path)) return stripBom(readFileSync(path, 'utf8'));
    }
    return undefined;
  };
  return {
    skills: skills.skills,
    prompts: deduped.prompts,
    contextFiles: loadProjectContextFiles(options),
    extensions: enabled(resolved.extensions).map(resource => resource.path),
    extensionSources,
    themes: enabled(resolved.themes),
    systemPrompt: findPrompt('SYSTEM.md'),
    appendSystemPrompt: [findPrompt('APPEND_SYSTEM.md')].filter((value): value is string => value !== undefined),
    diagnostics: [
      ...skills.diagnostics, ...prompts.diagnostics, ...deduped.diagnostics,
      ...(resolved.installFailures ?? []).map(failure => ({
        type: 'warning' as const, path: failure.source, message: failure.message,
      })),
    ],
  };
}

export function codingResourcePrompt(resources: CodingResources): string {
  return [
    ...resources.contextFiles.map(file => `## ${file.path}\n\n${file.content}`),
    resources.systemPrompt, ...resources.appendSystemPrompt, formatSkillsForPrompt(resources.skills),
  ].filter(Boolean).join('\n\n');
}
