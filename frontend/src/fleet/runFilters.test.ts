import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  applyFleetControls,
  groupByEngineVersion,
  groupByBatchId,
  searchRuns,
  paginate,
  type FleetControls,
  type FleetSortKey,
  type SortDirection,
} from './runFilters';
import { orderRuns, compareRuns } from './ordering';
import { durationMs } from './duration';
import type { Run, RunStatus } from '../api/types';

const RUN_STATUSES: readonly RunStatus[] = [
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'DELETED',
  'CANCELLED',
  'FAILED',
];

/**
 * Small inline Run factory, following the pattern in `ordering.test.ts`.
 * `updatedAt` is the only required field on `Run`, so it is defaulted.
 */
function makeRun(partial: Partial<Run> & { runId: string }): Run {
  return {
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...partial,
  };
}

// ISO timestamp arbitrary spanning a handful of distinct days so ties and
// distinct orderings both occur.
const isoArb = fc
  .integer({ min: 0, max: 10 })
  .map((day) => `2024-01-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`);

// A run generator that exercises every field the fleet controls read:
// status (incl. absent), workflowId (small pool + absent), engineVersion, and
// start/stop timestamps (incl. running/unknown-duration cases).
const runArb: fc.Arbitrary<Run> = fc.record({
  runId: fc.uuid(),
  updatedAt: isoArb,
  startedAt: fc.option(isoArb, { nil: undefined }),
  stoppedAt: fc.option(isoArb, { nil: undefined }),
  status: fc.option(fc.constantFrom<RunStatus>(...RUN_STATUSES), {
    nil: undefined,
  }),
  workflowId: fc.option(fc.constantFrom('wf-a', 'wf-b', 'wf-c'), {
    nil: undefined,
  }),
  engineVersion: fc.option(fc.constantFrom('1.0.0', '2.1.0', '3.0.0'), {
    nil: undefined,
  }),
  batchId: fc.option(fc.constantFrom('batch-1', 'batch-2'), {
    nil: undefined,
  }),
});

const sortKeyArb = fc.constantFrom<FleetSortKey>('recency', 'duration');
const directionArb = fc.constantFrom<SortDirection>('asc', 'desc');

// A statuses filter: null ("all") or a non-empty set drawn from the statuses.
const statusesArb: fc.Arbitrary<ReadonlySet<RunStatus> | null> = fc.oneof(
  fc.constant<ReadonlySet<RunStatus> | null>(null),
  fc
    .subarray([...RUN_STATUSES], { minLength: 1 })
    .map((s) => new Set<RunStatus>(s)),
);

const workflowIdArb: fc.Arbitrary<string | null> = fc.constantFrom(
  null,
  'wf-a',
  'wf-b',
  'wf-c',
);

const controlsArb: fc.Arbitrary<FleetControls> = fc.record({
  statuses: statusesArb,
  workflowId: workflowIdArb,
  sortKey: sortKeyArb,
  direction: directionArb,
});

