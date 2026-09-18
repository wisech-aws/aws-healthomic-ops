import { describe, it, expect, vi } from 'vitest';
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
  within,
} from '@testing-library/react';
import type { Edge, Node } from 'reactflow';
import RunDetailView from './RunDetailView';
import type { Run, Task } from '../api/types';
import type { Subscription, SubscriptionHandlers } from '../api/client';
import type { StaticGraph } from '../taskview/types';
import { SplitPanelSlotContext } from '../splitPanelSlot';
import type { SplitPanelSlot } from '../splitPanelSlot';

// Render React Flow headlessly: jsdom has no layout, so replace the canvas
// renderer with a simple list of node labels exposing status via data attrs so
// tests can assert on node color/status without a real flow container.
vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({
    nodes,
    onNodeClick,
  }: {
    nodes: Node[];
    edges: Edge[];
    onNodeClick?: (event: unknown, node: Node) => void;
  }) => (
    <div data-testid="reactflow">
      {nodes.map((n) => (
        <div
          key={n.id}
          data-testid={`node-${n.id}`}
          data-status={(n.data as { status?: string | null }).status ?? ''}
          data-color={(n.data as { color?: string }).color ?? ''}
          data-highlighted={
            (n.data as { highlighted?: boolean }).highlighted ? 'true' : 'false'
          }
          data-search-match={
            (n.data as { searchMatch?: boolean }).searchMatch ? 'true' : 'false'
          }
          data-dimmed={
            (n.data as { dimmed?: boolean }).dimmed ? 'true' : 'false'
          }
          data-selected={
            (n.data as { selected?: boolean }).selected ? 'true' : 'false'
          }
          onClick={() => onNodeClick?.(undefined, n)}
        >
          {(n.data as { label?: string }).label}
        </div>
      ))}
    </div>
  ),
  Handle: () => null,
  useReactFlow: () => ({ fitView: () => {} }),
  // Named exports used by the component / graph layout, stubbed for jsdom.
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

// The component imports reactflow's CSS; stub it so the jsdom test run doesn't
// try to parse the stylesheet.
vi.mock('reactflow/dist/style.css', () => ({}));

// LogsPanel uses the client's getRunLogs directly (not injected via RunDetailView),
// so stub it here. Keep the rest of the client intact for the injected props.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getRunLogs: vi.fn().mockResolvedValue({
      logStreamName: 'run/run-1/task/task-live',
      events: [{ timestamp: 1704067200000, message: 'task log line' }],
      nextToken: null,
    }),
  };
});

function makeRun(partial: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    name: 'my-run',
    status: 'RUNNING',
    startedAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...partial,
  };
}

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
    ...partial,
  };
}

/** A no-op subscription that never emits (default for most tests). */
function noopSubscribe(): (
  runId: string,
  handlers: SubscriptionHandlers<Task>,
) => Subscription {
  return () => ({ unsubscribe: () => {} });
}

