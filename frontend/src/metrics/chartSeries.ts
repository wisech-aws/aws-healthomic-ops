/**
 * Actual-vs-limit chart shaping (Design §9).
 *
 * Shapes a group of `MetricSeries` (all series for one task, or the run-level
 * series for run-scoped metrics) into one `ChartSeriesPair` per metric
 * family present in the group: an actual (usage) series paired with a limit
 * series **iff** a limit series was actually measured for that same family in
 * that same group — a limit is never fabricated when none was measured
 * (Req 2.4, 3.4, 9.8).
 *
 * Pure, total, deterministic: output depends only on the input array; no
 * I/O, no `Date.now()`, no randomness. Grouping key is `family` (CPU and
 * MEMORY each carry their own usage+limit pair per the registry; the other
 * families currently only ever emit a `usage` role, so `limit` is `null` for
 * them by construction of the input, not by this function fabricating
 * anything).
 */

import type { MetricFamily, MetricPoint, MetricSeries } from '../api/types';

/** One chart-ready actual-vs-limit pair for a single metric family. */
export interface ChartSeriesPair {
  /** The metric name backing the actual series, or the limit's when no actual series exists. */
  readonly metricName: string;
  /** The metric unit (e.g. `bytes`, `{cpu}`), or `null` when unknown. */
  readonly unit: string | null;
  /** The usage series' points, or `null` when no usage series exists for this family in the group. */
  readonly actual: MetricPoint[] | null;
  /**
   * The limit series' points, or `null` when no limit series exists for this
   * family in this group. Never fabricated (Req 2.4, 3.4, 9.8).
   */
  readonly limit: MetricPoint[] | null;
}

/**
 * Shape a per-task (or per-run) group of `MetricSeries` into chart-ready
 * actual-vs-limit pairs, one per metric family present in the group.
 *
 * For each family: `actual` is the first `role: 'usage'` series' points found
 * for that family (or `null` if none), and `limit` is the first
 * `role: 'limit'` series' points found for that *same* family in the *same*
 * group (or `null` if none — never fabricated). A family with neither a
 * usage nor a limit series is absent from the output, not represented as a
 * pair of `null`s.
 *
 * **Validates: Requirements 2.4, 3.4, 9.8**
 */
export function chartSeries(seriesGroup: readonly MetricSeries[]): ChartSeriesPair[] {
  const byFamily = new Map<MetricFamily, { usage?: MetricSeries; limit?: MetricSeries }>();

  for (const series of seriesGroup) {
    const entry = byFamily.get(series.family) ?? {};
    if (series.role === 'usage' && entry.usage === undefined) {
      entry.usage = series;
    } else if (series.role === 'limit' && entry.limit === undefined) {
      entry.limit = series;
    }
    byFamily.set(series.family, entry);
  }

  const pairs: ChartSeriesPair[] = [];
  for (const { usage, limit } of byFamily.values()) {
    if (usage === undefined && limit === undefined) {
      // Unreachable given the population loop above, but keeps the function
      // total/defensive: a family with neither role is never emitted.
      continue;
    }
    pairs.push({
      metricName: (usage ?? limit)!.metricName,
      unit: usage?.unit ?? limit?.unit ?? null,
      actual: usage ? usage.points : null,
      limit: limit ? limit.points : null,
    });
  }

  return pairs;
}
