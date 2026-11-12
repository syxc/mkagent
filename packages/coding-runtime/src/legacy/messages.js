// Shared native implementation; preserve legacy projection metadata and object identity.
export * from "../native-messages.ts";
import { convertToLlm as convertSDKToLlm } from "@earendil-works/pi-coding-agent";

/** @returns {any[]} */
export function convertToLlm(messages) {
    return convertSDKToLlm(messages);
}
