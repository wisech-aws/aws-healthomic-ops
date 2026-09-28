/**
 * Pure aggregation helpers for the Workflow_Group report
 * (workflow-performance-reports Req 3.x, 6.x; design §6, §"Testing Strategy").
 *
 * `aggregateMetric` computes mean, median, and p90 for one Tracked_Metric over
 * a group's runs, considering ONLY the runs for which that metric was available
 * — an unavailable run never contributes and is never counted as `0` (Req 3.2,
 * 10.1). It also reports the availability denominator: `availableCount` (N) and
 * `totalCount` (M). When no run has the metric available, every statistic is
 * `null` (the Metric_Unavailable_State) rather than a fabricated value (Req 3.4).
 *
 * `detectCollision` reports whether a friendly `(workflowName, versionName)`
 * group maps to more than one distinct `workflowId`, so a report never silently
 * blends two unrelated workflows (Req 6.1, 6.2).
 *
 * Both are pure and total — no I/O, never throw — so they are unit- and
 * property-testable in isolation.
 */

/** A per-run value for one metric: `null` when the metric was unavailable for that run. */
export type MetricValue = number | null;

/** The aggregated statistics for one Tracked_Metric across a group's runs. */
export interface AggregateMetric {
  /** Arithmetic mean over available values, or `null` when none are available. */
  mean: number | null;
  /** Median (interpolated midpoint of the sorted available values), or `null`. */
  median: number | null;
  /** p90 by the nearest-rank method over available values, or `null`. */
  p90: number | null;
  /** N — the number of runs for which the metric was available. */
  availableCount: number;
  /** M — the total number of runs in the group. */
  totalCount: number;
}

/**
 * Compute mean/median/p90 for one Tracked_Metric over a group's per-run values.
 *
 * `values` carries one entry per run in the group, `null` where the metric was
 * unavailable for that run. Statistics are computed over the non-null values
 * only; `totalCount` is `values.length` and `availableCount` is the count of
 * non-null entries (Req 3.2, 3.3). When no value is available every statistic
 * is `null` (Req 3.4).
 *
 * Definitions (fixed and documented so client/CSV/PDF agree, design §4):
 *  - mean:   arithmetic mean of the available values.
 *  - median: for an odd count, the middle sorted value; for an even count, the
 *            average of the two middle sorted values.
 *  - p90:    NEAREST-RANK — sort ascending, take the value at rank
 *            ceil(0.90 × n) (1-based), i.e. index `ceil(0.9n) - 1`.
 */
export function aggregateMetric(values: readonly MetricValue[]): AggregateMetric {
  const totalCount = values.length;
  const available = values.filter((v): v is number => v != null && Number.isFinite(v));
  const availableCount = available.length;

  if (availableCount === 0) {
    return { mean: null, median: null, p90: null, availableCount: 0, totalCount };
  }

  const sorted = [...available].sort((a, b) => a - b);

  const mean = sorted.reduce((a, b) => a + b, 0) / availableCount;

  const mid = Math.floor(availableCount / 2);
  const median =
    availableCount % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;

  // Nearest-rank p90: rank = ceil(0.9 * n), 1-based; clamp to [1, n].
  const rank = Math.min(availableCount, Math.max(1, Math.ceil(0.9 * availableCount)));
  const p90 = sorted[rank - 1];

  return { mean, median, p90, availableCount, totalCount };
}

/**
 * Detect a Workflow_Group name/version collision: `true` iff the group's runs
 * carry more than one distinct, defined `workflowId`
 * (workflow-performance-reports Req 6.2). Absent/empty ids are ignored (they
 * are not a distinct workflow), so a group whose runs simply lack an id is not
 * flagged as a collision.
 */
export function detectCollision(workflowIds: ReadonlyArray<string | undefined>): boolean {
  const distinct = new Set<string>();
  for (const id of workflowIds) {
    if (typeof id === 'string' && id.trim() !== '') {
      distinct.add(id);
    }
  }
  return distinct.size > 1;
}

/** The distinct, defined workflowIds observed in a group (for the collision affordance). */
export function distinctWorkflowIds(
  workflowIds: ReadonlyArray<string | undefined>,
): string[] {
  const distinct = new Set<string>();
  for (const id of workflowIds) {
    if (typeof id === 'string' && id.trim() !== '') {
      distinct.add(id);
    }
  }
  return [...distinct];
}

// ── High-volume (50k+) fixed-size chart series (Req 11.2) ───────────────────

/** One histogram bucket: `[lo, hi)` and the count of values in it. */
export interface HistogramBucket {
  lo: number;
  hi: number;
  count: number;
}

