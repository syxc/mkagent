// Ported from Pi v1.5.0 (f9a26365568127461c47a07a37dcb42c140a3ac5); MIT. See UPSTREAM.json and LICENSE.pi.
import { estimateProjectedContextTokens } from "./context-tokens.js";
import { convertToLlm } from "./messages.js";
export function _applyBoundaryDrafts(manager, drafts) {
    const appended = [];
    for (const draft of drafts) {
        let entryId;
        switch (draft.type) {
            case "custom":
                entryId = manager.appendCustomEntry(draft.customType, draft.data);
                break;
            case "custom_message":
                entryId = manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
                break;
            case "context_edit":
                entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
                break;
            case "compaction": {
                const tokensBefore = estimateProjectedContextTokens(manager.buildSessionProjection(), manager.getBranch()).tokens;
                entryId = manager.appendCompaction(draft.summary, draft.firstKeptEntryId, tokensBefore, draft.details, true, draft.usage);
                break;
            }
        }
        const entry = manager.getEntry(entryId);
        if (entry)
            appended.push(entry);
    }
    return appended;
}
export function _buildBoundaryContext(drafts, boundary) {
    const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
    const pendingMessages = this._getPendingBoundaryMessages();
    const llmMessages = convertToLlm(projection.messages);
    const finalRole = llmMessages[llmMessages.length - 1]?.role;
    const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
    const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
    const pendingCustomContext = this._pendingCustomMessages.length > 0;
    return {
        contextEntries: projection.entries,
        contextMessages: projection.messages,
        llmMessages,
        pendingMessages,
        canContinue: contextCanContinue ||
            pendingCustomContext ||
            (boundary === "turn_end"
                ? this.agent.hasQueuedMessages()
                : finalRole === "assistant" && this.agent.hasQueuedMessages()),
    };
}
export function _replaceMessageInPlace(target, replacement) {
    // Agent-core stores the finalized message object in its state before emitting message_end.
    // SessionManager persistence happens later in _handleAgentEvent() with event.message.
    // Mutating this object in place keeps agent state, later turn/agent events, listeners,
    // and the eventual SessionManager.appendMessage(event.message) persistence in sync.
    if (target === replacement) {
        return;
    }
    const targetRecord = target;
    for (const key of Object.keys(targetRecord)) {
        delete targetRecord[key];
    }
    Object.assign(targetRecord, replacement);
}
