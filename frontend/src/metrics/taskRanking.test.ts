import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { rankByDuration, topLongest, slowestTaskId } from './taskRanking';
import { makeTask } from '../taskview/testFactories';
import { durationMs } from '../fleet/duration';
import type { Task } from '../api/types';

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A fixed `now` used across the property tests so every duration is
 * deterministic (Req 3, "against a fixed Now").
 */
const NOW = 1_000_000_000_000;

/**
 * Generates a task whose timing is one of:
 *  - closed: parseable start and stop (known finite duration),
 *  - running: parseable start, no stop (known elapsed-so-far duration vs NOW),
 *  - unknown: absent/unparseable start (unknown duration, sorts last).
 * `startedAt` is kept <= NOW so running tasks have a non-negative elapsed time,
 * and stops are kept >= start so closed durations are the intuitive span.
 */
const taskArb: fc.Arbitrary<Task> = fc
  .record({
    id: fc.integer({ min: 0, max: 100_000 }),
    kind: fc.constantFrom<'closed' | 'running' | 'unknown'>(
      'closed',
      'running',
      'unknown',
    ),
    start: fc.integer({ min: 0, max: NOW }),
    span: fc.integer({ min: 0, max: 10_000_000 }),
    badStart: fc.constantFrom<string | null | undefined>(
      null,
      undefined,
      'not-a-date',
    ),
  })
  .map(({ id, kind, start, span, badStart }) => {
    if (kind === 'unknown') {
      return makeTask({
        taskId: `t${id}`,
        startedAt: badStart,
        stoppedAt: null,
      });
    }
    if (kind === 'running') {
      return makeTask({
        taskId: `t${id}`,
        startedAt: iso(start),
        stoppedAt: null,
      });
    }
    return makeTask({
      taskId: `t${id}`,
      startedAt: iso(start),
      stoppedAt: iso(start + span),
    });
  });

/** A list of tasks with unique ids so we can reason about permutations. */
const tasksArb: fc.Arbitrary<Task[]> = fc
  .array(taskArb, { minLength: 0, maxLength: 15 })
  .map((tasks) =>
    tasks.map((task, index) => makeTask({ ...task, taskId: `t${index}` })),
  );

const known = (task: Task): number | null =>
  durationMs(task.startedAt, task.stoppedAt, NOW);

describe('rankByDuration (Req 3.1, 3.2, 3.3)', () => {
  it('ranks a longer task ahead of a shorter one', () => {
    const short = makeTask({ taskId: 's', startedAt: iso(0), stoppedAt: iso(100) });
    const long = makeTask({ taskId: 'l', startedAt: iso(0), stoppedAt: iso(500) });
    const ranked = rankByDuration([short, long], NOW);
    expect(ranked.map((r) => r.task.taskId)).toEqual(['l', 's']);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(2);
  });

  it('places unknown-duration tasks last, preserving their input order', () => {
    const u1 = makeTask({ taskId: 'u1', startedAt: null, stoppedAt: null });
    const timed = makeTask({ taskId: 't', startedAt: iso(0), stoppedAt: iso(100) });
    const u2 = makeTask({ taskId: 'u2', startedAt: null, stoppedAt: null });
    const ranked = rankByDuration([u1, timed, u2], NOW);
    expect(ranked.map((r) => r.task.taskId)).toEqual(['t', 'u1', 'u2']);
  });

  it('returns an empty ranking for no tasks', () => {
    expect(rankByDuration([], NOW)).toEqual([]);
  });

  // Property 6: Ranking is a stable total order with unknowns last.
  // **Validates: Requirements 3.1, 3.2, 3.3**
  it('Property 6: one entry per task, knowns first sorted non-increasing, unknowns last in input order, ranks 1-based non-decreasing', () => {
    fc.assert(
      fc.property(tasksArb, (tasks) => {
        const ranked = rankByDuration(tasks, NOW);

        // One ranked entry per input task, and the set of ids is a permutation.
        expect(ranked).toHaveLength(tasks.length);
        expect([...ranked.map((r) => r.task.taskId)].sort()).toEqual(
          [...tasks.map((t) => t.taskId)].sort(),
        );

        // Each entry's reported durationMs matches the source-of-truth helper.
        for (const entry of ranked) {
          expect(entry.durationMs).toBe(known(entry.task));
        }

        const firstUnknown = ranked.findIndex((r) => r.durationMs == null);
        const boundary = firstUnknown === -1 ? ranked.length : firstUnknown;

        // Every known-duration entry precedes every unknown-duration entry.
        for (let i = boundary; i < ranked.length; i++) {
          expect(ranked[i].durationMs).toBeNull();
        }

        // Known-duration prefix is non-increasing in durationMs.
        for (let i = 1; i < boundary; i++) {
          expect(ranked[i - 1].durationMs as number).toBeGreaterThanOrEqual(
            ranked[i].durationMs as number,
          );
        }

        // Unknown-duration suffix preserves input order (stable).
        const inputOrder = new Map(tasks.map((t, i) => [t.taskId, i]));
        for (let i = boundary + 1; i < ranked.length; i++) {
          expect(inputOrder.get(ranked[i].task.taskId)!).toBeGreaterThan(
            inputOrder.get(ranked[i - 1].task.taskId)!,
          );
        }

        // Ranks are 1-based and non-decreasing down the list.
        if (ranked.length > 0) {
          expect(ranked[0].rank).toBe(1);
        }
        for (let i = 1; i < ranked.length; i++) {
          expect(ranked[i].rank).toBeGreaterThanOrEqual(ranked[i - 1].rank);
        }

        // topLongest returns only known-duration entries and at most n.
        const n = 5;
        const top = topLongest(tasks, n, NOW);
        expect(top.length).toBeLessThanOrEqual(n);
        expect(top.length).toBeLessThanOrEqual(boundary);
        for (const entry of top) {
          expect(entry.durationMs).not.toBeNull();
        }
      }),
    );
  });
});