// Property test — Property 9: Fleet filtering selects exactly the matching
// runs and preserves the input.
// **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
describe('applyFleetControls — filtering and input preservation (Property 9)', () => {
  it('returns exactly the runs matching the active status and workflow filters', () => {
    fc.assert(
      fc.property(fc.array(runArb), controlsArb, (runs, controls) => {
        const result = applyFleetControls(runs, controls);

        // Every returned run satisfies both active filters (Req 5.1, 5.2).
        for (const r of result) {
          if (controls.statuses != null) {
            expect(r.status != null && controls.statuses.has(r.status)).toBe(
              true,
            );
          }
          if (controls.workflowId != null) {
            expect(r.workflowId).toBe(controls.workflowId);
          }
        }

        // No matching run is dropped: the result multiset equals the set of
        // inputs that pass both predicates.
        const expectedIds = runs
          .filter(
            (r) =>
              (controls.statuses == null ||
                (r.status != null && controls.statuses.has(r.status))) &&
              (controls.workflowId == null ||
                r.workflowId === controls.workflowId),
          )
          .map((r) => r.runId)
          .sort();
        expect(result.map((r) => r.runId).sort()).toEqual(expectedIds);
      }),
    );
  });

  it('does not mutate the input array', () => {
    fc.assert(
      fc.property(fc.array(runArb), controlsArb, (runs, controls) => {
        const snapshot = runs.map((r) => r.runId);
        applyFleetControls(runs, controls);
        expect(runs.map((r) => r.runId)).toEqual(snapshot);
      }),
    );
  });

  it('reproduces the existing recency ordering when all filters are null and key is recency', () => {
    fc.assert(
      fc.property(fc.array(runArb), (runs) => {
        const controls: FleetControls = {
          statuses: null,
          workflowId: null,
          sortKey: 'recency',
          direction: 'desc',
        };
        const result = applyFleetControls(runs, controls);
        expect(result.map((r) => r.runId)).toEqual(
          orderRuns(runs).map((r) => r.runId),
        );
      }),
    );
  });
});

// Property test — Property 10: Fleet sorting is a deterministic total order.
// **Validates: Requirements 5.5, 5.6**
describe('applyFleetControls — sort total order (Property 10)', () => {
  it('is a permutation of the filtered input (no run added or dropped)', () => {
    fc.assert(
      fc.property(fc.array(runArb), controlsArb, (runs, controls) => {
        const result = applyFleetControls(runs, controls);
        const filteredIds = runs
          .filter(
            (r) =>
              (controls.statuses == null ||
                (r.status != null && controls.statuses.has(r.status))) &&
              (controls.workflowId == null ||
                r.workflowId === controls.workflowId),
          )
          .map((r) => r.runId)
          .sort();
        expect(result.map((r) => r.runId).sort()).toEqual(filteredIds);
      }),
    );
  });

  it('is deterministic for identical inputs', () => {
    fc.assert(
      fc.property(fc.array(runArb), controlsArb, (runs, controls) => {
        const a = applyFleetControls(runs, controls, 1_700_000_000_000);
        const b = applyFleetControls(runs, controls, 1_700_000_000_000);
        expect(a.map((r) => r.runId)).toEqual(b.map((r) => r.runId));
      }),
    );
  });

  it('duration sort places known before unknown, honors direction, ties broken by compareRuns', () => {
    fc.assert(
      fc.property(
        fc.array(runArb),
        directionArb,
        fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
        (runs, direction, now) => {
          const controls: FleetControls = {
            statuses: null,
            workflowId: null,
            sortKey: 'duration',
            direction,
          };
          const result = applyFleetControls(runs, controls, now);
          const flip = direction === 'asc' ? -1 : 1;

          for (let i = 0; i + 1 < result.length; i += 1) {
            const a = result[i];
            const b = result[i + 1];
            const da = durationMs(a.startedAt, a.stoppedAt, now);
            const db = durationMs(b.startedAt, b.stoppedAt, now);

            if (da == null && db == null) {
              // Both unknown: recency tie-break holds.
              expect(compareRuns(a, b)).toBeLessThanOrEqual(0);
            } else if (da == null) {
              // An unknown-duration run must never precede a known one, so if
              // this run is unknown its successor must also be unknown.
              expect(db).toBeNull();
            } else if (db == null) {
              // Known before unknown is allowed (this is the boundary).
              expect(da).not.toBeNull();
            } else if (da !== db) {
              // Ordered by the requested direction.
              expect(flip * (db - da)).toBeLessThanOrEqual(0);
            } else {
              // Equal known durations: recency tie-break holds.
              expect(compareRuns(a, b)).toBeLessThanOrEqual(0);
            }
          }

          // Every unknown-duration run sorts after every known-duration run.
          const lastKnown = result.reduce(
            (acc, r, i) =>
              durationMs(r.startedAt, r.stoppedAt, now) != null ? i : acc,
            -1,
          );
          const firstUnknown = result.findIndex(
            (r) => durationMs(r.startedAt, r.stoppedAt, now) == null,
          );
          if (lastKnown !== -1 && firstUnknown !== -1) {
            expect(lastKnown).toBeLessThan(firstUnknown);
          }
        },
      ),
    );
  });
});

