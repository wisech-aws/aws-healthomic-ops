/**
 * Per-run resource summary (enhancement 2).
 *
 * Aggregates a run's tasks into peak concurrent tasks, peak concurrent CPUs,
 * total CPU-hours, and peak concurrent memory, all derived from the half-open
 * execution intervals produced by `toIntervals` and the boundary sweep in
 * `peakConcurrent` (`metrics/intervals.ts`).
 *
 * Per the project's standing rule, no value is fabricated: each `ResourceMetric`
 * reports `available: false` with a `null` value when the field it needs
 * (`cpus` for the CPU metrics, `memory` for the memory metric) is absent on
 * every started task — never 0-as-data (Req 2.5, 2.6, 10.1, 10.4). While any
 * interval is still open the summary is flagged `partial` because the values
 * are provisional lower bounds (Req 2.7, 10.4).
 *
 * The peak-memory metric is a sum of each concurrently-running task's reserved
 * memory, reported in gibibytes (GiB). The unit is confirmed against the AWS
 * HealthOmics API reference — `TaskListItem.memory` / `GetRunTask` `memory` is
 * documented as the task's memory in gigabytes (HealthOmics uses gibibytes in
 * practice, e.g. a task reporting `6` maps to the 6,442,450,944-byte / 6 GiB
 * reservation surfaced by the run-utilization metrics). The raw integer sum is
 * therefore already in GiB and is surfaced with that unit (Req 11.1, 11.2,
 * 11.3).
 */

import type { Task } from '../api/types';
import { peakConcurrent, toIntervals } from './intervals';

/** Milliseconds in one hour, used to convert interval durations to hours. */
const MS_PER_HOUR = 3_600_000;

/**
 * The unit of the peak-memory metric, confirmed against the AWS HealthOmics API
 * reference (`TaskListItem` / `GetRunTask` `memory` = the task's memory in
 * gibibytes). The raw summed value is already in this unit, so it is surfaced
 * directly with the `GiB` label — no conversion is applied.
 */
export const MEMORY_UNIT = 'GiB';

/**
 * A short clarifying note for the peak-memory metric: it is the peak SUM of
 * reserved memory across concurrently-running tasks (a reservation-based
 * footprint), in GiB. This documents what the number means rather than
 * flagging an unknown unit — the unit is now confirmed (see {@link MEMORY_UNIT}).
 */
export const MEMORY_METRIC_NOTE =
  'Peak sum of reserved memory across concurrently-running tasks, in gibibytes (GiB).';

/**
 * A resource metric that may be unavailable. `available` distinguishes a real
 * computed value from "not derivable from present data" so the UI never shows a
 * fabricated 0. `note` carries the units caveat for memory (see Req 11).
 */
export interface ResourceMetric {
  /** The computed value, or `null` when the metric is unavailable. */
  readonly value: number | null;
  /** True when the metric's input field exists on at least one started task. */
  readonly available: boolean;
  /** Optional caveat or clarifying note (e.g. the memory metric note). */
  readonly note?: string;
  /** Optional unit label for the value (e.g. `GiB` for memory). */
  readonly unit?: string;
}

/** A run's aggregated resource footprint. */
export interface ResourceSummary {
  /** Peak count of concurrently-running tasks. Zero for an empty task set. */
  readonly peakConcurrentTasks: number;
  /** Peak sum of `cpus` across concurrently-running tasks. */
  readonly peakConcurrentCpus: ResourceMetric;
  /** Total CPU-hours = Σ (interval duration hours × interval cpus). */
  readonly cpuHours: ResourceMetric;
  /** Peak sum of reserved `memory` (GiB) across concurrently-running tasks. */
  readonly peakConcurrentMemory: ResourceMetric;
  /** True when any interval is still open (values are provisional lower bounds). */
  readonly partial: boolean;
}

/**
 * Summarize a run's resource usage from its tasks (Req 2.4–2.7).
 *
 * Builds intervals once via `toIntervals`, then:
 * - `peakConcurrentTasks`: peak overlap count (unit weight), 0 for empty input.
 * - `peakConcurrentCpus`: peak summed `cpus` over concurrent intervals;
 *   unavailable (value `null`) when no interval carries a non-null `cpus`.
 * - `cpuHours`: `Σ (durationMs(i)/3_600_000 × i.cpus)` over intervals with
 *   non-null `cpus`; unavailable when none carry a non-null `cpus`.
 * - `peakConcurrentMemory`: peak summed `memory` over concurrent intervals, in
 *   GiB (the confirmed unit; the raw integer sum is already in GiB, no
 *   conversion); carries the clarifying note and `GiB` unit; unavailable when
 *   no interval carries a non-null `memory`.
 * - `partial`: true iff any interval is `open`.
 */
export function summarizeResources(
  tasks: readonly Task[],
  now: number = Date.now(),
): ResourceSummary {
  const intervals = toIntervals(tasks, now);

  const hasCpus = intervals.some((i) => i.cpus != null);
  const hasMemory = intervals.some((i) => i.memory != null);
  const partial = intervals.some((i) => i.open);

  // Peak concurrent tasks: unit weight per interval (Req 2.2).
  const peakConcurrentTasks = peakConcurrent(intervals, () => 1).peakCount;

  // Peak concurrent CPUs: sum of cpus over overlapping intervals (Req 2.3).
  // Null cpus contribute 0 to the weight but do not make the metric available.
  const peakCpus = peakConcurrent(intervals, (i) => i.cpus ?? 0).peakWeight;
  const peakConcurrentCpus: ResourceMetric = hasCpus
    ? { value: peakCpus, available: true }
    : { value: null, available: false };

  // CPU-hours: summed area over intervals with non-null cpus (Req 2.4).
  // The interval duration is `end - start`; `toIntervals` guarantees
  // `start <= end` (inverted intervals are clamped), so this is >= 0 and
  // matches `durationMs` of the interval's bounding timestamps.
  const cpuHoursValue = intervals.reduce((sum, i) => {
    if (i.cpus == null) {
      return sum;
    }
    const durationHours = (i.end - i.start) / MS_PER_HOUR;
    return sum + durationHours * i.cpus;
  }, 0);
  const cpuHours: ResourceMetric = hasCpus
    ? { value: cpuHoursValue, available: true }
    : { value: null, available: false };

  // Peak concurrent memory: sum of reserved memory (GiB) over concurrent
  // intervals. The unit is confirmed (GiB, see MEMORY_UNIT) so the raw integer
  // sum is surfaced directly with that unit; the clarifying note documents what
  // the number means. Attached whether or not the metric is available.
  const peakMemory = peakConcurrent(intervals, (i) => i.memory ?? 0).peakWeight;
  const peakConcurrentMemory: ResourceMetric = hasMemory
    ? {
        value: peakMemory,
        available: true,
        note: MEMORY_METRIC_NOTE,
        unit: MEMORY_UNIT,
      }
    : {
        value: null,
        available: false,
        note: MEMORY_METRIC_NOTE,
        unit: MEMORY_UNIT,
      };

  return {
    peakConcurrentTasks,
    peakConcurrentCpus,
    cpuHours,
    peakConcurrentMemory,
    partial,
  };
}
