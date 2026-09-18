import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeProgress } from './progress';
import { makeTask, TASK_STATUSES } from '../taskview/testFactories';
import type { Run } from '../api/types';

function run(partial: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('computeProgress', () => {
  it('counts COMPLETED tasks as completed and all tasks as total', () => {
    const tasks = [
      makeTask({ status: 'COMPLETED' }),
      makeTask({ status: 'RUNNING' }),
      makeTask({ status: 'COMPLETED' }),
      makeTask({ status: 'FAILED' }),
    ];
    const { completed, total } = computeProgress(tasks, run(), 0);
    expect(completed).toBe(2);
    expect(total).toBe(4);
  });

  it('reports zero completed and zero total for an empty task set', () => {
    const { completed, total } = computeProgress([], run(), 0);
    expect(completed).toBe(0);
    expect(total).toBe(0);
  });

  it('formats elapsed time between startedAt and stoppedAt as HH:MM:SS', () => {
    const r = run({
      startedAt: '2024-01-01T00:00:00.000Z',
      stoppedAt: '2024-01-01T01:02:03.000Z',
    });
    expect(computeProgress([], r, 0).elapsed).toBe('01:02:03');
  });

  it('measures elapsed against now while the run is still running', () => {
    const start = Date.parse('2024-01-01T00:00:00.000Z');
    const r = run({ startedAt: '2024-01-01T00:00:00.000Z' });
    // 90 minutes after start, no stoppedAt.
    const now = start + 90 * 60 * 1000;
    expect(computeProgress([], r, now).elapsed).toBe('01:30:00');
  });

  it('returns a dash placeholder for elapsed when the run has no start time', () => {
    expect(computeProgress([], run(), 0).elapsed).toBe('—');
    expect(computeProgress([], null, 0).elapsed).toBe('—');
  });

  // Property 24: completed = count of COMPLETED, total = count, elapsed HH:MM:SS.
  // **Validates: Requirements 9.6**
  it('holds Property 24 across arbitrary task sets and durations', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...TASK_STATUSES)),
        fc.integer({ min: 0, max: 500_000 }),
        (statuses, elapsedSeconds) => {
          const tasks = statuses.map((status) => makeTask({ status }));
          const start = Date.parse('2024-01-01T00:00:00.000Z');
          const now = start + elapsedSeconds * 1000;
          const r = run({ startedAt: '2024-01-01T00:00:00.000Z' });

          const { completed, total, elapsed } = computeProgress(tasks, r, now);

          const expectedCompleted = statuses.filter(
            (s) => s === 'COMPLETED',
          ).length;
          expect(completed).toBe(expectedCompleted);
          expect(total).toBe(statuses.length);

          // HH:MM:SS shape with hours >= 2 digits and MM/SS in [00,59].
          expect(elapsed).toMatch(/^\d{2,}:[0-5]\d:[0-5]\d$/);
          const [hh, mm, ss] = elapsed.split(':').map(Number);
          expect(hh * 3600 + mm * 60 + ss).toBe(elapsedSeconds);
        },
      ),
    );
  });
});
