import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildTimelineView } from './timeline';
import { makeTask, TASK_STATUSES } from './testFactories';
import type { TaskStatus } from '../api/types';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('buildTimelineView (Req 7.4, 7.6)', () => {
  it('partitions tasks by status', () => {
    const view = buildTimelineView([
      makeTask({ status: 'RUNNING' }),
      makeTask({ status: 'COMPLETED' }),
      makeTask({ status: 'RUNNING' }),
    ]);
    const running = view.groups.find((g) => g.status === 'RUNNING')!;
    const completed = view.groups.find((g) => g.status === 'COMPLETED')!;
    expect(running.tasks).toHaveLength(2);
    expect(completed.tasks).toHaveLength(1);
  });

  it('orders tasks within a group by ascending start time (Req 7.4)', () => {
    const view = buildTimelineView([
      makeTask({ taskId: 'late', status: 'RUNNING', startedAt: iso(300) }),
      makeTask({ taskId: 'early', status: 'RUNNING', startedAt: iso(100) }),
      makeTask({ taskId: 'mid', status: 'RUNNING', startedAt: iso(200) }),
    ]);
    const running = view.groups.find((g) => g.status === 'RUNNING')!;
    expect(running.tasks.map((t) => t.taskId)).toEqual(['early', 'mid', 'late']);
  });

  it('maps a null status to an UNKNOWN group', () => {
    const view = buildTimelineView([makeTask({ status: null })]);
    expect(view.groups.map((g) => g.status)).toContain('UNKNOWN');
  });

  it('flags orderingUnavailable when no task has timing (Req 7.6)', () => {
    const view = buildTimelineView([
      makeTask({ status: 'PENDING', startedAt: null, stoppedAt: null }),
      makeTask({ status: 'RUNNING', startedAt: null, stoppedAt: null }),
    ]);
    expect(view.orderingUnavailable).toBe(true);
    // Still grouped by status despite missing timing.
    expect(view.groups.map((g) => g.status).sort()).toEqual(['PENDING', 'RUNNING']);
  });

  it('does not flag orderingUnavailable when any task has timing', () => {
    const view = buildTimelineView([
      makeTask({ startedAt: iso(0) }),
      makeTask({ startedAt: null }),
    ]);
    expect(view.orderingUnavailable).toBe(false);
  });

  it('reports orderingUnavailable false for zero tasks', () => {
    const view = buildTimelineView([]);
    expect(view.orderingUnavailable).toBe(false);
    expect(view.groups).toEqual([]);
  });

  // Property 19: Timeline grouping (Validates: Requirements 7.4)
  it('Property 19: partitions by status and orders each group by ascending start time', () => {
    const statusArb = fc.constantFrom<TaskStatus>(...TASK_STATUSES);
    const specArb = fc.record({
      status: statusArb,
      start: fc.integer({ min: 0, max: 10_000 }),
    });

    fc.assert(
      fc.property(fc.array(specArb, { maxLength: 20 }), (specs) => {
        const tasks = specs.map((s, i) =>
          makeTask({ taskId: `t${i}`, status: s.status, startedAt: iso(s.start) }),
        );
        const view = buildTimelineView(tasks);

        // Partition: every task appears exactly once, only under its status.
        const seen = new Set<string>();
        for (const group of view.groups) {
          for (const task of group.tasks) {
            expect(task.status).toBe(group.status);
            expect(seen.has(task.taskId)).toBe(false);
            seen.add(task.taskId);
          }
        }
        expect(seen.size).toBe(tasks.length);

        // Within each group: ascending start time.
        for (const group of view.groups) {
          const starts = group.tasks.map((t) => Date.parse(t.startedAt!));
          for (let i = 1; i < starts.length; i++) {
            expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
          }
        }
      }),
    );
  });
});
