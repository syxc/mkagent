// Shared native implementation; keep legacy imports without another source copy.
export * from "../../pi/core/prompt-templates.ts";
import { loadPromptTemplates as loadNativePromptTemplates, type LoadPromptTemplatesOptions } from "../../pi/core/prompt-templates.ts";
import { CONFIG_DIR_NAME } from "../config.ts";

export function loadPromptTemplates(options: LoadPromptTemplatesOptions) {
  return loadNativePromptTemplates(options, CONFIG_DIR_NAME);
}
