/** Bind SDK prompt construction to the Native installation's documentation. */
import { createSystemPromptBuilder } from '@earendil-works/pi-coding-agent';
import { getDocsPath, getExamplesPath, getReadmePath } from './pi/config.ts';

export { normalizeBuildSystemPromptOptions, diffSystemPromptSections, type BuildSystemPromptOptions, type NormalizedBuildSystemPromptOptions, type SystemPromptSections } from '@earendil-works/pi-coding-agent';
export const { buildSystemPrompt, buildSystemPromptSections, buildSystemPromptState }: ReturnType<typeof createSystemPromptBuilder> = createSystemPromptBuilder({ getDocsPath, getExamplesPath, getReadmePath });
