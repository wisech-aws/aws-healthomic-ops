import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  aggregateMetric,
  detectCollision,
  distinctWorkflowIds,
  buildHistogram,
  buildTimeBins,
  type MetricValue,
} from '../src/metrics/aggregate.js';

/** Independent reference implementations for the properties. */
function refMean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function refMedian(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function refNearestRankP90(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.min(s.length, Math.max(1, Math.ceil(0.9 * s.length)));
  return s[rank - 1];
}

describe('aggregateMetric — example cases', () => {
  it('empty / all-unavailable => Metric_Unavailable_State (all null)', () => {
    expect(aggregateMetric([])).toEqual({
      mean: null,
      median: null,
      p90: null,
      availableCount: 0,
      totalCount: 0,
    });
    expect(aggregateMetric([null, null])).toEqual({
      mean: null,
      median: null,
      p90: null,
      availableCount: 0,
      totalCount: 2,
    });
  });

  it('computes mean/median/p90 over available values only', () => {
    // Available: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100 (n=10)
    const vals: MetricValue[] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const a = aggregateMetric(vals);
    expect(a.mean).toBeCloseTo(55, 9);
    expect(a.median).toBeCloseTo(55, 9); // even count => (50+60)/2
    // nearest-rank p90: ceil(0.9*10)=9 => 9th value (1-based) = 90.
    expect(a.p90).toBe(90);
    expect(a.availableCount).toBe(10);
    expect(a.totalCount).toBe(10);
  });

  it('excludes unavailable (null) runs but counts them in totalCount, never as 0', () => {
    const a = aggregateMetric([100, null, 200, null]);
    expect(a.availableCount).toBe(2);
    expect(a.totalCount).toBe(4);
    expect(a.mean).toBeCloseTo(150, 9); // NOT (100+0+200+0)/4 = 75
    expect(a.p90).toBe(200);
  });
});

// Property 1 (availability gating) + Property 2 (no zero fabrication for the
// aggregate surface): statistics are computed over exactly the non-null values,
// and a null run never contributes a 0.
// Feature: workflow-performance-reports, Property 1
describe('aggregateMetric — Property 1: availability gating', () => {
  it('mean/median/p90 equal the reference over ONLY the available values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { nil: null }), {
          maxLength: 30,
        }),
        (values) => {
          const a = aggregateMetric(values);
          const available = values.filter((v): v is number => v != null && Number.isFinite(v));
          expect(a.totalCount).toBe(values.length);
          expect(a.availableCount).toBe(available.length);
          if (available.length === 0) {
            expect(a.mean).toBeNull();
            expect(a.median).toBeNull();
            expect(a.p90).toBeNull();
          } else {
            expect(a.mean).toBeCloseTo(refMean(available), 6);
            expect(a.median).toBeCloseTo(refMedian(available), 6);
            expect(a.p90).toBe(refNearestRankP90(available));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Property 3: percentile correctness — p90 uses the fixed nearest-rank method.
// Feature: workflow-performance-reports, Property 3
describe('aggregateMetric — Property 3: percentile correctness', () => {
  it('p90 equals the nearest-rank reference for any non-empty available set', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1e9, noNaN: true }), { minLength: 1, maxLength: 40 }),
        (available) => {
          const a = aggregateMetric(available);
          expect(a.p90).toBe(refNearestRankP90(available));
          // p90 is always one of the actual observed values (nearest-rank).
          expect(available).toContain(a.p90);
          // p90 >= median >= min for a sorted set.
          expect(a.p90! + 1e-9).toBeGreaterThanOrEqual(a.median!);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Property 4: denominator correctness — N is the available count, M the total.
// Feature: workflow-performance-reports, Property 4
describe('aggregateMetric — Property 4: denominators', () => {
  it('availableCount is the non-null count and totalCount is the length', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: null }), {
          maxLength: 25,
        }),
        (values) => {
          const a = aggregateMetric(values);
          const n = values.filter((v) => v != null && Number.isFinite(v as number)).length;
          expect(a.availableCount).toBe(n);
          expect(a.totalCount).toBe(values.length);
          expect(a.availableCount).toBeLessThanOrEqual(a.totalCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Property 6: collision detection — true iff > 1 distinct defined workflowId.
// Feature: workflow-performance-reports, Property 6
describe('detectCollision — Property 6', () => {
  it('example cases', () => {
    expect(detectCollision(['wf-1', 'wf-1', 'wf-1'])).toBe(false);
    expect(detectCollision(['wf-1', 'wf-2'])).toBe(true);
    expect(detectCollision([undefined, '', 'wf-1'])).toBe(false); // absent/empty ignored
    expect(detectCollision([])).toBe(false);
    expect(distinctWorkflowIds(['wf-1', 'wf-2', 'wf-1', undefined, ''])).toEqual(['wf-1', 'wf-2']);
  });

  it('collision is true iff distinct defined ids exceed one', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.constantFrom('a', 'b', 'c', ''), { nil: undefined }), {
          maxLength: 20,
        }),
        (ids) => {
          const defined = new Set(ids.filter((i) => typeof i === 'string' && i.trim() !== ''));
          expect(detectCollision(ids)).toBe(defined.size > 1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Property 12: histogram completeness — every available value falls in exactly
// one bucket, bucket count is bounded, and Σ counts == availableCount.
// Feature: workflow-performance-reports, Property 12
describe('buildHistogram — Property 12: completeness + bounded buckets', () => {
  it('sum of bucket counts equals available count; bucket count ≤ cap', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.double({ min: 0, max: 1e6, noNaN: true }), { nil: null }), {
          maxLength: 200,
        }),
        fc.integer({ min: 1, max: 40 }),
        (values, maxBuckets) => {
          const h = buildHistogram(values, maxBuckets, values.length);
          const finite = values.filter((v) => v != null && Number.isFinite(v as number));
          expect(h.availableCount).toBe(finite.length);
          expect(h.totalCount).toBe(values.length);
          expect(h.buckets.length).toBeLessThanOrEqual(maxBuckets);
          const summed = h.buckets.reduce((a, b) => a + b.count, 0);
          expect(summed).toBe(finite.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all-equal values collapse to a single bucket holding everything', () => {
    const h = buildHistogram([5, 5, 5, 5], 20, 4);
    expect(h.buckets).toHaveLength(1);
    expect(h.buckets[0].count).toBe(4);
  });

  it('empty/all-null yields zero buckets (never fabricated)', () => {
    expect(buildHistogram([], 10, 0).buckets).toEqual([]);
    expect(buildHistogram([null, null], 10, 2).buckets).toEqual([]);
  });
});

// Property 13: aggregate exactness at scale — mean and counts are exact for a
// large set; the histogram remains bounded and complete.
// Feature: workflow-performance-reports, Property 13
describe('aggregate — Property 13: exactness at 50k scale', () => {
  it('mean/counts exact and histogram bounded for 50,000 values', () => {
    const N = 50_000;
    const values: number[] = [];
    let sum = 0;
    for (let i = 0; i < N; i += 1) {
      const v = (i % 1000) + 1; // deterministic spread 1..1000
      values.push(v);
      sum += v;
    }
    const agg = aggregateMetric(values);
    expect(agg.availableCount).toBe(N);
    expect(agg.totalCount).toBe(N);
    expect(agg.mean).toBeCloseTo(sum / N, 6);
    // p90 exact via nearest-rank reference.
    const sorted = [...values].sort((a, b) => a - b);
    const p90rank = Math.ceil(0.9 * N);
    expect(agg.p90).toBe(sorted[p90rank - 1]);

    const h = buildHistogram(values, 30, N);
    expect(h.buckets.length).toBeLessThanOrEqual(30);
    expect(h.buckets.reduce((a, b) => a + b.count, 0)).toBe(N);
    expect(h.availableCount).toBe(N);
  });
});

describe('buildTimeBins — example', () => {
  const start = Date.parse('2026-09-01T00:00:00.000Z');
  const end = Date.parse('2026-09-05T00:00:00.000Z'); // 4 days

  it('bins by time with per-bin count and mean/p90, bounded bin count', () => {
    const points = [
      { stoppedAtMs: Date.parse('2026-09-01T06:00:00Z'), durationMs: 100 },
      { stoppedAtMs: Date.parse('2026-09-01T12:00:00Z'), durationMs: 300 },
      { stoppedAtMs: Date.parse('2026-09-03T00:00:00Z'), durationMs: 200 },
      { stoppedAtMs: Date.parse('2026-09-03T01:00:00Z'), durationMs: null }, // counted, no duration
    ];
    const bins = buildTimeBins(points, start, end, 4);
    expect(bins).toHaveLength(4);
    expect(bins[0].runCount).toBe(2);
    expect(bins[0].durationMeanMs).toBeCloseTo(200, 6);
    expect(bins[2].runCount).toBe(2);
    expect(bins[2].durationMeanMs).toBeCloseTo(200, 6);
    expect(bins[1].runCount).toBe(0);
    expect(bins[1].durationMeanMs).toBeNull();
  });

  it('caps bin count and ignores out-of-window points', () => {
    const points = [
      { stoppedAtMs: start - 1000, durationMs: 5 },
      { stoppedAtMs: end + 1000, durationMs: 5 },
      { stoppedAtMs: start + 1000, durationMs: 50 },
    ];
    const bins = buildTimeBins(points, start, end, 10);
    expect(bins.length).toBeLessThanOrEqual(10);
    const total = bins.reduce((a, b) => a + b.runCount, 0);
    expect(total).toBe(1);
  });
});
