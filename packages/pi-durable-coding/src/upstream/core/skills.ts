// Shared native implementation; keep legacy imports without another source copy.
export * from "../../pi/core/skills.ts";
import { loadSkills as loadNativeSkills, type LoadSkillsOptions } from "../../pi/core/skills.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";

export function loadSkills(options: LoadSkillsOptions) {
  return loadNativeSkills({ ...options, agentDir: options.agentDir ?? getAgentDir() }, CONFIG_DIR_NAME);
}