describe('RunDetailView', () => {
  it('queries getRun and listTasksForRun once on open (Req 9.1, 10.4)', async () => {
    const getRun = vi.fn().mockResolvedValue(makeRun());
    const listTasksForRun = vi
      .fn()
      .mockResolvedValue([makeTask({ startedAt: null, stoppedAt: null })]);

    render(
      <RunDetailView
        runId="run-1"
        getRun={getRun}
        listTasksForRun={listTasksForRun}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByLabelText('progress');
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(listTasksForRun).toHaveBeenCalledTimes(1);
  });

  it('shows an error with retry, then recovers (Req 9.2, 10.2)', async () => {
    const getRun = vi
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce(makeRun());
    const listTasksForRun = vi
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce([makeTask({ startedAt: null, stoppedAt: null })]);

    render(
      <RunDetailView
        runId="run-1"
        getRun={getRun}
        listTasksForRun={listTasksForRun}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    // Cloudscape Alert renders the message text; assert on it directly.
    expect(await screen.findByText(/timed out/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await screen.findByLabelText('progress');
    expect(screen.queryByText(/timed out/i)).not.toBeInTheDocument();
  });

  it('shows a zero-task empty state for a finished run with no tasks (Req 9.4)', async () => {
    // A terminal run (COMPLETED) with no tasks shows the empty state rather than
    // the Initializing node, which is reserved for active pre-task runs.
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'COMPLETED' }))}
        listTasksForRun={vi.fn().mockResolvedValue([])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    expect(
      await screen.findByText(/no tasks exist for this run/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();
  });

  it('shows an Initializing DAG node for an active run with no tasks yet', async () => {
    // An active run (RUNNING) that has not reported tasks yet renders a single
    // Initializing node and an "Initializing" layer indicator, not the empty
    // state.
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'RUNNING' }))}
        listTasksForRun={vi.fn().mockResolvedValue([])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    // The task graph renders (the Initializing node), not the empty message.
    const graph = await screen.findByTestId('task-graph');
    expect(graph).toHaveAttribute('data-initializing', 'true');
    expect(screen.getByTestId('node-__initializing__')).toBeInTheDocument();
    expect(screen.getByTestId('layer-indicator')).toHaveTextContent(
      /initializing/i,
    );
    expect(
      screen.queryByText(/no tasks exist for this run/i),
    ).not.toBeInTheDocument();
  });

  it('shows the inferred label and layer indicator for the Inferred_DAG (Req 7.3, 7.5)', async () => {
    // No static graph + tasks with timing => Inferred_DAG.
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun())}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([
            makeTask({ status: 'COMPLETED' }),
            makeTask({ status: 'RUNNING' }),
          ])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByTestId('reactflow');
    expect(screen.getByTestId('layer-indicator')).toHaveTextContent(
      /inferred dag/i,
    );
    expect(screen.getByTestId('inferred-label')).toHaveTextContent(/inferred/i);
  });

  it('shows a color legend for the task statuses present (Req 9.5)', async () => {
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun())}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([
            makeTask({ status: 'COMPLETED' }),
            makeTask({ status: 'RUNNING' }),
          ])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    const legend = await screen.findByTestId('task-status-legend');
    // Lists the statuses actually present.
    expect(legend).toHaveTextContent('COMPLETED');
    expect(legend).toHaveTextContent('RUNNING');
    // Not a status that isn't present.
    expect(legend).not.toHaveTextContent('FAILED');
  });

  it('defaults to the Inferred DAG and toggles up to the Static DAG when a static graph is supplied (Req 8.3, 8.1, 8.5, 9.3)', async () => {
    const staticGraph: StaticGraph = {
      workflowId: 'wf-1',
      nodes: [
        { id: 'n1', name: 'align' },
        { id: 'n2', name: 'call' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    render(
      <RunDetailView
        runId="run-1"
        staticGraph={staticGraph}
        getRun={vi.fn().mockResolvedValue(makeRun())}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ name: 'align', status: 'COMPLETED' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByTestId('reactflow');

    // DEFAULT: even though a Static DAG is available, the Inferred (timing) DAG
    // is shown by default (Req 8.3). The "inferred" label is present and the
    // static fidelity label is NOT shown yet.
    expect(screen.getByTestId('inferred-label')).toBeInTheDocument();
    expect(screen.queryByTestId('fidelity-label')).not.toBeInTheDocument();

    // The "Show static DAG" toggle is offered because a Static DAG is available.
    const toggle = screen.getByTestId('static-toggle');
    const toggleInput = toggle.querySelector('input') as HTMLInputElement;
    expect(toggleInput).not.toBeNull();

    // Toggle UP to the Static DAG.
    act(() => {
      fireEvent.click(toggleInput);
    });

    // Now the Static DAG is shown and labeled honestly by its fidelity. The
    // supplied graph carries no `fidelity`, so it is treated as approximate
    // (Req 8.1, 8.5) — never as an authoritative "true dependency graph".
    expect(screen.getByTestId('fidelity-label')).toHaveTextContent(
      /static dag \(approximate\)/i,
    );
    expect(screen.queryByTestId('inferred-label')).not.toBeInTheDocument();
    // Node n1 (align) matched the COMPLETED task and is colored accordingly.
    expect(screen.getByTestId('node-n1')).toHaveAttribute(
      'data-status',
      'COMPLETED',
    );
  });

  it('shows completed/total counts and HH:MM:SS elapsed (Req 9.6)', async () => {
    const started = '2024-01-01T00:00:00.000Z';
    const stopped = '2024-01-01T00:30:00.000Z';
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(
          makeRun({ startedAt: started, stoppedAt: stopped, workflowId: 'wf-777' }),
        )}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([
            makeTask({ status: 'COMPLETED' }),
            makeTask({ status: 'RUNNING' }),
          ])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByLabelText('progress');
    expect(screen.getByTestId('progress-count')).toHaveTextContent('1 / 2');
    expect(screen.getByTestId('progress-elapsed')).toHaveTextContent('00:30:00');
    // Run ID and Workflow ID are shown on the run detail view.
    expect(screen.getByTestId('run-id')).toHaveTextContent('run-1');
    expect(screen.getByTestId('workflow-id')).toHaveTextContent('wf-777');
  });

  it('updates the affected node color/status live on onTaskUpdated without reload (Req 9.7, 9.8)', async () => {
    let emit: ((task: Task) => void) | undefined;
    const subscribe = (
      _runId: string,
      handlers: SubscriptionHandlers<Task>,
    ): Subscription => {
      emit = handlers.next;
      return { unsubscribe: () => {} };
    };

    const task = makeTask({ taskId: 'task-live', name: 'align', status: 'RUNNING' });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun())}
        listTasksForRun={vi.fn().mockResolvedValue([task])}
        onTaskUpdated={subscribe}
      />,
    );

    await screen.findByTestId('node-task-live');
    expect(screen.getByTestId('node-task-live')).toHaveAttribute(
      'data-status',
      'RUNNING',
    );

    // Deliver a live update flipping the task to COMPLETED.
    act(() => {
      emit?.({ ...task, status: 'COMPLETED' });
    });

    await waitFor(() =>
      expect(screen.getByTestId('node-task-live')).toHaveAttribute(
        'data-status',
        'COMPLETED',
      ),
    );
    // Progress reflects the update too (1 completed now).
    expect(screen.getByTestId('progress-count')).toHaveTextContent('1 / 1');
  });

  it('opens the fly-out with the task detail when a task node is selected — not a reserved side column or an appended bottom block (Req 1.1, 1.5, 2.1, 2.2, 4.1)', async () => {
    const task = makeTask({ taskId: 'task-live', name: 'align', status: 'RUNNING' });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun())}
        listTasksForRun={vi.fn().mockResolvedValue([task])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    // The DAG renders full-width (Req 1.1). Before any selection the fly-out is
    // closed (Req 2.1): there is no detail panel and no reserved blank detail
    // region beside the full-width DAG (Req 1.5) — only the run-level context
    // band below it.
    const dagMaster = await screen.findByTestId('dag-master');
    expect(dagMaster).toBeInTheDocument();
    expect(screen.queryByTestId('detail-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-level-context')).toBeInTheDocument();

    // Click the task node in the full-width DAG.
    const node = await screen.findByTestId('node-task-live');
    fireEvent.click(node);

    // Selecting a node opens the fly-out on that task (Req 2.2). Without the
    // `Dashboard` shell provider the fly-out has no SplitPanel host, so the
    // component renders the SAME detail inline in its fly-out fallback region
    // (`detail-panel`) — never a reserved side column, never an appended block
    // at the bottom of the page. Scope the detail assertions to that region.
    const detailPanel = await screen.findByTestId('detail-panel');
    expect(
      await within(detailPanel).findByText(/logs — task align/i),
    ).toBeInTheDocument();
    expect(await within(detailPanel).findByTestId('logs-output')).toHaveTextContent(
      'task log line',
    );

    // The DAG stays rendered and interactive while the fly-out is open
    // (Req 2.5), and the detail never renders inside the DAG region itself.
    expect(screen.getByTestId('dag-master')).toBeInTheDocument();
    expect(dagMaster).not.toContainElement(
      screen.getByText(/logs — task align/i),
    );

    // The selected node carries the selection flag (amber ring).
    expect(screen.getByTestId('node-task-live')).toHaveAttribute(
      'data-selected',
      'true',
    );

    // The always-visible orientation strip remains rendered under a TASK
    // selection (Req 1.2): status + progress never scroll away.
    const strip = screen.getByTestId('orientation-strip');
    expect(strip).toBeInTheDocument();
    expect(within(strip).getByTestId('run-status')).toBeInTheDocument();
    expect(within(strip).getByTestId('progress-count')).toBeInTheDocument();
  });

  it('rings only the selected node and clears it when logs are closed', async () => {
    const tasks = [
      makeTask({ taskId: 'a', name: 'align', status: 'COMPLETED' }),
      makeTask({ taskId: 'b', name: 'call', status: 'COMPLETED' }),
    ];
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'COMPLETED' }))}
        listTasksForRun={vi.fn().mockResolvedValue(tasks)}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    // Before any selection, no node is ringed.
    const nodeA = await screen.findByTestId('node-a');
    expect(nodeA).toHaveAttribute('data-selected', 'false');
    expect(screen.getByTestId('node-b')).toHaveAttribute('data-selected', 'false');

    // Selecting node 'a' rings exactly 'a'.
    fireEvent.click(nodeA);
    expect(await screen.findByText(/logs — task align/i)).toBeInTheDocument();
    expect(screen.getByTestId('node-a')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('node-b')).toHaveAttribute('data-selected', 'false');

    // Closing the logs panel clears the selection ring.
    fireEvent.click(screen.getByRole('button', { name: /close logs/i }));
    expect(screen.getByTestId('node-a')).toHaveAttribute('data-selected', 'false');
  });

  it('shows a run-level failure banner with the statusMessage and failureReason (Req: surface run failures)', async () => {
    const run = makeRun({
      status: 'FAILED',
      statusMessage:
        'Workflow run failed. Review the CloudWatch logs engine log stream to debug the failure.',
      failureReason: 'WORKFLOW_RUN_FAILED',
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'FAILED' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    expect(await screen.findByTestId('run-failure-banner')).toBeInTheDocument();
    expect(screen.getByTestId('run-failure-message')).toHaveTextContent(
      'Workflow run failed. Review the CloudWatch logs engine log stream to debug the failure.',
    );
    expect(screen.getByTestId('run-failure-reason')).toHaveTextContent(
      'WORKFLOW_RUN_FAILED',
    );
  });

  it('shows the extracted error excerpt in the run-failure banner when found (Option B)', async () => {
    const run = makeRun({
      status: 'FAILED',
      statusMessage: 'Workflow run failed. Review the CloudWatch logs...',
      failureReason: 'WORKFLOW_RUN_FAILED',
    });
    const getErrorExcerpt = vi.fn().mockResolvedValue({
      found: true,
      truncated: false,
      lines: [
        'nextflow.validation.exceptions.SchemaValidationException: ...',
        "-> Entry 1: Error for field 'fastq_1': the file does not exist",
      ],
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'FAILED' })])}
        onTaskUpdated={noopSubscribe()}
        getErrorExcerpt={getErrorExcerpt}
      />,
    );

    expect(await screen.findByTestId('run-error-excerpt')).toHaveTextContent(
      "-> Entry 1: Error for field 'fastq_1': the file does not exist",
    );
    // Fetched against the ENGINE stream for a run-level failure.
    expect(getErrorExcerpt).toHaveBeenCalledWith({ runId: 'run-1', stream: 'ENGINE' });
  });

  it('does not show an excerpt block in the run-failure banner when none was found (never fabricated)', async () => {
    const run = makeRun({
      status: 'FAILED',
      statusMessage: 'Workflow run failed. Review the CloudWatch logs...',
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'FAILED' })])}
        onTaskUpdated={noopSubscribe()}
        getErrorExcerpt={vi
          .fn()
          .mockResolvedValue({ found: false, lines: [], truncated: false })}
      />,
    );

    expect(await screen.findByTestId('run-failure-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('run-error-excerpt')).not.toBeInTheDocument();
  });

  it('does not fetch an error excerpt for a healthy run', async () => {
    const getErrorExcerpt = vi.fn();
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'RUNNING' }))}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'RUNNING' })])}
        onTaskUpdated={noopSubscribe()}
        getErrorExcerpt={getErrorExcerpt}
      />,
    );

    await screen.findByLabelText('progress');
    expect(getErrorExcerpt).not.toHaveBeenCalled();
  });

  it('shows the extracted error excerpt above a failed task\'s logs (Option B)', async () => {
    const task = makeTask({
      taskId: 'sra-1',
      name: 'SRA_IDS_TO_RUNINFO',
      status: 'FAILED',
      statusMessage: 'Run failed due to task: ... failure.',
      failureReason: 'RUN_TASK_FAILED',
    });
    const getErrorExcerpt = vi.fn().mockResolvedValue({
      found: true,
      truncated: false,
      lines: ['[ERROR] We failed to reach a server.', '[ERROR] Reason: [Errno 110] Connection timed out'],
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'FAILED' }))}
        listTasksForRun={vi.fn().mockResolvedValue([task])}
        onTaskUpdated={noopSubscribe()}
        getErrorExcerpt={getErrorExcerpt}
      />,
    );

    const node = await screen.findByTestId('node-sra-1');
    fireEvent.click(node);

    expect(await screen.findByTestId('task-error-excerpt')).toHaveTextContent(
      '[ERROR] Reason: [Errno 110] Connection timed out',
    );
    expect(getErrorExcerpt).toHaveBeenCalledWith({
      runId: 'run-1',
      stream: 'TASK',
      taskId: 'sra-1',
    });
  });

  it('opens the Engine logs tab directly from the run-failure banner "View engine logs" action', async () => {
    const run = makeRun({
      status: 'FAILED',
      statusMessage: 'Workflow run failed. Review the CloudWatch logs...',
      failureReason: 'WORKFLOW_RUN_FAILED',
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'FAILED' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    fireEvent.click(await screen.findByTestId('run-failure-view-logs'));

    expect(await screen.findByText(/logs — run & engine/i)).toBeInTheDocument();
    // The Engine tab is active (not the default Run tab).
    expect(screen.getByRole('tab', { name: /engine/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('opens a failed task\'s logs directly from the failed-tasks list "View logs" action', async () => {
    const tasks = [
      makeTask({
        taskId: 'sra-1',
        name: 'SRA_IDS_TO_RUNINFO',
        status: 'FAILED',
        statusMessage: 'Run failed due to task: ... failure.',
        failureReason: 'RUN_TASK_FAILED',
      }),
    ];
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'FAILED' }))}
        listTasksForRun={vi.fn().mockResolvedValue(tasks)}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    const failedList = await screen.findByTestId('failed-tasks-list');
    fireEvent.click(within(failedList).getByTestId('failed-task-view-logs'));

    expect(await screen.findByText(/logs — task SRA_IDS_TO_RUNINFO/i)).toBeInTheDocument();
    expect(await screen.findByTestId('task-logs-failure-banner')).toBeInTheDocument();
  });

  it('does not show a run-failure banner when the run has no statusMessage (never fabricated)', async () => {
    const run = makeRun({ status: 'FAILED' });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'FAILED' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByLabelText('progress');
    expect(screen.queryByTestId('run-failure-banner')).not.toBeInTheDocument();
  });

  it('lists each failed/cancelled task with its own statusMessage/failureReason (Req: surface task failures)', async () => {
    const tasks = [
      makeTask({
        taskId: 'sra-1',
        name: 'SRA_IDS_TO_RUNINFO (SRR13191702)',
        status: 'FAILED',
        statusMessage:
          'Run failed due to task: NFCORE_FETCHNGS:SRA:SRA_IDS_TO_RUNINFO (SRR13191702), id: 8447635, failure.',
        failureReason: 'RUN_TASK_FAILED',
      }),
      makeTask({ taskId: 'ok-1', name: 'align', status: 'COMPLETED' }),
    ];
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'FAILED' }))}
        listTasksForRun={vi.fn().mockResolvedValue(tasks)}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    expect(await screen.findByTestId('failed-tasks-list')).toBeInTheDocument();
    expect(screen.getByTestId('failed-task-message')).toHaveTextContent(
      'Run failed due to task: NFCORE_FETCHNGS:SRA:SRA_IDS_TO_RUNINFO (SRR13191702), id: 8447635, failure.',
    );
    expect(screen.getByTestId('failed-task-reason')).toHaveTextContent(
      'RUN_TASK_FAILED',
    );
    // A healthy task's name never appears in the failed-tasks list (it may
    // still appear elsewhere, e.g. as a DAG node label).
    const failedList = screen.getByTestId('failed-tasks-list');
    expect(within(failedList).queryByText('align')).not.toBeInTheDocument();
  });

  it('does not render the failed-tasks list when no task failed/was cancelled', async () => {
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'RUNNING' }))}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'RUNNING' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByLabelText('progress');
    expect(screen.queryByTestId('failed-tasks-list')).not.toBeInTheDocument();
  });

  it('shows the task status detail banner above the logs for a failed task', async () => {
    const task = makeTask({
      taskId: 'task-failed',
      name: 'SRA_IDS_TO_RUNINFO',
      status: 'FAILED',
      statusMessage: 'Run failed due to task: ... failure.',
      failureReason: 'RUN_TASK_FAILED',
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'FAILED' }))}
        listTasksForRun={vi.fn().mockResolvedValue([task])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    const node = await screen.findByTestId('node-task-failed');
    fireEvent.click(node);

    expect(await screen.findByTestId('task-logs-failure-banner')).toBeInTheDocument();
    expect(screen.getByTestId('task-logs-failure-message')).toHaveTextContent(
      'Run failed due to task: ... failure.',
    );
    expect(screen.getByTestId('task-logs-failure-reason')).toHaveTextContent(
      'RUN_TASK_FAILED',
    );
  });

  it('does not show the task status detail banner for a healthy task', async () => {
    const task = makeTask({ taskId: 'task-live', name: 'align', status: 'RUNNING' });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun())}
        listTasksForRun={vi.fn().mockResolvedValue([task])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    const node = await screen.findByTestId('node-task-live');
    fireEvent.click(node);

    await screen.findByTestId('logs-output');
    expect(screen.queryByTestId('task-logs-failure-banner')).not.toBeInTheDocument();
  });

  it('opens run & engine logs from the header button', async () => {

    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun())}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'RUNNING' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByLabelText('progress');
    fireEvent.click(
      screen.getByRole('button', { name: /view run and engine logs/i }),
    );
    expect(await screen.findByText(/logs — run & engine/i)).toBeInTheDocument();
    // Run/Engine tabs are present.
    expect(screen.getByRole('tab', { name: /run/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /engine/i })).toBeInTheDocument();
  });

  it('renders the orientation strip (status + progress) for a null selection (Req 1.1, 1.2)', async () => {
    // With no selection, the always-visible orientation strip shows the run
    // status, name, and progress (completed/total + elapsed HH:MM:SS) — the
    // operator keeps orientation without any selection.
    const started = '2024-01-01T00:00:00.000Z';
    const stopped = '2024-01-01T00:15:00.000Z';
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi
          .fn()
          .mockResolvedValue(makeRun({ startedAt: started, stoppedAt: stopped }))}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'RUNNING' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    const strip = await screen.findByTestId('orientation-strip');
    // Status, name, progress count/elapsed, and layer indicator all live in the
    // strip and render with no selection active.
    expect(within(strip).getByTestId('run-status')).toBeInTheDocument();
    expect(within(strip).getByTestId('run-name')).toHaveTextContent('my-run');
    expect(within(strip).getByTestId('progress-count')).toHaveTextContent('0 / 1');
    expect(within(strip).getByTestId('progress-elapsed')).toHaveTextContent(
      '00:15:00',
    );
    expect(within(strip).getByTestId('layer-indicator')).toBeInTheDocument();
    // No selection is active: the detail panel shows the default run-level
    // context, not a task detail's logs.
    expect(screen.queryByText(/logs — task/i)).not.toBeInTheDocument();
  });

  it('keeps the orientation strip rendered under a RUN_ENGINE selection (Req 1.2)', async () => {
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun())}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'RUNNING' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByLabelText('progress');
    // Open run & engine logs (a RUN_ENGINE selection) from the header.
    fireEvent.click(
      screen.getByRole('button', { name: /view run and engine logs/i }),
    );
    // The run/engine logs render in the fly-out (its inline fallback region when
    // rendered without the `Dashboard` shell provider).
    const detailPanel = await screen.findByTestId('detail-panel');
    expect(
      await within(detailPanel).findByText(/logs — run & engine/i),
    ).toBeInTheDocument();

    // The orientation strip remains present alongside the RUN_ENGINE selection
    // (Req 1.2) — status + progress never scroll away.
    const strip = screen.getByTestId('orientation-strip');
    expect(within(strip).getByTestId('run-status')).toBeInTheDocument();
    expect(within(strip).getByTestId('progress-count')).toBeInTheDocument();
  });

  it('renders the run-level context (resource summary + failed-tasks list) in the full-width band regardless of fly-out state (Req 4.2)', async () => {
    // A finished run with a failed task and no selection: the run-level context
    // band — the derived resource summary and the failed-tasks list — renders
    // in its own full-width region below the DAG, reachable when nothing is
    // selected. There is no side detail column and the fly-out is closed.
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'FAILED' }))}
        listTasksForRun={vi.fn().mockResolvedValue([
          makeTask({ taskId: 'ok', name: 'align', status: 'COMPLETED' }),
          makeTask({
            taskId: 'bad',
            name: 'call',
            status: 'FAILED',
            statusMessage: 'task failed',
            failureReason: 'RUN_TASK_FAILED',
          }),
        ])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    const context = await screen.findByTestId('run-level-context');
    // Both run-level context pieces live inside the full-width band.
    expect(within(context).getByTestId('resource-summary')).toBeInTheDocument();
    expect(within(context).getByTestId('failed-tasks-list')).toBeInTheDocument();
    // The fly-out is closed while unselected: no detail panel, no task detail.
    expect(screen.queryByTestId('detail-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(/logs — task/i)).not.toBeInTheDocument();

    // The band stays rendered once the fly-out opens on a selection (Req 4.2):
    // selecting the failed node opens the fly-out AND the context band remains.
    fireEvent.click(screen.getByTestId('node-bad'));
    const detailPanel = await screen.findByTestId('detail-panel');
    expect(
      await within(detailPanel).findByText(/logs — task call/i),
    ).toBeInTheDocument();
    const contextWhileOpen = screen.getByTestId('run-level-context');
    expect(
      within(contextWhileOpen).getByTestId('resource-summary'),
    ).toBeInTheDocument();
    expect(
      within(contextWhileOpen).getByTestId('failed-tasks-list'),
    ).toBeInTheDocument();
  });

  it('renders the failure banner regardless of selection (null, TASK, and RUN_ENGINE) for a FAILED run (Req 2.3)', async () => {
    const run = makeRun({
      status: 'FAILED',
      statusMessage: 'Workflow run failed. Review the CloudWatch logs...',
      failureReason: 'WORKFLOW_RUN_FAILED',
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi.fn().mockResolvedValue([
          makeTask({ taskId: 'bad', name: 'call', status: 'FAILED' }),
        ])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    // Null selection: the failure banner is present in the always-visible zone.
    expect(await screen.findByTestId('run-failure-banner')).toBeInTheDocument();

    // TASK selection: selecting a node must not hide the run failure.
    fireEvent.click(screen.getByTestId('node-bad'));
    await within(screen.getByTestId('detail-panel')).findByText(/logs — task call/i);
    expect(screen.getByTestId('run-failure-banner')).toBeInTheDocument();

    // RUN_ENGINE selection: opening run/engine logs must not hide it either.
    fireEvent.click(
      screen.getByRole('button', { name: /view run and engine logs/i }),
    );
    await within(screen.getByTestId('detail-panel')).findByText(
      /logs — run & engine/i,
    );
    expect(screen.getByTestId('run-failure-banner')).toBeInTheDocument();
  });

  it('renders the analysis sections in a single-column stack, collapsed by default (Req 6.1, 6.2)', async () => {
    // The zone-3 analysis stack holds all five analysis sections in a single
    // column (no 2-up grid), each an ExpandableSection collapsed by default.
    // (Cloudscape keeps a collapsed section's content mounted but hidden, so
    // "collapsed" is asserted via each toggle's aria-expanded="false", and via
    // the inputs & outputs section needing an explicit expand click before its
    // content is reachable.)
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'COMPLETED' }))}
        listTasksForRun={vi.fn().mockResolvedValue([
          makeTask({
            status: 'COMPLETED',
            createdAt: '2024-01-01T00:00:00.000Z',
            startedAt: '2024-01-01T00:05:00.000Z',
            stoppedAt: '2024-01-01T00:20:00.000Z',
          }),
        ])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    // The analysis stack and all five sections are present in the DOM, below the
    // full-width DAG + run-level context band (Req 6.1). No analysis content was
    // removed by the restructure.
    const grid = await screen.findByTestId('analysis-stack');
    expect(within(grid).getByTestId('cost-section')).toBeInTheDocument();
    expect(within(grid).getByTestId('longest-tasks-section')).toBeInTheDocument();
    expect(within(grid).getByTestId('task-segments')).toBeInTheDocument();
    expect(within(grid).getByTestId('metrics-section')).toBeInTheDocument();

    // Each section's expand toggle reports the collapsed state (Req 6.2). The
    // container-variant ExpandableSection renders its header as a role="button"
    // carrying aria-expanded; scope the lookup to each section's own testid
    // (the ExpandableSection root) so we read that section's toggle, and take
    // the collapse toggle — the one that actually carries aria-expanded.
    for (const testId of [
      'cost-section',
      'longest-tasks-section',
      'task-segments',
      'metrics-section',
    ]) {
      const section = within(grid).getByTestId(testId);
      const toggle = within(section)
        .getAllByRole('button')
        .find((el) => el.getAttribute('aria-expanded') != null);
      expect(toggle).toBeDefined();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }

    // The inputs & outputs section (which owns its own ExpandableSection) is
    // collapsed by default too: its content (run parameters) is only reachable
    // after an explicit expand click.
    expect(screen.queryByTestId('run-parameters')).not.toBeInTheDocument();
  });

  it('renders run parameters, output link, and engine version (#7, #8)', async () => {
    const run = makeRun({
      status: 'RUNNING',
      outputUri: 's3://demo-bucket/run-outputs/run-1',
      engineVersion: '25.10.0',
      parameters: JSON.stringify({
        input: 's3://demo-bucket/samplesheet.csv',
        validate_params: false,
      }),
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi.fn().mockResolvedValue([makeTask({ status: 'RUNNING' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByLabelText('progress');
    // Expand the Inputs & outputs section.
    fireEvent.click(screen.getByRole('button', { name: /inputs & outputs/i }));

    expect(await screen.findByTestId('engine-version')).toHaveTextContent('25.10.0');
    // Output URI rendered as an external S3 console link. The output location is
    // a prefix (folder), so the console link completes the prefix with an
    // (encoded) trailing slash so S3 opens the folder view (#8).
    const outputLink = screen.getByRole('link', {
      name: /s3:\/\/demo-bucket\/run-outputs\/run-1/i,
    });
    expect(outputLink).toHaveAttribute(
      'href',
      expect.stringContaining('s3.console.aws.amazon.com'),
    );
    // prefix=run-outputs/run-1/  -> encoded as run-outputs%2Frun-1%2F
    expect(outputLink).toHaveAttribute(
      'href',
      expect.stringContaining('prefix=run-outputs%2Frun-1%2F'),
    );
    // The displayed link text keeps the original URI (no trailing slash added).
    expect(outputLink).toHaveTextContent('s3://demo-bucket/run-outputs/run-1');

    // Parameters rendered (an S3 input becomes a link, a flag becomes text).
    const params = screen.getByTestId('run-parameters');
    expect(params).toHaveTextContent('input');
    expect(params).toHaveTextContent('validate_params');
    expect(params).toHaveTextContent('false');
    // An S3 file *parameter* is an object, not a prefix — its console link must
    // NOT get a trailing slash appended (it points at the object key).
    const inputLink = screen.getByRole('link', {
      name: /s3:\/\/demo-bucket\/samplesheet\.csv/i,
    });
    expect(inputLink).toHaveAttribute(
      'href',
      expect.stringContaining('prefix=samplesheet.csv'),
    );
    expect(inputLink).not.toHaveAttribute(
      'href',
      expect.stringContaining('samplesheet.csv%2F'),
    );
  });

  it('renders the run configuration (role, storage, cache, networking, log level) when present (#reproducibility)', async () => {
    const run = makeRun({
      status: 'COMPLETED',
      roleArn: 'arn:aws:iam::123456789012:role/service-role/OmicsWorkflow-x',
      storageType: 'STATIC',
      storageCapacity: 1200,
      cacheId: 'cache-123',
      cacheBehavior: 'CACHE_ON_FAILURE',
      networkingMode: 'VPC',
      configurationName: 'nf-core-wf-vpc',
      logLevel: 'ALL',
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'COMPLETED' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByLabelText('progress');
    fireEvent.click(screen.getByRole('button', { name: /inputs & outputs/i }));

    const cfg = await screen.findByTestId('run-configuration');
    expect(cfg).toHaveTextContent('IAM role');
    expect(cfg).toHaveTextContent(
      'arn:aws:iam::123456789012:role/service-role/OmicsWorkflow-x',
    );
    // Storage capacity is appended for STATIC storage.
    expect(cfg).toHaveTextContent('STATIC (1200 GiB)');
    // Cache id with its behavior.
    expect(cfg).toHaveTextContent('cache-123 (CACHE_ON_FAILURE)');
    // Networking mode with the VPC configuration name.
    expect(cfg).toHaveTextContent('VPC — nf-core-wf-vpc');
    expect(cfg).toHaveTextContent('ALL');
  });

  it('omits run-configuration rows that are absent (never fabricated)', async () => {
    // Only a role and log level present; storage/cache/networking absent.
    const run = makeRun({
      status: 'COMPLETED',
      roleArn: 'arn:aws:iam::123456789012:role/r',
      logLevel: 'OFF',
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'COMPLETED' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByLabelText('progress');
    fireEvent.click(screen.getByRole('button', { name: /inputs & outputs/i }));

    const cfg = await screen.findByTestId('run-configuration');
    expect(cfg).toHaveTextContent('IAM role');
    expect(cfg).toHaveTextContent('Log level');
    // Absent settings are not shown at all.
    expect(cfg).not.toHaveTextContent('Storage');
    expect(cfg).not.toHaveTextContent('Run cache');
    expect(cfg).not.toHaveTextContent('Networking');
  });

  it('renders the run tags (cost-allocation) as a key/value table when present', async () => {
    // tags arrive as an AWSJSON string (string->string map).
    const run = makeRun({
      status: 'RUNNING',
      tags: JSON.stringify({
        WorkflowName: 'nf-core-fetchngs',
        SampleID: 'SAMPLE-123',
      }),
    });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'RUNNING' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    await screen.findByLabelText('progress');
    fireEvent.click(screen.getByRole('button', { name: /inputs & outputs/i }));

    const tags = await screen.findByTestId('run-tags');
    expect(tags).toHaveTextContent('WorkflowName');
    expect(tags).toHaveTextContent('nf-core-fetchngs');
    expect(tags).toHaveTextContent('SampleID');
    expect(tags).toHaveTextContent('SAMPLE-123');
  });

  it('does not render a tags table when the run has no tags', async () => {
    const run = makeRun({ status: 'RUNNING', engineVersion: '25.10.0' });
    render(
      <RunDetailView
        runId="run-1"
        getRun={vi.fn().mockResolvedValue(run)}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'RUNNING' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );
    await screen.findByLabelText('progress');
    fireEvent.click(screen.getByRole('button', { name: /inputs & outputs/i }));
    await screen.findByTestId('engine-version');
    expect(screen.queryByTestId('run-tags')).not.toBeInTheDocument();
  });

  // A fixed instant so still-running durations are deterministic across the
  // analytics panels (durations, resource summary, ranking, segments).
  const NOW = Date.parse('2024-01-01T02:00:00.000Z');

  it('shows "unavailable" in the resource card when tasks lack cpus (Req 2.5)', async () => {
    // Two started+stopped tasks with NO `cpus` field: the peak-concurrent-vCPUs
    // metric has no input on any started task, so it must render the explicit
    // "unavailable" affordance rather than a fabricated 0.
    render(
      <RunDetailView
        runId="run-1"
        now={NOW}
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'COMPLETED' }))}
        listTasksForRun={vi.fn().mockResolvedValue([
          makeTask({
            status: 'COMPLETED',
            startedAt: '2024-01-01T00:00:00.000Z',
            stoppedAt: '2024-01-01T00:30:00.000Z',
          }),
          makeTask({
            status: 'COMPLETED',
            startedAt: '2024-01-01T00:10:00.000Z',
            stoppedAt: '2024-01-01T00:20:00.000Z',
          }),
        ])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    // Resource summary card is present and the vCPU metric is unavailable.
    await screen.findByTestId('resource-summary');
    expect(
      screen.getByTestId('metric-peak-cpus-unavailable'),
    ).toBeInTheDocument();
    // The unavailable affordance is compact ("n/a") but explicitly labeled
    // "unavailable" for accessibility (Req 2.5 — explicit, not a fabricated 0).
    expect(
      screen.getByTestId('metric-peak-cpus-unavailable'),
    ).toHaveAttribute('aria-label', 'unavailable');
    // No fabricated peak-cpus value is shown.
    expect(screen.queryByTestId('metric-peak-cpus')).not.toBeInTheDocument();
  });

  it('highlights the slowest task on the DAG and flags it in the longest-tasks list (Req 3.6)', async () => {
    // Three completed tasks with distinct, non-overlapping durations so the
    // slowest is deterministic: `slow` runs 60 min, the others 10 and 20 min.
    render(
      <RunDetailView
        runId="run-1"
        now={NOW}
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'COMPLETED' }))}
        listTasksForRun={vi.fn().mockResolvedValue([
          makeTask({
            taskId: 'fast',
            name: 'fast',
            status: 'COMPLETED',
            startedAt: '2024-01-01T00:00:00.000Z',
            stoppedAt: '2024-01-01T00:10:00.000Z',
          }),
          makeTask({
            taskId: 'slow',
            name: 'slow',
            status: 'COMPLETED',
            startedAt: '2024-01-01T00:00:00.000Z',
            stoppedAt: '2024-01-01T01:00:00.000Z',
          }),
          makeTask({
            taskId: 'medium',
            name: 'medium',
            status: 'COMPLETED',
            startedAt: '2024-01-01T00:00:00.000Z',
            stoppedAt: '2024-01-01T00:20:00.000Z',
          }),
        ])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    // Inferred_DAG nodes are keyed by taskId; the slowest node is highlighted.
    await screen.findByTestId('node-slow');
    expect(screen.getByTestId('node-slow')).toHaveAttribute(
      'data-highlighted',
      'true',
    );
    // The other nodes are not highlighted.
    expect(screen.getByTestId('node-fast')).toHaveAttribute(
      'data-highlighted',
      'false',
    );
    expect(screen.getByTestId('node-medium')).toHaveAttribute(
      'data-highlighted',
      'false',
    );

    // The longest-tasks list flags the slowest task with a "slowest" badge.
    const longest = screen.getByTestId('longest-tasks');
    expect(longest).toBeInTheDocument();
    expect(screen.getByTestId('longest-tasks-slowest')).toHaveTextContent(
      /slowest/i,
    );

    // The legend surfaces the slowest-task highlight (its ringed swatch) so the
    // DAG highlight is explained. Shown only because a slowest task exists.
    const legend = screen.getByTestId('task-status-legend');
    const slowestLegend = screen.getByTestId('legend-slowest');
    expect(slowestLegend).toHaveTextContent(/slowest task/i);
    expect(legend).toContainElement(slowestLegend);
  });

  it('renders queue-wait under the unconfirmed caveat (Req 12.3)', async () => {
    // A task with a `createdAt` before `startedAt` produces a queue-wait
    // segment; the panel surfaces the unconfirmed-createdAt caveat.
    render(
      <RunDetailView
        runId="run-1"
        now={NOW}
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'COMPLETED' }))}
        listTasksForRun={vi.fn().mockResolvedValue([
          makeTask({
            status: 'COMPLETED',
            createdAt: '2024-01-01T00:00:00.000Z',
            startedAt: '2024-01-01T00:05:00.000Z',
            stoppedAt: '2024-01-01T00:20:00.000Z',
          }),
        ])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    // The task-segments panel and its queue-wait caveat are present.
    await screen.findByTestId('task-segments');
    const caveat = screen.getByTestId('queue-wait-caveat');
    expect(caveat).toBeInTheDocument();
    expect(caveat).toHaveTextContent(/unconfirmed/i);
    // Queue-wait is rendered (5 minutes: 00:05:00) alongside the caveat.
    expect(screen.getByTestId('segment-queue-wait')).toHaveTextContent(
      '00:05:00',
    );
    // Run-time is rendered too (15 minutes), without depending on the caveat.
    expect(screen.getByTestId('segment-run-time')).toHaveTextContent(
      '00:15:00',
    );
  });

  it('shows Unknown_State on the engine badge when engineVersion is absent (Req 7.2)', async () => {
    // A run with no `engineVersion` must show the Unknown_State affordance
    // rather than a fabricated version.
    render(
      <RunDetailView
        runId="run-1"
        now={NOW}
        getRun={vi.fn().mockResolvedValue(makeRun({ engineVersion: undefined }))}
        listTasksForRun={vi
          .fn()
          .mockResolvedValue([makeTask({ status: 'RUNNING' })])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    const badge = await screen.findByTestId('engine-version-badge');
    expect(badge).toHaveTextContent(/unknown/i);
    // No fabricated "Engine <version>" is shown.
    expect(badge).not.toHaveTextContent(/Engine \d/);
  });

  it('searches nodes by name: emphasizes matches, dims the rest, shows a count', async () => {
    render(
      <RunDetailView
        runId="run-1"
        now={NOW}
        getRun={vi.fn().mockResolvedValue(makeRun({ status: 'COMPLETED' }))}
        listTasksForRun={vi.fn().mockResolvedValue([
          makeTask({
            taskId: 'align',
            name: 'align_reads',
            status: 'COMPLETED',
            startedAt: '2024-01-01T00:00:00.000Z',
            stoppedAt: '2024-01-01T00:10:00.000Z',
          }),
          makeTask({
            taskId: 'call',
            name: 'call_variants',
            status: 'COMPLETED',
            startedAt: '2024-01-01T00:00:00.000Z',
            stoppedAt: '2024-01-01T00:20:00.000Z',
          }),
        ])}
        onTaskUpdated={noopSubscribe()}
      />,
    );

    // Search box is present; before typing, no node is dimmed or matched.
    const input = await screen.findByTestId('node-search-input');
    expect(screen.getByTestId('node-align')).toHaveAttribute('data-dimmed', 'false');
    expect(screen.queryByTestId('node-search-count')).not.toBeInTheDocument();

    // Type a query that matches only the "align_reads" node.
    fireEvent.change(input.querySelector('input')!, {
      target: { value: 'align' },
    });

    // Match count badge shows 1 match.
    expect(screen.getByTestId('node-search-count')).toHaveTextContent('1 match');

    // The matching node is emphasized and not dimmed; the other is dimmed.
    expect(screen.getByTestId('node-align')).toHaveAttribute(
      'data-search-match',
      'true',
    );
    expect(screen.getByTestId('node-align')).toHaveAttribute('data-dimmed', 'false');
    expect(screen.getByTestId('node-call')).toHaveAttribute(
      'data-search-match',
      'false',
    );
    expect(screen.getByTestId('node-call')).toHaveAttribute('data-dimmed', 'true');

    // Clearing the query restores the normal (undimmed) view.
    fireEvent.change(input.querySelector('input')!, { target: { value: '' } });
    expect(screen.getByTestId('node-align')).toHaveAttribute('data-dimmed', 'false');
    expect(screen.getByTestId('node-call')).toHaveAttribute('data-dimmed', 'false');
    expect(screen.queryByTestId('node-search-count')).not.toBeInTheDocument();
  });

  it('resolves a stale TASK selection (taskId no longer in the list) to the run-level context rather than erroring (Req 4.7)', async () => {
    vi.useFakeTimers();
    try {
      // Capture the subscription's error handler so we can force a drop; the
      // reconnecting manager then refetches the task list on reconnect.
      let onError: ((error: unknown) => void) | undefined;
      const subscribe = (
        _runId: string,
        handlers: SubscriptionHandlers<Task>,
      ): Subscription => {
        onError = handlers.error;
        return { unsubscribe: () => {} };
      };

      const kept = makeTask({ taskId: 'kept', name: 'kept-task', status: 'FAILED' });
      const gone = makeTask({ taskId: 'gone', name: 'gone-task', status: 'RUNNING' });
      // First load returns both tasks; the reconnect refetch drops 'gone'.
      const listTasksForRun = vi
        .fn()
        .mockResolvedValueOnce([kept, gone])
        .mockResolvedValue([kept]);

      render(
        <RunDetailView
          runId="run-1"
          getRun={vi.fn().mockResolvedValue(makeRun({ status: 'FAILED' }))}
          listTasksForRun={listTasksForRun}
          onTaskUpdated={subscribe}
        />,
      );

      // Select the task that will later disappear.
      const node = await vi.waitFor(() => screen.getByTestId('node-gone'));
      fireEvent.click(node);
      await vi.waitFor(() =>
        expect(screen.getByText(/logs — task gone-task/i)).toBeInTheDocument(),
      );

      // Force a subscription drop, then advance past the backoff so the manager
      // reconnects and refetches — the second listTasksForRun omits 'gone'.
      act(() => {
        onError?.(new Error('dropped'));
      });
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      // The now-stale TASK selection resolves to the run-level context: the
      // task detail is gone and the derived resource summary is shown instead —
      // no error, no empty task-detail panel (Req 4.7).
      await vi.waitFor(() =>
        expect(screen.queryByText(/logs — task gone-task/i)).not.toBeInTheDocument(),
      );
      expect(screen.getByTestId('resource-summary')).toBeInTheDocument();
      expect(screen.getByTestId('failed-tasks-list')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Fly-out via the Dashboard shell's SplitPanel slot ────────────────────
  // The above tests render `RunDetailView` WITHOUT the `Dashboard` provider, so
  // the fly-out degrades to its inline-fallback `detail-panel` region. These
  // tests render it INSIDE a `SplitPanelSlotContext.Provider` with a spy slot to
  // exercise the real fly-out path: the view supplies a SplitPanel node and
  // drives its open state through the slot, and closing it clears the selection.

  /**
   * A spy implementation of the shell's split-panel slot that records the last
   * node/open state the view registered and captures the toggle handler so a
   * test can fire the shell's "close" like the native SplitPanel would.
   */
  function makeSpySlot(): {
    slot: SplitPanelSlot;
    get: () => {
      node: React.ReactNode;
      open: boolean;
      onToggle: ((open: boolean) => void) | undefined;
    };
  } {
    const state: {
      node: React.ReactNode;
      open: boolean;
      onToggle: ((open: boolean) => void) | undefined;
    } = { node: null, open: false, onToggle: undefined };
    const slot: SplitPanelSlot = {
      setSplitPanel: (node) => {
        state.node = node;
      },
      setOpen: (open) => {
        state.open = open;
      },
      setOnToggle: (handler) => {
        state.onToggle = handler;
      },
    };
    return { slot, get: () => ({ ...state }) };
  }

  it('supplies the fly-out through the shell slot: closed when null, open on a TASK selection (Req 2.1, 2.2)', async () => {
    const { slot, get } = makeSpySlot();
    const task = makeTask({ taskId: 'task-live', name: 'align', status: 'RUNNING' });
    render(
      <SplitPanelSlotContext.Provider value={slot}>
        <RunDetailView
          runId="run-1"
          getRun={vi.fn().mockResolvedValue(makeRun())}
          listTasksForRun={vi.fn().mockResolvedValue([task])}
          onTaskUpdated={noopSubscribe()}
        />
      </SplitPanelSlotContext.Provider>,
    );

    // With the shell slot present, the inline fallback is NOT used: the detail
    // renders through the slot's SplitPanel node instead.
    const node = await screen.findByTestId('node-task-live');
    expect(screen.queryByTestId('detail-panel')).not.toBeInTheDocument();
    // Null selection ⇒ the fly-out is closed (Req 2.1).
    expect(get().open).toBe(false);

    // Selecting a node opens the fly-out on that task (Req 2.2): the slot is
    // driven open and given a SplitPanel node.
    fireEvent.click(node);
    await waitFor(() => expect(get().open).toBe(true));
    expect(get().node).not.toBeNull();
  });

  it('closes the fly-out and clears the selection when the shell toggles it shut (Req 2.4)', async () => {
    const { slot, get } = makeSpySlot();
    const tasks = [
      makeTask({ taskId: 'a', name: 'align', status: 'COMPLETED' }),
      makeTask({ taskId: 'b', name: 'call', status: 'COMPLETED' }),
    ];
    render(
      <SplitPanelSlotContext.Provider value={slot}>
        <RunDetailView
          runId="run-1"
          getRun={vi.fn().mockResolvedValue(makeRun({ status: 'COMPLETED' }))}
          listTasksForRun={vi.fn().mockResolvedValue(tasks)}
          onTaskUpdated={noopSubscribe()}
        />
      </SplitPanelSlotContext.Provider>,
    );

    // Select node 'a' — the fly-out opens and rings the node.
    const nodeA = await screen.findByTestId('node-a');
    fireEvent.click(nodeA);
    await waitFor(() => expect(get().open).toBe(true));
    expect(screen.getByTestId('node-a')).toHaveAttribute('data-selected', 'true');

    // Fire the shell's toggle like the native SplitPanel close would (open =
    // false). It clears the selection to null (Req 2.4): the fly-out closes and
    // the selection ring is dropped.
    act(() => {
      get().onToggle?.(false);
    });
    await waitFor(() =>
      expect(screen.getByTestId('node-a')).toHaveAttribute(
        'data-selected',
        'false',
      ),
    );
    await waitFor(() => expect(get().open).toBe(false));
  });

  it('deep links open the fly-out through the shell slot: failed-task "view logs" (TASK) and failure banner "view engine logs" (RUN_ENGINE) (Req 5.1, 5.2)', async () => {
    const { slot, get } = makeSpySlot();
    const run = makeRun({
      status: 'FAILED',
      statusMessage: 'Workflow run failed. Review the CloudWatch logs...',
      failureReason: 'WORKFLOW_RUN_FAILED',
    });
    const tasks = [
      makeTask({
        taskId: 'sra-1',
        name: 'SRA_IDS_TO_RUNINFO',
        status: 'FAILED',
        statusMessage: 'Run failed due to task: ... failure.',
        failureReason: 'RUN_TASK_FAILED',
      }),
    ];
    render(
      <SplitPanelSlotContext.Provider value={slot}>
        <RunDetailView
          runId="run-1"
          getRun={vi.fn().mockResolvedValue(run)}
          listTasksForRun={vi.fn().mockResolvedValue(tasks)}
          onTaskUpdated={noopSubscribe()}
        />
      </SplitPanelSlotContext.Provider>,
    );

    // No inline fallback with the shell present; the fly-out starts closed.
    const failedList = await screen.findByTestId('failed-tasks-list');
    expect(screen.queryByTestId('detail-panel')).not.toBeInTheDocument();
    expect(get().open).toBe(false);

    // The failed-tasks "view logs" deep link opens the fly-out (Req 5.1).
    fireEvent.click(within(failedList).getByTestId('failed-task-view-logs'));
    await waitFor(() => expect(get().open).toBe(true));

    // The failure banner "view engine logs" deep link keeps the fly-out open on
    // the run/engine detail (Req 5.2).
    fireEvent.click(screen.getByTestId('run-failure-view-logs'));
    await waitFor(() => expect(get().open).toBe(true));
    expect(get().node).not.toBeNull();
  });
});
