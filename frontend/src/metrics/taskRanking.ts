/**
 * Task ranking / critical-path approximation (enhancement 3).
 *
 * "Critical path" here is an approximation — the longest-running task(s) by
 * wall-clock duration, which is what is derivable without a per-run dependency
 * graph. This is deliberately labeled "longest-running tasks" and is not a
 * dependency-graph critical path (Req 3.7).
 *
 * Pure helpers (no React, no I/O, injectable `now`) so they can be unit- and
 * property-tested exactly like the existing `fleet/duration.ts` /
 * `fleet/ordering.ts`. Numeric durations reuse `durationMs`/`isRunning` from
 * `fleet/duration.ts` as the single source of truth for "how long did this
 * take", so running tasks are ranked by elapsed-so-far (Req 3.1–3.5).
 */

import type { Task } from '../api/types';
import { durationMs, isRunning } from '../fleet/duration';

/** A task ranked by descending wall-clock duration. */
export interface RankedTask {
  readonly task: Task;
  /** Wall-clock duration in ms; `null` means unknown duration (sorts last). */
  readonly durationMs: number | null;
  /** 1-based rank; equal durations share a rank, and ranks are non-decreasing. */
  readonly rank: number;
  /** True when the task is started but not stopped (duration is elapsed-so-far). */
  readonly running: boolean;
}

/**
 * Parses an ISO 8601 timestamp into epoch milliseconds, or negative infinity
 * when absent/unparseable so it sorts last under an ascending tie-break.
 */
function toEpoch(value: string | null | undefined): number {
  if (value == null) {
    return Number.NEGATIVE_INFINITY;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Ranks a run's tasks by descending wall-clock duration, longest first
 * (Req 3.1, 3.2).
 *
 * - One ranked entry per input task (no task added or dropped).
 * - Tasks with a known duration precede tasks with an unknown duration; among
 *   known-duration tasks the sequence is non-increasing in `durationMs`.
 * - Unknown-duration tasks preserve their relative input order (stable).
 * - Running tasks are ranked by their elapsed-so-far duration and flagged
 *   `running`.
 * - Ranks are 1-based and non-decreasing down the list; tasks that share an
 *   equal known duration share a rank (competition ranking).
 */
export function rankByDuration(
  tasks: readonly Task[],
  now: number = Date.now(),
): RankedTask[] {
  // Annotate first so the original input index is available as a stable
  // tie-break for equal (and unknown) durations.
  const annotated = tasks.map((task, index) => ({
    task,
    index,
    durationMs: durationMs(task.startedAt, task.stoppedAt, now),
    running: isRunning(task.startedAt, task.stoppedAt),
  }));

  const sorted = [...annotated].sort((a, b) => {
    const aKnown = a.durationMs != null;
    const bKnown = b.durationMs != null;
    // Known durations sort before unknown durations.
    if (aKnown !== bKnown) {
      return aKnown ? -1 : 1;
    }
    // Both unknown: preserve input order (stable).
    if (!aKnown || !bKnown) {
      return a.index - b.index;
    }
    // Both known: descending by duration, ties broken by input order (stable).
    if (a.durationMs !== b.durationMs) {
      return (b.durationMs as number) - (a.durationMs as number);
    }
    return a.index - b.index;
  });

  // Assign 1-based competition ranks: an entry shares the rank of the previous
  // entry when they have the same known duration, otherwise it takes its
  // 1-based position. Every unknown-duration entry shares a single rank block
  // after the known ones so ranks stay non-decreasing.
  let previousRank = 0;
  let previousDuration: number | null | undefined;
  let previousKnown: boolean | undefined;
  return sorted.map((entry, position) => {
    const known = entry.durationMs != null;
    const sameAsPrevious =
      position > 0 && known === previousKnown &&
      (known ? entry.durationMs === previousDuration : true);
    const rank = sameAsPrevious ? previousRank : position + 1;
    previousRank = rank;
    previousDuration = entry.durationMs;
    previousKnown = known;
    return {
      task: entry.task,
      durationMs: entry.durationMs,
      rank,
      running: entry.running,
    };
  });
}

/**
 * The top-N longest-running tasks, N defaulting to five (Req 3.3).
 *
 * Only tasks with a known duration are returned; unknown-duration tasks are
 * never surfaced as "longest". Fewer than N entries are returned when fewer
 * than N tasks have a known duration.
 */
export function topLongest(
  tasks: readonly Task[],
  n = 5,
  now: number = Date.now(),
): RankedTask[] {
  if (n <= 0) {
    return [];
  }
  return rankByDuration(tasks, now)
    .filter((ranked) => ranked.durationMs != null)
    .slice(0, n);
}

/**
 * The `taskId` of the single slowest task, or `null` when no task has a known
 * duration (Req 3.4, 3.5).
 *
 * The slowest task is the one whose duration is greater than or equal to every
 * other task's duration; ties resolve to the earliest `startedAt`
 * deterministically. The returned id is always one of the input tasks.
 */
export function slowestTaskId(
  tasks: readonly Task[],
  now: number = Date.now(),
): string | null {
  let best: { taskId: string; durationMs: number; startedAt: number } | null =
    null;
  for (const task of tasks) {
    const ms = durationMs(task.startedAt, task.stoppedAt, now);
    if (ms == null) {
      continue;
    }
    const startedAt = toEpoch(task.startedAt);
    if (
      best == null ||
      ms > best.durationMs ||
      (ms === best.durationMs && startedAt < best.startedAt)
    ) {
      best = { taskId: task.taskId, durationMs: ms, startedAt };
    }
  }
  return best == null ? null : best.taskId;
}
