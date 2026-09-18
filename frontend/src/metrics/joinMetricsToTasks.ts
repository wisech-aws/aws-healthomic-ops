/**
 * Task-id join of measured metric series to DAG nodes (Req 6).
 *
 * `getRunMetrics` returns a flat `MetricSeries[]` for a run; each series
 * carries `taskId` (from `@resource.aws.omics.task.id`) or `null` for
 * run-level series (e.g. the `RUN_FILESYSTEM` family). This module is the
 * pure JOIN step that groups per-task series by `taskId` and matches each
 * group to the `Task` (from the DAG/run state plane) whose `taskId` equals
 * it, so `RunMetricsPanel` can surface charts in the context of the
 * selected DAG node (design §9).
 *
 * Run-level series (`taskId === null`) are NOT part of this join at all —
 * they are excluded from both `matched` and `unavailableTaskIds`. The caller
 * (`RunMetricsPanel`) renders those separately in a run-scoped chart, not
 * attached to any node.
 */
import type { MetricSeries } from '../api/types';

/** All series belonging to a single task, grouped by `taskId`. */
export interface TaskMetrics {
  readonly taskId: string;
  readonly series: MetricSeries[];
}

/** The result of joining a run's series to its task list. */
export interface JoinResult {
  /** One entry per task that has at least one matching series, in `tasks` order. */
  readonly matched: TaskMetrics[];
  /**
   * `taskId`s of tasks with NO matching series (unavailable for that node),
   * in `tasks` order. Never a synthesized zero/placeholder series (Req 4.2).
   */
  readonly unavailableTaskIds: string[];
}

/**
 * Joins measured metric series to a run's tasks by task id (Req 6.1, 6.3,
 * 6.4, 4.2).
 *
 * Rules:
 *  - A series whose `taskId` equals a task's `taskId` is associated with
 *    EXACTLY that task (Req 6.1).
 *  - A series whose `taskId` matches no task in `tasks` is OMITTED from the
 *    result without discarding any other series — one unmatched series never
 *    corrupts or drops another task's matched group (Req 6.3).
 *  - A task in `tasks` with no matching series is reported in
 *    `unavailableTaskIds`; no placeholder/zero series is ever synthesized
 *    for it (Req 6.4, 4.2).
 *  - Series with `taskId === null` (run-level series, e.g. the
 *    `RUN_FILESYSTEM` family) are excluded from this per-task join entirely —
 *    they appear in neither `matched` nor `unavailableTaskIds`. The caller
 *    handles run-level series separately.
 *
 * Pure, total, and deterministic: `matched` and `unavailableTaskIds` both
 * preserve the order of `tasks`.
 */
export function joinMetricsToTasks(
  series: readonly MetricSeries[],
  tasks: readonly { taskId: string }[],
): JoinResult {
  const seriesByTaskId = new Map<string, MetricSeries[]>();
  for (const s of series) {
    if (s.taskId == null) {
      // Run-level series; not part of the per-task join (see doc comment).
      continue;
    }
    const group = seriesByTaskId.get(s.taskId);
    if (group) {
      group.push(s);
    } else {
      seriesByTaskId.set(s.taskId, [s]);
    }
  }

  const matched: TaskMetrics[] = [];
  const unavailableTaskIds: string[] = [];
  for (const task of tasks) {
    const group = seriesByTaskId.get(task.taskId);
    if (group && group.length > 0) {
      matched.push({ taskId: task.taskId, series: group });
    } else {
      unavailableTaskIds.push(task.taskId);
    }
  }

  return { matched, unavailableTaskIds };
}
