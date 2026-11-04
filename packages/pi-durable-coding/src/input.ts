/** The native template implementation is shared by every input entry point. */
import { readFileSync } from 'node:fs';
import type { CodingResources } from './resources.ts';
import { stripFrontmatter } from './upstream/utils/frontmatter.ts';

export { parseCommandArgs, substituteArgs, expandPromptTemplate as expandCodingTemplate } from './upstream/core/prompt-templates.ts';

/** Ported from AgentSession._expandSkillCommand, Pi v1.5.0, MIT. */
export function expandCodingSkill(
  text: string, resources: CodingResources,
  onError: (error: { extensionPath: string; event: string; error: string }) => void,
): string {
  if (!text.startsWith('/skill:')) return text;
  const spaceIndex = text.indexOf(' ');
  const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();
  const skill = resources.skills.find(candidate => candidate.name === skillName);
  if (!skill) return text;
  try {
    const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8')).trim();
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return args ? `${skillBlock}\n\n${args}` : skillBlock;
  } catch (error) {
    onError({ extensionPath: skill.filePath, event: 'skill_expansion', error: error instanceof Error ? error.message : String(error) });
    return text;
  }
}
