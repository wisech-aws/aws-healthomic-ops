/**
 * Fleet-view ordering.
 *
 * Not-yet-started runs (no `startedAt` — e.g. PENDING/STARTING) sort to the
 * **front** of the list (ordered among themselves by `updatedAt` descending),
 * because a run the user just launched but that has not started executing yet
 * is the *newest* thing in the fleet and should be visible on the first page —
 * not buried at the back for lacking a Start time. Started runs follow, ordered
 * by most recent `startedAt` (the run's Start time) descending, ties broken by
 * `updatedAt` descending. This module is a pure helper so the ordering rule can
 * be unit- and property-tested independently of the React view.
 */
import type { Run } from '../api/types';

/**
 * Parses an ISO 8601 timestamp into epoch milliseconds for comparison.
 *
 * A null/undefined or unparseable value yields negative infinity. Callers that
 * treat "absent start time" specially (see {@link compareRuns}) branch on
 * {@link hasStarted} first, so this sentinel only affects ordering *within* a
 * tier where all values are present.
 */
function toEpoch(value: string | null | undefined): number {
  if (value == null) {
    return Number.NEGATIVE_INFINITY;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Whether a run has a usable Start time (i.e. it has begun executing). A run
 * with an absent or unparseable `startedAt` has not started yet
 * (PENDING/STARTING) and is treated as a "not-yet-started" run for ordering.
 */
function hasStarted(run: Run): boolean {
  return toEpoch(run.startedAt) !== Number.NEGATIVE_INFINITY;
}

/**
 * Compares two runs for fleet order.
 *
 * Tiering:
 *   1. **Not-yet-started runs first.** A run with no usable `startedAt`
 *      (PENDING/STARTING — just launched, not executing yet) sorts ahead of any
 *      started run, so freshly-launched runs land on the first page instead of
 *      being pushed to the back for lacking a Start time. Within this tier,
 *      order by `updatedAt` descending (most recently created/updated first).
 *   2. **Started runs**, ordered by `startedAt` descending — the run's **Start
 *      time** (the field shown in the Run List "Start time" column), so
 *      "recency" means newest-started run first. Tie-break: `updatedAt`
 *      descending, so two runs that started at the same instant order by most
 *      recent activity.
 *
 * NOTE: the primary key was originally `updatedAt` (last status-change time),
 * which made an OLD run bubble to the top whenever any of its tasks changed
 * state. Sorting started runs by `startedAt` fixes that. A later refinement
 * moved not-yet-started runs from the back to the **front**, because those are
 * the newest runs and burying them was a UX regression.
 *
 * Returns a negative number when `a` should sort before `b`.
 */
export function compareRuns(a: Run, b: Run): number {
  const aStarted = hasStarted(a);
  const bStarted = hasStarted(b);
  if (aStarted !== bStarted) {
    // Not-yet-started (false) sorts before started (true) — front of the list.
    return aStarted ? 1 : -1;
  }
  if (!aStarted) {
    // Both not-yet-started: newest activity first.
    return descending(toEpoch(a.updatedAt), toEpoch(b.updatedAt));
  }
  // Both started: by Start time desc, then last activity desc.
  const startedDelta = descending(toEpoch(a.startedAt), toEpoch(b.startedAt));
  if (startedDelta !== 0) {
    return startedDelta;
  }
  return descending(toEpoch(a.updatedAt), toEpoch(b.updatedAt));
}

/**
 * Descending comparison of two epoch values that is safe for the sentinel
 * `NEGATIVE_INFINITY` used for absent timestamps. Plain subtraction would yield
 * `NaN` when both sides are `-Infinity` (two absent timestamps compared as
 * equal), so compare with ordering operators instead.
 */
function descending(a: number, b: number): number {
  if (a === b) {
    return 0;
  }
  return a > b ? -1 : 1;
}

/**
 * Returns a new array of runs ordered per {@link compareRuns}: not-yet-started
 * runs first (by `updatedAt` desc), then started runs by `startedAt` (Start
 * time) desc, ties broken by `updatedAt` desc. The input array is not mutated.
 */
export function orderRuns(runs: readonly Run[]): Run[] {
  return [...runs].sort(compareRuns);
}

/**
 * Merges an updated run into the fleet list and returns a newly ordered list
 * (Req 8.5, 8.6, 8.10; design Property 21).
 *
 * The update is upserted by `runId`: a run already present is replaced in place
 * with `updatedRun`, and a run not yet present is inserted. The whole list is
 * then re-ordered via {@link orderRuns}, so an update from any source (a
 * subscription event, a query result, or a direct API call) is applied subject
 * to the fleet ordering. The input array is not mutated.
 *
 * The operation is idempotent: applying the same `updatedRun` twice yields the
 * same list, because the upsert replaces (rather than appends) any existing run
 * with the same `runId` and the ordering is stable for equal comparison keys.
 */
export function mergeRunUpdate(
  runs: readonly Run[],
  updatedRun: Run,
): Run[] {
  let replaced = false;
  const merged = runs.map((existing) => {
    if (existing.runId === updatedRun.runId) {
      replaced = true;
      return updatedRun;
    }
    return existing;
  });
  if (!replaced) {
    merged.push(updatedRun);
  }
  return orderRuns(merged);
}

/**
 * Returns only the runs whose `status` equals `status` (Req 8.8; design
 * Property 23). Passing `null` selects runs whose status is absent. The input
 * array is not mutated and relative order is preserved, so callers that pass an
 * already-ordered list get an ordered filtered list back.
 */
export function filterRunsByStatus(
  runs: readonly Run[],
  status: Run['status'],
): Run[] {
  return runs.filter((r) => (r.status ?? null) === (status ?? null));
}
