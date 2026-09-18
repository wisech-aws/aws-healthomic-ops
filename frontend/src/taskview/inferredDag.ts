/**
 * Inferred_DAG ordering (Req 7.2).
 *
 * When no static graph is available, estimate task ordering from start/stop
 * times: a task with an earlier `startedAt` is placed no later than one with a
 * later `startedAt`, and tasks whose [startedAt, stoppedAt] intervals overlap
 * are grouped into the same level (shown concurrent).
 *
 * See design.md "Task DAG Rendering (Three Layers)" and Property 18.
 */

import type { Task } from '../api/types';
import type { InferredDagLevel, InferredDagOrdering } from './types';

/**
 * Parse an ISO-8601 timestamp to epoch milliseconds, or `null` when absent or
 * unparseable. Tasks with no usable start time sort after all timed tasks so
 * that timed tasks keep their relative ordering.
 */
function toMillis(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The effective end of a task's interval. An open (still-running) or missing
 * stop time is treated as extending to `+Infinity` so an unfinished task
 * overlaps everything that starts at or after its own start.
 */
function endMillis(start: number, stop: number | null): number {
  if (stop == null) {
    return Number.POSITIVE_INFINITY;
  }
  // Guard against inverted intervals (stop before start): clamp to start.
  return stop < start ? start : stop;
}

/**
 * Build the Inferred_DAG ordering for a run's tasks.
 *
 * Tasks are sorted by ascending start time. Tasks whose intervals overlap are
 * placed in the same level; a strictly-later, non-overlapping start opens a new
 * level. Within a level, tasks keep ascending start order. Tasks with no usable
 * start time are grouped into a trailing level (their order relative to timed
 * tasks is unknown).
 *
 * The result satisfies: for any two tasks a, b with start(a) < start(b), a's
 * level order is <= b's level order (earlier start placed no later, Req 7.2),
 * and any two overlapping tasks share a level (concurrent, Req 7.2).
 *
 * @param tasks The run's live tasks.
 * @returns Ordered, concurrency-grouped levels.
 */
export function buildInferredDagOrdering(
  tasks: readonly Task[],
): InferredDagOrdering {
  type Timed = { task: Task; start: number; end: number };

  const timed: Timed[] = [];
  const untimed: Task[] = [];

  for (const task of tasks) {
    const start = toMillis(task.startedAt);
    if (start == null) {
      untimed.push(task);
      continue;
    }
    timed.push({
      task,
      start,
      end: endMillis(start, toMillis(task.stoppedAt)),
    });
  }

  // Ascending start; ties broken by ascending end so grouping is deterministic.
  timed.sort((a, b) => (a.start - b.start) || (a.end - b.end));

  const levels: InferredDagLevel[] = [];
  let order = 0;
  let current: Timed[] = [];
  // The maximum end seen so far in the current level: a task overlaps the level
  // when its start is strictly before this running maximum end.
  let levelMaxEnd = Number.NEGATIVE_INFINITY;

  for (const entry of timed) {
    if (current.length === 0) {
      current.push(entry);
      levelMaxEnd = entry.end;
      continue;
    }
    if (entry.start < levelMaxEnd) {
      // Overlaps a task already in this level: concurrent, same level.
      current.push(entry);
      if (entry.end > levelMaxEnd) {
        levelMaxEnd = entry.end;
      }
    } else {
      // Starts at or after every task in the current level ends: new level.
      levels.push({ order, tasks: current.map((t) => t.task) });
      order += 1;
      current = [entry];
      levelMaxEnd = entry.end;
    }
  }
  if (current.length > 0) {
    levels.push({ order, tasks: current.map((t) => t.task) });
    order += 1;
  }

  if (untimed.length > 0) {
    // Tasks without a start time can't be ordered against timed tasks; place
    // them together in a trailing level.
    levels.push({ order, tasks: untimed });
  }

  return { kind: 'Inferred_DAG', levels };
}
