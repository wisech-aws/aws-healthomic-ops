import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ReportsView from './ReportsView';
import type { WorkflowGroup, WorkflowReport } from '../api/types';

const NOW = Date.parse('2024-02-01T00:00:00.000Z');

const GROUPS: WorkflowGroup[] = [
  { workflowName: 'nf-core-fetchngs', versionName: '(unversioned)', workflowIds: ['wf-1'], runCount: 3 },
];

function makeReport(partial: Partial<WorkflowReport> = {}): WorkflowReport {
  return {
    workflowName: 'nf-core-fetchngs',
    versionName: '(unversioned)',
    window: { start: '2024-01-01T00:00:00.000Z', end: '2024-02-01T00:00:00.000Z', stepSeconds: 0 },
    runCount: 3,
    succeeded: 2,
    failed: 1,
    cancelled: 0,
    collision: false,
    metrics: [
      { key: 'durationMs', unit: 'ms', mean: 600000, median: 600000, p90: 900000, availableCount: 3, totalCount: 3 },
      { key: 'peakMemoryGiB', unit: 'GiB', mean: 6, median: 6, p90: 6, availableCount: 2, totalCount: 3 },
    ],
    durationHistogram: {
      key: 'durationMs',
      unit: 'ms',
      availableCount: 3,
      totalCount: 3,
      buckets: [
        { lo: 300000, hi: 600000, count: 1 },
        { lo: 600000, hi: 900000, count: 2 },
      ],
    },
    timeBins: [
      { start: '2024-01-02T00:00:00.000Z', end: '2024-01-03T00:00:00.000Z', runCount: 3, durationMeanMs: 600000, durationP90Ms: 900000 },
    ],
    sample: [
      { runId: 'r-a', stoppedAt: '2024-01-02T10:00:00.000Z', status: 'COMPLETED', durationMs: 600000, meanCpu: 2, peakCpu: 3, meanMemoryGiB: 5, peakMemoryGiB: 6, cpuHours: 1, peakConcurrentTasks: 4, taskCount: 40, failedTaskCount: 0 },
    ],
    sampleCapped: false,
    ...partial,
  };
}

describe('ReportsView', () => {
  it('renders aggregate metrics with the N-of-M denominator for a partially-available metric', async () => {
    render(
      <ReportsView
        now={NOW}
        listWorkflowGroups={vi.fn().mockResolvedValue(GROUPS)}
        getWorkflowReport={vi.fn().mockResolvedValue(makeReport())}
      />,
    );

    expect(await screen.findByTestId('reports-view')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('reports-metrics-table')).toBeInTheDocument();
      expect(screen.getByTestId('reports-run-count')).toHaveTextContent('3');
    });
    // peakMemoryGiB is 2 of 3 => availability badge shown.
    await waitFor(() => {
      expect(screen.getByTestId('reports-availability')).toHaveTextContent('2 / 3');
    });
    // Utilization-permission honesty note is present.
    expect(screen.getByTestId('reports-utilization-note')).toBeInTheDocument();
  });

  it('shows the collision affordance when the group maps to multiple workflow ids', async () => {
    render(
      <ReportsView
        now={NOW}
        listWorkflowGroups={vi.fn().mockResolvedValue(GROUPS)}
        getWorkflowReport={vi.fn().mockResolvedValue(makeReport({ collision: true }))}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('reports-collision')).toBeInTheDocument();
    });
  });

  it('shows an empty state when no workflow groups fall in the window', async () => {
    render(
      <ReportsView
        now={NOW}
        listWorkflowGroups={vi.fn().mockResolvedValue([])}
        getWorkflowReport={vi.fn().mockResolvedValue(null)}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('reports-empty')).toBeInTheDocument();
    });
  });

  it('renders the report body with the EXACT real AppSync response shape (null utilization fields)', async () => {
    // Mirrors the real getWorkflowReport response captured from AppSync logs:
    // duration/cpuHours/tasks available, CPU/memory null (utilization absent).
    const realReport: WorkflowReport = {
      workflowName: 'nf-core-fetchngs',
      versionName: '(unversioned)',
      window: { start: '2026-08-26T17:19:27.539Z', end: '2026-09-25T17:19:27.539Z', stepSeconds: 0 },
      runCount: 14,
      succeeded: 13,
      failed: 1,
      cancelled: 0,
      collision: false,
      metrics: [
        { key: 'durationMs', unit: 'ms', mean: 1310247.5, median: 1242414.5, p90: 1619630, availableCount: 14, totalCount: 14 },
        { key: 'meanCpu', unit: 'vCPU', mean: null, median: null, p90: null, availableCount: 0, totalCount: 14 },
        { key: 'peakMemoryGiB', unit: 'GiB', mean: null, median: null, p90: null, availableCount: 0, totalCount: 14 },
      ],
      durationHistogram: {
        key: 'durationMs',
        unit: 'ms',
        availableCount: 14,
        totalCount: 14,
        buckets: [
          { lo: 600000, hi: 1100000, count: 6 },
          { lo: 1100000, hi: 1620000, count: 8 },
        ],
      },
      timeBins: [
        { start: '2026-09-02T00:00:00.000Z', end: '2026-09-03T00:00:00.000Z', runCount: 14, durationMeanMs: 1310247.5, durationP90Ms: 1619630 },
      ],
      sample: [
        { runId: '3269117', stoppedAt: '2026-09-02T17:04:59.935Z', status: 'COMPLETED', durationMs: 1400000, meanCpu: null, peakCpu: null, meanMemoryGiB: null, peakMemoryGiB: null, cpuHours: null, peakConcurrentTasks: null, taskCount: 39, failedTaskCount: 0 },
      ],
      sampleCapped: false,
    };
    const groups: WorkflowGroup[] = [
      { workflowName: 'nf-core-fetchngs', versionName: '(unversioned)', workflowIds: ['2237981'], runCount: 14 },
    ];
    render(
      <ReportsView
        now={NOW}
        listWorkflowGroups={vi.fn().mockResolvedValue(groups)}
        getWorkflowReport={vi.fn().mockResolvedValue(realReport)}
      />,
    );
    // The report body must render (run count + metrics table + histogram chart).
    await waitFor(() => {
      expect(screen.getByTestId('reports-run-count')).toHaveTextContent('14');
      expect(screen.getByTestId('reports-metrics-table')).toBeInTheDocument();
      expect(screen.getByTestId('reports-duration-chart')).toBeInTheDocument();
    });
  });
});
