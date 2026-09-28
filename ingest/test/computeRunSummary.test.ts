import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { computeRunSummary } from '../src/metrics/computeRunSummary.js';
import { UNVERSIONED_LABEL } from '../src/domain/records.js';
import type { RunRecord, TaskRecord } from '../src/domain/records.js';
import { RunStatus, TaskStatus } from '../src/domain/status.js';
import type { MetricSeries, MetricPoint } from '../src/metrics/parse.js';

const iso = (ms: number): string => new Date(ms).toISOString();
const BYTES_PER_GIB = 1024 ** 3;

function run(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    status: RunStatus.COMPLETED,
    updatedAt: iso(1_000_000),
    workflowName: 'nf-core-fetchngs',
    workflowVersionName: '1.12.0',
    workflowId: 'wf-1',
    startedAt: iso(0),
    stoppedAt: iso(600_000),
    ...partial,
  };
}

let taskSeq = 0;
function task(partial: Partial<TaskRecord> = {}): TaskRecord {
  taskSeq += 1;
  return {
    runId: 'run-1',
    taskId: `t-${taskSeq}`,
    status: TaskStatus.COMPLETED,
    updatedAt: iso(1_000_000),
    ...partial,
  };
}

function series(
  family: 'CPU' | 'MEMORY',
  values: number[],
  taskId = 't-a',
): MetricSeries {
  const points: MetricPoint[] = values.map((value, i) => ({
    timestamp: i * 30_000,
    value,
  }));
  return {
    metricName:
      family === 'CPU' ? 'aws.omics.task.cpu.usage' : 'aws.omics.task.memory.usage',
    family,
    role: 'usage',
    unit: family === 'CPU' ? '{cpu}' : 'By',
    taskId,
    direction: null,
    scratchMode: null,
    gpuId: null,
    points,
  };
}

describe('computeRunSummary — example cases', () => {
  it('normalizes an absent version to the Unversioned_Label', () => {
    const s = computeRunSummary(run({ workflowVersionName: undefined }), [], [], 2_000_000);
    expect(s.workflowVersionName).toBe(UNVERSIONED_LABEL);
  });

  it('computes duration from run start/stop', () => {
    const s = computeRunSummary(
      run({ startedAt: iso(0), stoppedAt: iso(600_000) }),
      [],
      [],
      2_000_000,
    );
    expect(s.durationAvailable).toBe(true);
    expect(s.durationMs).toBe(600_000);
  });

  it('flags duration unavailable when start or stop is absent (never 0)', () => {
    const s = computeRunSummary(run({ startedAt: undefined }), [], [], 2_000_000);
    expect(s.durationAvailable).toBe(false);
    expect(s.durationMs).toBeUndefined();
  });

  it('converts measured memory bytes to GiB', () => {
    const s = computeRunSummary(
      run(),
      [task()],
      [series('MEMORY', [6 * BYTES_PER_GIB, 3 * BYTES_PER_GIB])],
      2_000_000,
    );
    expect(s.memoryAvailable).toBe(true);
    expect(s.peakMemoryGiB).toBeCloseTo(6, 9);
    expect(s.meanMemoryGiB).toBeCloseTo(4.5, 9);
  });

  it('computes mean/peak CPU from usage series', () => {
    const s = computeRunSummary(run(), [task()], [series('CPU', [1, 3, 2])], 2_000_000);
    expect(s.cpuAvailable).toBe(true);
    expect(s.peakCpu).toBe(3);
    expect(s.meanCpu).toBeCloseTo(2, 9);
  });

  it('counts tasks and failed/cancelled tasks', () => {
    const tasks = [
      task({ status: TaskStatus.COMPLETED }),
      task({ status: TaskStatus.FAILED }),
      task({ status: TaskStatus.CANCELLED }),
    ];
    const s = computeRunSummary(run(), tasks, [], 2_000_000);
    expect(s.taskCount).toBe(3);
    expect(s.failedTaskCount).toBe(2);
  });

  it('computes CPU-hours and peak concurrency from task intervals', () => {
    // 1h @ 4 cpus + 1h @ 2 cpus, overlapping => peak concurrency 2, cpu-hours 6.
    const tasks = [
      task({ startedAt: iso(0), stoppedAt: iso(3_600_000), cpus: 4 }),
      task({ startedAt: iso(0), stoppedAt: iso(3_600_000), cpus: 2 }),
    ];
    const s = computeRunSummary(run(), tasks, [], 4_000_000);
    expect(s.cpuHoursAvailable).toBe(true);
    expect(s.cpuHours).toBeCloseTo(6, 9);
    expect(s.concurrencyAvailable).toBe(true);
    expect(s.peakConcurrentTasks).toBe(2);
  });
});