// Property test — Property 11: Engine grouping partitions the runs.
// **Validates: Requirements 7.3, 7.4**
describe('groupByEngineVersion — partitioning (Property 11)', () => {
  it('concatenation of groups is a permutation of the input', () => {
    fc.assert(
      fc.property(fc.array(runArb), (runs) => {
        const groups = groupByEngineVersion(runs);
        const flattenedIds = groups.flatMap((g) => g.runs.map((r) => r.runId));
        expect(flattenedIds.slice().sort()).toEqual(
          runs.map((r) => r.runId).sort(),
        );
      }),
    );
  });

  it('every run in a group shares the same engineVersion (absent under a single null group)', () => {
    fc.assert(
      fc.property(fc.array(runArb), (runs) => {
        const groups = groupByEngineVersion(runs);

        for (const group of groups) {
          for (const r of group.runs) {
            expect(r.engineVersion ?? null).toBe(group.engineVersion);
          }
        }

        // Each engineVersion key appears at most once (a single group each,
        // including the null group).
        const keys = groups.map((g) => g.engineVersion);
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });

  it('preserves input order within each group', () => {
    fc.assert(
      fc.property(fc.array(runArb), (runs) => {
        const groups = groupByEngineVersion(runs);

        for (const group of groups) {
          const expected = runs
            .filter((r) => (r.engineVersion ?? null) === group.engineVersion)
            .map((r) => r.runId);
          expect(group.runs.map((r) => r.runId)).toEqual(expected);
        }
      }),
    );
  });

  it('does not mutate the input array', () => {
    fc.assert(
      fc.property(fc.array(runArb), (runs) => {
        const snapshot = runs.map((r) => r.runId);
        groupByEngineVersion(runs);
        expect(runs.map((r) => r.runId)).toEqual(snapshot);
      }),
    );
  });

  // Concrete example: absent engineVersion collected under one null group.
  it('collects runs with absent engineVersion under a single null group', () => {
    const runs = [
      makeRun({ runId: 'a', engineVersion: '1.0.0' }),
      makeRun({ runId: 'b' }),
      makeRun({ runId: 'c', engineVersion: '1.0.0' }),
      makeRun({ runId: 'd' }),
    ];
    const groups = groupByEngineVersion(runs);
    const nullGroups = groups.filter((g) => g.engineVersion === null);
    expect(nullGroups).toHaveLength(1);
    expect(nullGroups[0].runs.map((r) => r.runId)).toEqual(['b', 'd']);
  });
});

describe('groupByBatchId — partitioning (mirrors engine grouping)', () => {
  it('concatenation of groups is a permutation of the input', () => {
    fc.assert(
      fc.property(fc.array(runArb), (runs) => {
        const groups = groupByBatchId(runs);
        const flattenedIds = groups.flatMap((g) => g.runs.map((r) => r.runId));
        expect(flattenedIds.slice().sort()).toEqual(
          runs.map((r) => r.runId).slice().sort(),
        );
      }),
    );
  });

  it('every run in a group shares the same batchId (absent under one null group)', () => {
    const runs = [
      makeRun({ runId: 'a', batchId: 'batch-1' }),
      makeRun({ runId: 'b' }),
      makeRun({ runId: 'c', batchId: 'batch-1' }),
      makeRun({ runId: 'd', batchId: 'batch-2' }),
      makeRun({ runId: 'e' }),
    ];
    const groups = groupByBatchId(runs);
    // Group keys unique; standalone runs (no batchId) under a single null group.
    const keys = groups.map((g) => g.batchId);
    expect(new Set(keys).size).toBe(keys.length);
    const nullGroup = groups.find((g) => g.batchId === null);
    expect(nullGroup?.runs.map((r) => r.runId)).toEqual(['b', 'e']);
    const b1 = groups.find((g) => g.batchId === 'batch-1');
    expect(b1?.runs.map((r) => r.runId)).toEqual(['a', 'c']);
  });

  it('preserves input order within each group and does not mutate input', () => {
    fc.assert(
      fc.property(fc.array(runArb), (runs) => {
        const snapshot = runs.map((r) => r.runId);
        const groups = groupByBatchId(runs);
        for (const group of groups) {
          const expected = runs
            .filter((r) => (r.batchId ?? null) === group.batchId)
            .map((r) => r.runId);
          expect(group.runs.map((r) => r.runId)).toEqual(expected);
        }
        expect(runs.map((r) => r.runId)).toEqual(snapshot);
      }),
    );
  });

  it('orders groups by batch id (numerically) with the No-batch group last', () => {
    // Input order is deliberately shuffled so the result reflects id ordering,
    // not first-appearance. Numeric ids must sort 9 < 100 (not lexically).
    const runs = [
      makeRun({ runId: 'r1', batchId: '100' }),
      makeRun({ runId: 'r2' }), // no batch
      makeRun({ runId: 'r3', batchId: '9' }),
      makeRun({ runId: 'r4', batchId: '100' }),
      makeRun({ runId: 'r5', batchId: '42' }),
      makeRun({ runId: 'r6' }), // no batch
    ];
    const groups = groupByBatchId(runs);
    // Batch ids ascending numerically (9, 42, 100), then null last.
    expect(groups.map((g) => g.batchId)).toEqual(['9', '42', '100', null]);
    // Within-group input order preserved; No-batch collects r2 then r6.
    expect(groups[2].runs.map((r) => r.runId)).toEqual(['r1', 'r4']);
    expect(groups[3].runs.map((r) => r.runId)).toEqual(['r2', 'r6']);
  });

  it('places the No-batch group last even when it appears first in the input', () => {
    const runs = [
      makeRun({ runId: 'a' }), // no batch, appears first
      makeRun({ runId: 'b', batchId: '5' }),
    ];
    const groups = groupByBatchId(runs);
    expect(groups.map((g) => g.batchId)).toEqual(['5', null]);
  });
});


describe('searchRuns — free-form text search', () => {
  const runs = [
    makeRun({
      runId: 'r-100',
      name: 'nightly-rnaseq',
      workflowName: 'nf-core/rnaseq',
      workflowId: 'wf-abc',
      status: 'COMPLETED',
      engineVersion: '25.10.0',
      batchId: 'batch-9',
    }),
    makeRun({
      runId: 'r-200',
      name: 'fetchngs-batch-1',
      workflowName: 'nf-core/fetchngs',
      workflowId: 'wf-xyz',
      status: 'RUNNING',
    }),
    makeRun({ runId: 'r-300', name: 'align-job' }),
  ];

  it('returns the input unchanged for an empty/whitespace query', () => {
    expect(searchRuns(runs, '').map((r) => r.runId)).toEqual(
      runs.map((r) => r.runId),
    );
    expect(searchRuns(runs, '   ').map((r) => r.runId)).toEqual(
      runs.map((r) => r.runId),
    );
  });

  it('matches case-insensitively on the run name', () => {
    expect(searchRuns(runs, 'RNASEQ').map((r) => r.runId)).toEqual(['r-100']);
  });

  it('matches on run id, workflow name, workflow id, status, engine, batch id', () => {
    expect(searchRuns(runs, 'r-200').map((r) => r.runId)).toEqual(['r-200']);
    expect(searchRuns(runs, 'fetchngs').map((r) => r.runId)).toEqual(['r-200']);
    expect(searchRuns(runs, 'wf-abc').map((r) => r.runId)).toEqual(['r-100']);
    expect(searchRuns(runs, 'running').map((r) => r.runId)).toEqual(['r-200']);
    expect(searchRuns(runs, '25.10').map((r) => r.runId)).toEqual(['r-100']);
    expect(searchRuns(runs, 'batch-9').map((r) => r.runId)).toEqual(['r-100']);
  });

  it('returns no matches when nothing contains the query', () => {
    expect(searchRuns(runs, 'zzz-nope')).toEqual([]);
  });

  it('preserves input order and does not mutate the input', () => {
    const snapshot = runs.map((r) => r.runId);
    const out = searchRuns(runs, 'nf-core');
    expect(out.map((r) => r.runId)).toEqual(['r-100', 'r-200']);
    expect(runs.map((r) => r.runId)).toEqual(snapshot);
  });

  // Property: every returned run actually contains the query in some field,
  // and no excluded run does — a sound, complete substring search.
  it('property: matches are exactly the runs whose text fields contain the query', () => {
    fc.assert(
      fc.property(fc.array(runArb), fc.string({ maxLength: 6 }), (rs, query) => {
        const out = searchRuns(rs, query);
        const q = query.trim().toLowerCase();
        const contains = (run: Run): boolean =>
          q !== '' &&
          [
            run.name,
            run.runId,
            run.workflowName,
            run.workflowId,
            run.status,
            run.engineVersion,
            run.batchId,
          ]
            .filter((v): v is string => typeof v === 'string')
            .some((f) => f.toLowerCase().includes(q));
        if (q === '') {
          expect(out.length).toBe(rs.length);
        } else {
          const outIds = new Set(out.map((r) => r.runId));
          for (const run of rs) {
            expect(outIds.has(run.runId)).toBe(contains(run));
          }
        }
      }),
    );
  });
});

describe('paginate — client-side pagination', () => {
  const runs = Array.from({ length: 23 }, (_, i) =>
    makeRun({ runId: `r-${i}` }),
  );

  it('returns the requested page with the given size', () => {
    const p1 = paginate(runs, 1, 10);
    expect(p1.items.map((r) => r.runId)).toEqual(
      runs.slice(0, 10).map((r) => r.runId),
    );
    expect(p1.pageCount).toBe(3);
    expect(p1.currentPage).toBe(1);

    const p3 = paginate(runs, 3, 10);
    expect(p3.items).toHaveLength(3); // last page: 23 - 20
    expect(p3.currentPage).toBe(3);
  });

  it('clamps an out-of-range page to the last page', () => {
    const p = paginate(runs, 99, 10);
    expect(p.currentPage).toBe(3);
    expect(p.items.map((r) => r.runId)).toEqual(['r-20', 'r-21', 'r-22']);
  });

  it('clamps page < 1 to page 1 and coerces pageSize to >= 1', () => {
    expect(paginate(runs, 0, 10).currentPage).toBe(1);
    expect(paginate(runs, -5, 10).currentPage).toBe(1);
    const tiny = paginate(runs, 1, 0);
    expect(tiny.items).toHaveLength(1);
    expect(tiny.pageCount).toBe(23);
  });

  it('an empty list is page 1 of 1 with no items', () => {
    const p = paginate([], 1, 25);
    expect(p.items).toEqual([]);
    expect(p.pageCount).toBe(1);
    expect(p.currentPage).toBe(1);
  });

  it('does not mutate the input', () => {
    const snapshot = runs.map((r) => r.runId);
    paginate(runs, 2, 10);
    expect(runs.map((r) => r.runId)).toEqual(snapshot);
  });

  // Property: pages partition the list in order without loss or duplication.
  it('property: concatenating all pages reproduces the input exactly', () => {
    fc.assert(
      fc.property(
        fc.array(runArb),
        fc.integer({ min: 1, max: 10 }),
        (rs, size) => {
          const first = paginate(rs, 1, size);
          const all: string[] = [];
          for (let pg = 1; pg <= first.pageCount; pg += 1) {
            all.push(...paginate(rs, pg, size).items.map((r) => r.runId));
          }
          expect(all).toEqual(rs.map((r) => r.runId));
        },
      ),
    );
  });
});
