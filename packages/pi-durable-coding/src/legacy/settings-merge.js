// Shared settings merge; retain the legacy open settings shape.
export { isToolModifier } from "../pi/core/settings-manager.ts";
import { deepMergeSettings } from "../pi/core/settings-manager.ts";

/** @returns {Record<string, any>} */
export function mergeCodingSettings(base, overrides) {
    return deepMergeSettings(base, overrides);
}
