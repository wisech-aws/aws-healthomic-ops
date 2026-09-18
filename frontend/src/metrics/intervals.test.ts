import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { toIntervals, peakConcurrent, type TaskInterval } from './intervals';
import { makeTask } from '../taskview/testFactories';
import type { Task } from '../api/types';

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Arbitrary for a Task whose timing fields explore all the branches
 * `toIntervals` cares about: a parseable start or an absent/unparseable one, and
 * a parseable stop, an absent stop (running), or an unparseable stop.
 */
const taskArb: fc.Arbitrary<Task> = fc.record({
  taskId: fc.string({ minLength: 1, maxLength: 8 }),
  startedAt: fc.oneof(
    fc.integer({ min: 0, max: 10_000_000 }).map(iso), // parseable
    fc.constant(null), // absent
    fc.constant('not-a-date'), // unparseable
  ),
  stoppedAt: fc.oneof(
    fc.integer({ min: 0, max: 10_000_000 }).map(iso), // parseable
    fc.constant(null), // absent (running)
    fc.constant('nope'), // unparseable (treated as running)
  ),
  cpus: fc.oneof(fc.integer({ min: 0, max: 64 }), fc.constant(null)),
  memory: fc.oneof(fc.integer({ min: 0, max: 1024 }), fc.constant(null)),
}).map((fields) =>
  makeTask({
    taskId: fields.taskId,
    startedAt: fields.startedAt,
    stoppedAt: fields.stoppedAt,
    cpus: fields.cpus,
    memory: fields.memory,
  }),
);

const hasParseableStart = (t: Task): boolean =>
  t.startedAt != null && !Number.isNaN(Date.parse(t.startedAt));

const hasParseableStop = (t: Task): boolean =>
  t.stoppedAt != null && !Number.isNaN(Date.parse(t.stoppedAt));

