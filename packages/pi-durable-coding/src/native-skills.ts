/** Bind SDK discovery to the Native installation's directory and agent defaults. */
import { loadSkills as loadSDKSkills, type LoadSkillsOptions, type LoadSkillsResult } from '@earendil-works/pi-coding-agent';
import { CONFIG_DIR_NAME, getAgentDir } from './pi/config.ts';

export { formatSkillsForPrompt, loadSkillsFromDir, type SkillFrontmatter, type Skill, type LoadSkillsResult, type LoadSkillsFromDirOptions, type LoadSkillsOptions } from '@earendil-works/pi-coding-agent';

export function loadSkills(options: LoadSkillsOptions, projectConfigDir = CONFIG_DIR_NAME): LoadSkillsResult {
  const { agentDir, skillPaths, includeDefaults, cwd } = options;
  return loadSDKSkills({ agentDir: agentDir ?? getAgentDir(), skillPaths, includeDefaults, cwd }, projectConfigDir);
}