/** A fixed-size distribution of a metric's available values. */
export interface MetricHistogram {
  buckets: HistogramBucket[];
  /** N — values counted into the histogram. */
  availableCount: number;
  /** M — total runs in the group (for the N-of-M denominator). */
  totalCount: number;
}

/**
 * Build a fixed-size histogram of `values` over at most `maxBuckets` equal-width
 * buckets (workflow-performance-reports Req 11.2, Property 12).
 *
 * Guarantees, regardless of how many values are supplied (10 or 10 million):
 *  - the number of buckets is ≤ `maxBuckets` (bounded output);
 *  - every finite value falls in EXACTLY one bucket (the last bucket is closed
 *    on the right so the max value is included);
 *  - the sum of bucket counts equals the number of finite values.
 *
 * `nulls` (unavailable) are excluded; `totalCount` records the group size for
 * the denominator. When there are no finite values, returns zero buckets.
 */
export function buildHistogram(
  values: readonly MetricValue[],
  maxBuckets: number,
  totalCount: number,
): MetricHistogram {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  const availableCount = finite.length;
  if (availableCount === 0) {
    return { buckets: [], availableCount: 0, totalCount };
  }

  let min = finite[0];
  let max = finite[0];
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const cap = Math.max(1, Math.floor(maxBuckets));
  // Degenerate spread (all values equal): a single bucket holding everything.
  if (max === min) {
    return {
      buckets: [{ lo: min, hi: max, count: availableCount }],
      availableCount,
      totalCount,
    };
  }

  const bucketCount = cap;
  const width = (max - min) / bucketCount;
  const buckets: HistogramBucket[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    buckets.push({ lo: min + i * width, hi: min + (i + 1) * width, count: 0 });
  }
  for (const v of finite) {
    // index by position; clamp so the maximum lands in the last bucket
    // (last bucket is treated as closed on the right).
    let idx = Math.floor((v - min) / width);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    buckets[idx].count += 1;
  }
  return { buckets, availableCount, totalCount };
}

/** One time bin: `[start, end)` with a run count and per-bin duration stats. */
export interface TimeBin {
  start: string;
  end: string;
  runCount: number;
  /** Mean duration (ms) over runs in the bin with duration available, or null. */
  durationMeanMs: number | null;
  /** p90 duration (ms) over runs in the bin with duration available, or null. */
  durationP90Ms: number | null;
}

/** A run's `(stoppedAt, durationMs)` for time-binning; durationMs null = unavailable. */
export interface TimeBinPoint {
  stoppedAtMs: number;
  durationMs: number | null;
}

/**
 * Bin `[startMs, endMs)` into at most `maxBins` equal-width time bins and
 * compute per-bin run count + mean/p90 duration (Req 11.2). The number of bins
 * is bounded by `maxBins` regardless of run count. p90 per bin uses the same
 * nearest-rank definition as {@link aggregateMetric}. Points outside the window
 * are ignored; a run with null duration counts toward `runCount` but not the
 * duration stats (availability honesty).
 */
export function buildTimeBins(
  points: readonly TimeBinPoint[],
  startMs: number,
  endMs: number,
  maxBins: number,
): TimeBin[] {
  const cap = Math.max(1, Math.floor(maxBins));
  if (!(endMs > startMs)) {
    return [];
  }
  const span = endMs - startMs;
  const binCount = cap;
  const width = span / binCount;
  const durationsByBin: number[][] = Array.from({ length: binCount }, () => []);
  const counts = new Array<number>(binCount).fill(0);

  for (const p of points) {
    if (p.stoppedAtMs < startMs || p.stoppedAtMs >= endMs) {
      continue;
    }
    let idx = Math.floor((p.stoppedAtMs - startMs) / width);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
    if (p.durationMs != null && Number.isFinite(p.durationMs)) {
      durationsByBin[idx].push(p.durationMs);
    }
  }

  const bins: TimeBin[] = [];
  for (let i = 0; i < binCount; i += 1) {
    const ds = durationsByBin[i];
    let mean: number | null = null;
    let p90: number | null = null;
    if (ds.length > 0) {
      const sorted = [...ds].sort((a, b) => a - b);
      mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const rank = Math.min(sorted.length, Math.max(1, Math.ceil(0.9 * sorted.length)));
      p90 = sorted[rank - 1];
    }
    bins.push({
      start: new Date(startMs + i * width).toISOString(),
      end: new Date(startMs + (i + 1) * width).toISOString(),
      runCount: counts[i],
      durationMeanMs: mean,
      durationP90Ms: p90,
    });
  }
  return bins;
}
