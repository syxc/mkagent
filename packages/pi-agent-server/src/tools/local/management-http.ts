/**
 * Ported 1:1 from @earendil-works/pi-coding-agent 1.1.0
 * `utils/management-http.js`.
 *
 * Transport-level retry helper for idempotent management requests (version
 * checks and binary downloads). It must not be used for agent/model requests:
 * those can fail after the HTTP request starts and are retried by their
 * semantic caller instead.
 *
 * Caller cancellation and `timeoutMs` are terminal. `attemptTimeoutMs` aborts
 * only the current attempt so a hung connection can be retried.
 */

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchWithRetryOptions {
  maxRetries?: number;
  retryOnStatus?: boolean;
  timeoutMs?: number;
  attemptTimeoutMs?: number;
  /** Injectable for tests; production uses the global fetch. */
  fetch?: typeof fetch;
}

export async function fetchWithRetry(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined = undefined,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxRetries =
    options.maxRetries === undefined || !Number.isFinite(options.maxRetries)
      ? 2
      : Math.max(0, Math.floor(options.maxRetries));
  const retryOnStatus = options.retryOnStatus ?? true;
  const parentSignal = init?.signal ?? undefined;
  const timeoutSignal =
    options.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const attemptTimeoutMs =
    options.attemptTimeoutMs !== undefined && options.attemptTimeoutMs > 0 ? options.attemptTimeoutMs : undefined;

  for (let attempt = 0; ; attempt++) {
    parentSignal?.throwIfAborted();
    timeoutSignal?.throwIfAborted();

    const attemptTimeoutSignal = attemptTimeoutMs ? AbortSignal.timeout(attemptTimeoutMs) : undefined;
    const signals = [parentSignal, timeoutSignal, attemptTimeoutSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    try {
      const response = await fetchImpl(input, signal ? { ...init, signal } : init);
      const shouldRetry = retryOnStatus && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries;
      if (!shouldRetry) return response;
      try {
        await response.body?.cancel();
      } catch {
        // The response is being discarded before a retry. There is nothing
        // useful to do if cancelling its body also fails.
      }
    } catch (error) {
      const attemptTimedOut =
        attemptTimeoutSignal?.aborted === true && !parentSignal?.aborted && !timeoutSignal?.aborted;
      if (
        parentSignal?.aborted ||
        timeoutSignal?.aborted ||
        (error instanceof Error && error.name === 'AbortError' && !attemptTimedOut && timeoutSignal === undefined) ||
        attempt >= maxRetries
      ) {
        throw error;
      }
    }
  }
}
