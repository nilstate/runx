export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export interface FetchWithTimeoutOptions {
  readonly fetchImpl?: typeof fetch;
  readonly url: string;
  readonly init?: RequestInit;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly description: string;
}

/**
 * Wraps a fetch call with a timeout and an upstream AbortSignal. Aborts the
 * request when either the upstream signal fires or `timeoutMs` elapses.
 * Defaults to `DEFAULT_HTTP_TIMEOUT_MS`; pass `0` to disable the timer.
 */
export async function fetchWithTimeout(options: FetchWithTimeoutOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available. Use Node.js 20+ or inject fetchImpl.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  const onUpstreamAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", onUpstreamAbort, { once: true });
    }
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`${options.description} timed out after ${timeoutMs}ms.`)), timeoutMs)
    : undefined;
  try {
    return await fetchImpl(options.url, { ...options.init, signal: controller.signal });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener("abort", onUpstreamAbort);
  }
}
