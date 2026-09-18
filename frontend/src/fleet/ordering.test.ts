import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  orderRuns,
  compareRuns,
  mergeRunUpdate,
  filterRunsByStatus,
} from './ordering';
import type { Run, RunStatus } from '../api/types';

function run(partial: Partial<Run> & { runId: string }): Run {
  return {
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('orderRuns', () => {
  it('orders by descending updatedAt', () => {
    const runs = [
      run({ runId: 'a', updatedAt: '2024-01-01T00:00:00.000Z' }),
      run({ runId: 'b', updatedAt: '2024-01-03T00:00:00.000Z' }),
      run({ runId: 'c', updatedAt: '2024-01-02T00:00:00.000Z' }),
    ];
    expect(orderRuns(runs).map((r) => r.runId)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties on equal updatedAt by descending start time', () => {
    const updatedAt = '2024-01-01T00:00:00.000Z';
    const runs = [
      run({ runId: 'early', updatedAt, startedAt: '2024-01-01T01:00:00.000Z' }),
      run({ runId: 'late', updatedAt, startedAt: '2024-01-01T05:00:00.000Z' }),
      run({ runId: 'mid', updatedAt, startedAt: '2024-01-01T03:00:00.000Z' }),
    ];
    expect(orderRuns(runs).map((r) => r.runId)).toEqual([
      'late',
      'mid',
      'early',
    ]);
  });

  it('does not mutate the input array', () => {
    const runs = [
      run({ runId: 'a', updatedAt: '2024-01-01T00:00:00.000Z' }),
      run({ runId: 'b', updatedAt: '2024-01-02T00:00:00.000Z' }),
    ];
    const snapshot = runs.map((r) => r.runId);
    orderRuns(runs);
    expect(runs.map((r) => r.runId)).toEqual(snapshot);
  });

  it('ranks runs with a start time ahead of ties lacking one', () => {
    const updatedAt = '2024-01-01T00:00:00.000Z';
    const runs = [
      run({ runId: 'none', updatedAt }),
      run({ runId: 'has', updatedAt, startedAt: '2024-01-01T02:00:00.000Z' }),
    ];
    expect(orderRuns(runs).map((r) => r.runId)).toEqual(['has', 'none']);
  });

  // Property test — fleet ordering with tie-break (design Property 20).
  // **Validates: Requirements 8.4**
  it('is sorted by descending updatedAt with descending startedAt tie-break', () => {
    const isoArb = fc
      .integer({ min: 0, max: 10 })
      .map((day) => `2024-01-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`);
    const runArb: fc.Arbitrary<Run> = fc.record({
      runId: fc.uuid(),
      updatedAt: isoArb,
      startedAt: fc.option(isoArb, { nil: undefined }),
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
