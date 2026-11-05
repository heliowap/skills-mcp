import { DecisionAuthError, DecisionTimeoutError } from "./errors";

export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** Delay before the second attempt; doubles after each failed attempt. */
  baseDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 250 };

export interface RunOptions {
  /** Budget for the whole call, retries and backoff included. */
  timeoutMs: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
  policy?: Partial<RetryPolicy>;
}

/**
 * Runs `attempt` under one deadline. Retries the statuses in RETRYABLE_STATUSES
 * with exponential backoff, up to `maxAttempts`. Maps HTTP 401/403 to
 * DecisionAuthError without retrying. Enforces the deadline even when `attempt`
 * ignores its signal.
 */
export async function runWithRetry<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  { timeoutMs, signal, policy }: RunOptions,
): Promise<T> {
  const { maxAttempts, baseDelayMs } = { ...DEFAULT_RETRY_POLICY, ...policy };
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const abortReason = (): unknown => (timedOut ? new DecisionTimeoutError(timeoutMs) : combined.reason);

  try {
    for (let n = 1; ; n++) {
      try {
        return await raceAbort(
          (async () => attempt(combined))(),
          combined,
          abortReason,
        );
      } catch (error) {
        if (combined.aborted) throw abortReason();
        const status = statusOf(error);
        if (status === 401 || status === 403) throw new DecisionAuthError(status);
        if (!isRetryable(status) || n >= maxAttempts) throw error;
        await sleep(baseDelayMs * 2 ** (n - 1), combined);
        if (combined.aborted) throw abortReason();
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

/** Rate limit, Anthropic overload, and the gateway and availability errors. Other 5xx (500, 501) fail at once. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504, 529]);

function isRetryable(status: number | undefined): boolean {
  return status !== undefined && RETRYABLE_STATUSES.has(status);
}

/** Rejects as soon as `signal` aborts, even if `promise` never settles. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, reason: () => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
