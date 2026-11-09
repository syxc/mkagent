// Shared native facade; retain the legacy duck-typed runtime constructor.
import * as native from "@earendil-works/pi-coding-agent";

// Keep the legacy facade structural for host runtimes and plugin consumers.
/** @type {import("./api-types.ts").LegacyConstructor<import("@earendil-works/pi-coding-agent").ModelRegistry>} */
const NativeModelRegistry = native.ModelRegistry;

export class ModelRegistry extends NativeModelRegistry {
    constructor(runtime) {
        super(runtime);
    }
}
