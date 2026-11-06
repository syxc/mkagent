// Shared native runner; retain the headless UI and host documentation prompt.
export * from "../pi/core/extensions/runner.ts";
import * as shared from "../pi/core/extensions/runner.ts";
import { theme } from "../headless-ui.ts";
import { buildSystemPrompt } from "../upstream/core/system-prompt.ts";

// Keep the existing untyped JavaScript API at the host/plugin boundary.
/** @type {import("./api-types.ts").LegacyConstructor<import("../pi/core/extensions/runner.ts").ExtensionRunner>} */
const NativeExtensionRunner = shared.ExtensionRunner;

export class ExtensionRunner extends NativeExtensionRunner {
    constructor(extensions, runtime, cwd, sessionManager, modelRegistry) {
        super(extensions, runtime, cwd, sessionManager, modelRegistry, {
            getTheme: () => theme,
            buildSystemPrompt,
        });
    }
}
