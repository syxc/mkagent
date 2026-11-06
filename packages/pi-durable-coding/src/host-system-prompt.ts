/** Keep legacy documentation URLs outside the native prompt implementation. */
import { getSystemMessageText } from '@earendil-works/pi-ai';
import {
  buildSystemPromptSections as nativeSections, type BuildSystemPromptOptions, type SystemPromptSections,
} from './pi/core/system-prompt.ts';
import {
  getDocsPath as nativeDocsPath, getExamplesPath as nativeExamplesPath, getReadmePath as nativeReadmePath,
} from './pi/config.ts';
import { getDocsPath, getExamplesPath, getReadmePath } from './upstream/config.ts';

export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
  const sections = nativeSections(input);
  if (sections.docs && !input.customPrompt && !input.sections?.docs) {
    for (const [nativePath, hostPath] of [
      [nativeReadmePath(), getReadmePath()], [nativeDocsPath(), getDocsPath()], [nativeExamplesPath(), getExamplesPath()],
    ]) {
      sections.docs = sections.docs.replaceAll(nativePath, hostPath);
    }
  }
  return sections;
}

export function buildSystemPromptState(input: BuildSystemPromptOptions): { content: string; sections?: SystemPromptSections } {
  if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
  return { content: '', sections: buildSystemPromptSections(input) };
}

export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
  return getSystemMessageText({ role: 'system', ...buildSystemPromptState(input), timestamp: 0 });
}
