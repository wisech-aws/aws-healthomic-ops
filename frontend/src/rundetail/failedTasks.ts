/**
 * Failed/cancelled task selection (Req 4.1, 4.2, Property 8).
 *
 * Pure helpers so the run-detail "show failures only" quick filter and its
 * count badge are unit- and property-testable without rendering the view. The
 * run detail view calls {@link failedOrCancelledTasks} for the filtered set and
 * uses its length for the count badge.
 *
 * A task is selected exactly when its `status` is `FAILED` or `CANCELLED`; any
 * other status (including a null/absent status) is excluded. No fabrication:
 * a task with no status is never counted as a failure.
 */
import type { Task } from '../api/types';

/**
 * True iff the task's `status` is exactly `FAILED` or `CANCELLED` (Req 4.1).
 *
 * A task whose status is absent/null or any non-failure status returns `false`.
 */
export function isFailedOrCancelledTask(
  task: Pick<Task, 'status'>,
): boolean {
  return task.status === 'FAILED' || task.status === 'CANCELLED';
}

/**
 * Select exactly the tasks whose `status` is `FAILED` or `CANCELLED`, preserving
 * input order (Req 4.1). The selection size is the count badge value (Req 4.2).
 */
export function failedOrCancelledTasks<T extends Pick<Task, 'status'>>(
  tasks: readonly T[],
): T[] {
  return tasks.filter(isFailedOrCancelledTask);
}
