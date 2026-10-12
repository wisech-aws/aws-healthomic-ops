/**
 * Pure helpers for the Reports view's duration distribution histogram.
 *
 * Two exports:
 *  - {@link formatDurationMs} — a shared H:MM:SS formatter (one source of truth
 *    for the aggregate table and the per-bucket run popovers).
 *  - {@link runsInBuckets} — maps the full paged run set onto the server's
 *    fixed-size histogram buckets so each bar's run count equals the number of
 *    runs listed in its popover.
 *
 * Strict no-fabrication: a run is placed in a bucket only when it carries a
 * usable `durationMs` (a finite number >= 0). Runs with a null/undefined/NaN/
 * Infinity/negative `durationMs` are placed in NO bucket — never counted.
 */
import type { HistogramBucket, RunPoint } from '../api/types';

/** True when `v` is a finite number >= 0 (rejects null/undefined/NaN/Infinity/negative). */
function isUsableDurationMs(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Assign each run to its histogram bucket, mirroring the server's
 * `buildHistogram` (ingest/src/metrics/aggregate.ts) EXACTLY so per-bar counts
 * reconcile with per-popover run lists.
 *
 * Convention (matches the server):
 *  - `min = buckets[0].lo`, `max = buckets[last].hi`,
 *    `width = (max - min) / buckets.length`.
 *  - A usable run lands in `idx = floor((v - min) / width)` clamped to
 *    `[0, buckets.length - 1]`. Net effect: every bucket is half-open
 *    `[lo, hi)` EXCEPT the LAST bucket which is CLOSED `[lo, hi]`, so the max
 *    value lands in the final bucket.
 *  - Degenerate case (`max === min`, i.e. non-positive/non-finite `width`):
 *    every usable run collapses into index 0, mirroring the server's single
 *    bucket.
 *
 * Returns an array index-aligned to `buckets`; `buckets.length === 0` yields
 * `[]`. Input order is preserved within each bucket.
 */
export function runsInBuckets(
  points: readonly RunPoint[],
  buckets: readonly HistogramBucket[],
): RunPoint[][] {
  if (buckets.length === 0) {
    return [];
  }
  const out: RunPoint[][] = buckets.map(() => []);
  const min = buckets[0].lo;
  const max = buckets[buckets.length - 1].hi;
  const width = (max - min) / buckets.length;
  const lastIndex = buckets.length - 1;

  for (const p of points) {
    if (!isUsableDurationMs(p.durationMs)) {
      continue;
    }
    let idx: number;
    if (!(width > 0)) {
      // Degenerate single-bucket collapse (max === min or non-finite width).
      idx = 0;
    } else {
      idx = Math.floor((p.durationMs - min) / width);
      if (idx < 0) {
        idx = 0;
      } else if (idx > lastIndex) {
        idx = lastIndex;
      }
    }
    out[idx].push(p);
  }
  return out;
}

/**
 * Format a duration in milliseconds as `H:MM:SS`. Shared by the aggregate
 * table's duration branch and the bucket popovers' per-run duration labels so
 * they stay a single source of truth.
 */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
