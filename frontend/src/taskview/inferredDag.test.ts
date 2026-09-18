import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildInferredDagOrdering } from './inferredDag';
import { makeTask } from './testFactories';
import type { InferredDagOrdering } from './types';

const iso = (ms: number): string => new Date(ms).toISOString();

/** Map each task id to the order of the level it landed in. */
function orderByTaskId(result: InferredDagOrdering): Map<string, number> {
  const map = new Map<string, number>();
  for (const level of result.levels) {
    for (const task of level.tasks) {
      map.set(task.taskId, level.order);
    }
  }
  return map;
}

describe('buildInferredDagOrdering (Req 7.2)', () => {
  it('places an earlier-starting task in an earlier level', () => {
    const early = makeTask({ taskId: 'early', startedAt: iso(0), stoppedAt: iso(100) });
    const late = makeTask({ taskId: 'late', startedAt: iso(200), stoppedAt: iso(300) });
    const result = buildInferredDagOrdering([late, early]);
    const order = orderByTaskId(result);
    expect(order.get('early')!).toBeLessThan(order.get('late')!);
  });

  it('groups overlapping-interval tasks into the same level (concurrent)', () => {
    const a = makeTask({ taskId: 'a', startedAt: iso(0), stoppedAt: iso(100) });
    const b = makeTask({ taskId: 'b', startedAt: iso(50), stoppedAt: iso(150) });
    const result = buildInferredDagOrdering([a, b]);
    const order = orderByTaskId(result);
    expect(order.get('a')).toBe(order.get('b'));
    expect(result.levels).toHaveLength(1);
    expect(result.levels[0].tasks).toHaveLength(2);
  });

  it('separates non-overlapping tasks into distinct ordered levels', () => {
    const a = makeTask({ taskId: 'a', startedAt: iso(0), stoppedAt: iso(100) });
    const b = makeTask({ taskId: 'b', startedAt: iso(100), stoppedAt: iso(200) });
    const result = buildInferredDagOrdering([a, b]);
    expect(result.levels).toHaveLength(2);
  });

  it('treats a still-running (open) task as overlapping later starts', () => {
    const running = makeTask({ taskId: 'r', startedAt: iso(0), stoppedAt: null });
    const later = makeTask({ taskId: 'l', startedAt: iso(500), stoppedAt: iso(600) });
    const result = buildInferredDagOrdering([running, later]);
    const order = orderByTaskId(result);
    expect(order.get('r')).toBe(order.get('l'));
  });

  it('places untimed tasks in a trailing level', () => {
    const timed = makeTask({ taskId: 't', startedAt: iso(0), stoppedAt: iso(10) });
    const untimed = makeTask({ taskId: 'u', startedAt: null, stoppedAt: null });
    const result = buildInferredDagOrdering([timed, untimed]);
    const order = orderByTaskId(result);
    expect(order.get('u')!).toBeGreaterThan(order.get('t')!);
  });

  it('returns no levels for zero tasks', () => {
    expect(buildInferredDagOrdering([]).levels).toEqual([]);
  });

  // Property 18: Inferred DAG ordering (Validates: Requirements 7.2)
  it('Property 18: earlier start placed no later, and overlapping tasks share a level', () => {
    const intervalArb = fc
      .tuple(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
      )
      .map(([s, d]) => ({ start: s, stop: s + d }));

    fc.assert(
      fc.property(
        fc.array(intervalArb, { minLength: 1, maxLength: 12 }),
        (intervals) => {
          const tasks = intervals.map((iv, i) =>
            makeTask({
              taskId: `t${i}`,
              startedAt: iso(iv.start),
              stoppedAt: iso(iv.stop),
            }),
          );
          const result = buildInferredDagOrdering(tasks);
          const order = orderByTaskId(result);
          const startOf = new Map(intervals.map((iv, i) => [`t${i}`, iv.start]));
          const endOf = new Map(intervals.map((iv, i) => [`t${i}`, iv.stop]));

          for (let i = 0; i < tasks.length; i++) {
            for (let j = 0; j < tasks.length; j++) {
              const idI = `t${i}`;
              const idJ = `t${j}`;
              const si = startOf.get(idI)!;
              const sj = startOf.get(idJ)!;
              // Earlier start placed no later.
              if (si < sj) {
                expect(order.get(idI)!).toBeLessThanOrEqual(order.get(idJ)!);
              }
              // Strictly overlapping intervals must share a level (concurrent).
              const ei = endOf.get(idI)!;
              const ej = endOf.get(idJ)!;
              const overlaps = si < ej && sj < ei;
              if (overlaps) {
                expect(order.get(idI)).toBe(order.get(idJ));
              }
            }
          }
        },
      ),
    );
  });
});
