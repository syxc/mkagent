// Shared native implementation; preserve legacy projection metadata and object identity.
export * from "../pi/core/messages.ts";
import { convertToLlm as convertNativeToLlm } from "../pi/core/messages.ts";

/** @returns {any[]} */
export function convertToLlm(messages) {
    return convertNativeToLlm(messages, { preserveHostMetadata: true });
}
