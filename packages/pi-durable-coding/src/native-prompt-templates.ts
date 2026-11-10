/** Bind SDK prompt discovery to the Native installation's project directory. */
import { loadPromptTemplates as loadSDKPromptTemplates, type LoadPromptTemplatesOptions, type LoadPromptTemplatesResult } from '@earendil-works/pi-coding-agent';
import { CONFIG_DIR_NAME } from './pi/config.ts';

export { parseCommandArgs, substituteArgs, expandPromptTemplate, type PromptTemplate, type LoadPromptTemplatesOptions, type LoadPromptTemplatesResult } from '@earendil-works/pi-coding-agent';

export function loadPromptTemplates(options: LoadPromptTemplatesOptions, projectConfigDir = CONFIG_DIR_NAME): LoadPromptTemplatesResult {
  return loadSDKPromptTemplates(options, projectConfigDir);
}
