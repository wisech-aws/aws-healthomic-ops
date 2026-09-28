/**
 * Regression test for the run-detail task fly-out white-screen (production).
 *
 * The existing `TaskDetailPanel.test.tsx` and `RunDetailView.test.tsx` render
 * the detail STANDALONE (inline-fallback path, no `AppLayout`/`SplitPanel`
 * host), which is exactly why they missed the crash: production renders the
 * task detail INSIDE a Cloudscape `SplitPanel` hosted by `AppLayout` (the shell
 * slot in `App.tsx`'s `Dashboard`). This test mounts the detail on that REAL
 * `AppLayout > SplitPanel > TaskDetailPanel(Container > SpaceBetween >
 * ExpandableSection > UtilizationBars)` path and asserts selecting a task
 * renders the detail WITHOUT throwing — for a completed task, a running task
 * (stoppedAt null), and a task with null cpus/memory/instanceType/startedAt,
 * since real task data varies.
 *
 * The metrics section uses the DEFAULT ExpandableSection variant (not
 * `variant="container"`): the container variant renders a nested Cloudscape
 * Container that participates in the sticky/analytics-funnel machinery, and
 * nesting it inside this panel's own Container while hosted in the shell's
 * SplitPanel drove an unrecoverable layout/render loop that white-screened the
 * app. This test guards that the fly-out composition stays crash-free while the
 * three requested UX behaviors are preserved: logs above metrics, metrics
 * collapsible + collapsed by default, and start/end/duration in the header.
 *
 * jsdom lacks `ResizeObserver`, which the real Cloudscape `AppLayout`/
 * `SplitPanel` use for layout measurement; it is polyfilled here so the host
 * behaves like a real browser instead of no-op'ing.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AppLayout from '@cloudscape-design/components/app-layout';
import SplitPanel from '@cloudscape-design/components/split-panel';
import TaskDetailPanel from './TaskDetailPanel';
import type { MetricSeries, Task } from '../api/types';
import type { TaskMetrics } from '../metrics/joinMetricsToTasks';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
  }
});

// LogsPanel reads the client's getRunLogs directly (not injected via the
// panel), so stub it to render the log tail without a network call.
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

const SPLIT_PANEL_I18N = {
  preferencesTitle: '',
  preferencesConfirm: '',
  preferencesCancel: '',
  closeButtonAriaLabel: 'close',
  openButtonAriaLabel: 'open',
  resizeHandleAriaLabel: 'resize',
  preferencesPositionLabel: '',
  preferencesPositionDescription: '',
  preferencesPositionBottom: '',
  preferencesPositionSide: '',
};

function makeTask(partial: Partial<Task> = {}): Task {
  return {
    runId: 'run-1',
    taskId: 't1',
    name: 'align',
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

function cpuUsageSeries(): MetricSeries {
  return {
    metricName: 'aws.omics.task.cpu.usage',
    family: 'CPU',
    role: 'usage',
    unit: '{cpu}',
    taskId: 't1',
    points: [
      { timestamp: 1704067200000, value: 1200 },
      { timestamp: 1704067260000, value: 1800 },
    ],
  };
}

/** Mount the task detail on the REAL AppLayout > SplitPanel production path. */
function renderFlyout(task: Task, taskMetrics: TaskMetrics | null) {
  return render(
    <AppLayout
      navigationHide
      toolsHide
      splitPanelOpen
      onSplitPanelToggle={() => {}}
      splitPanel={
        <SplitPanel header="Logs" i18nStrings={SPLIT_PANEL_I18N}>
          <TaskDetailPanel
            runId="run-1"
            task={task}
            selection={{ kind: 'TASK', taskId: 't1', label: 'align' }}
            taskMetrics={taskMetrics}
            now={Date.parse('2024-01-01T02:00:00.000Z')}
            onClose={() => {}}
          />
        </SplitPanel>
      }
      content={<div>dag</div>}
    />,
  );
}

describe('TaskDetailPanel on the real SplitPanel/AppLayout fly-out path (regression)', () => {
  it('renders the detail without throwing for a COMPLETED task', async () => {
    renderFlyout(
      makeTask({ status: 'COMPLETED', stoppedAt: '2024-01-01T01:00:00.000Z' }),
      { taskId: 't1', series: [cpuUsageSeries()] },
    );

    // The detail renders (no white-screen / thrown error).
    expect(await screen.findByText(/logs — task align/i)).toBeInTheDocument();
    // No error-boundary fallback: the panel body rendered cleanly.
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
    // The resource detail carries the start/end/duration header fields.
    expect(screen.getByTestId('task-detail-start-time')).toBeInTheDocument();
    expect(screen.getByTestId('task-detail-end-time')).toBeInTheDocument();
    expect(screen.getByTestId('task-detail-duration')).toHaveTextContent('01:00:00');

    // The "Measured utilization" section is collapsed by default (its toggle
    // reports aria-expanded="false"); expanding it reveals the bars.
    const toggle = screen.getByRole('button', { name: /measured utilization/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const logsOutput = await screen.findByTestId('logs-output');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const utilization = await screen.findByTestId('task-utilization');
    // Logs stay ABOVE the metrics in DOM order (log tail reachable without
    // scrolling past the charts).
    const position = logsOutput.compareDocumentPosition(utilization);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the detail without throwing for a RUNNING task (stoppedAt null)', async () => {
    renderFlyout(makeTask({ status: 'RUNNING', stoppedAt: null }), null);

    expect(await screen.findByText(/logs — task align/i)).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
    // Running task shows the honest "In progress" end-time affordance.
    expect(screen.getByTestId('task-detail-end-time')).toHaveTextContent(/in progress/i);

    fireEvent.click(screen.getByRole('button', { name: /measured utilization/i }));
    expect(
      await screen.findByTestId('task-utilization-unavailable'),
    ).toBeInTheDocument();
  });

  it('renders the detail without throwing for a task with null cpus/memory/instanceType/startedAt', async () => {
    renderFlyout(
      makeTask({
        status: 'PENDING',
        startedAt: null,
        stoppedAt: null,
        cpus: null,
        memory: null,
        instanceType: null,
      }),
      { taskId: 't1', series: [cpuUsageSeries()] },
    );

    expect(await screen.findByText(/logs — task align/i)).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
    // Absent fields render honest dashes / the unavailable affordance, never fabricated.
    expect(screen.getByTestId('task-resource-cpus')).toHaveTextContent('—');
    expect(screen.getByTestId('task-resource-memory')).toHaveTextContent('—');
    expect(
      screen.getByTestId('task-resource-instance-type-unavailable'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('task-detail-start-time')).toHaveTextContent('—');

    fireEvent.click(screen.getByRole('button', { name: /measured utilization/i }));
    expect(await screen.findByTestId('task-utilization')).toBeInTheDocument();
  });
});
