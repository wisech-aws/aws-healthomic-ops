/**
 * Selection-driven detail panel for the Run Detail master-detail layout
 * (design §Components and Interfaces; Req 4.3–4.6, 8.4).
 *
 * This is a PRESENTATIONAL component extracted out of {@link RunDetailView} so
 * the detail region has a single, testable contract. It renders exactly one of
 * three things, driven purely by the current `selection`:
 *
 *  - `selection.kind === 'TASK'` → the selected task's detail, in order: its
 *    resource detail ({@link TaskResourceDetail}, including start/end/duration
 *    and the "Resource type unavailable" affordance when the task has no
 *    instance type, Req 4.4), a best-effort task failure banner
 *    ({@link TaskLogsFailureBanner}), the task's own log tail
 *    ({@link LogsPanel} stream=TASK) (Req 4.3), and finally its measured
 *    utilization ({@link UtilizationBars}) collapsed by default inside an
 *    `ExpandableSection` so the log tail stays reachable.
 *  - `selection.kind === 'RUN_ENGINE'` → the run + engine logs tabs (Req 4.5).
 *  - `selection === null` → renders nothing (the default run-level context
 *    stays in `RunDetailView` in this stage; see design §Staging).
 *
 * The panel is PURE w.r.t. data: it receives the already-selected `task` and
 * callbacks and does not fetch run-wide metrics itself. `getErrorExcerpt` is
 * injectable (defaults to the real client); a rejection is caught and treated
 * as "no excerpt available" — never fabricated, never fatal to the panel
 * (Req 8.4). This behavior is unchanged from the pre-extraction inline code.
 */
import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Tabs from '@cloudscape-design/components/tabs';
import { getErrorExcerpt as defaultGetErrorExcerpt } from '../api/client';
import { formatStartTime, isRunning, taskDuration } from '../fleet/duration';
import type { ErrorExcerpt, Task } from '../api/types';
import type { TaskMetrics } from '../metrics/joinMetricsToTasks';
import ErrorBoundary from '../components/ErrorBoundary';
import LogsPanel from './LogsPanel';
import UtilizationBars from './UtilizationBars';

/** The stream a best-effort error excerpt is fetched from (Option B). */
type ErrorExcerptStream = 'RUN' | 'ENGINE' | 'TASK';

/** Injectable error-excerpt fetcher (defaults to the real client). */
type GetErrorExcerpt = (variables: {
  runId: string;
  stream: ErrorExcerptStream;
  taskId?: string;
}) => Promise<ErrorExcerpt>;

/** The selection value driving the detail panel (owned by `RunDetailView`). */
export type DetailSelection =
  | { kind: 'TASK'; taskId: string; label?: string }
  | { kind: 'RUN_ENGINE' }
  | null;

/**
 * Renders an extracted error excerpt (Option B) as a small monospace block,
 * with a "partial excerpt" note when the source was truncated. Callers must
 * only render this when `excerpt.found` is true.
 */
