// Shared estimators; keep the legacy untyped inputs at the compatibility boundary.
import * as native from "../pi/core/compaction/compaction.ts";

export function calculateContextTokens(usage) {
    return native.calculateContextTokens(usage);
}

export function estimateContextTokens(messages) {
    return native.estimateContextTokens(messages);
}

export function estimateProjectedContextTokens(projection, branchEntries) {
    return native.estimateProjectedContextTokens(projection, branchEntries);
}

export function estimateTokens(message) {
    return native.estimateTokens(message);
}
