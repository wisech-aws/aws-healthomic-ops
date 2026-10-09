import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReportsView from './ReportsView';
import type { WorkflowGroup, WorkflowReport, RunPoint } from '../api/types';

// Recharts' ResponsiveContainer measures its parent at runtime; jsdom reports a
// zero-size layout, so the inner ScatterChart (and the scatter's sr-only
// open-run buttons) would not render without a fixed size. Mock it to a
// fixed-size div so the scatter's data path is observable under test.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 280 }}>{children}</div>
    ),
  };
});

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

  // Per-run duration scatter (interactive, click-to-open-run).
  describe('per-run duration scatter', () => {
    const SCATTER_POINTS: RunPoint[] = [
      { runId: 'run-fast', stoppedAt: '2024-01-02T10:00:00.000Z', status: 'COMPLETED', durationMs: 600000 },
      { runId: 'run-slow', stoppedAt: '2024-01-02T12:00:00.000Z', status: 'FAILED', durationMs: 1_800_000 },
      // Null-duration run must be omitted (never fabricated).
      { runId: 'run-nodur', stoppedAt: '2024-01-02T13:00:00.000Z', status: 'CANCELLED', durationMs: null },
    ];

    function pager(points: RunPoint[]) {
      return vi.fn().mockResolvedValue({ items: points, nextToken: null });
    }

    it('renders the scatter block with one marker per timed run (null-duration omitted)', async () => {
      render(
        <ReportsView
          now={NOW}
          listWorkflowGroups={vi.fn().mockResolvedValue(GROUPS)}
          getWorkflowReport={vi.fn().mockResolvedValue(makeReport())}
          listWorkflowRunPoints={pager(SCATTER_POINTS)}
          onOpenRun={vi.fn()}
        />,
      );

      expect(await screen.findByTestId('reports-run-scatter')).toBeInTheDocument();
      // The scatter renders one keyboard/sr open-run affordance per plottable
      // run (data-path proxy for the SVG markers). Only the two timed runs are
      // present; the null-duration run is omitted (never fabricated).
      const openers = await screen.findAllByTestId('run-scatter-sr-open');
      expect(openers).toHaveLength(2);
      const text = openers.map((o) => o.textContent).join(' | ');
      expect(text).toContain('run-slow');
      expect(text).toContain('run-fast');
      expect(text).not.toContain('run-nodur');
    });

    it('activating a run marker calls onOpenRun with that run id', async () => {
      const onOpenRun = vi.fn();
      render(
        <ReportsView
          now={NOW}
          listWorkflowGroups={vi.fn().mockResolvedValue(GROUPS)}
          getWorkflowReport={vi.fn().mockResolvedValue(makeReport())}
          listWorkflowRunPoints={pager(SCATTER_POINTS)}
          onOpenRun={onOpenRun}
        />,
      );

      const openers = await screen.findAllByTestId('run-scatter-sr-open');
      const slow = openers.find((o) => o.textContent?.includes('run-slow'));
      expect(slow).toBeDefined();
      fireEvent.click(slow!);
      expect(onOpenRun).toHaveBeenCalledWith('run-slow');
    });

    it('shows the empty affordance and no markers when all runs lack a usable duration', async () => {
      render(
        <ReportsView
          now={NOW}
          listWorkflowGroups={vi.fn().mockResolvedValue(GROUPS)}
          getWorkflowReport={vi.fn().mockResolvedValue(makeReport())}
          listWorkflowRunPoints={pager([
            { runId: 'r-x', stoppedAt: '2024-01-02T10:00:00.000Z', status: 'FAILED', durationMs: null },
          ])}
          onOpenRun={vi.fn()}
        />,
      );

      expect(await screen.findByTestId('reports-run-scatter')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('run-scatter-empty')).toHaveTextContent(
          'No timed runs to plot.',
        );
      });
      expect(screen.queryByTestId('run-scatter-sr-open')).not.toBeInTheDocument();
    });
  });
});
