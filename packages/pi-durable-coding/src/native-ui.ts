/** Use the SDK UI and retain only the shared image asset binding. */
import { ToolExecutionComponent as SDKToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { ensurePngTranscoder } from './pi/utils/image-convert.ts';

export {
  ArminComponent, AssistantMessageComponent, BashExecutionComponent, BorderedLoader,
  BranchSummaryMessageComponent, CompactionSummaryMessageComponent, CustomEditor,
  CustomMessageComponent, renderDiff, DynamicBorder, ExtensionEditorComponent,
  ExtensionInputComponent, ExtensionSelectorComponent, FooterComponent,
  keyHint, keyText, rawKeyHint, LoginDialogComponent, ModelSelectorComponent,
  OAuthSelectorComponent, SessionSelectorComponent, SettingsSelectorComponent,
  ShowImagesSelectorComponent, SkillInvocationMessageComponent, ThemeSelectorComponent,
  ThinkingSelectorComponent, TreeSelectorComponent, UserMessageComponent,
  UserMessageSelectorComponent, truncateToVisualLines,
} from '@earendil-works/pi-coding-agent';
export type {
  CustomEditorOptions, RenderDiffOptions, SettingsCallbacks, SettingsConfig,
  ToolExecutionOptions, VisualTruncateResult,
} from '@earendil-works/pi-coding-agent';

export class ToolExecutionComponent extends SDKToolExecutionComponent {
  protected override _ensurePngTranscoder(onRegistered: () => void): void {
    ensurePngTranscoder(onRegistered);
  }
}
