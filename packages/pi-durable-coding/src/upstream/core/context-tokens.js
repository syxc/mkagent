// Ported from Pi v1.5.0 (f9a26365568127461c47a07a37dcb42c140a3ac5); MIT. See UPSTREAM.json and LICENSE.pi.
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
// ============================================================================
// Token calculation
// ============================================================================
/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage) {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 */
function getAssistantUsage(msg) {
    if (msg.role === "assistant" && "usage" in msg) {
        const assistantMsg = msg;
        if (assistantMsg.stopReason !== "aborted" &&
            assistantMsg.stopReason !== "error" &&
            assistantMsg.usage &&
            calculateContextTokens(assistantMsg.usage) > 0) {
            return assistantMsg.usage;
        }
    }
    return undefined;
}
function getLastAssistantUsageInfo(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const usage = getAssistantUsage(messages[i]);
        if (usage)
            return { usage, index: i };
    }
    return undefined;
}
/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages) {
    const usageInfo = getLastAssistantUsageInfo(messages);
    if (!usageInfo) {
        let estimated = 0;
        for (const message of messages) {
            estimated += estimateTokens(message);
        }
        return {
            tokens: estimated,
            usageTokens: 0,
            trailingTokens: estimated,
            lastUsageIndex: null,
        };
    }
    const usageTokens = calculateContextTokens(usageInfo.usage);
    let trailingTokens = 0;
    for (let i = usageInfo.index + 1; i < messages.length; i++) {
        trailingTokens += estimateTokens(messages[i]);
    }
    return {
        tokens: usageTokens + trailingTokens,
        usageTokens,
        trailingTokens,
        lastUsageIndex: usageInfo.index,
    };
}
/** Estimate projected context without trusting usage captured before a later edit or compaction. */
export function estimateProjectedContextTokens(projection, branchEntries) {
    const estimate = estimateContextTokens(projection.messages);
    if (estimate.lastUsageIndex !== null) {
        let projectedMessageIndex = 0;
        let usageEntryId;
        for (const entry of projection.entries) {
            const nextMessageIndex = projectedMessageIndex + entry.messages.length;
            if (estimate.lastUsageIndex < nextMessageIndex) {
                usageEntryId = entry.sourceEntry.id;
                break;
            }
            projectedMessageIndex = nextMessageIndex;
        }
        const usageEntryIndex = usageEntryId ? branchEntries.findIndex((entry) => entry.id === usageEntryId) : -1;
        let latestInvalidatingEntryIndex = -1;
        for (let i = branchEntries.length - 1; i >= 0; i--) {
            const entry = branchEntries[i];
            if (entry.type === "context_edit" || entry.type === "compaction") {
                latestInvalidatingEntryIndex = i;
                break;
            }
        }
        if (usageEntryIndex > latestInvalidatingEntryIndex)
            return estimate;
    }
    const currentSystem = getCurrentSystemMessage(projection.messages);
    let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
    for (const message of projection.messages) {
        if (message.role !== "system")
            tokens += estimateTokens(message);
    }
    return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}
// ============================================================================
// Cut point detection
// ============================================================================
const ESTIMATED_IMAGE_CHARS = 4800;
function estimateTextAndImageContentChars(content) {
    if (typeof content === "string") {
        return content.length;
    }
    let chars = 0;
    for (const block of content) {
        if (block.type === "text" && block.text) {
            chars += block.text.length;
        }
        else if (block.type === "image") {
            chars += ESTIMATED_IMAGE_CHARS;
        }
    }
    return chars;
}
/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message) {
    let chars = 0;
    switch (message.role) {
        case "system": {
            const system = message;
            chars = estimateTextAndImageContentChars(system.content);
            if (system.sections) {
                for (const section of Object.values(system.sections)) {
                    if (section)
                        chars += section.length;
                }
            }
            if (system.toolsAdded)
                chars += JSON.stringify(system.toolsAdded).length;
            return Math.ceil(chars / 4);
        }
        case "user": {
            chars = estimateTextAndImageContentChars(message.content);
            return Math.ceil(chars / 4);
        }
        case "assistant": {
            const assistant = message;
            for (const block of assistant.content) {
                if (block.type === "text") {
                    chars += block.text.length;
                }
                else if (block.type === "thinking") {
                    chars += block.thinking.length;
                }
                else if (block.type === "toolCall") {
                    chars += block.name.length + JSON.stringify(block.arguments).length;
                }
            }
            return Math.ceil(chars / 4);
        }
        case "custom":
        case "toolResult": {
            chars = estimateTextAndImageContentChars(message.content);
            return Math.ceil(chars / 4);
        }
        case "bashExecution": {
            chars = message.command.length + message.output.length;
            return Math.ceil(chars / 4);
        }
        case "branchSummary":
        case "compactionSummary": {
            chars = message.summary.length;
            return Math.ceil(chars / 4);
        }
    }
    return 0;
}
