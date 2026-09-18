/**
 * Timeline_View grouping (Req 7.4, 7.6).
 *
 * The always-available floor layer: partition tasks by {@link TaskStatus} and
 * order tasks within each group by ascending start time. When no task carries
 * timing data, the view still groups by status but flags that ordering data is
 * unavailable (Req 7.6).
 *
 * See design.md "Task DAG Rendering (Three Layers)" and Property 19.
 */

import type { Task, TaskStatus } from '../api/types';
import type { TimelineGroup, TimelineView } from './types';

/**
 * Stable status ordering for groups. Tasks with no status fall into a trailing
 * `UNKNOWN` group so every task is represented exactly once.
 */
const STATUS_ORDER: readonly (TaskStatus | 'UNKNOWN')[] = [
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
  'UNKNOWN',
];

/** Parse an ISO-8601 timestamp to epoch millis, or `null` when unusable. */
function toMillis(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Build the Timeline_View grouping for a run's tasks.
 *
 * Tasks are partitioned by status (a `null`/absent status maps to `UNKNOWN`)
 * and, within each group, ordered by ascending start time. Tasks lacking a
 * usable start time sort to the end of their group while retaining input order
 * relative to one another (Req 7.4).
 *
 * `orderingUnavailable` is `true` when no task carries any usable timing data;
 * the grouping is still produced so the view can render with an "ordering data
 * unavailable" indication (Req 7.6).
 *
 * @param tasks The run's live tasks.
 * @returns Status groups (only non-empty groups, in stable status order) plus
 *   the ordering-unavailable flag.
 */
export function buildTimelineView(tasks: readonly Task[]): TimelineView {
  const buckets = new Map<TaskStatus | 'UNKNOWN', { task: Task; start: number | null; seq: number }[]>();

  let anyTiming = false;
  tasks.forEach((task, seq) => {
    const key: TaskStatus | 'UNKNOWN' = task.status ?? 'UNKNOWN';
    const start = toMillis(task.startedAt);
    if (start != null) {
      anyTiming = true;
    }
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [{ task, start, seq }]);
    } else {
      bucket.push({ task, start, seq });
    }
  });

  const groups: TimelineGroup[] = [];
  for (const status of STATUS_ORDER) {
    const bucket = buckets.get(status);
    if (bucket === undefined || bucket.length === 0) {
      continue;
    }
    // Ascending start time; untimed tasks (null start) sort last, preserving
    // their original relative order via the stable `seq` tie-break.
    bucket.sort((a, b) => {
      if (a.start == null && b.start == null) {
        return a.seq - b.seq;
      }
      if (a.start == null) {
        return 1;
      }
      if (b.start == null) {
        return -1;
      }
      return a.start - b.start || a.seq - b.seq;
    });
    groups.push({ status, tasks: bucket.map((b) => b.task) });
  }

  return {
    kind: 'Timeline_View',
    groups,
    // Ordering is unavailable only when there are tasks but none carry timing.
    orderingUnavailable: tasks.length > 0 && !anyTiming,
  };
}
