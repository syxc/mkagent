// Ported from Pi v1.5.0 (f9a26365568127461c47a07a37dcb42c140a3ac5); MIT. See UPSTREAM.json and LICENSE.pi.
import { SystemEntry } from "@earendil-works/pi-durable";
export { findBaseline, leadWithSystem, contribute };
const EXCLUDED_STOP_REASONS = new Set(["aborted", "error", "deferred"]);
const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed.";
/**
 * The baseline among `entries`, oldest first: the system message of the first `pi.system` entry after the head
 * marker, or of the transcript without one, when generation wrote it with every section and tool in effect. After a
 * head marker it always does, and omits the retained `pi.system` entries. Without one it does when it saw no system
 * message before, which holds unless an earlier entry carries one, even if an edit omits it later. An edit that targets
 * the baseline contributes other messages, or none, so none leads; a later entry does not take its place.
 */
function findBaseline(head, entries) {
    for (const entry of entries) {
        if (head !== undefined && entry.id <= head.id)
            continue;
        if (SystemEntry.is(entry))
            return entry.model?.find((message) => message.role === "system") ?? null;
        if (head === undefined && carriesSystemMessage(entry))
            return null;
    }
    return undefined;
}
/** Whether an entry's own messages, or the replacement messages of its edits, include a system message. */
function carriesSystemMessage(entry) {
    const isSystem = (message) => message.role === "system";
    return ((entry.model?.some(isSystem) ?? false) ||
        (entry.edits?.some((edit) => edit.action === "replace" && edit.messages.some(isSystem)) ?? false));
}
/**
 * Move the first system message to the front when only user messages precede it, or when it is the baseline's. A run's
 * input is committed before generation renders the system prompt, so a transcript starts with the input followed by
 * the baseline, and the range after a compaction with the kept history, assistant messages included. Providers treat
 * only a leading system message as the initial prompt and tool set; without it, a later tool change rewrites the
 * request's tool list and invalidates the whole prompt cache. Only the first system message moves, so replaying
 * system messages in order gives the same sections and tools. Any other system message, before an assistant message,
 * stays where it was committed: moving it would change what it means to the model.
 */
function leadWithSystem(messages, baseline) {
    const index = messages.findIndex((message) => message.role === "system");
    if (index <= 0)
        return messages;
    const system = messages[index];
    if (system !== baseline && messages.slice(0, index).some((message) => message.role !== "user")) {
        return messages;
    }
    return [system, ...messages.slice(0, index), ...messages.slice(index + 1)];
}
/** One active entry's model messages after its edit and excluded stop reasons, before tool result ordering. */
function contribute(entry, edit) {
    if (edit?.action === "omit")
        return Object.freeze([]);
    const contributed = edit?.action === "replace" ? edit.messages : (entry.model ?? []);
    return Object.freeze(contributed.filter((message) => message.role !== "assistant" || !EXCLUDED_STOP_REASONS.has(message.stopReason)));
}
/** Objects `freezeJson()` froze with everything in them. `Object.isFrozen()` holds for shallow freezes too. */
const deeplyFrozen = new WeakSet();
/** Freeze a JSON value and everything in it. */
function freezeJson(value) {
    if (value === null || typeof value !== "object" || deeplyFrozen.has(value))
        return value;
    for (const child of Object.values(value))
        freezeJson(child);
    Object.freeze(value);
    deeplyFrozen.add(value);
    return value;
}
/**
 * Place each assistant's tool results directly after it in call order. Results are taken from the messages before
 * the next assistant; a missing result is synthesized and unmatched results are dropped.
 */
export function orderToolResults(messages) {
    const ordered = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role === "toolResult")
            continue;
        ordered.push(message);
        if (message.role !== "assistant")
            continue;
        const calls = message.content.filter((content) => content.type === "toolCall");
        if (calls.length === 0)
            continue;
        const results = new Map();
        for (let next = index + 1; next < messages.length && messages[next].role !== "assistant"; next++) {
            const candidate = messages[next];
            if (candidate.role === "toolResult" && !results.has(candidate.toolCallId)) {
                results.set(candidate.toolCallId, next);
            }
        }
        for (const call of calls) {
            const resultIndex = results.get(call.id);
            ordered.push(resultIndex === undefined ? missingResult(call, message.timestamp) : messages[resultIndex]);
        }
    }
    return ordered;
}
function missingResult(call, timestamp) {
    return freezeJson({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: MISSING_RESULT_TEXT }],
        isError: true,
        details: { reason: "missing_result" },
        timestamp,
    });
}
