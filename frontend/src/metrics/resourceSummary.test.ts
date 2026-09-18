import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  summarizeResources,
  MEMORY_UNITS_UNCONFIRMED_NOTE,
} from './resourceSummary';
import { toIntervals, peakConcurrent, type TaskInterval } from './intervals';
import { makeTask } from '../taskview/testFactories';
import type { Task } from '../api/types';

const iso = (ms: number): string => new Date(ms).toISOString();

const MS_PER_HOUR = 3_600_000;

/**
 * Arbitrary for a Task exercising every branch `summarizeResources` cares
 * about: a parseable start or an absent/unparseable one, a parseable stop, an
 * absent stop (running), or an unparseable stop (treated as running), and
 * `cpus`/`memory` that are either a non-null number or explicitly `null`.
 */
const taskArb: fc.Arbitrary<Task> = fc
  .record({
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
  })
  .map((fields) =>
    makeTask({
      taskId: fields.taskId,
      startedAt: fields.startedAt,
      stoppedAt: fields.stoppedAt,
      cpus: fields.cpus,
      memory: fields.memory,
    }),
  );

/**
 * Independent reference for the presence of at least one non-null field among
 * the intervals a task set produces. Recomputes intervals via `toIntervals`
 * (the boundary the metrics are defined against) rather than trusting the
 * summary under test.
 */
const someIntervalHas = (
  intervals: readonly TaskInterval[],
  pick: (i: TaskInterval) => number | null,
): boolean => intervals.some((i) => pick(i) != null);

