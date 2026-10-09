import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  runPointsToScatterData,
  formatDurationMs,
  topLongestRuns,
  type ScatterDatum,
} from './runScatter';
import type { RunPoint } from '../api/types';

function run(partial: Partial<RunPoint> & Pick<RunPoint, 'runId'>): RunPoint {
  return {
    stoppedAt: '2024-01-02T10:00:00.000Z',
    status: 'COMPLETED',
    durationMs: 600000,
    ...partial,
  };
}

describe('runPointsToScatterData', () => {
  it('omits runs with null durationMs', () => {
    const out = runPointsToScatterData([run({ runId: 'r-null', durationMs: null })]);
    expect(out).toEqual([]);
  });

  it('omits runs with undefined durationMs', () => {
    const out = runPointsToScatterData([run({ runId: 'r-undef', durationMs: undefined })]);
    expect(out).toEqual([]);
  });

  it('omits runs with negative duration', () => {
    const out = runPointsToScatterData([run({ runId: 'r-neg', durationMs: -1 })]);
    expect(out).toEqual([]);
  });

  it('omits runs with NaN or Infinity duration', () => {
    const out = runPointsToScatterData([
      run({ runId: 'r-nan', durationMs: Number.NaN }),
      run({ runId: 'r-inf', durationMs: Number.POSITIVE_INFINITY }),
    ]);
    expect(out).toEqual([]);
  });

  it('omits runs with an unparseable stoppedAt', () => {
    const out = runPointsToScatterData([run({ runId: 'r-bad', stoppedAt: 'not-a-date' })]);
    expect(out).toEqual([]);
  });

  it('maps a valid run to the right x (epoch ms) and y (minutes), carrying runId and status', () => {
    const out = runPointsToScatterData([
      run({ runId: 'r-ok', stoppedAt: '2024-01-02T10:00:00.000Z', durationMs: 900000, status: 'FAILED' }),
    ]);
    expect(out).toEqual([
      {
        runId: 'r-ok',
        x: Date.parse('2024-01-02T10:00:00.000Z'),
        y: 15, // 900000 / 60000
        status: 'FAILED',
      },
    ]);
  });

  it('keeps a zero duration (finite, >= 0)', () => {
    const out = runPointsToScatterData([run({ runId: 'r-zero', durationMs: 0 })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ runId: 'r-zero', y: 0 });
  });

  it('preserves input order and only keeps usable runs', () => {
    const out = runPointsToScatterData([
      run({ runId: 'a', durationMs: 60000 }),
      run({ runId: 'b', durationMs: null }),
      run({ runId: 'c', durationMs: 120000 }),
    ]);
    expect(out.map((d) => d.runId)).toEqual(['a', 'c']);
  });

  it('returns empty for empty input', () => {
    expect(runPointsToScatterData([])).toEqual([]);
  });
});

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

describe('topLongestRuns', () => {
  const data: ScatterDatum[] = [
    { runId: 'a', x: 1, y: 10 },
    { runId: 'b', x: 2, y: 30 },
    { runId: 'c', x: 3, y: 20 },
    { runId: 'd', x: 4, y: 30 },
  ];

  it('returns the N highest-y datums descending by y, stable on ties', () => {
    expect(topLongestRuns(data, 2).map((d) => d.runId)).toEqual(['b', 'd']);
    expect(topLongestRuns(data, 3).map((d) => d.runId)).toEqual(['b', 'd', 'c']);
  });

  it('never returns more than the input length', () => {
    expect(topLongestRuns(data, 100)).toHaveLength(4);
  });

  it('returns empty for n <= 0', () => {
    expect(topLongestRuns(data, 0)).toEqual([]);
    expect(topLongestRuns(data, -5)).toEqual([]);
  });
});

describe('runPointsToScatterData — properties', () => {
  const runArb: fc.Arbitrary<RunPoint> = fc.record({
    runId: fc.string({ minLength: 1, maxLength: 8 }),
    stoppedAt: fc.oneof(
      fc.constantFrom('2024-01-02T10:00:00.000Z', '2026-09-02T17:04:59.935Z', 'not-a-date', ''),
      fc.date({ min: new Date('2000-01-01'), max: new Date('2030-01-01') }).map((d) => d.toISOString()),
    ),
    durationMs: fc.oneof(
      fc.constantFrom<number | null | undefined>(null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1),
      fc.integer({ min: 0, max: 10_000_000 }),
    ),
    status: fc.constantFrom('COMPLETED', 'FAILED', 'CANCELLED', null),
  });

  it('output length never exceeds input length, and every output run was usable', () => {
    fc.assert(
      fc.property(fc.array(runArb, { maxLength: 30 }), (points) => {
        const out = runPointsToScatterData(points);
        expect(out.length).toBeLessThanOrEqual(points.length);
        for (const d of out) {
          // Every output run must correspond to an input run that was usable:
          // finite durationMs >= 0 whose minutes match d.y, and a parseable
          // stop time matching d.x. (runId is not unique in the arbitrary, so
          // match on the full derived shape, not just the id.)
          const src = points.find(
            (p) =>
              p.runId === d.runId &&
              typeof p.durationMs === 'number' &&
              Number.isFinite(p.durationMs) &&
              p.durationMs >= 0 &&
              p.durationMs / 60000 === d.y &&
              Date.parse(p.stoppedAt) === d.x,
          );
          expect(src).toBeDefined();
          expect(Number.isFinite(d.x)).toBe(true);
          expect(d.y).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(d.y)).toBe(true);
        }
      }),
    );
  });
});
