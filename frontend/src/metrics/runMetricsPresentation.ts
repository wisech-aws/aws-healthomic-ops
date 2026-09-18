/**
 * Measured-presentation derivation for `RunDetailView`/`RunMetricsPanel`
 * (Req 5.1, 5.2; design §9 "augment-not-replace").
 *
 * `getRunMetrics` can come back loading, as a typed error, as an empty
 * success (no measured metrics for this run), or as a success with series.
 * This module is the pure derivation of which of those four states to show
 * for the *measured* panel — it has NO knowledge of, and NO way to reach, the
 * derived `ResourceSummary` (`metrics/resourceSummary.ts`).
 *
 * CRITICAL (Req 5.1, 5.2): `deriveMeasuredPresentation` does not take a
 * `ResourceSummary` as input, does not return one, and cannot mutate one —
 * there is nothing in its signature or implementation that could touch it.
 * This makes it structurally impossible for any measured outcome (loading,
 * error, unavailable, or ready) to blank or degrade the derived summary.
 * `RunDetailView` must render `ResourceSummaryCard` unconditionally,
 * regardless of this function's output; the measured panel this function
 * drives is only ever added *alongside* it, never in place of it.
 */
import type { MetricSeries, RunMetrics } from '../api/types';

/** The four distinct, mutually-exclusive states the measured panel can be in. */
export type MeasuredPhase = 'loading' | 'error' | 'unavailable' | 'ready';

/** What `RunMetricsPanel` should render for the measured metrics view. */
export interface RunMetricsPresentation {
  /** Which of the four honest states to show (Req 10.1, 10.2, 10.4). */
  readonly phase: MeasuredPhase;
  /** The series to chart. Empty unless `phase === 'ready'`. */
  readonly series: MetricSeries[];
  /** The typed error message. Non-null iff `phase === 'error'`. */
  readonly errorMessage: string | null;
}

/**
 * Derive the measured-metrics presentation state from a `getRunMetrics`
 * result (Req 5.1, 5.2, 10.1–10.4; Property 7).
 *
 * Rules (design §9, Property 7):
 *  - `isLoading` true, or `result` is `null` with no result yet, → `'loading'`
 *    (no series, no error).
 *  - Otherwise a non-null `result.error` → `'error'`, carrying that message
 *    with `series: []` (a typed failure is never conflated with "no data").
 *  - Otherwise an empty `result.series` → `'unavailable'`, `series: []`,
 *    `errorMessage: null` (honest "no measured data", never a fabricated
 *    value).
 *  - Otherwise → `'ready'`, `series: result.series`, `errorMessage: null`.
 *
 * Pure, total, deterministic, and — by construction — incapable of touching
 * the derived `ResourceSummary`: this function neither accepts one as input
 * nor produces one as output, so no measured outcome here can ever blank or
 * degrade it (Req 5.1, 5.2).
 */
export function deriveMeasuredPresentation(
  result: RunMetrics | null,
  isLoading: boolean,
): RunMetricsPresentation {
  if (isLoading || result == null) {
    return { phase: 'loading', series: [], errorMessage: null };
  }

  if (result.error != null) {
    return { phase: 'error', series: [], errorMessage: result.error };
  }

  if (result.series.length === 0) {
    return { phase: 'unavailable', series: [], errorMessage: null };
  }

  return { phase: 'ready', series: result.series, errorMessage: null };
}
