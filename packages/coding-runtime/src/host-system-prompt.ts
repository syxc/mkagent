/** Bind SDK prompt construction to the legacy documentation URLs. */
import { createSystemPromptBuilder } from '@earendil-works/pi-coding-agent';
import { getDocsPath, getExamplesPath, getReadmePath } from './upstream/config.ts';

export const { buildSystemPrompt, buildSystemPromptSections, buildSystemPromptState }: ReturnType<typeof createSystemPromptBuilder> = createSystemPromptBuilder({ getDocsPath, getExamplesPath, getReadmePath });