function ErrorExcerptBlock({
  excerpt,
  testIdPrefix,
}: {
  excerpt: ErrorExcerpt;
  testIdPrefix: string;
}): React.JSX.Element {
  return (
    <div data-testid={`${testIdPrefix}-error-excerpt`}>
      <Box variant="small" color="text-status-inactive">
        Extracted from the log stream:
      </Box>
      <pre
        style={{
          margin: '4px 0 0 0',
          maxHeight: 220,
          overflow: 'auto',
          background: '#0f1b2d',
          color: '#e6edf3',
          padding: '8px 10px',
          borderRadius: '6px',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '12px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {excerpt.lines.join('\n')}
      </pre>
      {excerpt.truncated && (
        <Box variant="small" color="text-status-inactive">
          (partial excerpt — see full logs for more)
        </Box>
      )}
    </div>
  );
}

/**
 * Task status-detail banner shown above a selected task's logs: the task's
 * own `statusMessage`/`failureReason` (when HealthOmics captured one), plus a
 * best-effort extracted error excerpt (Option B) fetched from that task's own
 * log stream. Renders nothing when the task has no `statusMessage` at all
 * (never fabricated); the excerpt fetch is independent and its
 * absence/failure never blocks the banner or the logs panel below it.
 */
function TaskLogsFailureBanner({
  runId,
  task,
  getErrorExcerpt,
}: {
  runId: string;
  task: Task | null;
  getErrorExcerpt: GetErrorExcerpt;
}): React.JSX.Element | null {
  const [excerpt, setExcerpt] = useState<ErrorExcerpt | null>(null);
  // Whether the task-level error-excerpt fetch is in flight, so the banner can
  // show a small progress indicator while it reads the task's log stream.
  const [excerptLoading, setExcerptLoading] = useState(false);

  useEffect(() => {
    setExcerpt(null);
    if (task?.statusMessage == null) {
      return;
    }
    let cancelled = false;
    setExcerptLoading(true);
    getErrorExcerpt({ runId, stream: 'TASK', taskId: task.taskId })
      .then((result) => {
        if (!cancelled) {
          setExcerpt(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExcerpt(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setExcerptLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId, task?.taskId, task?.statusMessage, getErrorExcerpt]);

  if (task?.statusMessage == null) {
    return null;
  }

  return (
    <Alert
      type={task.status === 'FAILED' ? 'error' : 'warning'}
      header="Task status detail"
      data-testid="task-logs-failure-banner"
    >
      <SpaceBetween size="xxs">
        <span data-testid="task-logs-failure-message">{task.statusMessage}</span>
        {task.failureReason != null && (
          <Box variant="small" color="text-status-inactive">
            Reason code:{' '}
            <span data-testid="task-logs-failure-reason">{task.failureReason}</span>
          </Box>
        )}
        {excerptLoading ? (
          <Box
            variant="small"
            color="text-status-inactive"
            data-testid="task-error-excerpt-loading"
          >
            <Spinner size="normal" /> Extracting error details from the log
            stream…
          </Box>
        ) : (
          excerpt?.found && <ErrorExcerptBlock excerpt={excerpt} testIdPrefix="task" />
        )}
      </SpaceBetween>
    </Alert>
  );
}

/**
 * Compact resource-detail strip for the selected task, shown in the task logs
 * header/detail alongside its logs (Req 8.1, 8.2). Surfaces the task's captured
 * `cpus`, `memory`, and `instanceType` (the resource/instance type). Each field
 * is shown only from a real captured value; when a field is absent it renders an
 * explicit unavailable affordance ("—") rather than a fabricated value, and the
 * instance type in particular gets a labeled "Resource type unavailable"
 * affordance so the absence is unmistakable — never a zero or blank.
 *
 * Alongside the resource fields it surfaces the task's Start time, End time,
 * and Duration (Req 8.1). These are HONEST: an absent `startedAt` yields the
 * helper's dash placeholder rather than a fabricated time, a still-running task
 * shows an explicit "In progress" affordance for its end time (never an
 * invented stop time), and its duration is elapsed-so-far measured against the
 * injected `now`.
 */
function TaskResourceDetail({
  task,
  now,
}: {
  task: Task | null;
  now: number;
}): React.JSX.Element | null {
  if (task == null) {
    return null;
  }
  const hasInstanceType =
    task.instanceType != null && task.instanceType !== '';
  const running = isRunning(task.startedAt, task.stoppedAt);
  return (
    <div data-testid="task-resource-detail">
      <ColumnLayout columns={3} variant="text-grid">
        <div>
          <Box variant="awsui-key-label">vCPUs</Box>
          <span data-testid="task-resource-cpus">{task.cpus ?? '—'}</span>
        </div>
        <div>
          <Box variant="awsui-key-label">Memory (GiB)</Box>
          <span data-testid="task-resource-memory">{task.memory ?? '—'}</span>
        </div>
        <div>
          <Box variant="awsui-key-label">Resource type</Box>
          {hasInstanceType ? (
            <span data-testid="task-resource-instance-type">
              {task.instanceType}
            </span>
          ) : (
            <span
              data-testid="task-resource-instance-type-unavailable"
              aria-label="Resource type unavailable"
            >
              — <Box variant="small" color="text-status-inactive" display="inline">
                Resource type unavailable
              </Box>
            </span>
          )}
        </div>
        <div>
          <Box variant="awsui-key-label">Start time</Box>
          <span data-testid="task-detail-start-time">
            {formatStartTime(task.startedAt)}
          </span>
        </div>
        <div>
          <Box variant="awsui-key-label">End time</Box>
          <span data-testid="task-detail-end-time">
            {task.stoppedAt != null ? (
              formatStartTime(task.stoppedAt)
            ) : running ? (
              <Box variant="small" color="text-status-inactive" display="inline">
                In progress
              </Box>
            ) : (
              '—'
            )}
          </span>
        </div>
        <div>
          <Box variant="awsui-key-label">Duration</Box>
          <span data-testid="task-detail-duration">
            {taskDuration(task, now)}
            {running && (
              <Box variant="small" color="text-status-inactive" display="inline">
                {' '}
                (elapsed)
              </Box>
            )}
          </span>
        </div>
      </ColumnLayout>
    </div>
  );
}

/** Props for {@link TaskDetailPanel}. */
export interface TaskDetailPanelProps {
  /** The run whose task/logs are being shown. */
  readonly runId: string;
  /**
   * The selected task (already resolved from the selection by the parent), or
   * `null` when there is no matching task. When `selection.kind === 'TASK'`
   * but `task` is `null` (a stale selection whose `taskId` is no longer in the
   * task list), the resource detail / failure banner simply render nothing and
   * the log tail still opens for the selected `taskId`.
   */
  readonly task: Task | null;
  /** The current selection driving what the panel renders. */
  readonly selection: DetailSelection;
  /**
   * Whether the RUN itself failed. Drives OPT-IN tail (newest-first fetch) for
   * the RUN and ENGINE log tabs, so a failed run's error — at the end of a
   * possibly huge stream — is reached immediately. The TASK stream instead
   * tails from the selected task's own FAILED/CANCELLED status. Defaults to
   * `false` (successful runs keep the unchanged oldest-first retrieval).
   */
  readonly runFailed?: boolean;
  /**
   * The selected task's measured metric slice, joined upstream by
   * `RunDetailView` via `joinMetricsToTasks(...).matched`, or `null` when the
   * task has no matching series. Rendered as that task's compact
   * {@link UtilizationBars} above the log tail; `null`/no-pairs renders the
   * explicit "utilization unavailable for this task" state — never a fabricated
   * bar. Only meaningful for a `{ kind: 'TASK' }` selection.
   */
  readonly taskMetrics?: TaskMetrics | null;
  /** Which run/engine logs tab is active (only used for a RUN_ENGINE selection). */
  readonly runLogsTabId?: 'run' | 'engine';
  /** Called when the active run/engine logs tab changes. */
  readonly onRunLogsTabChange?: (tabId: 'run' | 'engine') => void;
  /**
   * Fetches a best-effort error excerpt (Option B) from a task's CloudWatch log
   * stream. Injectable for tests; defaults to the real client. A rejection is
   * caught and treated as "no excerpt available" — never fatal (Req 8.4).
   */
  readonly getErrorExcerpt?: GetErrorExcerpt;
  /**
   * The current instant in epoch milliseconds, injected so the selected task's
   * running-duration is deterministic and testable. Defaults to `Date.now()`
   * at render time.
   */
  readonly now?: number;
  /** Invoked when the operator closes the detail panel. */
  readonly onClose: () => void;
}

/**
 * Selection-driven detail panel (the "detail" of the master-detail layout).
 * See the module doc for the full contract. Renders nothing when `selection`
 * is `null`.
 */
export default function TaskDetailPanel({
  runId,
  task,
  selection,
  taskMetrics = null,
  runLogsTabId = 'run',
  onRunLogsTabChange,
  getErrorExcerpt = defaultGetErrorExcerpt,
  runFailed = false,
  now = Date.now(),
  onClose,
}: TaskDetailPanelProps): React.JSX.Element | null {
  if (selection == null) {
    return null;
  }

  const label =
    selection.kind === 'TASK' ? selection.label ?? selection.taskId : null;

  return (
    <Container
      header={
        <Header
          actions={
            <Button
              iconName="close"
              variant="icon"
              ariaLabel="Close logs"
              onClick={onClose}
            />
          }
        >
          {selection.kind === 'TASK'
            ? `Logs — task ${label}`
            : 'Logs — run & engine'}
        </Header>
      }
    >
      {/* Defense in depth: a render error anywhere in the detail body (driven by
          real, variable task/metric data) degrades to an inline Cloudscape error
          Alert instead of propagating to the app root and blanking the whole
          screen. The panel header/close affordance above stays usable. */}
      <ErrorBoundary title="Something went wrong displaying this panel.">
      {selection.kind === 'TASK' ? (
        <SpaceBetween size="s">
          {/* Selected task's resource detail: its captured cpus/memory, the
              resource (instance) type it ran on, and its start/end/duration,
              shown above the logs (Req 8.1). A task without an instanceType
              shows an explicit "Resource type unavailable" affordance rather
              than a fabricated value (Req 8.2). */}
          <TaskResourceDetail task={task} now={now} />
          {/* Task failure detail banner: shows this task's own
              statusMessage/failureReason (when HealthOmics captured one), plus a
              best-effort extracted error excerpt (Option B) from the task's own
              log stream, above the raw log tail — so the concise reason is
              visible before scrolling logs. Only for a task that actually has a
              message; never fabricated. */}
          <TaskLogsFailureBanner
            runId={runId}
            task={task}
            getErrorExcerpt={getErrorExcerpt}
          />
          {/* The raw log tail, now placed directly above the measured metrics
              so it stays reachable without scrolling past the utilization
              charts (order: resource detail → failure banner → log tail →
              collapsible metrics). */}
          <LogsPanel
            runId={runId}
            stream="TASK"
            taskId={selection.taskId}
            tail={task?.status === 'FAILED' || task?.status === 'CANCELLED'}
          />
          {/* The selected task's measured utilization, now BELOW the log tail
              and collapsed by default inside an ExpandableSection so it never
              pushes the tail out of view. When the task has no matching series
              `UtilizationBars` renders an explicit "utilization unavailable for
              this task" state instead of a fabricated zero bar.

              NOTE: this uses the DEFAULT ExpandableSection variant, NOT
              `variant="container"`. The container variant renders a nested
              Cloudscape `Container` (which registers with the analytics-funnel /
              sticky-container context); nesting that inside this panel's own
              `Container` while it is hosted in the shell's `SplitPanel` drove an
              unrecoverable layout/render loop that unhandled-crashed (white
              screened) the app in production. The default variant is still
              collapsible and collapsed-by-default (the three requested UX
              behaviors — logs above metrics, metrics collapsible + collapsed by
              default, and start/end/duration in the header — are all preserved),
              but renders no nested container, so the fragile composition is
              gone. The `data-testid` lives on a wrapping <div> rather than on
              the component. */}
          <div data-testid="task-utilization-section">
            <ExpandableSection
              headerText="Measured utilization"
              defaultExpanded={false}
            >
              <UtilizationBars taskMetrics={taskMetrics} />
            </ExpandableSection>
          </div>
        </SpaceBetween>
      ) : (
        <Tabs
          activeTabId={runLogsTabId}
          onChange={({ detail }) =>
            onRunLogsTabChange?.(detail.activeTabId as 'run' | 'engine')
          }
          tabs={[
            {
              id: 'run',
              label: 'Run',
              content: <LogsPanel runId={runId} stream="RUN" tail={runFailed === true} />,
            },
            {
              id: 'engine',
              label: 'Engine',
              content: (
                <LogsPanel runId={runId} stream="ENGINE" tail={runFailed === true} />
              ),
            },
          ]}
        />
      )}
      </ErrorBoundary>
    </Container>
  );
}
