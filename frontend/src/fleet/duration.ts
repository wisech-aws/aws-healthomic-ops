/**
 * Duration and timestamp formatting helpers for the fleet view.
 *
 * Duration is the elapsed time between a run's start (`startedAt`) and stop
 * (`stoppedAt`); a run that has started but not stopped is measured against the
 * current time (Req 8.1). Kept as pure helpers so formatting is testable.
 */

import type { Task } from '../api/types';

/**
 * Formats an elapsed duration in milliseconds as `HH:MM:SS`.
 *
 * Negative or non-finite inputs are treated as zero. Hours are not zero-padded
 * to two digits so long runs (100h+) still render correctly.
 */
export function formatDuration(ms: number): string {
  const totalSeconds =
    Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Computes and formats a run's duration from its start and stop timestamps.
 *
 * - No `startedAt`: duration is unknown, returns a dash placeholder.
 * - `startedAt` but no `stoppedAt`: still running, measured against `now`.
 * - Both present: measured between them.
 */
export function runDuration(
  startedAt: string | null | undefined,
  stoppedAt: string | null | undefined,
  now: number = Date.now(),
): string {
  if (startedAt == null) {
    return '—';
  }
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) {
    return '—';
  }
  const end = stoppedAt != null ? Date.parse(stoppedAt) : now;
  const resolvedEnd = Number.isNaN(end) ? now : end;
  return formatDuration(resolvedEnd - start);
}

/**
 * Formats an ISO 8601 timestamp for display, or a dash placeholder when the
 * value is absent or unparseable.
 */
export function formatStartTime(startedAt: string | null | undefined): string {
  if (startedAt == null) {
    return '—';
  }
  const ms = Date.parse(startedAt);
  if (Number.isNaN(ms)) {
    return '—';
  }
  return new Date(ms).toLocaleString();
}

/**
 * Numeric elapsed milliseconds between `startedAt` and `stoppedAt`, or `null`
 * when the duration is unknown (start absent or unparseable).
 *
 * A started-but-not-stopped item is measured against `now` (elapsed-so-far);
 * an unparseable `stoppedAt` also falls back to `now`. Negative results (stop
 * before start) clamp to 0. Distinct from `runDuration`, which returns a
 * formatted string — this returns milliseconds for sorting, aggregation, and
 * ranking (Req 1.1–1.5, 10.1, 10.3).
 */
export function durationMs(
  startedAt: string | null | undefined,
  stoppedAt: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (startedAt == null) {
    return null;
  }
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) {
    return null;
  }
  const end = stoppedAt != null ? Date.parse(stoppedAt) : now;
  const resolvedEnd = Number.isNaN(end) ? now : end;
  return Math.max(0, resolvedEnd - start);
}

/**
 * True when the item is started but not yet stopped (elapsed-so-far applies).
 *
 * A `startedAt` that is absent or unparseable is not running; a present
 * `stoppedAt` means it has stopped.
 */
export function isRunning(
  startedAt: string | null | undefined,
  stoppedAt: string | null | undefined,
): boolean {
  if (startedAt == null || Number.isNaN(Date.parse(startedAt))) {
    return false;
  }
  return stoppedAt == null;
}

/**
 * Task duration as a formatted `HH:MM:SS` string (reuses `runDuration`), keyed
 * off a Task's `startedAt`/`stoppedAt`. Convenience wrapper so the run-detail
 * task table has a one-call cell (#1).
 */
export function taskDuration(
  task: Pick<Task, 'startedAt' | 'stoppedAt'>,
  now: number = Date.now(),
): string {
  return runDuration(task.startedAt, task.stoppedAt, now);
}
