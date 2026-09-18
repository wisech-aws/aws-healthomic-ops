import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import TaskDetailPanel from './TaskDetailPanel';
import type { DetailSelection } from './TaskDetailPanel';
import type { ErrorExcerpt, MetricSeries, Task } from '../api/types';
import type { TaskMetrics } from '../metrics/joinMetricsToTasks';

// LogsPanel reads the client's getRunLogs directly (it is not injected via
// TaskDetailPanel), so stub it here to render the log tail without a network
// call. The rest of the client is kept intact.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getRunLogs: vi.fn().mockResolvedValue({
      logStreamName: 'run/run-1/task/t1',
      events: [{ timestamp: 1704067200000, message: 'task log line' }],
      nextToken: null,
    }),
  };
});

let taskSeq = 0;
function makeTask(partial: Partial<Task> = {}): Task {
  taskSeq += 1;
  return {
    runId: 'run-1',
    taskId: `t${taskSeq}`,
    name: `task-${taskSeq}`,
    status: 'RUNNING',
    startedAt: '2024-01-01T00:00:00.000Z',
    stoppedAt: null,
    updatedAt: '2024-01-01T00:00:00.000Z',
    cpus: 4,
    memory: 8,
    instanceType: 'omics.r.2xlarge',
    ...partial,
  };
}

function excerpt(partial: Partial<ErrorExcerpt> = {}): ErrorExcerpt {
  return { found: true, truncated: false, lines: ['boom'], ...partial };
}

