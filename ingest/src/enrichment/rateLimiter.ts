/**
 * Token-bucket rate limiter for the HealthOmics read APIs.
 *
 * HealthOmics read operations (`GetRun`, `ListRunTasks`, `GetRunTask`,
 * `GetWorkflow`) share a low account request budget (~10 TPS). A batch of
 * several thousand runs produces a burst of thousands of task/run status-change
 * events, each of which enriches via one of these calls — which without pacing
 * self-inflicts a `ThrottlingException` storm and drops task timing/name
 * (leaving "bare" task records). This limiter paces every enrichment call so a
 * single Lambda instance never exceeds the configured rate; combined with a low
 * reserved concurrency on the ingest Lambda, it keeps the account-wide call
 * rate within the API budget.
 *
 * The limiter is a classic token bucket: it refills `ratePerSec` tokens per
 * second up to a small burst `capacity`, and `acquire()` waits until a token is
 * available. It is pure of I/O aside from a timer-based wait, and the wait
 * function is injectable so it is deterministically unit-testable.
 */

/** Default HealthOmics read-API budget: 10 transactions per second. */
export const OMICS_TPS = 10;

/** Injectable sleep so tests don't wait on real timers. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });

/**
 * A token-bucket rate limiter. `acquire()` resolves once a token is available,
 * pacing callers to at most `ratePerSec` sustained calls per second (with a
 * short burst up to `capacity`). Fair-ish: waiters are served in arrival order
 * because each computes its own next-available time from a shared cursor.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  /** The epoch-ms time at which the next token becomes available. */
  private nextAvailable = 0;

  constructor(
    ratePerSec: number = OMICS_TPS,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: Sleep = defaultSleep,
  ) {
    if (!(ratePerSec > 0)) {
      throw new Error('RateLimiter ratePerSec must be > 0');
    }
    this.intervalMs = 1000 / ratePerSec;
  }

  /**
   * Wait until a token is available, then consume it. Enforces a minimum
   * spacing of `1000/ratePerSec` ms between granted tokens: each caller reserves
   * the max of "now" and the running cursor, so N concurrent callers are paced
   * out at the target rate rather than all firing at once.
   */
  async acquire(): Promise<void> {
    const now = this.now();
    // The slot this caller gets: no earlier than now, and at least one interval
    // after the previously granted slot.
    const slot = Math.max(now, this.nextAvailable);
    this.nextAvailable = slot + this.intervalMs;
    const waitMs = slot - now;
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
  }
}

/**
 * Process-global limiter shared by every enrichment call in a Lambda instance.
 * A module singleton so all `GetRun`/`GetRunTask`/`ListRunTasks`/`GetWorkflow`
 * calls in one instance are paced against the same budget.
 */
export const omicsRateLimiter = new RateLimiter(
  Number(process.env.OMICS_TPS ?? OMICS_TPS),
);
