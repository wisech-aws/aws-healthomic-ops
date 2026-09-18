/**
 * Fleet-view ordering.
 *
 * Runs are ordered by most recent `updatedAt` in descending order, with ties
 * between equal `updatedAt` values broken by start time (`startedAt`) in
 * descending order (Req 8.4). This module is a pure helper so the ordering rule
 * can be unit- and property-tested independently of the React view.
 */
import type { Run } from '../api/types';

/**
 * Parses an ISO 8601 timestamp into epoch milliseconds for comparison.
 *
 * A null/undefined or unparseable value sorts last within its comparison group
 * by yielding negative infinity (so present timestamps always rank ahead of
 * absent ones under descending order).
 */
function toEpoch(value: string | null | undefined): number {
  if (value == null) {
    return Number.NEGATIVE_INFINITY;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Compares two runs for descending fleet order.
 *
 * Primary key: `updatedAt` descending. Tie-break: `startedAt` descending.
 * Returns a negative number when `a` should sort before `b`.
 */
export function compareRuns(a: Run, b: Run): number {
  const updatedDelta = descending(toEpoch(a.updatedAt), toEpoch(b.updatedAt));
  if (updatedDelta !== 0) {
    return updatedDelta;
  }
  return descending(toEpoch(a.startedAt), toEpoch(b.startedAt));
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
 * Returns a new array of runs ordered by descending `updatedAt`, ties broken by
 * descending `startedAt` (Req 8.4). The input array is not mutated.
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
