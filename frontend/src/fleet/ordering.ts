/**
 * Fleet-view ordering.
 *
 * Runs are ordered into two tiers:
 *
 *   1. **Pending-not-started runs first.** A run that is still NON-TERMINAL
 *      (PENDING/STARTING per {@link NON_TERMINAL_STATUSES}) *and* has no usable
 *      `startedAt` has genuinely just been launched and is not executing yet.
 *      It is the newest thing in the fleet and must be visible on the first
 *      page, so it sorts to the front, ordered among its peers by `updatedAt`
 *      descending (most recently created/updated first).
 *   2. **Everyone else** — started runs *and* runs that reached a TERMINAL
 *      state (CANCELLED/FAILED/COMPLETED/DELETED) before they ever started —
 *      ordered by an **effective recency** timestamp descending, tie-broken by
 *      `updatedAt` descending.
 *
 * Effective recency = `startedAt` if the run has started, else `updatedAt`.
 *
 * Rationale: a terminal status is a run's *final resting state*, not "about to
 * start". A run cancelled or failed before it started has no `startedAt`, but
 * it is dead — pinning it to the front (as a naive "no start time → front" rule
 * would) is wrong. Its `updatedAt` is the moment it reached that terminal state
 * (i.e. *when it was cancelled*), so `updatedAt` is the correct recency key and
 * it interleaves honestly among the started runs by when it actually ended.
 * This is why tier 1 gates on {@link NON_TERMINAL_STATUSES}, not merely on the
 * absence of a start time.
 *
 * A run whose status is absent/unknown is not in {@link NON_TERMINAL_STATUSES},
 * so it falls to tier 2 and is ordered by its `updatedAt` (no-fabrication: we
 * do not assume an unknown status is pending).
 *
 * This module is a pure helper so the ordering rule can be unit- and
 * property-tested independently of the React view.
 */
import type { Run, RunStatus } from '../api/types';
import { NON_TERMINAL_STATUSES } from './staleness';

/**
 * Parses an ISO 8601 timestamp into epoch milliseconds for comparison.
 *
 * A null/undefined or unparseable value yields negative infinity. The sentinel
 * keeps {@link descending} well-defined when a timestamp is missing; in
 * practice `updatedAt` is always a real ISO string, so tier-2 effective
 * recency resolves to a genuine epoch and the sentinel is only a safety net.
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
 * with an absent or unparseable `startedAt` has not started yet. Note that
 * "not started" alone does NOT make a run front-tier — see
 * {@link isPendingNotStarted}, which also requires a non-terminal status.
 */
function hasStarted(run: Run): boolean {
  return toEpoch(run.startedAt) !== Number.NEGATIVE_INFINITY;
}

/**
 * The run's **effective recency** epoch used by tier 2: the Start time if the
 * run has started, otherwise its last-change time (`updatedAt`). For a
 * cancelled/failed-before-start run, `updatedAt` is when it reached its
 * terminal state — i.e. when it was cancelled — which is the honest recency key.
 */
function recencyEpoch(run: Run): number {
  return hasStarted(run) ? toEpoch(run.startedAt) : toEpoch(run.updatedAt);
}

/**
 * Whether a run belongs to the front tier: it is NON-TERMINAL
 * (PENDING/STARTING/RUNNING/STOPPING per {@link NON_TERMINAL_STATUSES}) *and*
 * has not started yet. In practice this is a just-launched PENDING/STARTING run
 * (a RUNNING/STOPPING run normally has a `startedAt`). A run with an
 * absent/unknown status is not in the set, so this returns `false` and the run
 * falls to tier 2.
 */
function isPendingNotStarted(run: Run): boolean {
  return (
    NON_TERMINAL_STATUSES.has(run.status as RunStatus) && !hasStarted(run)
  );
}

/**
 * Compares two runs for fleet order.
 *
 * Tiering:
 *   1. **Pending-not-started runs first.** A non-terminal run with no usable
 *      `startedAt` (just-launched PENDING/STARTING, per
 *      {@link isPendingNotStarted}) sorts ahead of everyone, so freshly-launched
 *      runs land on the first page. Within this tier, order by `updatedAt`
 *      descending.
 *   2. **Everyone else** — started runs *and* terminal-before-start runs —
 *      ordered by {@link recencyEpoch} (effective recency: `startedAt` if
 *      started, else `updatedAt`) descending, tie-broken by `updatedAt`
 *      descending.
 *
 * A terminal run (CANCELLED/FAILED/COMPLETED/DELETED) is NOT front-tier even
 * with no `startedAt`: it is in its final state, not about to start, so it is
 * placed by WHEN it ended (its `updatedAt`), interleaving honestly among the
 * started runs rather than being pinned to the top. An absent/unknown status
 * also lands in tier 2 (no-fabrication).
 *
 * Returns a negative number when `a` should sort before `b`.
 */
export function compareRuns(a: Run, b: Run): number {
  const aFront = isPendingNotStarted(a);
  const bFront = isPendingNotStarted(b);
  if (aFront !== bFront) {
    // Front tier (true) sorts before tier 2 (false).
    return aFront ? -1 : 1;
  }
  if (aFront) {
    // Both front: newest activity first.
    return descending(toEpoch(a.updatedAt), toEpoch(b.updatedAt));
  }
  // Both tier 2: by effective recency desc, then last activity desc.
  const recencyDelta = descending(recencyEpoch(a), recencyEpoch(b));
  if (recencyDelta !== 0) {
    return recencyDelta;
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
 * Returns a new array of runs ordered per {@link compareRuns}: pending-not-
 * started runs first (by `updatedAt` desc), then everyone else by effective
 * recency (`startedAt` if started, else `updatedAt`) desc, ties broken by
 * `updatedAt` desc. The input array is not mutated.
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
