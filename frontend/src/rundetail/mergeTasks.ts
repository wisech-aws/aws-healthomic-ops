/**
 * Monotonic task merging for the run detail view.
 *
 * Task state reaches the view from two independent sources: `listTasksForRun`
 * snapshots (initial load and re-syncs) and `onTaskUpdated` subscription
 * messages. Neither is ordered with respect to the other, and AppSync does not
 * guarantee delivery order, so a naive replace can regress a task (a stale
 * RUNNING overwriting COMPLETED) or drop a task a snapshot hasn't seen yet.
 *
 * The rule, applied per `taskId`:
 *  - never regress from a terminal status (COMPLETED/FAILED/CANCELLED) to a
 *    non-terminal one;
 *  - otherwise keep the record with the newer `updatedAt`;
 *  - on an `updatedAt` tie, keep the higher status rank
 *    (PENDING < STARTING < RUNNING < STOPPING < terminal); on a full tie take
 *    the incoming record (same state, possibly more fields).
 */
import type { Task, TaskStatus } from '../api/types';

const STATUS_RANK: Record<TaskStatus, number> = {
  PENDING: 0,
  STARTING: 1,
  RUNNING: 2,
  STOPPING: 3,
  COMPLETED: 4,
  FAILED: 4,
  CANCELLED: 4,
};

const TERMINAL_RANK = 4;

function rank(task: Task): number {
  return task.status != null ? STATUS_RANK[task.status] : -1;
}

function isTerminal(task: Task): boolean {
  return rank(task) === TERMINAL_RANK;
}

function timeOf(task: Task): number {
  const ms = Date.parse(task.updatedAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Returns whichever of `current` and `incoming` (same `taskId`) should be kept
 * under the monotonic rule above. Returns `current` by reference when it wins,
 * so callers can detect "no change".
 */
export function pickTask(current: Task, incoming: Task): Task {
  if (isTerminal(current) && !isTerminal(incoming)) {
    return current;
  }
  const currentAt = timeOf(current);
  const incomingAt = timeOf(incoming);
  if (incomingAt !== currentAt) {
    return incomingAt > currentAt ? incoming : current;
  }
  return rank(incoming) >= rank(current) ? incoming : current;
}

/**
 * Applies one subscription update to the task list. Unknown tasks are
 * appended; known tasks are kept or replaced by {@link pickTask}. Returns
 * `tasks` unchanged (same reference) when the update is stale.
 */
export function applyTaskUpdate(tasks: Task[], updated: Task): Task[] {
  const index = tasks.findIndex((task) => task.taskId === updated.taskId);
  if (index === -1) {
    return [...tasks, updated];
  }
  const kept = pickTask(tasks[index], updated);
  if (kept === tasks[index]) {
    return tasks;
  }
  const next = tasks.slice();
  next[index] = kept;
  return next;
}

/**
 * Merges a `listTasksForRun` snapshot into the current task list. Each task is
 * resolved by {@link pickTask}; snapshot tasks not yet in state are appended,
 * and tasks in state but missing from the snapshot are kept (an eventually
 * consistent read can miss a brand-new item). Returns `prev` unchanged (same
 * reference) when nothing changed.
 */
export function mergeTasks(prev: Task[], snapshot: Task[]): Task[] {
  const indexById = new Map<string, number>();
  prev.forEach((task, i) => indexById.set(task.taskId, i));
  let next: Task[] | null = null;
  for (const incoming of snapshot) {
    const list: Task[] = next ?? prev;
    const index = indexById.get(incoming.taskId);
    if (index === undefined) {
      next = next ?? prev.slice();
      indexById.set(incoming.taskId, next.length);
      next.push(incoming);
      continue;
    }
    const kept = pickTask(list[index], incoming);
    if (kept !== list[index]) {
      next = next ?? prev.slice();
      next[index] = kept;
    }
  }
  return next ?? prev;
}
