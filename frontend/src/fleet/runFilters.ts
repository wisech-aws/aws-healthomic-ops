/**
 * Fleet-view filtering, sorting, and grouping (enhancements 5 and 7).
 *
 * These helpers compose with the existing recency ordering (`compareRuns` in
 * `ordering.ts`) and numeric duration primitive (`durationMs` in `duration.ts`)
 * rather than reimplementing them, so the fleet's default recency behavior is
 * preserved exactly. Every helper is pure and leaves its input array unmutated,
 * following the pattern established by `orderRuns`/`filterRunsByStatus`.
 */

import type { Run, RunStatus } from '../api/types';
import { compareRuns } from './ordering';
import { durationMs } from './duration';

/** Sort key for the fleet list: most-recent-first, or by wall-clock duration. */
export type FleetSortKey = 'recency' | 'duration';

/** Sort direction. `desc` is longest/most-recent first. */
export type SortDirection = 'asc' | 'desc';

/**
 * The active fleet controls. A `null` filter means "all" (no restriction), so
 * an all-`null` control set with `sortKey: 'recency'` reproduces the existing
 * fleet ordering (Req 5.4).
 */
export interface FleetControls {
  /** Selected statuses; `null` selects every status (Req 5.1). */
  readonly statuses: ReadonlySet<RunStatus> | null;
  /** Selected workflow id; `null` selects every workflow (Req 5.2). */
  readonly workflowId: string | null;
  readonly sortKey: FleetSortKey;
  readonly direction: SortDirection;
}

/**
 * Apply the status and workflow filters, then sort (Req 5.1–5.6).
 *
 * The input array is copied first and never mutated (Req 5.3). `recency`
 * delegates to the existing {@link compareRuns} comparator; `duration` sorts by
 * numeric {@link durationMs} with unknown (null) durations always sorted last,
 * ties broken by {@link compareRuns} for a deterministic total order (Req 5.5,
 * 5.6). `direction` is honored for both keys; unknown-duration runs remain last
 * regardless of direction (they are not "shortest", they are unknown).
 */
export function applyFleetControls(
  runs: readonly Run[],
  controls: FleetControls,
  now: number = Date.now(),
): Run[] {
  let result = [...runs];

  const { statuses, workflowId } = controls;
  if (statuses != null) {
    result = result.filter((r) => r.status != null && statuses.has(r.status));
  }
  if (workflowId != null) {
    result = result.filter((r) => r.workflowId === workflowId);
  }

  const flip = controls.direction === 'asc' ? -1 : 1;

  if (controls.sortKey === 'recency') {
    // compareRuns is inherently descending (most-recent first); invert for asc.
    result.sort((a, b) => flip * compareRuns(a, b));
    return result;
  }

  // Duration sort: known durations ordered by the requested direction, unknown
  // durations always last, ties broken by the recency comparator.
  result.sort((a, b) => {
    const da = durationMs(a.startedAt, a.stoppedAt, now);
    const db = durationMs(b.startedAt, b.stoppedAt, now);

    if (da == null && db == null) {
      return compareRuns(a, b);
    }
    if (da == null) {
      return 1; // a unknown => a after b
    }
    if (db == null) {
      return -1; // b unknown => a before b
    }
    if (da !== db) {
      // Descending (longest first) by default; invert for ascending.
      return flip * (db - da);
    }
    return compareRuns(a, b);
  });

  return result;
}

/**
 * Distinct workflow options present in `runs`, sorted by label then id for a
 * stable, deterministic filter UI. A run's `workflowName` is used as the label
 * when present, otherwise its `workflowId`. Runs without a `workflowId` are
 * omitted (there is no workflow to filter on). The input is not mutated.
 */
export function workflowOptions(
  runs: readonly Run[],
): Array<{ id: string; label: string }> {
  const byId = new Map<string, string>();
  for (const run of runs) {
    const id = run.workflowId;
    if (id == null) {
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, run.workflowName ?? id);
    }
  }
  return Array.from(byId, ([id, label]) => ({ id, label })).sort((a, b) => {
    const byLabel = a.label.localeCompare(b.label);
    return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id);
  });
}

