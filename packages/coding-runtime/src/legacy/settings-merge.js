// Shared settings merge; retain the legacy open settings shape.
export { isToolModifier } from "@earendil-works/pi-coding-agent";
import { deepMergeSettings } from "@earendil-works/pi-coding-agent";

/** @returns {Record<string, any>} */
export function mergeCodingSettings(base, overrides) {
    return deepMergeSettings(base, overrides);
}