// Property 2: an unavailable metric is never fabricated as 0 — its value is
// undefined and its availability flag is false.
// Feature: workflow-performance-reports, Property 2
describe('computeRunSummary — Property 2: no zero fabrication', () => {
  it('unavailable metrics carry undefined value + false flag, never 0', () => {
    fc.assert(
      fc.property(
        fc.record({
          hasStart: fc.boolean(),
          hasStop: fc.boolean(),
          cpuVals: fc.array(fc.double({ min: 0, max: 64, noNaN: true }), { maxLength: 6 }),
          memVals: fc.array(fc.double({ min: 0, max: 1e11, noNaN: true }), { maxLength: 6 }),
          taskCpus: fc.array(fc.option(fc.integer({ min: 0, max: 32 }), { nil: undefined }), {
            maxLength: 5,
          }),
        }),
        (g) => {
          const tasks = g.taskCpus.map((c) =>
            task({ startedAt: iso(0), stoppedAt: iso(3_600_000), cpus: c }),
          );
          const ser: MetricSeries[] = [];
          if (g.cpuVals.length > 0) ser.push(series('CPU', g.cpuVals));
          if (g.memVals.length > 0) ser.push(series('MEMORY', g.memVals));
          const s = computeRunSummary(
            run({
              startedAt: g.hasStart ? iso(0) : undefined,
              stoppedAt: g.hasStop ? iso(600_000) : undefined,
            }),
            tasks,
            ser,
            4_000_000,
          );

          if (g.cpuVals.length === 0) {
            expect(s.cpuAvailable).toBe(false);
            expect(s.meanCpu).toBeUndefined();
            expect(s.peakCpu).toBeUndefined();
          } else {
            expect(s.cpuAvailable).toBe(true);
            expect(typeof s.meanCpu).toBe('number');
          }

          if (g.memVals.length === 0) {
            expect(s.memoryAvailable).toBe(false);
            expect(s.meanMemoryGiB).toBeUndefined();
            expect(s.peakMemoryGiB).toBeUndefined();
          } else {
            expect(s.memoryAvailable).toBe(true);
          }

          if (g.hasStart && g.hasStop) {
            expect(s.durationAvailable).toBe(true);
          } else {
            expect(s.durationAvailable).toBe(false);
            expect(s.durationMs).toBeUndefined();
          }

          const anyCpus = g.taskCpus.some((c) => c != null);
          expect(s.cpuHoursAvailable).toBe(anyCpus);
          if (!anyCpus) {
            expect(s.cpuHours).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Property 10: every surfaced memory statistic is in GiB (bytes / 1024^3).
// Feature: workflow-performance-reports, Property 10
describe('computeRunSummary — Property 10: memory unit is GiB', () => {
  it('mean/peak memory equal the byte values divided by 1024^3', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1, max: 1e12, noNaN: true }), { minLength: 1, maxLength: 8 }),
        (bytes) => {
          const s = computeRunSummary(run(), [task()], [series('MEMORY', bytes)], 2_000_000);
          const expectedPeak = Math.max(...bytes) / BYTES_PER_GIB;
          const expectedMean =
            bytes.reduce((a, b) => a + b, 0) / bytes.length / BYTES_PER_GIB;
          expect(s.peakMemoryGiB).toBeCloseTo(expectedPeak, 6);
          expect(s.meanMemoryGiB).toBeCloseTo(expectedMean, 6);
        },
      ),
      { numRuns: 100 },
    );
  });
});
