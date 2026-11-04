// Ported from Pi v1.5.0 (f9a26365568127461c47a07a37dcb42c140a3ac5); MIT. See UPSTREAM.json and LICENSE.pi.
export { deepMergeSettings as mergeCodingSettings };
function isMergeableObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function deepMergeObjects(base, overrides) {
    const result = { ...base };
    for (const key of Object.keys(overrides)) {
        const overrideValue = overrides[key];
        if (overrideValue === undefined) {
            continue;
        }
        const baseValue = base[key];
        result[key] =
            isMergeableObject(baseValue) && isMergeableObject(overrideValue)
                ? deepMergeObjects(baseValue, overrideValue)
                : overrideValue;
    }
    return result;
}
/** Whether a tool selection entry is a `+name` or `-name` modifier. */
export function isToolModifier(entry) {
    return typeof entry === "string" && (entry.startsWith("+") || entry.startsWith("-"));
}
/**
 * Merge `defaultTools` of two settings layers. A list with plain tool names replaces the inherited
 * one; a list of only `+name`/`-name` entries is appended, so it modifies the inherited selection.
 */
function mergeDefaultTools(base, overrides) {
    if (overrides === undefined)
        return base;
    // Settings files are not validated; a malformed value replaces instead of throwing here.
    if (!Array.isArray(base) || !Array.isArray(overrides) || !overrides.every(isToolModifier))
        return overrides;
    return [...base, ...overrides];
}
/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base, overrides) {
    const merged = deepMergeObjects(base, overrides);
    const defaultTools = mergeDefaultTools(base.defaultTools, overrides.defaultTools);
    return defaultTools === undefined ? merged : { ...merged, defaultTools };
}
