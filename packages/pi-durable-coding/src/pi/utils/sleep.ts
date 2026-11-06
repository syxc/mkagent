import { sleep as sharedSleep } from "@earendil-works/pi-ai/utils/sleep";

/** Keep the coding API's optional signal and cancellation error over the shared timer. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return sharedSleep(ms, signal ?? new AbortController().signal).catch((error: unknown) => {
		if (signal?.aborted && Object.is(error, signal.reason)) throw new Error("Aborted");
		throw error;
	});
}
