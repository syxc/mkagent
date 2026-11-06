// Shared native facade; retain the legacy duck-typed runtime constructor.
import * as native from "../pi/core/model-registry.ts";

// Keep the legacy facade structural for host runtimes and plugin consumers.
/** @type {import("./api-types.ts").LegacyConstructor<import("../pi/core/model-registry.ts").ModelRegistry>} */
const NativeModelRegistry = native.ModelRegistry;

export class ModelRegistry extends NativeModelRegistry {
    constructor(runtime) {
        super(runtime);
    }
}