/**
 * Partition runs by `engineVersion`, preserving input order within each group
 * (Req 7.3, 7.4). Runs with an absent `engineVersion` are collected under a
 * single group keyed by `null`. Group order follows first appearance of each
 * engine version in the input. The concatenation of the groups' runs is a
 * permutation of the input (no run is added or dropped). The input is not
 * mutated.
 */
export function groupByEngineVersion(
  runs: readonly Run[],
): Array<{ engineVersion: string | null; runs: Run[] }> {
  const groups: Array<{ engineVersion: string | null; runs: Run[] }> = [];
  const index = new Map<string | null, number>();

  for (const run of runs) {
    const key = run.engineVersion ?? null;
    let pos = index.get(key);
    if (pos === undefined) {
      pos = groups.length;
      index.set(key, pos);
      groups.push({ engineVersion: key, runs: [] });
    }
    groups[pos].runs.push(run);
  }

  return groups;
}

/**
 * Partition runs by `batchId`, preserving input order within each group.
 * Standalone runs (no `batchId`) are collected under a single group keyed by
 * `null`.
 *
 * Group ordering: batch groups are sorted by batch id (numerically when both
 * ids parse as numbers — as HealthOmics batch ids do — otherwise by locale
 * string compare), and the `null` "No batch" group is always placed **last**.
 * Within each group, runs keep their input order. The concatenation of the
 * groups' runs is a permutation of the input (no run added or dropped). The
 * input is not mutated.
 */
export function groupByBatchId(
  runs: readonly Run[],
): Array<{ batchId: string | null; runs: Run[] }> {
  const byKey = new Map<string | null, Run[]>();
  for (const run of runs) {
    const key = run.batchId ?? null;
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [run]);
    } else {
      bucket.push(run);
    }
  }

  // Order the batch ids; the null ("No batch") group is forced to the bottom.
  const compareBatchId = (a: string, b: string): number => {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) {
      return na - nb;
    }
    return a.localeCompare(b);
  };
  const keys = Array.from(byKey.keys()).sort((a, b) => {
    if (a === null) return 1; // null (No batch) sorts last
    if (b === null) return -1;
    return compareBatchId(a, b);
  });

  return keys.map((batchId) => ({ batchId, runs: byKey.get(batchId)! }));
}

/**
 * Free-form text search over the run list.
 *
 * Case-insensitive substring match across a run's human-relevant text fields:
 * run name, run id, workflow name, workflow id, status, engine version, and
 * batch id. An empty/whitespace-only query returns the input unchanged (no
 * filtering). The input array is never mutated; matching runs are returned in
 * their original order. No fabrication — a field that is absent simply does not
 * contribute a match.
 */
export function searchRuns(runs: readonly Run[], query: string): Run[] {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return [...runs];
  }
  const fields = (run: Run): string[] =>
    [
      run.name,
      run.runId,
      run.workflowName,
      run.workflowId,
      run.status,
      run.engineVersion,
      run.batchId,
    ].filter((v): v is string => typeof v === 'string');
  return runs.filter((run) =>
    fields(run).some((f) => f.toLowerCase().includes(q)),
  );
}

/** A single page of runs plus the pagination metadata the UI needs. */
export interface RunPage {
  /** The runs on the requested page (may be shorter than `pageSize` on the last page). */
  readonly items: Run[];
  /** Total number of pages (at least 1, even when there are no runs). */
  readonly pageCount: number;
  /** The clamped, 1-based current page index actually returned. */
  readonly currentPage: number;
}

/**
 * Client-side pagination over an already-ordered run list.
 *
 * `page` is 1-based and clamped into `[1, pageCount]` so an out-of-range page
 * (e.g. after the list shrinks) resolves to the nearest valid page rather than
 * an empty view. `pageSize` is coerced to at least 1. `pageCount` is at least 1
 * even for an empty list (an empty list is "page 1 of 1"). The input array is
 * not mutated.
 */
export function paginate(
  runs: readonly Run[],
  page: number,
  pageSize: number,
): RunPage {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(runs.length / size));
  const currentPage = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const start = (currentPage - 1) * size;
  return {
    items: runs.slice(start, start + size),
    pageCount,
    currentPage,
  };
}
