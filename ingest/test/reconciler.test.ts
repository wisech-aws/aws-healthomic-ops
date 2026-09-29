import { describe, it, expect, vi } from 'vitest';

import { reconcileRun, type ReconcileDeps } from '../src/reconcilerHandler.js';
import { TaskStatus, RunStatus } from '../src/domain/status.js';
import type { RunRecord, TaskRecord } from '../src/domain/records.js';
import type { MetricSeries } from '../src/metrics/parse.js';

// Build a ReconcileDeps with injectable fakes so the reconciler runs with no
// real OmicsClient / CloudWatch / DynamoDB.
function makeDeps(overrides: Partial<ReconcileDeps> = {}): {
  deps: ReconcileDeps;
  upsertedTasks: TaskRecord[];
  upsertedSummaries: unknown[];
  registryCalls: unknown[];
} {
  const upsertedTasks: TaskRecord[] = [];
  const upsertedSummaries: unknown[] = [];
  const registryCalls: unknown[] = [];
  const deps: ReconcileDeps = {
    enrichRun: async (runId) => ({
      runId,
      status: RunStatus.COMPLETED,
      workflowName: 'nf-core-rnaseq',
      workflowVersionName: 'v2-wave-fix',
      workflowId: 'wf-1',
      startedAt: '2026-09-29T12:00:00.000Z',
      stoppedAt: '2026-09-29T12:30:00.000Z',
    }),
    enrichTasks: async (runId) => [
      { runId, taskId: 't-1', status: TaskStatus.COMPLETED, name: 'a', startedAt: '2026-09-29T12:01:00.000Z', stoppedAt: '2026-09-29T12:05:00.000Z' },
      { runId, taskId: 't-2', status: TaskStatus.COMPLETED, name: 'b', startedAt: '2026-09-29T12:02:00.000Z', stoppedAt: '2026-09-29T12:06:00.000Z' },
    ],
    sweep: async () => [] as MetricSeries[],
    repo: {
      upsertTask: async (t) => {
        upsertedTasks.push(t);
        return { outcome: 'written' };
      },
      upsertSummary: async (s) => {
        upsertedSummaries.push(s);
        return { outcome: 'written' };
      },
      upsertGroupRegistry: async (...args) => {
        registryCalls.push(args);
      },
    },
    ...overrides,
  };
  return { deps, upsertedTasks, upsertedSummaries, registryCalls };
}

describe('reconcileRun — deferred re-sweep', () => {
  it('re-upserts all authoritative tasks and counts terminal corrections', async () => {
    const { deps, upsertedTasks } = makeDeps();
    const report = await reconcileRun(deps, 'run-1');
    // Both authoritative tasks are re-written with a fresh updatedAt.
    expect(upsertedTasks).toHaveLength(2);
    expect(upsertedTasks.every((t) => t.status === TaskStatus.COMPLETED)).toBe(true);
    expect(upsertedTasks.every((t) => typeof t.updatedAt === 'string')).toBe(true);
    expect(report.tasksCorrected).toBe(2);
  });

  it('rebuilds the Run_Summary with a fresh updatedAt (force-wins the monotonic guard) and refreshes the registry', async () => {
    const { deps, upsertedSummaries, registryCalls } = makeDeps();
    const before = Date.now();
    const report = await reconcileRun(deps, 'run-1');
    expect(report.summaryWritten).toBe(true);
    expect(upsertedSummaries).toHaveLength(1);
    const summary = upsertedSummaries[0] as { updatedAt: string; workflowVersionName: string };
    // updatedAt was force-stamped to ~now so it beats any prior summary.
    expect(Date.parse(summary.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(summary.workflowVersionName).toBe('v2-wave-fix');
    expect(registryCalls).toHaveLength(1);
  });

  it('populates utilization when the re-sweep now returns series (the metric-lag fix)', async () => {
    // Simulate metrics having LANDED by the time the deferred re-sweep runs.
    const series: MetricSeries[] = [
      { family: 'CPU', role: 'used', points: [{ ts: 1, value: 3.2 }] } as unknown as MetricSeries,
    ];
    const { deps, upsertedSummaries } = makeDeps({ sweep: async () => series });
    const report = await reconcileRun(deps, 'run-1');
    expect(report.withUtilization).toBe(true);
    expect(upsertedSummaries).toHaveLength(1);
  });

  it('isolates a task upsert failure (keeps reconciling the rest + summary)', async () => {
    const { deps } = makeDeps({
      repo: {
        upsertTask: vi.fn().mockRejectedValueOnce(new Error('ddb down')).mockResolvedValue({ outcome: 'written' }),
        upsertSummary: async () => ({ outcome: 'written' }),
        upsertGroupRegistry: async () => undefined,
      },
    });
    // Must not throw despite the first task upsert failing.
    const report = await reconcileRun(deps, 'run-1');
    expect(report.summaryWritten).toBe(true);
  });
});