describe('slowestTaskId (Req 3.4, 3.5)', () => {
  it('returns null when no task has a known duration', () => {
    const u1 = makeTask({ taskId: 'u1', startedAt: null, stoppedAt: null });
    const u2 = makeTask({ taskId: 'u2', startedAt: 'nope', stoppedAt: null });
    expect(slowestTaskId([u1, u2], NOW)).toBeNull();
  });

  it('resolves ties to the earliest startedAt', () => {
    const later = makeTask({ taskId: 'later', startedAt: iso(1000), stoppedAt: iso(2000) });
    const earlier = makeTask({ taskId: 'earlier', startedAt: iso(0), stoppedAt: iso(1000) });
    // Both have a 1000ms duration; earliest start wins.
    expect(slowestTaskId([later, earlier], NOW)).toBe('earlier');
  });

  // Property 7: Slowest id is the argmax of duration.
  // **Validates: Requirements 3.4, 3.5**
  it('Property 7: null iff no known duration; otherwise argmax by duration with earliest-start tie-break', () => {
    fc.assert(
      fc.property(tasksArb, (tasks) => {
        const slowest = slowestTaskId(tasks, NOW);

        const knownTasks = tasks.filter((t) => known(t) != null);

        if (knownTasks.length === 0) {
          // Null iff no task has a known duration.
          expect(slowest).toBeNull();
          return;
        }

        // Non-null result must be one of the input tasks.
        expect(slowest).not.toBeNull();
        const winner = tasks.find((t) => t.taskId === slowest);
        expect(winner).toBeDefined();

        const winnerDuration = known(winner!) as number;
        // The winner's duration is >= every other task's known duration.
        const maxDuration = Math.max(
          ...knownTasks.map((t) => known(t) as number),
        );
        expect(winnerDuration).toBe(maxDuration);

        // Tie-break: among all tasks tied at the max duration, the winner is
        // the one with the earliest parseable startedAt.
        const startEpoch = (t: Task): number => {
          const ms = t.startedAt == null ? NaN : Date.parse(t.startedAt);
          return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
        };
        const tied = knownTasks.filter(
          (t) => (known(t) as number) === maxDuration,
        );
        const earliestStart = Math.min(...tied.map(startEpoch));
        expect(startEpoch(winner!)).toBe(earliestStart);
      }),
    );
  });
});
