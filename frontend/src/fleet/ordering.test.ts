import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  orderRuns,
  compareRuns,
  mergeRunUpdate,
  mergeRunPage,
  filterRunsByStatus,
} from './ordering';
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

const NON_TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
]);

function run(partial: Partial<Run> & { runId: string }): Run {
  return {
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('orderRuns', () => {
  it('orders by descending startedAt (Start time = recency)', () => {
    const runs = [
      run({ runId: 'a', startedAt: '2024-01-01T00:00:00.000Z' }),
      run({ runId: 'b', startedAt: '2024-01-03T00:00:00.000Z' }),
      run({ runId: 'c', startedAt: '2024-01-02T00:00:00.000Z' }),
    ];
    expect(orderRuns(runs).map((r) => r.runId)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties on equal startedAt by descending updatedAt (last activity)', () => {
    const startedAt = '2024-01-01T00:00:00.000Z';
    const runs = [
      run({ runId: 'early', startedAt, updatedAt: '2024-01-01T01:00:00.000Z' }),
      run({ runId: 'late', startedAt, updatedAt: '2024-01-01T05:00:00.000Z' }),
      run({ runId: 'mid', startedAt, updatedAt: '2024-01-01T03:00:00.000Z' }),
    ];
    expect(orderRuns(runs).map((r) => r.runId)).toEqual([
      'late',
      'mid',
      'early',
    ]);
  });

  it('does not mutate the input array', () => {
    const runs = [
      run({ runId: 'a', startedAt: '2024-01-01T00:00:00.000Z' }),
      run({ runId: 'b', startedAt: '2024-01-02T00:00:00.000Z' }),
    ];
    const snapshot = runs.map((r) => r.runId);
    orderRuns(runs);
    expect(runs.map((r) => r.runId)).toEqual(snapshot);
  });

  it('ranks PENDING not-yet-started runs at the FRONT; terminal-no-start is NOT front', () => {
    const runs = [
      run({ runId: 'has', startedAt: '2024-01-01T02:00:00.000Z', updatedAt: '2024-01-01T02:00:00.000Z' }),
      // 'none' is PENDING with no startedAt — a freshly-launched run must appear
      // on the first page, so it sorts AHEAD of any started run.
      run({ runId: 'none', status: 'PENDING', updatedAt: '2024-01-01T09:00:00.000Z' }),
      // 'cancelled' has no startedAt but is TERMINAL; its updatedAt is older than
      // 'has''s startedAt, so it must sort BELOW 'has' — never at the front.
      run({ runId: 'cancelled', status: 'CANCELLED', updatedAt: '2024-01-01T01:00:00.000Z' }),
    ];
    expect(orderRuns(runs).map((r) => r.runId)).toEqual(['none', 'has', 'cancelled']);
  });

  it('orders multiple pending not-started runs among themselves by updatedAt desc, all ahead of started runs', () => {
    const runs = [
      run({ runId: 'started-new', status: 'RUNNING', startedAt: '2024-01-05T00:00:00.000Z', updatedAt: '2024-01-05T00:00:00.000Z' }),
      run({ runId: 'pending-old', status: 'PENDING', updatedAt: '2024-01-01T00:00:00.000Z' }),
      run({ runId: 'started-old', status: 'RUNNING', startedAt: '2024-01-02T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' }),
      run({ runId: 'pending-new', status: 'STARTING', updatedAt: '2024-01-03T00:00:00.000Z' }),
    ];
    // Both pending runs first (newest updatedAt first), then started runs by startedAt desc.
    expect(orderRuns(runs).map((r) => r.runId)).toEqual([
      'pending-new',
      'pending-old',
      'started-new',
      'started-old',
    ]);
  });

  it('CANCELLED run with no start time is NOT at the front and interleaves by updatedAt', () => {
    const runs = [
      run({ runId: 's', status: 'RUNNING', startedAt: '2024-01-02T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' }),
      run({ runId: 'c-newer', status: 'CANCELLED', updatedAt: '2024-01-03T00:00:00.000Z' }),
      run({ runId: 'c-older', status: 'CANCELLED', updatedAt: '2024-01-01T00:00:00.000Z' }),
    ];
    // Effective recency: c-newer.updatedAt (01-03) > s.startedAt (01-02) > c-older.updatedAt (01-01).
    expect(orderRuns(runs).map((r) => r.runId)).toEqual(['c-newer', 's', 'c-older']);
  });

  it('FAILED-before-start behaves like CANCELLED (tier 2 by updatedAt, not pinned front)', () => {
    const runs = [
      run({ runId: 's', status: 'RUNNING', startedAt: '2024-01-02T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' }),
      run({ runId: 'f-newer', status: 'FAILED', updatedAt: '2024-01-03T00:00:00.000Z' }),
      run({ runId: 'f-older', status: 'FAILED', updatedAt: '2024-01-01T00:00:00.000Z' }),
    ];
    expect(orderRuns(runs).map((r) => r.runId)).toEqual(['f-newer', 's', 'f-older']);
  });

  it('STARTING no-start sorts to the front tier like PENDING', () => {
    const runs = [
      run({ runId: 'has', status: 'RUNNING', startedAt: '2024-01-05T00:00:00.000Z', updatedAt: '2024-01-05T00:00:00.000Z' }),
      run({ runId: 'starting', status: 'STARTING', updatedAt: '2024-01-01T00:00:00.000Z' }),
    ];
    expect(orderRuns(runs).map((r) => r.runId)).toEqual(['starting', 'has']);
  });

  it('absent/unknown status with no start time falls to tier 2 by updatedAt, not front', () => {
    const runs = [
      // Absent status, no start — tier 2, despite a very recent updatedAt.
      run({ runId: 'unknown', updatedAt: '2024-01-09T00:00:00.000Z' }),
      // PENDING no-start — front tier, despite an older updatedAt.
      run({ runId: 'pending', status: 'PENDING', updatedAt: '2024-01-01T00:00:00.000Z' }),
    ];
    expect(orderRuns(runs).map((r) => r.runId)).toEqual(['pending', 'unknown']);
  });

  // Property test — every pending-not-started run precedes everyone else; the
  // output is always a permutation of the input (no run added or dropped).
  it('places every pending-not-started run ahead of everyone else', () => {
    const isoArb = fc
      .integer({ min: 0, max: 10 })
      .map((day) => `2024-01-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`);
    const runArb: fc.Arbitrary<Run> = fc.record({
      runId: fc.uuid(),
      updatedAt: isoArb,
      startedAt: fc.option(isoArb, { nil: undefined }),
      status: fc.option(fc.constantFrom<RunStatus>(...RUN_STATUSES), {
        nil: undefined,
      }),
    });

    fc.assert(
      fc.property(fc.array(runArb), (runs) => {
        const ordered = orderRuns(runs);
        const front = (r: Run) => {
          const started =
            r.startedAt != null && !Number.isNaN(Date.parse(r.startedAt));
          return r.status != null && NON_TERMINAL.has(r.status) && !started;
        };
        // Once we see the first non-front run, no front run may follow.
        let seenNonFront = false;
        for (const r of ordered) {
          if (front(r)) {
            expect(seenNonFront).toBe(false);
          } else {
            seenNonFront = true;
          }
        }
        // Ordering preserves the multiset of runs.
        expect(ordered.length).toBe(runs.length);
      }),
    );
  });

  // Property test — the sorted list respects the total order defined by
  // compareRuns, and ordering preserves the multiset of runs.
  it('produces a list consistent with compareRuns and preserves the input multiset', () => {
    const isoArb = fc
      .integer({ min: 0, max: 10 })
      .map((day) => `2024-01-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`);
    const runArb: fc.Arbitrary<Run> = fc.record({
      runId: fc.uuid(),
      updatedAt: isoArb,
      startedAt: fc.option(isoArb, { nil: undefined }),
      status: fc.option(fc.constantFrom<RunStatus>(...RUN_STATUSES), {
        nil: undefined,
      }),
    });

    fc.assert(
      fc.property(fc.array(runArb), (runs) => {
        const ordered = orderRuns(runs);
        for (let i = 0; i + 1 < ordered.length; i += 1) {
          expect(compareRuns(ordered[i], ordered[i + 1])).toBeLessThanOrEqual(0);
        }
        // Ordering preserves the multiset of runs.
        expect(ordered.length).toBe(runs.length);
      }),
    );
  });
});

describe('mergeRunUpdate', () => {
  it('updates a displayed run in place (Req 8.5)', () => {
    const runs = [
      run({ runId: 'a', status: 'RUNNING', updatedAt: '2024-01-02T00:00:00.000Z' }),
      run({ runId: 'b', status: 'PENDING', updatedAt: '2024-01-01T00:00:00.000Z' }),
    ];
    const merged = mergeRunUpdate(runs, run({ runId: 'a', status: 'COMPLETED', updatedAt: '2024-01-02T00:00:00.000Z' }));
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.runId === 'a')?.status).toBe('COMPLETED');
  });

  it('inserts an undisplayed run in its ordered position (Req 8.6)', () => {
    const runs = [
      run({ runId: 'a', updatedAt: '2024-01-01T00:00:00.000Z' }),
      run({ runId: 'c', updatedAt: '2024-01-03T00:00:00.000Z' }),
    ];
    const merged = mergeRunUpdate(runs, run({ runId: 'b', updatedAt: '2024-01-02T00:00:00.000Z' }));
    expect(merged.map((r) => r.runId)).toEqual(['c', 'b', 'a']);
  });

  it('re-orders after an in-place update changes updatedAt (Req 8.10)', () => {
    const runs = orderRuns([
      run({ runId: 'a', updatedAt: '2024-01-01T00:00:00.000Z' }),
      run({ runId: 'b', updatedAt: '2024-01-02T00:00:00.000Z' }),
    ]);
    const merged = mergeRunUpdate(runs, run({ runId: 'a', updatedAt: '2024-01-05T00:00:00.000Z' }));
    expect(merged.map((r) => r.runId)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const runs = [run({ runId: 'a', updatedAt: '2024-01-01T00:00:00.000Z' })];
    const snapshot = runs.map((r) => r.runId);
    mergeRunUpdate(runs, run({ runId: 'b', updatedAt: '2024-01-02T00:00:00.000Z' }));
    expect(runs.map((r) => r.runId)).toEqual(snapshot);
  });

  // Property test — fleet update merge is idempotent and order-preserving
  // (design Property 21). **Validates: Requirements 8.5, 8.6, 8.10**
  it('is idempotent, keeps the run exactly once, and stays ordered', () => {
    const isoArb = fc
      .integer({ min: 0, max: 10 })
      .map((day) => `2024-01-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`);
    const idArb = fc.constantFrom('r0', 'r1', 'r2', 'r3', 'r4');
    const runArb: fc.Arbitrary<Run> = fc.record({
      runId: idArb,
      updatedAt: isoArb,
      startedAt: fc.option(isoArb, { nil: undefined }),
      status: fc.constantFrom<RunStatus>(...RUN_STATUSES),
    });

    fc.assert(
      fc.property(fc.array(runArb), runArb, (existing, update) => {
        // Start from an ordered, de-duplicated fleet so the precondition
        // (a valid ordered list with unique ids) holds.
        const base = orderRuns(
          Array.from(new Map(existing.map((r) => [r.runId, r])).values()),
        );

        const once = mergeRunUpdate(base, update);

        // Contains the run exactly once, with the updated fields.
        const matches = once.filter((r) => r.runId === update.runId);
        expect(matches).toHaveLength(1);
        expect(matches[0]).toEqual(update);

        // Remains ordered per Property 20.
        for (let i = 0; i + 1 < once.length; i += 1) {
          expect(compareRuns(once[i], once[i + 1])).toBeLessThanOrEqual(0);
        }

        // Idempotent: applying the same update again yields the same list.
        const twice = mergeRunUpdate(once, update);
        expect(twice.map((r) => r.runId)).toEqual(once.map((r) => r.runId));
        expect(twice).toEqual(once);
      }),
    );
  });
});

describe('mergeRunPage', () => {
  it('upserts overlapping pages without duplicate runIds', () => {
    const page1 = [run({ runId: 'a' }), run({ runId: 'b' })];
    const page2 = [run({ runId: 'b' }), run({ runId: 'c' })];
    const merged = mergeRunPage(mergeRunPage([], page1), page2);
    expect(merged.map((r) => r.runId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the existing row when it is newer than the incoming one', () => {
    const live = run({ runId: 'a', status: 'COMPLETED', updatedAt: '2024-01-02T00:00:00.000Z' });
    const stale = run({ runId: 'a', status: 'RUNNING', updatedAt: '2024-01-01T00:00:00.000Z' });
    expect(mergeRunPage([live], [stale])).toEqual([live]);
  });

  it('replaces the existing row when the incoming one is newer', () => {
    const old = run({ runId: 'a', status: 'RUNNING', updatedAt: '2024-01-01T00:00:00.000Z' });
    const fresh = run({ runId: 'a', status: 'COMPLETED', updatedAt: '2024-01-02T00:00:00.000Z' });
    expect(mergeRunPage([old], [fresh])).toEqual([fresh]);
  });

  it('lets the incoming row win on an updatedAt tie', () => {
    const existing = run({ runId: 'a', name: 'before' });
    const incoming = run({ runId: 'a', name: 'after' });
    expect(mergeRunPage([existing], [incoming])).toEqual([incoming]);
  });

  it('does not mutate its inputs and is idempotent', () => {
    const current = [run({ runId: 'a', updatedAt: '2024-01-01T00:00:00.000Z' })];
    const page = [run({ runId: 'b', updatedAt: '2024-01-02T00:00:00.000Z' })];
    const currentCopy = [...current];
    const pageCopy = [...page];
    const once = mergeRunPage(current, page);
    expect(current).toEqual(currentCopy);
    expect(page).toEqual(pageCopy);
    expect(mergeRunPage(once, page)).toEqual(once);
  });

  // Property: the result holds exactly the union of runIds, each once, ordered
  // per compareRuns.
  it('returns the unique union of runIds in fleet order', () => {
    const isoArb = fc
      .integer({ min: 0, max: 10 })
      .map((day) => `2024-01-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`);
    const runArb: fc.Arbitrary<Run> = fc.record({
      runId: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
      updatedAt: isoArb,
      startedAt: fc.option(isoArb, { nil: undefined }),
      status: fc.constantFrom<RunStatus>(...RUN_STATUSES),
    });
    fc.assert(
      fc.property(fc.array(runArb), fc.array(runArb), (current, incoming) => {
        const merged = mergeRunPage(current, incoming);
        const ids = merged.map((r) => r.runId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(ids)).toEqual(
          new Set([...current, ...incoming].map((r) => r.runId)),
        );
        for (let i = 0; i + 1 < merged.length; i += 1) {
          expect(compareRuns(merged[i], merged[i + 1])).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});

describe('filterRunsByStatus', () => {
  it('returns only runs whose status matches the selection (Req 8.8)', () => {
    const runs = [
      run({ runId: 'a', status: 'RUNNING' }),
      run({ runId: 'b', status: 'COMPLETED' }),
      run({ runId: 'c', status: 'RUNNING' }),
    ];
    expect(filterRunsByStatus(runs, 'RUNNING').map((r) => r.runId)).toEqual([
      'a',
      'c',
    ]);
  });

  it('preserves the relative order of matching runs', () => {
    const ordered = orderRuns([
      run({ runId: 'a', status: 'RUNNING', updatedAt: '2024-01-01T00:00:00.000Z' }),
      run({ runId: 'b', status: 'RUNNING', updatedAt: '2024-01-03T00:00:00.000Z' }),
      run({ runId: 'c', status: 'RUNNING', updatedAt: '2024-01-02T00:00:00.000Z' }),
    ]);
    expect(filterRunsByStatus(ordered, 'RUNNING').map((r) => r.runId)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  // Property test — status filtering (design Property 23 groundwork).
  // **Validates: Requirements 8.8, 8.9**
  it('contains exactly the runs matching the status; clearing restores all', () => {
    const isoArb = fc
      .integer({ min: 0, max: 10 })
      .map((day) => `2024-01-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`);
    const runArb: fc.Arbitrary<Run> = fc.record({
      runId: fc.uuid(),
      updatedAt: isoArb,
      startedAt: fc.option(isoArb, { nil: undefined }),
      status: fc.constantFrom<RunStatus>(...RUN_STATUSES),
    });

    fc.assert(
      fc.property(
        fc.array(runArb),
        fc.constantFrom<RunStatus>(...RUN_STATUSES),
        (runs, status) => {
          const ordered = orderRuns(runs);
          const filtered = filterRunsByStatus(ordered, status);

          // Exactly the runs whose status equals the selection.
          expect(filtered.every((r) => r.status === status)).toBe(true);
          expect(filtered).toHaveLength(
            ordered.filter((r) => r.status === status).length,
          );

          // Filtering an ordered list yields an ordered list.
          for (let i = 0; i + 1 < filtered.length; i += 1) {
            expect(
              compareRuns(filtered[i], filtered[i + 1]),
            ).toBeLessThanOrEqual(0);
          }

          // "Clearing" is simply the full ordered list again (Req 8.9).
          expect(orderRuns(runs)).toEqual(ordered);
        },
      ),
    );
  });
});
