// Shared package implementation; adapt only the legacy resource discovery contract.
export {
	getExtensionTempFolder,
	type ConfiguredPackage, type MissingSourceAction, type PackageInstallFailure,
	type PackageManager, type PackageResolutionPolicy, type PackageUpdate,
	type PathMetadata, type ProgressCallback, type ProgressEvent, type ResolvedPaths,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import {
	DefaultPackageManager as NativePackageManager,
	type MissingSourceAction,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "../upstream/config.ts";

export class DefaultPackageManager extends NativePackageManager {
	constructor(options: ConstructorParameters<typeof NativePackageManager>[0]) {
		super(options, CONFIG_DIR_NAME);
	}

	override async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>) {
		const result = await super.resolve(onMissing && (async (source) => {
			const offline = process.env.PI_OFFLINE?.toLowerCase();
			return offline === "1" || offline === "true" || offline === "yes"
				? "skip" : onMissing(source);
		}));
		return { ...result, installFailures: result.installFailures?.filter(failure => !failure.skipped) };
	}
}
