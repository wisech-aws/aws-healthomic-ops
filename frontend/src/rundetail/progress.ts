/**
 * Run-detail progress computation (Req 9.6, Property 24).
 *
 * Pure helper so the progress indicator's counting and elapsed-time formatting
 * are unit- and property-testable without rendering the view. The run detail
 * view calls {@link computeProgress} and renders `completed / total` plus the
 * `elapsed` string.
 *
 * - `completed` is the number of tasks whose status is exactly `COMPLETED`.
 * - `total` is the total number of tasks.
 * - `elapsed` is the run's elapsed wall-clock time formatted as `HH:MM:SS`,
 *   measured from `startedAt` to `stoppedAt` (or to `now` while still running),
 *   reusing the shared fleet {@link runDuration} helper so formatting matches
 *   the fleet view exactly.
 */
import type { Run, Task } from '../api/types';
import { runDuration } from '../fleet/duration';

/** Progress summary for a run's task set (Req 9.6). */
export interface Progress {
  /** Count of tasks with status `COMPLETED`. */
  readonly completed: number;
  /** Total number of tasks. */
  readonly total: number;
  /** Elapsed time formatted `HH:MM:SS`, or a dash when start time is unknown. */
  readonly elapsed: string;
}

/**
 * Compute the run detail progress indicator values.
 *
 * @param tasks The run's live tasks.
 * @param run The run (supplies `startedAt`/`stoppedAt` for elapsed time), or
 *   `null`/`undefined` when the run hasn't loaded — elapsed is then unknown.
 * @param now Current epoch millis; injectable so tests are deterministic.
 * @returns The completed/total counts and the `HH:MM:SS` elapsed string.
 */
export function computeProgress(
  tasks: readonly Task[],
  run: Run | null | undefined,
  now: number = Date.now(),
): Progress {
  const total = tasks.length;
  let completed = 0;
  for (const task of tasks) {
    if (task.status === 'COMPLETED') {
      completed += 1;
    }
  }
  const elapsed = runDuration(run?.startedAt, run?.stoppedAt, now);
  return { completed, total, elapsed };
}
