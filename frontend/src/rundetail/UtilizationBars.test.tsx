import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import UtilizationBars from './UtilizationBars';
import type { MetricSeries } from '../api/types';
import type { TaskMetrics } from '../metrics/joinMetricsToTasks';
import { formatMetricValue } from '../metrics/formatMetricValue';
import { MEMORY_UNITS_UNCONFIRMED_NOTE } from '../metrics/resourceSummary';

// UtilizationBars is purely presentational over an already-joined per-task
// metric slice; it shapes the slice with the pure `chartSeries` helper and
// derives peak/mean/limit ONLY from measured points. These tests cover the
// design's Property 1 (never fabricates a value) and the acceptance criteria
// for the compact peak/mean-vs-limit representation (Req 3.1–3.5, 8.4).

/**
 * A CPU usage series (`{cpu}` unit, `role: 'usage'`). Points are chosen so the
 * peak (max) and mean (arithmetic) are distinct and easy to assert:
 *   peak = 3.9, mean = (3.9 + 0.9 + 0.9) / 3 = 1.9.
 */
function cpuUsageSeries(taskId: string): MetricSeries {
  return {
    metricName: 'aws.omics.task.cpu.usage',
    family: 'CPU',
    role: 'usage',
    unit: '{cpu}',
    taskId,
    points: [
      { timestamp: 1704067200000, value: 3.9 },
      { timestamp: 1704067260000, value: 0.9 },
      { timestamp: 1704067320000, value: 0.9 },
    ],
  };
}

/** A CPU limit series (`role: 'limit'`) whose peak is the allocated ceiling of 4 vCPU. */
function cpuLimitSeries(taskId: string): MetricSeries {
  return {
    metricName: 'aws.omics.task.cpu.limit',
    family: 'CPU',
    role: 'limit',
    unit: '{cpu}',
    taskId,
    points: [{ timestamp: 1704067200000, value: 4 }],
  };
}

/**
 * A MEMORY usage series (`By` unit). Peak = 6 GiB, mean = 3 GiB across two
 * points, so the byte-formatting helper is exercised for both.
 */
function memoryUsageSeries(taskId: string): MetricSeries {
  return {
    metricName: 'aws.omics.task.memory.usage',
    family: 'MEMORY',
    role: 'usage',
    unit: 'By',
    taskId,
    points: [
      { timestamp: 1704067200000, value: 6 * 1024 ** 3 },
      { timestamp: 1704067260000, value: 0 },
    ],
  };
}

describe('UtilizationBars', () => {
  it('renders a labeled peak AND mean plus the correct limit ceiling for an actual+limit family (Req 3.1, 3.2)', () => {
    const taskMetrics: TaskMetrics = {
      taskId: 'task-1',
      series: [cpuUsageSeries('task-1'), cpuLimitSeries('task-1')],
    };

    render(<UtilizationBars taskMetrics={taskMetrics} />);

    // Region + per-family bar render; the explicit unavailable state does not.
    expect(screen.getByTestId('task-utilization')).toBeInTheDocument();
    const bar = screen.getByTestId('task-metric-bar-task-1-aws.omics.task.cpu.usage');
    expect(bar).toBeInTheDocument();
    expect(
      screen.queryByTestId('task-utilization-unavailable'),
    ).not.toBeInTheDocument();

    // Peak (3.9), mean (1.9) and the measured limit ceiling (4) are all shown,
    // each explicitly labeled and formatted via the shared helper (millicores).
    const peakText = formatMetricValue(3.9, '{cpu}'); // "3900m"
    const meanText = formatMetricValue(1.9, '{cpu}'); // "1900m"
    const limitText = formatMetricValue(4, '{cpu}'); // "4000m"
    expect(bar).toHaveTextContent(
      new RegExp(`peak\\s*${peakText}\\s*/\\s*mean\\s*${meanText}\\s*of\\s*${limitText}`),
    );
  });

  it('renders peak+mean with no fabricated limit for an actual-only family (Req 3.3, 8.4)', () => {
    const taskMetrics: TaskMetrics = {
      taskId: 'task-2',
      series: [cpuUsageSeries('task-2')],
    };

    render(<UtilizationBars taskMetrics={taskMetrics} />);

    const bar = screen.getByTestId('task-metric-bar-task-2-aws.omics.task.cpu.usage');
    expect(bar).toBeInTheDocument();

    // The no-limit variant renders (no measured ceiling), never a fabricated one.
    expect(
      screen.getByTestId('task-metric-bar-task-2-aws.omics.task.cpu.usage-nolimit'),
    ).toBeInTheDocument();

    const peakText = formatMetricValue(3.9, '{cpu}');
    const meanText = formatMetricValue(1.9, '{cpu}');
    // Peak and mean are shown and labeled...
    expect(bar).toHaveTextContent(
      new RegExp(`peak\\s*${peakText}\\s*/\\s*mean\\s*${meanText}`),
    );
    // ...but there is no "of <limit>" ceiling clause fabricated.
    expect(bar).not.toHaveTextContent(/\bof\b/);
  });

  it('surfaces the unconfirmed-units note on a MEMORY bar (Req 8.4)', () => {
    const taskMetrics: TaskMetrics = {
      taskId: 'task-3',
      series: [memoryUsageSeries('task-3')],
    };

    render(<UtilizationBars taskMetrics={taskMetrics} />);

    const note = screen.getByTestId(
      'task-metric-bar-task-3-aws.omics.task.memory.usage-units-note',
    );
    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent(MEMORY_UNITS_UNCONFIRMED_NOTE);

    // Memory peak/mean are formatted via the shared byte helper (peak 6 GiB, mean 3 GiB).
    const bar = screen.getByTestId('task-metric-bar-task-3-aws.omics.task.memory.usage');
    expect(bar).toHaveTextContent(formatMetricValue(6 * 1024 ** 3, 'By')); // "6.00 GiB"
    expect(bar).toHaveTextContent(formatMetricValue(3 * 1024 ** 3, 'By')); // "3.00 GiB"
  });

  it('renders the "utilization unavailable for this task" state when taskMetrics is null (Req 3.5, 8.4)', () => {
    render(<UtilizationBars taskMetrics={null} />);

    const unavailable = screen.getByTestId('task-utilization-unavailable');
    expect(unavailable).toBeInTheDocument();
    expect(unavailable).toHaveTextContent(/utilization unavailable for this task/i);

    // No region or fabricated bar is produced.
    expect(screen.queryByTestId('task-utilization')).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^task-metric-bar-/)).not.toBeInTheDocument();
  });

  it('renders the "utilization unavailable" state when the slice yields no chart pairs (Req 3.5, 8.4)', () => {
    // A slice with no series produces no pairs from `chartSeries`, so the
    // explicit unavailable state must show rather than a zero/placeholder bar.
    const taskMetrics: TaskMetrics = { taskId: 'empty', series: [] };

    render(<UtilizationBars taskMetrics={taskMetrics} />);

    expect(screen.getByTestId('task-utilization-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('task-utilization')).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^task-metric-bar-/)).not.toBeInTheDocument();
  });
});
