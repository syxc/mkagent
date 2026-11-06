import { raceWithAbortSignal as race } from "@earendil-works/pi-ai/utils/abort";
export { operationSignal } from "@earendil-works/pi-ai/utils/abort";

/** Retain the coding API's optional signal over the public shared implementation. */
export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	return signal ? race(operation, signal) : operation;
}
