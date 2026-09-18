/**
 * Task state-transition segments (enhancement 8).
 *
 * Breaks a task's time into two segments:
 *   queueWaitMs: `createdAt` -> `startedAt`   (time before the task started)
 *   runTimeMs:   `startedAt` -> `stoppedAt`   (or -> `now` while running)
 *
 * Each segment is `null` when its bounding timestamps are absent/unparseable
 * (Req 8.3) — no fabricated value is produced.
 *
 * `queueWaitMs` deliberately has NO `now` fallback (Req 8.2): an unstarted task
 * has an unknown wait, so it must be `null` even though `durationMs` would
 * otherwise measure against `now`. It is therefore computed explicitly here,
 * requiring both `createdAt` and `startedAt` to be present and parseable.
 *
 * `confidence` is `'unconfirmed'` whenever `queueWaitMs` is derived (non-null),
 * because the `createdAt` semantics (creation vs first-scheduled) are not yet
 * confirmed against AWS documentation (Req 12.1, 12.2). `runTimeMs` does not
 * depend on `createdAt`, so a task with an unknown queue-wait is `'confirmed'`
 * (Req 12.4).
 */

import type { Task } from '../api/types';
import { durationMs, isRunning } from '../fleet/duration';

/**
 * A task's time broken into queue-wait and run-time.
 *
 * - `queueWaitMs`: `createdAt` -> `startedAt`, or `null` when unknown.
 * - `runTimeMs`: `startedAt` -> `stoppedAt` (or `now` while running), or `null`.
 * - `running`: true when the task has started but not stopped.
 * - `confidence`: `'unconfirmed'` when `queueWaitMs` is derived, else
 *   `'confirmed'` (see Req 12).
 */
export interface TaskSegments {
  readonly taskId: string;
  readonly queueWaitMs: number | null;
  readonly runTimeMs: number | null;
  readonly running: boolean;
  readonly confidence: 'confirmed' | 'unconfirmed';
}

/**
 * Queue-wait from `createdAt` to `startedAt`, with NO `now` fallback (Req 8.2).
 *
 * Returns `null` unless both timestamps are present and parseable. Negative
 * results (started before created) clamp to 0, matching `durationMs`.
 */
function queueWait(
  createdAt: string | null | undefined,
  startedAt: string | null | undefined,
): number | null {
  if (createdAt == null || startedAt == null) {
    return null;
  }
  const created = Date.parse(createdAt);
  const started = Date.parse(startedAt);
  if (Number.isNaN(created) || Number.isNaN(started)) {
    return null;
  }
  return Math.max(0, started - created);
}

/**
 * Compute the queue-wait / run-time segments for a single task.
 */
export function segmentsFor(task: Task, now: number = Date.now()): TaskSegments {
  const runTimeMs = durationMs(task.startedAt, task.stoppedAt, now);
  const queueWaitMs = queueWait(task.createdAt, task.startedAt);
  return {
    taskId: task.taskId,
    queueWaitMs,
    runTimeMs,
    running: isRunning(task.startedAt, task.stoppedAt),
    confidence: queueWaitMs != null ? 'unconfirmed' : 'confirmed',
  };
}

/**
 * Compute segments for every task in a run.
 */
export function segmentsForAll(
  tasks: readonly Task[],
  now: number = Date.now(),
): TaskSegments[] {
  return tasks.map((task) => segmentsFor(task, now));
}
