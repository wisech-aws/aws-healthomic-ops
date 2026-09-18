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
 * The peak-memory metric always carries an unconfirmed-units note and is
 * computed as a unit-agnostic sum with no unit conversion, so only its display
 * label changes if the confirmed unit differs (Req 11.1, 11.2, 11.3;
 * CONFIRM AGAINST AWS DOCS).
 */

import type { Task } from '../api/types';
import { peakConcurrent, toIntervals } from './intervals';

/** Milliseconds in one hour, used to convert interval durations to hours. */
const MS_PER_HOUR = 3_600_000;

/**
 * The unconfirmed-units caveat attached to the peak memory metric. The memory
 * unit reported by AWS HealthOmics is not yet confirmed against AWS docs, so
 * the raw aggregated value is surfaced under this note rather than converted
 * into any unit (Req 11.1, 11.2).
 */
export const MEMORY_UNITS_UNCONFIRMED_NOTE =
  'Memory unit is unconfirmed pending AWS documentation confirmation; the raw value is not unit-converted.';

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
  /** Optional caveat (e.g. the memory unconfirmed-units note). */
  readonly note?: string;
}

/** A run's aggregated resource footprint. */
export interface ResourceSummary {
  /** Peak count of concurrently-running tasks. Zero for an empty task set. */
  readonly peakConcurrentTasks: number;
  /** Peak sum of `cpus` across concurrently-running tasks. */
  readonly peakConcurrentCpus: ResourceMetric;
  /** Total CPU-hours = Σ (interval duration hours × interval cpus). */
  readonly cpuHours: ResourceMetric;
  /** Peak sum of `memory` across concurrently-running tasks (units unconfirmed). */
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
 * - `peakConcurrentMemory`: peak summed `memory` over concurrent intervals,
 *   a unit-agnostic sum with no conversion; always carries the unconfirmed
 *   units note; unavailable when no interval carries a non-null `memory`.
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

  // Peak concurrent memory: unit-agnostic sum, no conversion (Req 11.1–11.3).
  // The units note is attached ALWAYS, whether or not the metric is available.
  const peakMemory = peakConcurrent(intervals, (i) => i.memory ?? 0).peakWeight;
  const peakConcurrentMemory: ResourceMetric = hasMemory
    ? {
        value: peakMemory,
        available: true,
        note: MEMORY_UNITS_UNCONFIRMED_NOTE,
      }
    : {
        value: null,
        available: false,
        note: MEMORY_UNITS_UNCONFIRMED_NOTE,
      };

  return {
    peakConcurrentTasks,
    peakConcurrentCpus,
    cpuHours,
    peakConcurrentMemory,
    partial,
  };
}
