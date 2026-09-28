import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { toReportCsv, csvEscape } from './reportCsv';
import type { WorkflowReport, RunPoint } from '../api/types';

function report(partial: Partial<WorkflowReport> = {}): WorkflowReport {
  return {
    workflowName: 'nf-core-fetchngs',
    versionName: '(unversioned)',
    window: { start: '2024-01-01T00:00:00.000Z', end: '2024-01-31T00:00:00.000Z', stepSeconds: 0 },
    runCount: 2,
    succeeded: 1,
    failed: 1,
    cancelled: 0,
    collision: false,
    metrics: [
      { key: 'peakMemoryGiB', unit: 'GiB', mean: 6, median: 6, p90: 6, availableCount: 1, totalCount: 2 },
    ],
    durationHistogram: {
      key: 'durationMs',
      unit: 'ms',
      availableCount: 2,
      totalCount: 2,
      buckets: [{ lo: 300_000, hi: 600_000, count: 2 }],
    },
    timeBins: [],
    sample: [],
    sampleCapped: false,
    ...partial,
  };
}

const ROWS: RunPoint[] = [
  {
    runId: 'run-a',
    stoppedAt: '2024-01-02T10:00:00.000Z',
    status: 'COMPLETED',
    durationMs: 600_000,
    meanCpu: 2,
    peakCpu: 3,
    meanMemoryGiB: 5,
    peakMemoryGiB: 6,
    cpuHours: 1,
    peakConcurrentTasks: 4,
    taskCount: 40,
    failedTaskCount: 0,
  },
  {
    runId: 'run-b',
    stoppedAt: '2024-01-03T10:00:00.000Z',
    status: 'FAILED',
    durationMs: 300_000,
    meanCpu: null,
    peakCpu: null,
    meanMemoryGiB: null,
    peakMemoryGiB: null,
    cpuHours: null,
    peakConcurrentTasks: null,
    taskCount: 38,
    failedTaskCount: 2,
  },
];

describe('csvEscape', () => {
  it('quotes fields containing comma, quote, or newline', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape('a\nb')).toBe('"a\nb"');
  });
});

describe('toReportCsv — example', () => {
  it('includes the group label, aggregate block, and per-run block', () => {
    const csv = toReportCsv(report(), ROWS);
    expect(csv).toContain('Workflow,nf-core-fetchngs');
    expect(csv).toContain('Version,(unversioned)');
    expect(csv).toContain('Aggregate metrics');
    expect(csv).toContain('Per-run values');
    expect(csv).toContain('run-a');
    expect(csv).toContain('run-b');
    expect(csv).toContain('peakMemory(GiB)');
  });

  it('renders unavailable metric cells as empty, never 0', () => {
    const csv = toReportCsv(report(), ROWS);
    const lines = csv.split('\n');
    const runBLine = lines.find((l) => l.startsWith('run-b'))!;
    const cells = runBLine.split(',');
    // runId, stoppedAt, status, durationMs, meanCpu, peakCpu, meanMemory,
    // peakMemory, cpuHours, peakConcurrentTasks, taskCount, failed.
    expect(cells[4]).toBe(''); // meanCpu
    expect(cells[7]).toBe(''); // peakMemory
    expect(cells[9]).toBe(''); // peakConcurrentTasks
    expect(cells[10]).toBe('38'); // taskCount available
  });
});

// Property 9: an unavailable metric never appears as 0 in the CSV; available
// values appear verbatim; the memory columns stay GiB.
// Feature: workflow-performance-reports, Property 9
describe('toReportCsv — Property 9: CSV honesty', () => {
  it('null per-run metric values become empty cells, never 0', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            avail: fc.boolean(),
            v: fc.double({ min: 0.1, max: 1e6, noNaN: true }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (specs) => {
          const rows: RunPoint[] = specs.map((r, i) => ({
            runId: `r-${i}`,
            stoppedAt: '2024-01-02T10:00:00.000Z',
            status: 'COMPLETED',
            durationMs: r.avail ? r.v : null,
            meanCpu: r.avail ? r.v : null,
            peakCpu: r.avail ? r.v : null,
            meanMemoryGiB: r.avail ? r.v : null,
            peakMemoryGiB: r.avail ? r.v : null,
            cpuHours: r.avail ? r.v : null,
            peakConcurrentTasks: r.avail ? Math.round(r.v) : null,
            taskCount: 10,
            failedTaskCount: 0,
          }));
          const csv = toReportCsv(report({ runCount: rows.length }), rows);
          const lines = csv.split('\n');
          specs.forEach((r, i) => {
            const line = lines.find((l) => l.startsWith(`r-${i},`))!;
            const cells = line.split(',');
            if (r.avail) {
              expect(cells[4]).not.toBe('');
            } else {
              expect(cells[4]).toBe(''); // never '0'
            }
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
