import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatFleetLoadLine,
  getFleetLoadTimings,
  resetFleetLoadTimingsForTests,
  startFleetLoadTimer,
  MAX_RECORDS,
  type FleetLoadTimingRecord,
} from './loadTiming';

function rec(partial: Partial<FleetLoadTimingRecord>): FleetLoadTimingRecord {
  return {
    seq: 1,
    kind: 'cold',
    outcome: 'complete',
    startedAt: '2024-01-01T00:00:00.000Z',
    rowsShownAtStart: false,
    firstRowsMs: 212,
    completeMs: 1140,
    pages: 6,
    runs: 513,
    capped: false,
    ...partial,
  };
}

describe('loadTiming', () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetFleetLoadTimingsForTests();
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('marks start/first-rows/complete, measures both spans, and logs one line', () => {
    const mark = vi.spyOn(performance, 'mark');
    const measure = vi.spyOn(performance, 'measure');
    const clearMarks = vi.spyOn(performance, 'clearMarks');

    const timer = startFleetLoadTimer('cold', { rowsShownAtStart: false });
    timer.markFirstRows();
    timer.finish({ outcome: 'complete', pages: 2, runs: 150 });

    expect(mark.mock.calls.map((c) => c[0])).toEqual([
      'fleet:start:1',
      'fleet:first-rows:1',
      'fleet:complete:1',
    ]);
    expect(measure.mock.calls.map((c) => c[0])).toEqual([
      'fleet:first-rows',
      'fleet:complete',
    ]);
    expect(measure.mock.calls[0][1]).toMatchObject({
      start: 'fleet:start:1',
      end: 'fleet:first-rows:1',
      detail: { kind: 'cold', seq: 1, pages: 2, runs: 150 },
    });
    expect(clearMarks).toHaveBeenCalledWith('fleet:start:1');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toMatch(
      /^\[fleet\] cold load: first rows [\d,]+ ms, complete [\d,]+ ms, 2 pages, 150 runs$/,
    );
  });

  it('formats every load kind and outcome', () => {
    expect(formatFleetLoadLine(rec({}))).toBe(
      '[fleet] cold load: first rows 212 ms, complete 1,140 ms, 6 pages, 513 runs',
    );
    expect(
      formatFleetLoadLine(
        rec({ kind: 'warm', rowsShownAtStart: true, firstRowsMs: null, completeMs: 1050 }),
      ),
    ).toBe(
      '[fleet] warm revalidate: cached rows shown instantly, revalidate complete 1,050 ms, 6 pages, 513 runs',
    );
    expect(
      formatFleetLoadLine(
        rec({ kind: 'refresh', rowsShownAtStart: true, firstRowsMs: null, completeMs: 980 }),
      ),
    ).toBe('[fleet] refresh: rows kept, complete 980 ms, 6 pages, 513 runs');
    expect(
      formatFleetLoadLine(
        rec({ kind: 'reconnect', rowsShownAtStart: true, firstRowsMs: null, completeMs: 1010.4 }),
      ),
    ).toBe('[fleet] reconnect: rows kept, complete 1,010 ms, 6 pages, 513 runs');
    expect(
      formatFleetLoadLine(rec({ firstRowsMs: null, completeMs: 210, pages: 1, runs: 0 })),
    ).toBe('[fleet] cold load: no rows, complete 210 ms, 1 page, 0 runs');
    expect(formatFleetLoadLine(rec({ pages: 10, runs: 1000, capped: true }))).toBe(
      '[fleet] cold load: first rows 212 ms, complete 1,140 ms, 10 pages, 1,000 runs (capped)',
    );
    expect(
      formatFleetLoadLine(
        rec({ outcome: 'error', failedPage: 3, completeMs: 640, pages: 2, runs: 200 }),
      ),
    ).toBe('[fleet] cold load: failed on page 3 after 640 ms, 2 pages, 200 runs');
    expect(
      formatFleetLoadLine(
        rec({ kind: 'refresh', outcome: 'superseded', completeMs: 310, pages: 2, runs: 200 }),
      ),
    ).toBe('[fleet] refresh: superseded after 310 ms, 2 pages, 200 runs');
    expect(formatFleetLoadLine(rec({ pages: 1, runs: 1 }))).toMatch(/1 page, 1 run$/);
  });

  it('keeps the last 20 records on a read-only window.__fleetLoadTimings', () => {
    for (let i = 0; i < MAX_RECORDS + 5; i += 1) {
      startFleetLoadTimer('refresh', { rowsShownAtStart: true }).finish({
        outcome: 'complete',
        pages: 1,
        runs: i,
      });
    }
    const timings = getFleetLoadTimings();
    expect(timings).toHaveLength(MAX_RECORDS);
    expect(timings[0].seq).toBe(6);
    expect(timings[MAX_RECORDS - 1].seq).toBe(MAX_RECORDS + 5);

    const exposed = (window as unknown as { __fleetLoadTimings: FleetLoadTimingRecord[] })
      .__fleetLoadTimings;
    expect(exposed).toEqual(timings);
    expect(Object.isFrozen(exposed)).toBe(true);
    expect(Object.isFrozen(exposed[0])).toBe(true);
    // Neither reassigning nor mutating the exposed copy affects the store.
    expect(() => {
      (window as unknown as Record<string, unknown>).__fleetLoadTimings = [];
    }).toThrow();
    expect(() => {
      (exposed[0] as { runs: number }).runs = 999;
    }).toThrow();
    expect(getFleetLoadTimings()).toHaveLength(MAX_RECORDS);
    expect(getFleetLoadTimings()[0].runs).toBe(5);
    // Counts and durations only — no run names/ids.
    expect(Object.keys(timings[0]).sort()).toEqual(
      [
        'capped',
        'completeMs',
        'firstRowsMs',
        'kind',
        'outcome',
        'pages',
        'rowsShownAtStart',
        'runs',
        'seq',
        'startedAt',
      ].sort(),
    );
  });

  it('finish is idempotent and markFirstRows after finish is a no-op', () => {
    const mark = vi.spyOn(performance, 'mark');
    const timer = startFleetLoadTimer('cold', { rowsShownAtStart: false });
    timer.finish({ outcome: 'complete', pages: 1, runs: 0 });
    timer.finish({ outcome: 'complete', pages: 1, runs: 0 });
    timer.markFirstRows();
    expect(info).toHaveBeenCalledTimes(1);
    expect(mark.mock.calls.map((c) => c[0])).not.toContain('fleet:first-rows:1');
    expect(getFleetLoadTimings()).toHaveLength(1);
    expect(getFleetLoadTimings()[0].firstRowsMs).toBeNull();
  });

  it('never throws without the performance API', () => {
    vi.stubGlobal('performance', undefined);
    const timer = startFleetLoadTimer('cold', { rowsShownAtStart: false });
    expect(() => {
      timer.markFirstRows();
      timer.finish({ outcome: 'complete', pages: 1, runs: 3 });
    }).not.toThrow();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toMatch(
      /^\[fleet\] cold load: first rows \d+ ms, complete \d+ ms, 1 page, 3 runs$/,
    );
  });

  it('never throws when mark/measure throw', () => {
    vi.spyOn(performance, 'mark').mockImplementation(() => {
      throw new Error('mark broke');
    });
    vi.spyOn(performance, 'measure').mockImplementation(() => {
      throw new Error('measure broke');
    });
    const timer = startFleetLoadTimer('warm', { rowsShownAtStart: true });
    expect(() =>
      timer.finish({ outcome: 'complete', pages: 1, runs: 3 }),
    ).not.toThrow();
    expect(info.mock.calls[0][0]).toMatch(/^\[fleet\] warm revalidate:/);
  });
});
