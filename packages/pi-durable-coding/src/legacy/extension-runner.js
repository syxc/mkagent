// Use the SDK runner with the headless UI and host documentation prompt.
export { emitSessionShutdownEvent, emitProjectTrustEvent } from "@earendil-works/pi-coding-agent";
import { ExtensionRunner as SDKRunner } from "@earendil-works/pi-coding-agent";
import { theme } from "../headless-ui.ts";
import { buildSystemPrompt } from "../upstream/core/system-prompt.ts";

/** @typedef {import("@earendil-works/pi-coding-agent").BeforeAgentStartTrigger} BeforeAgentStartTrigger */
/** @typedef {import("@earendil-works/pi-coding-agent").ExtensionErrorListener} ExtensionErrorListener */
/** @typedef {import("@earendil-works/pi-coding-agent").NewSessionHandler} NewSessionHandler */
/** @typedef {import("@earendil-works/pi-coding-agent").ForkHandler} ForkHandler */
/** @typedef {import("@earendil-works/pi-coding-agent").NavigateTreeHandler} NavigateTreeHandler */
/** @typedef {import("@earendil-works/pi-coding-agent").SwitchSessionHandler} SwitchSessionHandler */
/** @typedef {import("@earendil-works/pi-coding-agent").ReloadHandler} ReloadHandler */
/** @typedef {import("@earendil-works/pi-coding-agent").ShutdownHandler} ShutdownHandler */

// Keep the existing untyped JavaScript API at the host/plugin boundary.
/** @type {import("./api-types.ts").LegacyConstructor<import("@earendil-works/pi-coding-agent").ExtensionRunner>} */
const NativeExtensionRunner = SDKRunner;

export class ExtensionRunner extends NativeExtensionRunner {
    constructor(extensions, runtime, cwd, sessionManager, modelRegistry) {
        super(extensions, runtime, cwd, sessionManager, modelRegistry, {
            getTheme: () => theme,
            buildSystemPrompt,
        });
    }
}
