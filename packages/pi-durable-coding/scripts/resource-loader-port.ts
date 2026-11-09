/** Explicit host resource policies over the pinned native loading algorithms. */
export function portResourceLoader(path: string, source: string): string {
  let body = source;
  const replace = (before: string, after: string, count = 1) => {
    if (body.split(before).length - 1 !== count) throw new Error(`Pinned resource port changed: ${path}: ${before}`);
    body = body.replaceAll(before, after);
  };

  if (path === 'core/skills.ts' || path === 'core/prompt-templates.ts') {
    const name = path === 'core/skills.ts' ? 'loadSkills' : 'loadPromptTemplates';
    const options = path === 'core/skills.ts' ? 'LoadSkillsOptions' : 'LoadPromptTemplatesOptions';
    const result = path === 'core/skills.ts' ? 'LoadSkillsResult' : 'LoadPromptTemplatesResult';
    replace(`export function ${name}(options: ${options}): ${result} {`,
      `export function ${name}(options: ${options}, projectConfigDir = CONFIG_DIR_NAME): ${result} {`);
    replace('resolve(resolvedCwd, CONFIG_DIR_NAME,', 'resolve(resolvedCwd, projectConfigDir,', path === 'core/skills.ts' ? 2 : 1);

  }
  return body;
}