describe('summarizeResources — Property 4: metrics available exactly when inputs exist (Req 2.5, 2.6, 2.7, 10.1, 10.4)', () => {
  it('empty input reports all metrics unavailable and zero peak tasks', () => {
    const summary = summarizeResources([]);
    expect(summary.peakConcurrentTasks).toBe(0);
    expect(summary.peakConcurrentCpus).toEqual({ value: null, available: false });
    expect(summary.cpuHours).toEqual({ value: null, available: false });
    expect(summary.peakConcurrentMemory.available).toBe(false);
    expect(summary.peakConcurrentMemory.value).toBeNull();
    expect(summary.partial).toBe(false);
  });

  // Property 4: Resource metrics are available exactly when their inputs exist.
  // Validates: Requirements 2.5, 2.6, 2.7, 10.1, 10.4
  it('Property 4: availability matches the presence of the metric input, never 0-as-data', () => {
    fc.assert(
      fc.property(
        fc.array(taskArb, { maxLength: 15 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        (tasks, now) => {
          const summary = summarizeResources(tasks, now);
          const intervals = toIntervals(tasks, now);

          const hasCpus = someIntervalHas(intervals, (i) => i.cpus);
          const hasMemory = someIntervalHas(intervals, (i) => i.memory);
          const anyOpen = intervals.some((i) => i.open);

          // CPU metrics available iff some started task carries non-null cpus.
          expect(summary.peakConcurrentCpus.available).toBe(hasCpus);
          expect(summary.cpuHours.available).toBe(hasCpus);
          // Memory available iff some started task carries non-null memory.
          expect(summary.peakConcurrentMemory.available).toBe(hasMemory);

          // Unavailable metrics carry a null value (never 0-as-data);
          // available metrics carry a concrete number.
          if (hasCpus) {
            expect(typeof summary.peakConcurrentCpus.value).toBe('number');
            expect(typeof summary.cpuHours.value).toBe('number');
          } else {
            expect(summary.peakConcurrentCpus.value).toBeNull();
            expect(summary.cpuHours.value).toBeNull();
          }
          if (hasMemory) {
            expect(typeof summary.peakConcurrentMemory.value).toBe('number');
          } else {
            expect(summary.peakConcurrentMemory.value).toBeNull();
          }

          // partial is true iff any interval is still open (provisional).
          expect(summary.partial).toBe(anyOpen);

          // peakConcurrentTasks is a non-negative count, 0 iff no intervals.
          expect(summary.peakConcurrentTasks).toBeGreaterThanOrEqual(0);
          if (intervals.length === 0) {
            expect(summary.peakConcurrentTasks).toBe(0);
          }
        },
      ),
    );
  });
});

describe('summarizeResources — Property 5: CPU-hours equals the summed area (Req 2.4)', () => {
  // Property 5: CPU-hours equals the summed area.
  // Validates: Requirements 2.4
  it('Property 5: cpuHours.value equals the independently summed area over cpu intervals', () => {
    fc.assert(
      fc.property(
        fc.array(taskArb, { maxLength: 15 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        (tasks, now) => {
          const summary = summarizeResources(tasks, now);
          const intervals = toIntervals(tasks, now);
          const hasCpus = someIntervalHas(intervals, (i) => i.cpus);

          // Independent reference: Σ over intervals with non-null cpus of
          // (durationMs / 3_600_000) × cpus, computed directly from intervals.
          const expected = intervals.reduce((sum, i) => {
            if (i.cpus == null) {
              return sum;
            }
            return sum + ((i.end - i.start) / MS_PER_HOUR) * i.cpus;
          }, 0);

          if (hasCpus) {
            expect(summary.cpuHours.available).toBe(true);
            expect(summary.cpuHours.value).toBeCloseTo(expected, 9);
          } else {
            // No cpu-bearing interval => unavailable, null (not the 0 area).
            expect(summary.cpuHours.available).toBe(false);
            expect(summary.cpuHours.value).toBeNull();
          }
        },
      ),
    );
  });

  it('matches a hand-computed area for two non-overlapping cpu intervals', () => {
    // 1h @ 4 cpus + 2h @ 2 cpus = 4 + 4 = 8 cpu-hours.
    const a = makeTask({ taskId: 'a', startedAt: iso(0), stoppedAt: iso(MS_PER_HOUR), cpus: 4 });
    const b = makeTask({
      taskId: 'b',
      startedAt: iso(2 * MS_PER_HOUR),
      stoppedAt: iso(4 * MS_PER_HOUR),
      cpus: 2,
    });
    const summary = summarizeResources([a, b]);
    expect(summary.cpuHours.available).toBe(true);
    expect(summary.cpuHours.value).toBeCloseTo(8, 9);
  });

  it('ignores intervals with null cpus in the area sum', () => {
    // Only the 3h @ 1 cpu interval contributes; the null-cpu task adds nothing.
    const withCpu = makeTask({
      taskId: 'c',
      startedAt: iso(0),
      stoppedAt: iso(3 * MS_PER_HOUR),
      cpus: 1,
    });
    const noCpu = makeTask({
      taskId: 'd',
      startedAt: iso(0),
      stoppedAt: iso(5 * MS_PER_HOUR),
      cpus: null,
    });
    const summary = summarizeResources([withCpu, noCpu]);
    expect(summary.cpuHours.value).toBeCloseTo(3, 9);
  });
});

describe('summarizeResources — peak-memory unconfirmed-units caveat (Req 11.1, 11.2, 11.3)', () => {
  it('attaches the unconfirmed-units note when memory is available', () => {
    const t = makeTask({ startedAt: iso(0), stoppedAt: iso(MS_PER_HOUR), memory: 512 });
    const summary = summarizeResources([t]);
    expect(summary.peakConcurrentMemory.available).toBe(true);
    expect(summary.peakConcurrentMemory.note).toBe(MEMORY_UNITS_UNCONFIRMED_NOTE);
  });

  it('attaches the unconfirmed-units note even when memory is unavailable', () => {
    const t = makeTask({ startedAt: iso(0), stoppedAt: iso(MS_PER_HOUR), memory: null });
    const summary = summarizeResources([t]);
    expect(summary.peakConcurrentMemory.available).toBe(false);
    expect(summary.peakConcurrentMemory.value).toBeNull();
    expect(summary.peakConcurrentMemory.note).toBe(MEMORY_UNITS_UNCONFIRMED_NOTE);
  });

  it('always states the unit is unconfirmed regardless of availability', () => {
    fc.assert(
      fc.property(
        fc.array(taskArb, { maxLength: 15 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        (tasks, now) => {
          const summary = summarizeResources(tasks, now);
          // The caveat is present in every case, available or not.
          expect(summary.peakConcurrentMemory.note).toBe(
            MEMORY_UNITS_UNCONFIRMED_NOTE,
          );
        },
      ),
    );
  });

  it('reports a unit-agnostic sum with no unit conversion (raw value is the concurrent memory sum)', () => {
    fc.assert(
      fc.property(
        fc.array(taskArb, { maxLength: 15 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        (tasks, now) => {
          const summary = summarizeResources(tasks, now);
          const intervals = toIntervals(tasks, now);
          const hasMemory = someIntervalHas(intervals, (i) => i.memory);

          // The raw value equals the peak summed memory over concurrent
          // intervals — a unit-agnostic sum, never scaled/converted.
          const expectedPeakMemory = peakConcurrent(
            intervals,
            (i) => i.memory ?? 0,
          ).peakWeight;

          if (hasMemory) {
            expect(summary.peakConcurrentMemory.value).toBe(expectedPeakMemory);
          } else {
            expect(summary.peakConcurrentMemory.value).toBeNull();
          }
        },
      ),
    );
  });
});