describe('toIntervals (Req 2.1, 10.1, 10.3, 10.4)', () => {
  it('drops a task with absent startedAt', () => {
    const t = makeTask({ startedAt: null });
    expect(toIntervals([t])).toEqual([]);
  });

  it('drops a task with unparseable startedAt', () => {
    const t = makeTask({ startedAt: 'garbage' });
    expect(toIntervals([t])).toEqual([]);
  });

  it('closes a running (no stop) task at now and flags it open', () => {
    const now = 5_000;
    const t = makeTask({ startedAt: iso(1_000), stoppedAt: null });
    const [iv] = toIntervals([t], now);
    expect(iv.start).toBe(1_000);
    expect(iv.end).toBe(now);
    expect(iv.open).toBe(true);
  });

  it('treats an unparseable stop as running (open, end = now)', () => {
    const now = 8_000;
    const t = makeTask({ startedAt: iso(2_000), stoppedAt: 'bad' });
    const [iv] = toIntervals([t], now);
    expect(iv.end).toBe(now);
    expect(iv.open).toBe(true);
  });

  it('clamps an inverted interval (stop before start) to end = start', () => {
    const t = makeTask({ startedAt: iso(500), stoppedAt: iso(100) });
    const [iv] = toIntervals([t]);
    expect(iv.start).toBe(500);
    expect(iv.end).toBe(500);
  });

  // Property 2: Intervals never fabricate execution
  // Validates: Requirements 2.1, 10.1, 10.3, 10.4
  it('Property 2: intervals never fabricate execution', () => {
    fc.assert(
      fc.property(
        fc.array(taskArb, { maxLength: 15 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        (tasks, now) => {
          const intervals = toIntervals(tasks, now);
          const startedTasks = tasks.filter(hasParseableStart);

          // Output length never exceeds the input, and equals the count of
          // tasks with a parseable start (no fabrication, none dropped wrongly).
          expect(intervals.length).toBeLessThanOrEqual(tasks.length);
          expect(intervals.length).toBe(startedTasks.length);

          // Every produced interval maps positionally to a started task, in
          // input order, and never invents an id.
          for (let k = 0; k < intervals.length; k++) {
            const iv = intervals[k];
            const src = startedTasks[k];
            expect(iv.taskId).toBe(src.taskId);
            expect(iv.start).toBe(Date.parse(src.startedAt!));

            // start <= end always holds (inverted intervals are clamped).
            expect(iv.start).toBeLessThanOrEqual(iv.end);

            // open iff the source task had no parseable stop.
            expect(iv.open).toBe(!hasParseableStop(src));
            if (iv.open) {
              // A running task extends exactly to now.
              expect(iv.end).toBe(now < iv.start ? iv.start : now);
            } else {
              const rawEnd = Date.parse(src.stoppedAt!);
              expect(iv.end).toBe(rawEnd < iv.start ? iv.start : rawEnd);
            }

            // Resource fields are carried through, null when absent.
            expect(iv.cpus).toBe(src.cpus ?? null);
            expect(iv.memory).toBe(src.memory ?? null);
          }

          // No task lacking a usable start produced an interval.
          const producedIds = new Set(intervals.map((i) => i.taskId));
          for (const t of tasks) {
            if (!hasParseableStart(t) && !startedTasks.some((s) => s.taskId === t.taskId)) {
              expect(producedIds.has(t.taskId)).toBe(false);
            }
          }
        },
      ),
    );
  });
});

/**
 * Brute-force reference for peak concurrency over half-open intervals.
 * Samples every start instant (the only instants where the active count can
 * increase) and computes the max count and max summed weight of intervals whose
 * `[start, end)` contains that instant.
 */
function referencePeak(
  intervals: readonly TaskInterval[],
  weight: (i: TaskInterval) => number,
): { peakCount: number; peakWeight: number } {
  let peakCount = 0;
  let peakWeight = 0;
  // The active set can only grow at a start boundary; sampling every start
  // instant is sufficient to find both maxima for half-open intervals.
  for (const probe of intervals) {
    const t = probe.start;
    let count = 0;
    let w = 0;
    for (const i of intervals) {
      if (i.start <= t && t < i.end) {
        count += 1;
        w += weight(i);
      }
    }
    if (count > peakCount) peakCount = count;
    if (w > peakWeight) peakWeight = w;
  }
  return { peakCount, peakWeight };
}

/** Arbitrary for a well-formed interval (start <= end), as toIntervals emits. */
const intervalArb: fc.Arbitrary<TaskInterval> = fc
  .record({
    taskId: fc.string({ minLength: 1, maxLength: 6 }),
    start: fc.integer({ min: 0, max: 1_000 }),
    len: fc.integer({ min: 0, max: 500 }),
    cpus: fc.integer({ min: 0, max: 32 }),
    memory: fc.integer({ min: 0, max: 256 }),
  })
  .map(({ taskId, start, len, cpus, memory }) => ({
    taskId,
    start,
    end: start + len,
    cpus,
    memory,
    open: false,
  }));

const byCpus = (i: TaskInterval): number => i.cpus ?? 0;

describe('peakConcurrent (Req 2.2, 2.3, 11.3)', () => {
  it('returns {0,0} for empty input', () => {
    expect(peakConcurrent([], byCpus)).toEqual({ peakCount: 0, peakWeight: 0 });
  });

  it('does not count a task ending exactly when another starts (half-open)', () => {
    const first: TaskInterval = {
      taskId: 'a', start: 0, end: 100, cpus: 2, memory: 4, open: false,
    };
    const second: TaskInterval = {
      taskId: 'b', start: 100, end: 200, cpus: 3, memory: 8, open: false,
    };
    const { peakCount, peakWeight } = peakConcurrent([first, second], byCpus);
    expect(peakCount).toBe(1);
    expect(peakWeight).toBe(3); // never 2 + 3
  });

  it('peakWeight sums the weight over the concurrent set', () => {
    const a: TaskInterval = { taskId: 'a', start: 0, end: 100, cpus: 2, memory: 4, open: false };
    const b: TaskInterval = { taskId: 'b', start: 10, end: 100, cpus: 3, memory: 8, open: false };
    const c: TaskInterval = { taskId: 'c', start: 20, end: 100, cpus: 5, memory: 1, open: false };
    const { peakCount, peakWeight } = peakConcurrent([a, b, c], byCpus);
    expect(peakCount).toBe(3);
    expect(peakWeight).toBe(2 + 3 + 5);
  });

  // Property 3: Peak concurrency equals the true overlap maximum
  // Validates: Requirements 2.2, 2.3, 11.3
  it('Property 3: peak concurrency equals the true overlap maximum', () => {
    fc.assert(
      fc.property(
        fc.array(intervalArb, { maxLength: 20 }),
        (intervals) => {
          const sweep = peakConcurrent(intervals, byCpus);
          const reference = referencePeak(intervals, byCpus);
          expect(sweep).toEqual(reference);

          // Empty input yields {0, 0}.
          if (intervals.length === 0) {
            expect(sweep).toEqual({ peakCount: 0, peakWeight: 0 });
          }
        },
      ),
    );
  });

  it('Property 3: half-open semantics — touching intervals never overlap', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            taskId: fc.string({ minLength: 1, maxLength: 6 }),
            start: fc.integer({ min: 0, max: 500 }),
            len: fc.integer({ min: 0, max: 300 }),
            cpus: fc.integer({ min: 0, max: 16 }),
          }),
          { maxLength: 15 },
        ),
        (specs) => {
          const intervals: TaskInterval[] = specs.map((s) => ({
            taskId: s.taskId,
            start: s.start,
            end: s.start + s.len,
            cpus: s.cpus,
            memory: null,
            open: false,
          }));
          // The sweep must match the half-open reference in every case.
          expect(peakConcurrent(intervals, byCpus)).toEqual(
            referencePeak(intervals, byCpus),
          );
        },
      ),
    );
  });
});
