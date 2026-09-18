import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isFailedOrCancelledTask, failedOrCancelledTasks } from './failedTasks';
import { makeTask, TASK_STATUSES } from '../taskview/testFactories';
import type { TaskStatus } from '../api/types';

/** Statuses that must be selected by the failed-task filter (Req 4.1). */
const FAILURE_STATUSES: readonly TaskStatus[] = ['FAILED', 'CANCELLED'];

/** fast-check arbitrary for a task status, or `null` (absent status). */
const statusArb: fc.Arbitrary<TaskStatus | null> = fc.constantFrom(
  ...TASK_STATUSES,
  null,
);

describe('isFailedOrCancelledTask (Req 4.1)', () => {
  it('selects FAILED tasks', () => {
    expect(isFailedOrCancelledTask(makeTask({ status: 'FAILED' }))).toBe(true);
  });

  it('selects CANCELLED tasks', () => {
    expect(isFailedOrCancelledTask(makeTask({ status: 'CANCELLED' }))).toBe(true);
  });

  it('rejects a COMPLETED task', () => {
    expect(isFailedOrCancelledTask(makeTask({ status: 'COMPLETED' }))).toBe(false);
  });

  it('rejects a task with a null status (no fabrication)', () => {
    expect(isFailedOrCancelledTask(makeTask({ status: null }))).toBe(false);
  });
});

describe('failedOrCancelledTasks (Req 4.1, 4.2)', () => {
  it('returns exactly the failed/cancelled tasks preserving order', () => {
    const a = makeTask({ taskId: 'a', status: 'COMPLETED' });
    const b = makeTask({ taskId: 'b', status: 'FAILED' });
    const c = makeTask({ taskId: 'c', status: 'RUNNING' });
    const d = makeTask({ taskId: 'd', status: 'CANCELLED' });
    expect(failedOrCancelledTasks([a, b, c, d])).toEqual([b, d]);
  });

  it('returns an empty selection for an empty input', () => {
    expect(failedOrCancelledTasks([])).toEqual([]);
  });

  // Property 8: Failed filter selects exactly the failed/cancelled tasks.
  // Validates: Requirements 4.1, 4.2
  it('Property 8: selects exactly FAILED/CANCELLED tasks; count equals badge value', () => {
    fc.assert(
      fc.property(
        fc.array(statusArb, { maxLength: 40 }),
        (statuses) => {
          const tasks = statuses.map((status, i) =>
            makeTask({ taskId: `t${i}`, status }),
          );
          const selected = failedOrCancelledTasks(tasks);
          const selectedIds = new Set(selected.map((t) => t.taskId));

          const expectedIds = tasks
            .filter((t) => t.status != null && FAILURE_STATUSES.includes(t.status))
            .map((t) => t.taskId);

          // Selection is exactly the FAILED/CANCELLED tasks, in input order.
          expect(selected.map((t) => t.taskId)).toEqual(expectedIds);

          // Req 4.2: badge count equals the selection size.
          expect(selected.length).toBe(expectedIds.length);

          // No other-status or null-status task is included.
          for (const t of selected) {
            expect(t.status === 'FAILED' || t.status === 'CANCELLED').toBe(true);
          }

          // Result is a subset (sublist) of the input.
          const inputIds = new Set(tasks.map((t) => t.taskId));
          for (const id of selectedIds) {
            expect(inputIds.has(id)).toBe(true);
          }

          // Every non-failure task is excluded.
          for (const t of tasks) {
            if (!(t.status === 'FAILED' || t.status === 'CANCELLED')) {
              expect(selectedIds.has(t.taskId)).toBe(false);
            }
          }
        },
      ),
    );
  });
});
