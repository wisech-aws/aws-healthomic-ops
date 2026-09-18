/**
 * Interval model and peak-concurrency overlap sweep (enhancement 2).
 *
 * Turns a run's tasks into a clean set of half-open execution intervals
 * `[start, end)` and answers overlap questions (peak concurrent count and the
 * peak of a per-interval weight, e.g. cpus or memory) via a boundary sweep.
 *
 * Overlap semantics deliberately match the already-proven approach in
 * `taskview/inferredDag.ts`: intervals are half-open, so a task ending exactly
 * when another starts is not counted as concurrent, and a still-running task
 * extends to `now`. Every value is derived from data already present on the
 * tasks — a task without a usable start never produces an interval (no
 * fabrication; Req 2.1, 10.1, 10.3, 10.4).
 */

import type { Task } from '../api/types';

/** A task's execution interval with its resource request. Milliseconds epoch. */
export interface TaskInterval {
  readonly taskId: string;
  /** Interval start, epoch ms. */
  readonly start: number;
  /** Interval end, epoch ms; open (running) tasks use `now`. */
  readonly end: number;
  /** `cpus` carried by the task, or `null` when absent. */
  readonly cpus: number | null;
  /** `memory` carried by the task, or `null` when absent. */
  readonly memory: number | null;
  /** True when derived from a still-running task (end = `now`). */
  readonly open: boolean;
}

/**
 * Build execution intervals from tasks (Req 2.1).
 *
 * A task with no usable (absent/unparseable) `startedAt` is dropped — it has
 * not run, so it contributes nothing measurable and never a fabricated
 * interval. A running task (started, not stopped, or unparseable stop) is
 * closed at `now` and flagged `open`. Inverted intervals (stop before start)
 * clamp `end = start`. `cpus`/`memory` are carried through, `null` when absent.
 */
export function toIntervals(
  tasks: readonly Task[],
  now: number = Date.now(),
): TaskInterval[] {
  const intervals: TaskInterval[] = [];
  for (const task of tasks) {
    if (task.startedAt == null) {
      continue;
    }
    const start = Date.parse(task.startedAt);
    if (Number.isNaN(start)) {
      continue;
    }

    const parsedStop =
      task.stoppedAt != null ? Date.parse(task.stoppedAt) : NaN;
    const stopped = task.stoppedAt != null && !Number.isNaN(parsedStop);
    const open = !stopped;
    const rawEnd = stopped ? parsedStop : now;
    // Clamp inverted intervals (stop before start) to end = start.
    const end = rawEnd < start ? start : rawEnd;

    intervals.push({
      taskId: task.taskId,
      start,
      end,
      cpus: task.cpus ?? null,
      memory: task.memory ?? null,
      open,
    });
  }
  return intervals;
}

interface BoundaryEvent {
  readonly t: number;
  readonly isEnd: boolean;
  readonly w: number;
}

/**
 * Compute the maximum number of simultaneously-active intervals (peak
 * concurrency) and the summed value of a per-interval numeric weight at that
 * peak, via a boundary sweep (Req 2.2, 2.3).
 *
 * Ends are processed before starts at an equal timestamp so a task ending
 * exactly when another starts is not counted as concurrent (half-open
 * `[start, end)`). `weight` selects the quantity summed across concurrent
 * intervals (e.g. `cpus`). Returns `{peakCount: 0, peakWeight: 0}` for empty
 * input (never fabricated).
 */
export function peakConcurrent(
  intervals: readonly TaskInterval[],
  weight: (i: TaskInterval) => number,
): { peakCount: number; peakWeight: number } {
  if (intervals.length === 0) {
    return { peakCount: 0, peakWeight: 0 };
  }

  // Build boundary events: +weight at start, -weight at end.
  const events: BoundaryEvent[] = [];
  for (const i of intervals) {
    const w = weight(i);
    events.push({ t: i.start, isEnd: false, w });
    events.push({ t: i.end, isEnd: true, w });
  }

  // Sort by timestamp ascending; at an equal timestamp ends come before starts
  // (isEnd descending) so touching intervals are not counted as concurrent.
  events.sort((a, b) => {
    if (a.t !== b.t) {
      return a.t - b.t;
    }
    // ends (isEnd=true) before starts (isEnd=false)
    return Number(b.isEnd) - Number(a.isEnd);
  });

  let curCount = 0;
  let curWeight = 0;
  let peakCount = 0;
  let peakWeight = 0;

  for (const e of events) {
    // INVARIANT: after each prefix, curCount/curWeight reflect the active set
    // on the half-open segment just closed; peakCount/peakWeight are the
    // running maxima over all processed prefixes.
    if (e.isEnd) {
      curCount -= 1;
      curWeight -= e.w;
    } else {
      curCount += 1;
      curWeight += e.w;
      if (curCount > peakCount) {
        peakCount = curCount;
      }
      if (curWeight > peakWeight) {
        peakWeight = curWeight;
      }
    }
  }

  return { peakCount, peakWeight };
}
