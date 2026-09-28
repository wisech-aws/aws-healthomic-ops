/**
 * Shared retry-with-timeout helper for HealthOmics enrichment calls.
 *
 * Every enrichment call to the HealthOmics read APIs (`GetRun`, `ListRunTasks`,
 * `GetRunTask`, `GetWorkflow`) is wrapped by {@link callWithRetry} so the same
 * timeout and retry policy applies uniformly (design.md "Ingest Lambda Design"
 * step 2 "Enrich on demand"):
 *
 *   - a per-call timeout of {@link CALL_TIMEOUT_MS} (10s), and
 *   - up to {@link MAX_ATTEMPTS} (3) attempts before giving up.
 *
 * "Up to 3 retries" (task 5.1) / "retried up to 3 times" (design) is realized
 * here as 3 total attempts: an operation that fails on every attempt is invoked
 * three times. On persistent failure the helper does NOT throw; it returns a
 * failed {@link CallResult} so the caller can log the failed operation and the
 * affected identifier and fall back to event-only fields with the unretrieved
 * fields left unset (Req 2.5, 2.6). Timeouts count as failures and are retried
 * like any other error (Req 2.5).
 */

import { omicsRateLimiter } from './rateLimiter.js';

/** Per-call timeout budget in milliseconds (Req 2.5). */
export const CALL_TIMEOUT_MS = 10_000;

/**
 * Maximum number of attempts for a single operation before falling back
 * (Req 2.6). Three total attempts = the initial call plus up to two retries,
 * matching the "retried up to 3 times" budget in design.md.
 */
export const MAX_ATTEMPTS = 3;

/** Base backoff delay (ms) before the first retry; doubles each attempt. */
export const BASE_RETRY_DELAY_MS = 250;

/** Cap on the per-retry backoff delay (ms). */
export const MAX_RETRY_DELAY_MS = 5_000;

/**
 * The outcome of a retried, time-boxed enrichment call.
 *
 * On success, `ok` is `true` and `value` carries the operation's result. On
 * persistent failure (every attempt errored or timed out), `ok` is `false` and
 * `error` carries the last underlying failure; callers treat this as "leave the
 * unretrieved fields unset" rather than propagating an exception (Req 2.5).
 */
export type CallResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * Error used to reject a call that exceeds {@link CALL_TIMEOUT_MS}. Kept
 * distinct so logs can tell a timeout apart from an API-returned error, though
 * both are handled identically (retry, then fall back) per Req 2.5.
 */
export class CallTimeoutError extends Error {
  constructor(
    /** The logical operation name, e.g. `GetRun`. */
    public readonly operation: string,
    /** The affected run/task/workflow identifier. */
    public readonly identifier: string,
    public readonly timeoutMs: number,
  ) {
    super(`${operation}(${identifier}) did not respond within ${timeoutMs}ms`);
    this.name = 'CallTimeoutError';
  }
}

/**
 * Options controlling {@link callWithRetry}. Exposed primarily so tests can
 * shrink the timeout and attempt counts; production callers use the defaults.
 */
export interface RetryOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  /** Base backoff delay (ms). Defaults to {@link BASE_RETRY_DELAY_MS}. */
  baseDelayMs?: number;
  /** Max backoff delay (ms). Defaults to {@link MAX_RETRY_DELAY_MS}. */
  maxDelayMs?: number;
  /**
   * Sleep function used between retries; injectable so tests don't actually
   * wait. Defaults to a real timer-based sleep.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional sink for the per-attempt / final-failure log lines. Defaults to
   * `console.warn`. Injected in tests to assert the failed operation and
   * identifier are logged (Req 2.5).
   */
  logger?: (message: string, error?: unknown) => void;
  /**
   * Optional rate limiter awaited before EACH attempt so all enrichment calls
   * are paced within the HealthOmics API budget (~10 TPS). Defaults to the
   * process-global {@link omicsRateLimiter}; pass a no-op/custom limiter in
   * tests. Awaiting before every attempt (not just the first) ensures retries
   * also consume from the budget rather than bursting past it.
   */
  rateLimiter?: { acquire: () => Promise<void> };
}

/** Default real sleep. Unref'd not needed here since it always resolves. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with full jitter (ms) for a 0-based retry index.
 * delay = random(0, min(base * 2^index, cap)). Full jitter spreads retries so a
 * fleet of concurrent Lambda invocations doesn't retry in lockstep and deepen a
 * throttling storm.
 */
export function backoffWithJitter(
  retryIndex: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(baseMs * 2 ** retryIndex, capMs);
  return Math.floor(random() * exp);
}

/**
 * Race a promise-returning `fn` against a {@link CALL_TIMEOUT_MS} timeout.
 *
 * The timeout is a soft, caller-side bound: it rejects the returned promise so
 * the caller stops waiting, but it cannot cancel the in-flight SDK request
 * (the underlying HTTP call is separately bounded by the SDK's own request
 * timeout configured on the client). Rejecting here is sufficient to satisfy
 * "does not return a response within 10 seconds" (Req 2.5).
 */
function withTimeout<T>(
  fn: () => Promise<T>,
  operation: string,
  identifier: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new CallTimeoutError(operation, identifier, timeoutMs));
      }
    }, timeoutMs);
    // `unref` so a pending timer never keeps the Lambda process alive; guarded
    // because the browser/test environments return a number without `unref`.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }

    fn().then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      },
    );
  });
}

/**
 * Invoke `fn` with a per-call timeout, retrying on error/timeout up to
 * `maxAttempts` total attempts (Req 2.5, 2.6).
 *
 * Never throws: on persistent failure it logs the failed `operation` and the
 * affected `identifier` and returns `{ ok: false, error }` so the caller can
 * persist from event fields only and leave unretrieved fields unset (Req 2.5).
 *
 * @param operation  Logical operation name for logs, e.g. `GetRun`. Restricted
 *                   by callers to the four allowed read operations (Req 2.1).
 * @param identifier The affected run/task/workflow id, echoed into logs.
 * @param fn         The thunk performing the actual SDK call.
 */
export async function callWithRetry<T>(
  operation: string,
  identifier: string,
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<CallResult<T>> {
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? BASE_RETRY_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? MAX_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.logger ?? ((message, error) => console.warn(message, error));
  const rateLimiter = options.rateLimiter ?? omicsRateLimiter;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // Pace within the HealthOmics API budget before every attempt so a burst
      // of concurrent enrichments (e.g. a several-thousand-run batch) cannot
      // exceed ~10 TPS and self-inflict a throttling storm.
      await rateLimiter.acquire();
      const value = await withTimeout(fn, operation, identifier, timeoutMs);
      return { ok: true, value };
    } catch (err) {
      lastError = err;
      log(
        `enrichment: ${operation}(${identifier}) attempt ${attempt}/${maxAttempts} failed`,
        err,
      );
      // Back off before the next attempt (not after the final one) with
      // exponential + full-jitter delay. Immediate retries would amplify a
      // throttling storm; jitter de-syncs concurrent invocations.
      if (attempt < maxAttempts) {
        await sleep(backoffWithJitter(attempt - 1, baseDelayMs, maxDelayMs));
      }
    }
  }

  // Persistent failure after every attempt: log the failed operation and the
  // affected identifier once more, then hand control back to the caller which
  // will persist from event fields only (Req 2.5, 2.6).
  log(
    `enrichment: ${operation}(${identifier}) failed after ${maxAttempts} attempts; ` +
      `leaving enriched fields unset`,
    lastError,
  );
  return { ok: false, error: lastError };
}
