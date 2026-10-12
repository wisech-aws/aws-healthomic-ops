import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { runsInBuckets, formatDurationMs } from './durationBuckets';
import type { HistogramBucket, RunPoint } from '../api/types';

function run(partial: Partial<RunPoint> & Pick<RunPoint, 'runId'>): RunPoint {
  return {
    stoppedAt: '2024-01-02T10:00:00.000Z',
    status: 'COMPLETED',
    durationMs: 600000,
    ...partial,
  };
}

describe('formatDurationMs', () => {
  it('formats a known ms value to H:MM:SS', () => {
    expect(formatDurationMs(0)).toBe('0:00:00');
    expect(formatDurationMs(900000)).toBe('0:15:00'); // 15 min
    expect(formatDurationMs(3_661_000)).toBe('1:01:01'); // 1h 1m 1s
  });

  it('rounds to the nearest second', () => {
    expect(formatDurationMs(1499)).toBe('0:00:01');
    expect(formatDurationMs(1500)).toBe('0:00:02');
  });
});

describe('runsInBuckets', () => {
  // Two equal-width buckets: [300000, 600000) and [600000, 900000].
  const buckets: HistogramBucket[] = [
    { lo: 300000, hi: 600000, count: 0 },
    { lo: 600000, hi: 900000, count: 0 },
  ];

  it('returns [] for empty buckets', () => {
    expect(runsInBuckets([run({ runId: 'r' })], [])).toEqual([]);
  });

  it('returns index-aligned empty arrays when there are no runs', () => {
    expect(runsInBuckets([], buckets)).toEqual([[], []]);
  });

  it('places a run in the lower bucket when below the interior boundary', () => {
    const out = runsInBuckets([run({ runId: 'r-lo', durationMs: 450000 })], buckets);
    expect(out[0].map((p) => p.runId)).toEqual(['r-lo']);
    expect(out[1]).toEqual([]);
  });

  it('places a run exactly on an interior boundary in the UPPER bucket ([lo,hi))', () => {
    // 600000 is buckets[0].hi and buckets[1].lo: half-open [lo,hi) => upper.
    const out = runsInBuckets([run({ runId: 'r-boundary', durationMs: 600000 })], buckets);
    expect(out[0]).toEqual([]);
    expect(out[1].map((p) => p.runId)).toEqual(['r-boundary']);
  });

  it('places the max value in the LAST bucket (closed on the right)', () => {
    const out = runsInBuckets([run({ runId: 'r-max', durationMs: 900000 })], buckets);
    expect(out[0]).toEqual([]);
    expect(out[1].map((p) => p.runId)).toEqual(['r-max']);
  });

  it('places the min value in the first bucket', () => {
    const out = runsInBuckets([run({ runId: 'r-min', durationMs: 300000 })], buckets);
    expect(out[0].map((p) => p.runId)).toEqual(['r-min']);
    expect(out[1]).toEqual([]);
  });

  it('clamps a below-min run into the first bucket and an above-max run into the last', () => {
    const out = runsInBuckets(
      [
        run({ runId: 'r-under', durationMs: 100000 }),
        run({ runId: 'r-over', durationMs: 5_000_000 }),
      ],
      buckets,
    );
    expect(out[0].map((p) => p.runId)).toEqual(['r-under']);
    expect(out[1].map((p) => p.runId)).toEqual(['r-over']);
  });

  it('excludes runs with null/undefined/NaN/Infinity/negative durations', () => {
    const out = runsInBuckets(
      [
        run({ runId: 'r-null', durationMs: null }),
        run({ runId: 'r-undef', durationMs: undefined }),
        run({ runId: 'r-nan', durationMs: Number.NaN }),
        run({ runId: 'r-inf', durationMs: Number.POSITIVE_INFINITY }),
        run({ runId: 'r-neg', durationMs: -1 }),
      ],
      buckets,
    );
    expect(out).toEqual([[], []]);
  });

  it('places all finite runs in index 0 for a degenerate single collapsed bucket (lo === hi)', () => {
    const degenerate: HistogramBucket[] = [{ lo: 500000, hi: 500000, count: 0 }];
    const out = runsInBuckets(
      [
        run({ runId: 'a', durationMs: 500000 }),
        run({ runId: 'b', durationMs: 123 }),
        run({ runId: 'c', durationMs: null }),
      ],
      degenerate,
    );
    expect(out).toHaveLength(1);
    expect(out[0].map((p) => p.runId)).toEqual(['a', 'b']);
  });

  it('preserves input order within a bucket', () => {
    const out = runsInBuckets(
      [
        run({ runId: 'first', durationMs: 400000 }),
        run({ runId: 'second', durationMs: 350000 }),
      ],
      buckets,
    );
    expect(out[0].map((p) => p.runId)).toEqual(['first', 'second']);
  });

  it('per-bucket counts reconcile with a hand-built durationHistogram fixture', () => {
    // Fixture: histogram claims bucket0=1, bucket1=2.
    const histogram: HistogramBucket[] = [
      { lo: 300000, hi: 600000, count: 1 },
      { lo: 600000, hi: 900000, count: 2 },
    ];
    const points: RunPoint[] = [
      run({ runId: 'b0', durationMs: 450000 }),
      run({ runId: 'b1a', durationMs: 600000 }),
      run({ runId: 'b1b', durationMs: 900000 }),
    ];
    const out = runsInBuckets(points, histogram);
    expect(out.map((bucket) => bucket.length)).toEqual(
      histogram.map((b) => b.count),
    );
  });
});

describe('runsInBuckets — properties', () => {
  const runArb: fc.Arbitrary<RunPoint> = fc.record({
    runId: fc.string({ minLength: 1, maxLength: 8 }),
    stoppedAt: fc.constant('2024-01-02T10:00:00.000Z'),
    durationMs: fc.oneof(
      fc.constantFrom<number | null | undefined>(
        null,
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
      ),
      fc.integer({ min: 0, max: 10_000_000 }),
    ),
    status: fc.constantFrom('COMPLETED', 'FAILED', 'CANCELLED', null),
  });

  it('every assigned run has a finite duration within [min, max], and total assigned <= input length', () => {
    fc.assert(
      fc.property(
        fc.array(runArb, { maxLength: 40 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (points, bucketCount, a, b) => {
          const min = Math.min(a, b);
          const max = Math.max(a, b);
          const width = (max - min) / bucketCount;
          const buckets: HistogramBucket[] = Array.from(
            { length: bucketCount },
            (_, i) => ({
              lo: min + i * width,
              hi: i === bucketCount - 1 ? max : min + (i + 1) * width,
              count: 0,
            }),
          );

          const out = runsInBuckets(points, buckets);
          expect(out).toHaveLength(bucketCount);

          let totalAssigned = 0;
          for (let i = 0; i < out.length; i += 1) {
            for (const p of out[i]) {
              totalAssigned += 1;
              // Only finite, >= 0 durations are ever assigned.
              expect(typeof p.durationMs).toBe('number');
              expect(Number.isFinite(p.durationMs as number)).toBe(true);
              expect(p.durationMs as number).toBeGreaterThanOrEqual(0);
            }
          }
          // Total assigned equals the count of usable runs (every usable run is
          // clamped into some bucket), and never exceeds the input length.
          const usable = points.filter(
            (p) =>
              typeof p.durationMs === 'number' &&
              Number.isFinite(p.durationMs) &&
              (p.durationMs as number) >= 0,
          ).length;
          expect(totalAssigned).toBe(usable);
          expect(totalAssigned).toBeLessThanOrEqual(points.length);
        },
      ),
    );
  });
});
