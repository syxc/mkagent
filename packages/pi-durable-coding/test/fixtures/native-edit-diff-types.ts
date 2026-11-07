import { applyEditsToNormalizedContent, fuzzyFindText } from '../../src/pi/core/tools/edit-diff.ts';

declare module '../../src/pi/core/tools/edit-diff.ts' {
  interface FuzzyMatchResult { fixtureMatchMetadata?: string; }
  interface AppliedEditsResult { fixtureEditMetadata?: string; }
}

export const matchMetadata: string | undefined = fuzzyFindText('a', 'a').fixtureMatchMetadata;
export const editMetadata: string | undefined =
  applyEditsToNormalizedContent('a', [{ oldText: 'a', newText: 'b' }], 'fixture.txt').fixtureEditMetadata;
