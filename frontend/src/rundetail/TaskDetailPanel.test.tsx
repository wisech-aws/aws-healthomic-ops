import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import TaskDetailPanel from './TaskDetailPanel';
import type { DetailSelection } from './TaskDetailPanel';
import type { ErrorExcerpt, MetricSeries, Task } from '../api/types';
import type { TaskMetrics } from '../metrics/joinMetricsToTasks';
import { getRunLogs } from '../api/client';

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

  it('renders task Start time, End time, and Duration for a completed TASK selection (Req 8.1)', async () => {
    const task = makeTask({
      taskId: 'task-done',
      name: 'align',
      status: 'COMPLETED',
      startedAt: '2024-01-01T00:00:00.000Z',
      stoppedAt: '2024-01-01T01:23:45.000Z',
    });
    // A fixed `now` keeps the duration deterministic (unused for a stopped task).
    const now = Date.parse('2024-01-01T02:00:00.000Z');

    render(
      <TaskDetailPanel
        runId="run-1"
        task={task}
        selection={{ kind: 'TASK', taskId: 'task-done', label: 'align' }}
        now={now}
        onClose={() => {}}
      />,
    );

    // Start time and End time are surfaced from the real captured timestamps.
    expect(screen.getByTestId('task-detail-start-time')).toHaveTextContent(/\d/);
    const endTime = screen.getByTestId('task-detail-end-time');
    expect(endTime).toHaveTextContent(/\d/);
    // A completed task shows a concrete end time, not the "In progress" affordance.
    expect(endTime).not.toHaveTextContent(/in progress/i);
    // Duration is the elapsed HH:MM:SS between start and stop.
    expect(screen.getByTestId('task-detail-duration')).toHaveTextContent('01:23:45');

    await screen.findByTestId('logs-output');
  });

  it('shows an "In progress" end-time affordance (never a fabricated stop time) for a running TASK selection', async () => {
    // A running task: startedAt present, stoppedAt null.
    const task = makeTask({
      taskId: 'task-running',
      name: 'align',
      status: 'RUNNING',
      startedAt: '2024-01-01T00:00:00.000Z',
      stoppedAt: null,
    });
    // Fixed `now` => deterministic elapsed-so-far duration (30 minutes).
    const now = Date.parse('2024-01-01T00:30:00.000Z');

    render(
      <TaskDetailPanel
        runId="run-1"
        task={task}
        selection={{ kind: 'TASK', taskId: 'task-running', label: 'align' }}
        now={now}
        onClose={() => {}}
      />,
    );

    // End time shows the explicit "In progress" affordance, never a fabricated
    // timestamp.
    const endTime = screen.getByTestId('task-detail-end-time');
    expect(endTime).toHaveTextContent(/in progress/i);
    // Duration is elapsed-so-far measured against the injected `now`.
    expect(screen.getByTestId('task-detail-duration')).toHaveTextContent('00:30:00');

    await screen.findByTestId('logs-output');
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

  it('shows a progress indicator while the error excerpt is being fetched, then clears it', async () => {
    const task = makeTask({
      taskId: 'task-failed',
      name: 'SRA_IDS_TO_RUNINFO',
      status: 'FAILED',
      statusMessage: 'Run failed due to task: ... failure.',
      failureReason: 'RUN_TASK_FAILED',
    });
    // A deferred promise so we can assert the loading state WHILE the fetch is
    // in flight, then resolve it and assert the indicator is gone.
    let resolveExcerpt!: (value: ErrorExcerpt) => void;
    const pending = new Promise<ErrorExcerpt>((resolve) => {
      resolveExcerpt = resolve;
    });
    const getErrorExcerpt = vi.fn().mockReturnValue(pending);

    render(
      <TaskDetailPanel
        runId="run-1"
        task={task}
        selection={{ kind: 'TASK', taskId: 'task-failed', label: 'SRA_IDS_TO_RUNINFO' }}
        getErrorExcerpt={getErrorExcerpt}
        onClose={() => {}}
      />,
    );

    // While pending: the progress indicator is shown and no excerpt block yet.
    expect(
      await screen.findByTestId('task-error-excerpt-loading'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('task-error-excerpt')).not.toBeInTheDocument();

    // Resolve the fetch with a found excerpt.
    resolveExcerpt(
      excerpt({ lines: ['[ERROR] boom'] }),
    );

    // The indicator clears and the excerpt block appears.
    expect(await screen.findByTestId('task-error-excerpt')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByTestId('task-error-excerpt-loading'),
      ).not.toBeInTheDocument(),
    );
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

      // The metrics live inside a collapsed-by-default "Measured utilization"
      // ExpandableSection below the log tail; the section header is always
      // present. Expand it before asserting on the bars.
      const utilizationSection = screen.getByTestId('task-utilization-section');
      expect(utilizationSection).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /measured utilization/i }));

      // The utilization region renders as compact bars, with a per-family bar
      // for the matched CPU usage series (UtilizationBars, not a line chart).
      const utilization = await screen.findByTestId('task-utilization');
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

      // The log tail now appears ABOVE the measured-utilization region in DOM
      // order (new order: resource detail → failure banner → log tail →
      // collapsible metrics), so the tail stays reachable without scrolling
      // past the charts.
      const logsOutput = await screen.findByTestId('logs-output');
      const position = logsOutput.compareDocumentPosition(utilization);
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

      // Expand the collapsed "Measured utilization" section to reach its content.
      fireEvent.click(screen.getByRole('button', { name: /measured utilization/i }));

      // The explicit "utilization unavailable for this task" state renders...
      const unavailable = await screen.findByTestId('task-utilization-unavailable');
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

      // Expand the collapsed "Measured utilization" section to reach its content.
      fireEvent.click(screen.getByRole('button', { name: /measured utilization/i }));

      expect(
        await screen.findByTestId('task-utilization-unavailable'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('task-utilization')).not.toBeInTheDocument();
      expect(
        screen.queryByTestId(/^task-metric-bar-/),
      ).not.toBeInTheDocument();

      await screen.findByTestId('logs-output');
    });
  });

  // OPT-IN tail (failed-run triage): only a FAILED/CANCELLED task tails its own
  // stream; a healthy/running task keeps the default oldest-first retrieval.
  // LogsPanel reads the module-mocked client `getRunLogs`, so assert on its
  // call args.
  describe('tail (failed-run triage)', () => {
    const getRunLogsMock = vi.mocked(getRunLogs);

    it('tails the TASK stream (tail:true) for a FAILED task selection', async () => {
      getRunLogsMock.mockClear();
      const task = makeTask({ taskId: 'task-failed', name: 'align', status: 'FAILED' });

      render(
        <TaskDetailPanel
          runId="run-1"
          task={task}
          selection={{ kind: 'TASK', taskId: 'task-failed', label: 'align' }}
          onClose={() => {}}
        />,
      );

      await screen.findByTestId('logs-output');
      await waitFor(() =>
        expect(getRunLogsMock).toHaveBeenCalledWith({
          runId: 'run-1',
          stream: 'TASK',
          taskId: 'task-failed',
          tail: true,
        }),
      );
    });

    it('does NOT tail the TASK stream for a non-failed (RUNNING) task selection', async () => {
      getRunLogsMock.mockClear();
      const task = makeTask({ taskId: 'task-ok', name: 'align', status: 'RUNNING' });

      render(
        <TaskDetailPanel
          runId="run-1"
          task={task}
          selection={{ kind: 'TASK', taskId: 'task-ok', label: 'align' }}
          onClose={() => {}}
        />,
      );

      await screen.findByTestId('logs-output');
      await waitFor(() =>
        expect(getRunLogsMock).toHaveBeenCalledWith({
          runId: 'run-1',
          stream: 'TASK',
          taskId: 'task-ok',
        }),
      );
      // The default (successful) path must not carry a tail flag.
      const lastCall =
        getRunLogsMock.mock.calls[getRunLogsMock.mock.calls.length - 1][0];
      expect(lastCall).not.toHaveProperty('tail');
    });

    it('tails the RUN/ENGINE tabs (tail:true) when runFailed is set', async () => {
      getRunLogsMock.mockClear();

      render(
        <TaskDetailPanel
          runId="run-1"
          task={null}
          selection={{ kind: 'RUN_ENGINE' }}
          runFailed
          onClose={() => {}}
        />,
      );

      await screen.findByTestId('logs-output');
      await waitFor(() =>
        expect(getRunLogsMock).toHaveBeenCalledWith({
          runId: 'run-1',
          stream: 'RUN',
          taskId: undefined,
          tail: true,
        }),
      );
    });
  });
});