describe('TaskDetailPanel', () => {
  it('renders nothing when the selection is null', () => {
    const { container } = render(
      <TaskDetailPanel
        runId="run-1"
        task={null}
        selection={null}
        onClose={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the resource detail and the task logs for a TASK selection (Req 4.3)', async () => {
    const task = makeTask({ taskId: 'task-live', name: 'align', status: 'RUNNING' });
    const selection: DetailSelection = {
      kind: 'TASK',
      taskId: 'task-live',
      label: 'align',
    };

    render(
      <TaskDetailPanel
        runId="run-1"
        task={task}
        selection={selection}
        onClose={() => {}}
      />,
    );

    // Header names the selected task.
    expect(screen.getByText(/logs — task align/i)).toBeInTheDocument();

    // Resource detail strip surfaces cpus/memory/instance type.
    const detail = screen.getByTestId('task-resource-detail');
    expect(detail).toBeInTheDocument();
    expect(screen.getByTestId('task-resource-cpus')).toHaveTextContent('4');
    expect(screen.getByTestId('task-resource-memory')).toHaveTextContent('8');
    expect(screen.getByTestId('task-resource-instance-type')).toHaveTextContent(
      'omics.r.2xlarge',
    );

    // The task's log tail renders below the detail.
    expect(await screen.findByTestId('logs-output')).toHaveTextContent(
      'task log line',
    );
  });

  it('renders the run/engine logs tabs for a RUN_ENGINE selection (Req 4.5)', async () => {
    render(
      <TaskDetailPanel
        runId="run-1"
        task={null}
        selection={{ kind: 'RUN_ENGINE' }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/logs — run & engine/i)).toBeInTheDocument();
    // Both Run and Engine tabs are present.
    expect(screen.getByRole('tab', { name: /run/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /engine/i })).toBeInTheDocument();
    // No task-scoped resource detail in the run/engine view.
    expect(screen.queryByTestId('task-resource-detail')).not.toBeInTheDocument();
    // The default (Run) tab's logs render.
    expect(await screen.findByTestId('logs-output')).toBeInTheDocument();
  });

  it('renders the "Resource type unavailable" affordance for a task with no instanceType (Req 4.4)', async () => {
    const task = makeTask({ taskId: 'no-type', name: 'align', instanceType: null });

    render(
      <TaskDetailPanel
        runId="run-1"
        task={task}
        selection={{ kind: 'TASK', taskId: 'no-type', label: 'align' }}
        onClose={() => {}}
      />,
    );

    const unavailable = screen.getByTestId('task-resource-instance-type-unavailable');
    expect(unavailable).toBeInTheDocument();
    expect(unavailable).toHaveTextContent(/resource type unavailable/i);
    expect(unavailable).toHaveAttribute('aria-label', 'Resource type unavailable');
    // A fabricated instance type value is never shown.
    expect(
      screen.queryByTestId('task-resource-instance-type'),
    ).not.toBeInTheDocument();

    // Let the log tail's async fetch settle so its state update is flushed.
    await screen.findByTestId('logs-output');
  });

  it('treats a getErrorExcerpt rejection as "no excerpt available" without failing the panel (Req 8.4)', async () => {
    const task = makeTask({
      taskId: 'task-failed',
      name: 'SRA_IDS_TO_RUNINFO',
      status: 'FAILED',
      statusMessage: 'Run failed due to task: ... failure.',
      failureReason: 'RUN_TASK_FAILED',
    });
    const getErrorExcerpt = vi.fn().mockRejectedValue(new Error('excerpt boom'));

    render(
      <TaskDetailPanel
        runId="run-1"
        task={task}
        selection={{ kind: 'TASK', taskId: 'task-failed', label: 'SRA_IDS_TO_RUNINFO' }}
        getErrorExcerpt={getErrorExcerpt}
        onClose={() => {}}
      />,
    );

    // The failure banner (statusMessage/reason) still renders — the excerpt
    // fetch was attempted but its rejection is caught, not fatal.
    expect(await screen.findByTestId('task-logs-failure-banner')).toBeInTheDocument();
    expect(screen.getByTestId('task-logs-failure-message')).toHaveTextContent(
      'Run failed due to task: ... failure.',
    );

    await waitFor(() =>
      expect(getErrorExcerpt).toHaveBeenCalledWith({
        runId: 'run-1',
        stream: 'TASK',
        taskId: 'task-failed',
      }),
    );

    // No excerpt block is shown (the rejection yields the no-excerpt state),
    // and the log tail below still renders — the panel is unharmed.
    expect(screen.queryByTestId('task-error-excerpt')).not.toBeInTheDocument();
    expect(await screen.findByTestId('logs-output')).toBeInTheDocument();
  });

  it('renders the extracted error excerpt above the logs when one is found (Option B)', async () => {
    const task = makeTask({
      taskId: 'task-failed',
      name: 'SRA_IDS_TO_RUNINFO',
      status: 'FAILED',
      statusMessage: 'Run failed due to task: ... failure.',
      failureReason: 'RUN_TASK_FAILED',
    });
    const getErrorExcerpt = vi.fn().mockResolvedValue(
      excerpt({
        lines: [
          '[ERROR] We failed to reach a server.',
          '[ERROR] Reason: [Errno 110] Connection timed out',
        ],
      }),
    );

    render(
      <TaskDetailPanel
        runId="run-1"
        task={task}
        selection={{ kind: 'TASK', taskId: 'task-failed', label: 'SRA_IDS_TO_RUNINFO' }}
        getErrorExcerpt={getErrorExcerpt}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByTestId('task-error-excerpt')).toHaveTextContent(
      '[ERROR] Reason: [Errno 110] Connection timed out',
    );
  });

  // Req 2.6, 2.8, 3.1, 3.4: a selected task's measured utilization renders as
  // compact peak/mean `UtilizationBars` (not tall line charts) above the log
  // tail, so the tail stays reachable without extended scrolling; a task with
  // no matching series shows an explicit "utilization unavailable" state —
  // never a fabricated/zero bar.
  describe('task-scoped utilization bars', () => {
    // A realistic CPU usage series (role: 'usage') so `chartSeries` yields a
    // pair for the task. Matches the MetricSeries shape in api/types.
    function cpuUsageSeries(taskId: string): MetricSeries {
      return {
        metricName: 'aws.omics.task.cpu.usage',
        family: 'CPU',
        role: 'usage',
        unit: '{cpu}',
        taskId,
        points: [
          { timestamp: 1704067200000, value: 1200 },
          { timestamp: 1704067260000, value: 1800 },
          { timestamp: 1704067320000, value: 1500 },
        ],
      };
    }

    it('renders compact peak/mean utilization bars ABOVE the log tail for a TASK selection with matching series (Req 3.1, 3.4)', async () => {
      const task = makeTask({ taskId: 'task-metrics', name: 'align', status: 'RUNNING' });
      const taskMetrics: TaskMetrics = {
        taskId: 'task-metrics',
        series: [cpuUsageSeries('task-metrics')],
      };

      render(
        <TaskDetailPanel
          runId="run-1"
          task={task}
          selection={{ kind: 'TASK', taskId: 'task-metrics', label: 'align' }}
          taskMetrics={taskMetrics}
          onClose={() => {}}
        />,
      );

      // The utilization region renders as compact bars, with a per-family bar
      // for the matched CPU usage series (UtilizationBars, not a line chart).
      const utilization = screen.getByTestId('task-utilization');
      expect(utilization).toBeInTheDocument();
      const bar = screen.getByTestId(
        'task-metric-bar-task-metrics-aws.omics.task.cpu.usage',
      );
      expect(bar).toBeInTheDocument();
      // The bar carries the explicitly labeled peak AND mean measured values.
      expect(bar).toHaveTextContent(/peak/i);
      expect(bar).toHaveTextContent(/mean/i);
      // The explicit unavailable state is NOT shown when a bar exists.
      expect(
        screen.queryByTestId('task-utilization-unavailable'),
      ).not.toBeInTheDocument();

      // The compact bars appear ABOVE the log tail in DOM order (design §Zone 2:
      // resource detail → utilization bars → failure banner → log tail), so the
      // tail stays reachable without scrolling past tall charts.
      const logsOutput = await screen.findByTestId('logs-output');
      const position = utilization.compareDocumentPosition(logsOutput);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders the explicit "utilization unavailable" state and no bar when taskMetrics is null (Req 3.5)', async () => {
      const task = makeTask({ taskId: 'no-metrics', name: 'align', status: 'RUNNING' });

      render(
        <TaskDetailPanel
          runId="run-1"
          task={task}
          selection={{ kind: 'TASK', taskId: 'no-metrics', label: 'align' }}
          taskMetrics={null}
          onClose={() => {}}
        />,
      );

      // The explicit "utilization unavailable for this task" state renders...
      const unavailable = screen.getByTestId('task-utilization-unavailable');
      expect(unavailable).toBeInTheDocument();
      expect(unavailable).toHaveTextContent(/utilization unavailable for this task/i);
      // ...and NO bar region or per-bar element is fabricated.
      expect(screen.queryByTestId('task-utilization')).not.toBeInTheDocument();
      expect(
        screen.queryByTestId(/^task-metric-bar-/),
      ).not.toBeInTheDocument();

      // The log tail still renders below the unavailable state.
      await screen.findByTestId('logs-output');
    });

    it('renders the explicit "utilization unavailable" state when the series produce no bar pairs (Req 3.5)', async () => {
      const task = makeTask({ taskId: 'no-bars', name: 'align', status: 'RUNNING' });
      // A slice with no chart-producing (usage/limit) series yields no pairs
      // from `chartSeries`, so the unavailable state must show rather than a
      // fabricated zero bar.
      const taskMetrics: TaskMetrics = { taskId: 'no-bars', series: [] };

      render(
        <TaskDetailPanel
          runId="run-1"
          task={task}
          selection={{ kind: 'TASK', taskId: 'no-bars', label: 'align' }}
          taskMetrics={taskMetrics}
          onClose={() => {}}
        />,
      );

      expect(
        screen.getByTestId('task-utilization-unavailable'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('task-utilization')).not.toBeInTheDocument();
      expect(
        screen.queryByTestId(/^task-metric-bar-/),
      ).not.toBeInTheDocument();

      await screen.findByTestId('logs-output');
    });
  });
});
