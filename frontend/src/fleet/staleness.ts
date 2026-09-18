/**
 * Stale-run detection helpers for the fleet view (enhancement #9).
 *
 * A run whose status indicates it should still be progressing (non-terminal)
 * but whose `updatedAt` is far in the past may be stuck. Because `updatedAt` is
 * bumped by every ingest write, a genuinely progressing run stays fresh; only a
 * run that has gone quiet while non-terminal is flagged. Kept as pure helpers
 * (injectable `now`) so staleness is unit- and property-testable
 * (Req 9.1–9.4, 10.1, 10.3).
 */

import type { Run, RunStatus } from '../api/types';

/**
 * Non-terminal run statuses: a run in one of these should keep progressing.
 *
 * The terminal statuses (`COMPLETED`, `DELETED`, `CANCELLED`, `FAILED`) are a
 * run's final resting state and are never flagged stale; everything else is a
 * status from which the run is still expected to advance.
 */
export const NON_TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
]);

/** Default staleness threshold: one hour, in milliseconds. */
const DEFAULT_THRESHOLD_MS = 60 * 60 * 1000;

export interface Staleness {
  readonly stale: boolean;
  /** `now - updatedAt`, or `null` when `updatedAt` is unparseable. */
  readonly ageMs: number | null;
  readonly reason: 'active-no-progress' | 'terminal' | 'unknown';
}

/**
 * Evaluates whether a run is stale.
 *
 * A run is stale iff its status is non-terminal, its `updatedAt` is parseable,
 * and `now - updatedAt` exceeds `thresholdMs`. Terminal runs are never stale
 * (`reason: 'terminal'`). A run with an unparseable/absent `updatedAt` is not
 * flagged stale (`reason: 'unknown'`) — we do not guess. Otherwise the reason
 * is `'active-no-progress'` whether or not the threshold is exceeded.
 *
 * `thresholdMs` defaults to one hour and must be positive; a non-positive
 * threshold falls back to the default.
 */
export function evaluateStaleness(
  run: Run,
  thresholdMs: number = DEFAULT_THRESHOLD_MS,
  now: number = Date.now(),
): Staleness {
  const threshold =
    Number.isFinite(thresholdMs) && thresholdMs > 0
      ? thresholdMs
      : DEFAULT_THRESHOLD_MS;

  // Terminal status: never stale, regardless of updatedAt.
  if (run.status == null || !NON_TERMINAL_STATUSES.has(run.status)) {
    return { stale: false, ageMs: null, reason: 'terminal' };
  }

  const updatedAt = Date.parse(run.updatedAt);
  if (Number.isNaN(updatedAt)) {
    return { stale: false, ageMs: null, reason: 'unknown' };
  }

  const ageMs = now - updatedAt;
  return {
    stale: ageMs > threshold,
    ageMs,
    reason: 'active-no-progress',
  };
}
