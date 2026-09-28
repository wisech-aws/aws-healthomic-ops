/**
 * Run detail view (Cloudscape) (Req 7.3, 7.5, 9.1–9.8).
 *
 * On open, queries `getRun` and `listTasksForRun` exactly once (Req 9.1, 10.4);
 * a failure/timeout shows an error state with a retry action (Req 9.2). It then
 * renders the run's tasks as a node-edge graph:
 *
 *  - Layer selection picks the highest-fidelity available layer (True_DAG when
 *    a static graph is available, else Inferred_DAG when timing exists, else
 *    Timeline_View) via {@link selectLayer}.
 *  - True_DAG and Inferred_DAG render through React Flow with automatic dagre
 *    layout (Req 9.3); Timeline_View renders the grouped-by-status list.
 *  - A visible layer indicator (a Cloudscape Badge) always shows which layer is
 *    displayed (Req 7.5), and an "inferred" label is shown for the Inferred_DAG
 *    (Req 7.3).
 *  - Each task node is colored by `TaskStatus` via {@link taskStatusColor}
 *    (Req 9.5).
 *  - A progress indicator shows completed/total tasks and elapsed time in
 *    HH:MM:SS via {@link computeProgress} (Req 9.6).
 *  - A run with zero tasks shows an empty state instead of an empty graph
 *    (Req 9.4).
 *
 * It subscribes to `onTaskUpdated(runId)` through the reconnecting subscription
 * manager and applies each task update into the task list in place, which
 * recomputes the affected node's color/status without a page reload
 * (Req 9.7, 9.8).
 *
 * STATIC GRAPH: on open the view fetches the run's `StaticGraph` once via
 * `getStaticGraph(run.workflowId, run.workflowVersionName ?? 'DEFAULT')`
 * alongside the run/tasks queries (Req 7.1). A fetch failure degrades to `null`
 * (fall back to the Inferred DAG) and never surfaces an error banner or blocks
 * the run/tasks load. When the fetched graph has ≥1 node a Static DAG is
 * AVAILABLE, but the Inferred (timing) DAG is shown by DEFAULT; a "Show static
 * DAG" toggle switches up to the Static DAG for the same tasks without
 * refetching (Req 8.3). When shown, the Static DAG is labeled by its fidelity
 * ("True dependency graph" for `exact`, "Static DAG (approximate)" otherwise,
 * Req 8.1, 8.2, 8.5).
 * An explicit `staticGraph` prop, when provided, overrides the fetch (kept for
 * backward compatibility with callers/tests that supply one out of band).
 *
 * MEASURED METRICS: once the run is known, the view also fetches measured
 * utilization via `getRunMetrics` (once per mount, with a manual Refresh) and
 * renders it through {@link RunMetricsPanel}, collapsed by default inside an
 * `ExpandableSection` below the task diagram (Req 5.1, 5.2). This augments,
 * never replaces, the derived `ResourceSummaryCard` above the diagram. It is
 * decoupled from the run/tasks load: it never blocks or fails the ready
 * state, and the panel itself is responsible for its own
 * loading/error/unavailable/ready presentation.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  type Node,
  type ReactFlowInstance,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './taskGraph.css';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Alert from '@cloudscape-design/components/alert';
import Spinner from '@cloudscape-design/components/spinner';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Link from '@cloudscape-design/components/link';
import Toggle from '@cloudscape-design/components/toggle';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import SplitPanel from '@cloudscape-design/components/split-panel';
import Popover from '@cloudscape-design/components/popover';
import Input from '@cloudscape-design/components/input';
import Table from '@cloudscape-design/components/table';
import {
  getErrorExcerpt as defaultGetErrorExcerpt,
  getRun as defaultGetRun,
  getRunCostEstimate as defaultGetRunCostEstimate,
  getRunMetrics as defaultGetRunMetrics,
  getStaticGraph as defaultGetStaticGraph,
  listTasksForRun as defaultListTasksForRun,
  onTaskUpdated as defaultOnTaskUpdated,
} from '../api/client';
import type { Subscription, SubscriptionHandlers } from '../api/client';
import type {
  ErrorExcerpt,
  MetricFamily,
  Run,
  RunCostEstimate,
  RunMetrics,
  Task,
  TaskStatus,
} from '../api/types';
import { createReconnectingSubscription } from '../api/subscriptionManager';
import { useSplitPanelSlot } from '../splitPanelSlot';
import { selectLayer } from '../taskview/selectLayer';
import { buildTrueDagOverlay } from '../taskview/trueDag';
import { buildInferredDagOrdering } from '../taskview/inferredDag';
import { buildTimelineView } from '../taskview/timeline';
import type { LayerKind, StaticGraph } from '../taskview/types';
import { statusIndicatorType } from '../fleet/statusIndicator';
import { taskStatusColor, SLOWEST_TASK_COLOR } from '../fleet/statusColors';
import TaskDetailPanel from './TaskDetailPanel';
import RunMetricsPanel from './RunMetricsPanel';
import RunCostPanel from './RunCostPanel';
import { computeProgress } from './progress';
import type { Progress } from './progress';
import { failedOrCancelledTasks } from './failedTasks';
import { parseRunParameters } from './parseRunParameters';
import {
  buildInferredDagFlow,
  buildInitializingFlow,
  buildTrueDagFlow,
} from './graphLayout';
import type { TaskNodeData } from './graphLayout';
import TaskNode from './TaskNode';
import { matchNodeIds } from './nodeSearch';
import { formatDuration, taskDuration } from '../fleet/duration';
import { summarizeResources } from '../metrics/resourceSummary';
import type { ResourceSummary } from '../metrics/resourceSummary';
import { joinMetricsToTasks } from '../metrics/joinMetricsToTasks';
import type { TaskMetrics } from '../metrics/joinMetricsToTasks';
import { slowestTaskId, topLongest } from '../metrics/taskRanking';
import type { RankedTask } from '../metrics/taskRanking';
import { segmentsForAll } from '../metrics/taskSegments';
import type { TaskSegments } from '../metrics/taskSegments';

/** Loading/error/ready phases of the initial queries (Req 10.1–10.3). */
type LoadPhase = 'loading' | 'error' | 'ready';

/** Human-readable label per layer for the layer indicator (Req 7.5). */
const LAYER_LABEL: Record<LayerKind, string> = {
  True_DAG: 'True DAG',
  Inferred_DAG: 'Inferred DAG',
  Timeline_View: 'Timeline',
};

/** Custom node type registry for the task DAG (stable module-level identity). */
const NODE_TYPES = { task: TaskNode } as const;

/**
 * The full set of resource-metric families the measured-usage panel requests
 * on open (Req 9.1, 9.3). Issued once per mount (never polled). Widened beyond
 * CPU/MEMORY so the storage (FILESYSTEM/SCRATCH/RUN_FILESYSTEM) and NETWORK
 * series are fetched too; `RunMetricsPanel` + `formatMetricValue` render them in
 * human-readable units and omit absent series without error (Req 9.2, 9.4).
 */
const ALL_METRIC_FAMILIES: readonly MetricFamily[] = [
  'CPU',
  'MEMORY',
  'FILESYSTEM',
  'SCRATCH',
  'RUN_FILESYSTEM',
  'NETWORK',
];

/**
 * Props for {@link RunDetailView}. The data functions are injectable so tests
 * (and a later real wiring) can supply stubs; they default to the real client.
 */
export interface RunDetailViewProps {
  /** The run to display. */
  readonly runId: string;
  /**
   * An explicit static graph for the run's workflow. Normally the view fetches
   * its own graph via {@link getStaticGraph} on open (Req 7.1); this prop lets
   * a caller/test supply one out of band, in which case it wins over the fetch.
   * When neither the prop nor a fetched graph yields ≥1 node, layer selection
   * falls back to Inferred_DAG / Timeline_View.
   */
  readonly staticGraph?: StaticGraph | null;
  /** Invoked when the operator chooses to return to the fleet list. */
  readonly onBack?: () => void;
  readonly getRun?: (runId: string) => Promise<Run | null>;
  readonly listTasksForRun?: (runId: string) => Promise<Task[]>;
  /**
   * Fetches the run's static graph for the workflow version. Injectable for
   * tests; defaults to the real client. A rejection/`null` degrades to the
   * Inferred DAG without surfacing an error (Req 7.1, 7.3, 8.4).
   */
  readonly getStaticGraph?: (
    workflowId: string,
    workflowVersionName: string,
  ) => Promise<StaticGraph | null>;
  readonly onTaskUpdated?: (
    runId: string,
    handlers: SubscriptionHandlers<Task>,
  ) => Subscription;
  /**
   * Fetches measured utilization metrics for the run. Injectable for tests;
   * defaults to the real client. A thrown rejection is caught and surfaced as
   * a typed-error `RunMetrics` result rather than left unhandled (Req 10.3).
   */
  readonly getRunMetrics?: (variables: {
    runId: string;
    startTime?: string;
    endTime?: string;
    stepSeconds?: number;
    families?: MetricFamily[];
  }) => Promise<RunMetrics>;
  /**
   * Fetches an estimated per-run cost breakdown for the run. Injectable for
   * tests; defaults to the real client. A thrown rejection is caught and
   * surfaced as a typed-error `RunCostEstimate` result rather than left
   * unhandled — mirroring {@link getRunMetrics}. This is a list-price
   * ESTIMATE, never the actual billed amount (Req 5.2).
   */
  readonly getRunCostEstimate?: (variables: {
    runId: string;
  }) => Promise<RunCostEstimate>;
  /**
   * Fetches a best-effort error excerpt from a run/task's CloudWatch log
   * stream (Option B). Injectable for tests; defaults to the real client. A
   * thrown rejection is caught and treated as "no excerpt available" rather
   * than left unhandled — never fabricated, never fatal to the view.
   */
  readonly getErrorExcerpt?: (variables: {
    runId: string;
    stream: 'RUN' | 'ENGINE' | 'TASK';
    taskId?: string;
  }) => Promise<ErrorExcerpt>;
  /**
   * The current instant in epoch milliseconds, injected so the analytics panels
   * (durations, resource summary, longest-tasks, segments) are deterministic and
   * testable for still-running items. Defaults to `Date.now()` at render time.
   */
  readonly now?: number;
}

/**
 * Scroll a deep-linked-to logs panel into view, if the element supports
 * `scrollIntoView` (absent in some test environments, e.g. jsdom). A no-op
 * when `el` is null or the method is unavailable — never throws.
 */
function scrollLogsPanelIntoView(el: HTMLDivElement | null): void {
  if (el != null && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

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
 * Zone 1 — the always-visible orientation strip (Req 1.1–1.3).
 *
 * A compact header zone rendered unconditionally at the top of the ready-state
 * body, above the master-detail working area and the analysis grid. It gives an
 * operator constant orientation regardless of the current selection or which
 * analysis sections are expanded:
 *
 *  - the run status badge (a Cloudscape `StatusIndicator`, mapped from the run
 *    status via {@link statusIndicatorType}; an absent status renders as
 *    "UNKNOWN" rather than a fabricated value),
 *  - the run name (falling back to the run id / prop id when unnamed),
 *  - the progress indicator (completed/total task counts and elapsed time
 *    formatted HH:MM:SS, from {@link computeProgress}), and
 *  - the layer indicator badge (passed in so the strip stays presentational and
 *    the layer-selection logic remains in {@link RunDetailView}).
 *
 * It is intentionally selection-independent: none of its content is gated on
 * `logsSelection` or any analysis-section expand/collapse state, so it renders
 * for every Selection value and every Analysis_Grid state (Req 1.2, 1.3). The
 * run failure banner (Req 2.x) is rendered by {@link RunDetailView} directly
 * below this strip so a failed run is never hidden by the current selection.
 */
function RunOrientationStrip({
  run,
  runId,
  progress,
  layerIndicator,
}: {
  run: Run | null;
  runId: string;
  progress: Progress;
  layerIndicator: React.ReactNode;
}): React.JSX.Element {
  const status = run?.status ?? null;
  const name = run?.name ?? run?.runId ?? runId;
  return (
    <div aria-label="orientation strip" data-testid="orientation-strip">
      <SpaceBetween size="xs">
        {/* Status + name + layer indicator on one compact row. */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '8px 16px',
            rowGap: '8px',
          }}
        >
          <span aria-label="run status" data-testid="run-status">
            <StatusIndicator type={statusIndicatorType(status)}>
              {status ?? 'UNKNOWN'}
            </StatusIndicator>
          </span>
          <Box variant="h2" data-testid="run-name" padding="n">
            {name}
          </Box>
          {layerIndicator}
        </div>

        {/* Run identifiers + progress (completed/total and elapsed HH:MM:SS,
            Req 1.1 / 9.6). Kept in the strip so orientation never scrolls
            away. */}
        <div aria-label="progress">
          <ColumnLayout columns={4} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">Run ID</Box>
              <span data-testid="run-id">{run?.runId ?? runId}</span>
            </div>
            <div>
              <Box variant="awsui-key-label">Workflow ID</Box>
              <span data-testid="workflow-id">{run?.workflowId ?? '—'}</span>
            </div>
            <div>
              <Box variant="awsui-key-label">Tasks completed</Box>
              <span data-testid="progress-count">
                {progress.completed} / {progress.total}
              </span>
            </div>
            <div>
              <Box variant="awsui-key-label">Elapsed</Box>
              <span data-testid="progress-elapsed">{progress.elapsed}</span>
            </div>
          </ColumnLayout>
        </div>
      </SpaceBetween>
    </div>
  );
}

/** Merge an updated task into the list by `taskId`, appending if new. */
function applyTaskUpdate(tasks: Task[], updated: Task): Task[] {
  let found = false;
  const next = tasks.map((task) => {
    if (task.taskId === updated.taskId) {
      found = true;
      return updated;
    }
    return task;
  });
  return found ? next : [...next, updated];
}

export default function RunDetailView({
  runId,
  staticGraph: staticGraphProp = null,
  onBack,
  getRun = defaultGetRun,
  listTasksForRun = defaultListTasksForRun,
  getStaticGraph = defaultGetStaticGraph,
  onTaskUpdated = defaultOnTaskUpdated,
  getRunMetrics = defaultGetRunMetrics,
  getRunCostEstimate = defaultGetRunCostEstimate,
  getErrorExcerpt = defaultGetErrorExcerpt,
  now,
}: RunDetailViewProps): React.JSX.Element {
  const [phase, setPhase] = useState<LoadPhase>('loading');
  const [run, setRun] = useState<Run | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // The static graph fetched on open (Req 7.1). A failed/absent fetch leaves
  // this `null`, which `selectLayer` treats as "fall back to Inferred DAG"
  // (Req 7.3, 8.4). An explicit `staticGraph` prop, when provided, overrides
  // this fetched value.
  const [fetchedGraph, setFetchedGraph] = useState<StaticGraph | null>(null);
  // Measured utilization metrics (Req 5.1, 5.2). Independent of `phase`: it
  // never blocks or degrades the run/tasks/static-graph ready state, and
  // `RunMetricsPanel` itself renders the loading/error/unavailable/ready
  // states from these two pieces of state.
  const [metricsResult, setMetricsResult] = useState<RunMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  // Estimated per-run cost breakdown (Req 5.2). Independent of `phase`, exactly
  // like the measured metrics above: it never blocks or degrades the
  // run/tasks/static-graph ready state, and `RunCostPanel` renders its own
  // loading/error/unavailable/ready states from these two pieces of state. A
  // list-price ESTIMATE, never the actual billed amount.
  const [costResult, setCostResult] = useState<RunCostEstimate | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  // Best-effort error excerpt for a FAILED run (Option B): fetched once the
  // run is known to have failed, independent of `phase` — a fetch
  // failure/absence just means no excerpt is shown, never an error banner of
  // its own (the run-failure banner above it already reports the failure).
  const [runErrorExcerpt, setRunErrorExcerpt] = useState<ErrorExcerpt | null>(null);
  // Whether the run-level error-excerpt fetch (`getErrorExcerpt`, ENGINE stream)
  // is currently in flight, so the failure banner can show a progress indicator
  // ("Extracting error details…") instead of silently showing nothing during
  // the brief backend read. Independent of the run/tasks load.
  const [runExcerptLoading, setRunExcerptLoading] = useState(false);
  // When on, the operator has chosen to view the Static DAG even though the
  // Inferred (timing) DAG is shown by default. A view-only override of the
  // default layer with no refetch (Req 8.3). Defaults to false, so the Inferred
  // timing DAG is the default view and the Static DAG is opt-in.
  const [showStatic, setShowStatic] = useState(false);
  // Logs panel selection: either a selected task node ({taskId, name}) or the
  // run/engine logs ('RUN_ENGINE'), or null when the panel is closed.
  const [logsSelection, setLogsSelection] = useState<
    { kind: 'TASK'; taskId: string; label: string } | { kind: 'RUN_ENGINE' } | null
  >(null);
  // Which run/engine logs tab is active. Lets a "View engine logs" deep link
  // (from the run-failure banner) open the panel directly on the Engine tab
  // instead of defaulting to Run.
  const [runLogsTabId, setRunLogsTabId] = useState<'run' | 'engine'>('run');
  // Scroll target for the logs panel so a deep-link action (from a failure
  // banner higher up the page) brings the opened panel into view instead of
  // leaving the operator to scroll down and find it themselves.
  const logsPanelRef = useRef<HTMLDivElement | null>(null);
  // Failed-task quick filter (Req 4.1, 4.2): when on, only FAILED/CANCELLED
  // tasks are shown in the graph/timeline. The count badge always reflects the
  // full failure count regardless of the toggle state.
  const [showFailedOnly, setShowFailedOnly] = useState(false);
  // DAG node search (case-insensitive substring on task name). Empty query =>
  // no active search (nothing dimmed). Matches are emphasized and the rest
  // dimmed; the view fits to the matches.
  //
  // PERF: this holds the DEBOUNCED query only. The immediate, per-keystroke
  // input value and its debounce live entirely inside {@link NodeSearchBox} so
  // typing re-renders just that small box — NOT this large view (which would
  // otherwise reconcile the whole ReactFlow graph, the analysis stack, and the
  // unmemoized toolbar/legend on every keystroke, causing the typing lag). The
  // box only pushes its settled value up here (~200ms after typing stops), so
  // this view re-renders once per settled query rather than once per keystroke.
  const [debouncedNodeSearchQuery, setDebouncedNodeSearchQuery] = useState('');
  // The live React Flow instance, captured on init so a search can fit the view
  // to the matching nodes.
  const flowInstanceRef = useRef<ReactFlowInstance | null>(null);

  // Guards the "query exactly once per mount" contract (Req 10.4) against React
  // StrictMode double-invocation of effects in development.
  const hasQueried = useRef(false);

  // Fetches measured utilization for the run (Req 5.1, 5.2, 7.4). Decoupled
  // from `phase`: it never blocks or fails the run/tasks/static-graph ready
  // state. `runForWindow`, when passed, supplies the run's own execution
  // window (the "frontend already holds it" fast path, design §"Run
  // window"); when omitted (e.g. the manual Refresh from `RunMetricsPanel`)
  // the current `run` state is used, and when neither is known, start/end
  // are omitted entirely so the Lambda's GetRun fallback kicks in. A thrown
  // rejection is caught and turned into a typed-error result rather than left
  // as stale/undefined state (Req 10.3).
  const loadMetrics = useCallback(
    async (runForWindow?: Run | null) => {
      const windowRun = runForWindow !== undefined ? runForWindow : run;
      setMetricsLoading(true);
      try {
        const result = await getRunMetrics({
          runId,
          startTime: windowRun?.startedAt ?? undefined,
          endTime: windowRun?.stoppedAt ?? undefined,
          // Request the full family set (Req 9.1, 9.3) so storage/network series
          // are fetched alongside CPU/MEMORY; issued once per mount, not polled.
          families: [...ALL_METRIC_FAMILIES],
        });
        setMetricsResult(result);
      } catch (error) {
        setMetricsResult({
          runId,
          window: null,
          series: [],
          error:
            error instanceof Error
              ? error.message
              : 'Measured utilization could not be loaded.',
        });
      } finally {
        setMetricsLoading(false);
      }
    },
    [getRunMetrics, runId, run],
  );

  // Fetches the estimated per-run cost breakdown (Req 5.2). Decoupled from
  // `phase` exactly like `loadMetrics`: it never blocks or fails the
  // run/tasks/static-graph ready state. A thrown rejection is caught and turned
  // into a typed-error `RunCostEstimate` result (never left unhandled, never a
  // fabricated cost). Re-issuable on demand via the panel's Refresh.
  const loadCost = useCallback(async () => {
    setCostLoading(true);
    try {
      const result = await getRunCostEstimate({ runId });
      setCostResult(result);
    } catch (error) {
      setCostResult({
        runId,
        lineItems: [],
        total: null,
        currency: null,
        effectiveDate: null,
        partial: false,
        error:
          error instanceof Error
            ? error.message
            : 'Estimated cost could not be loaded.',
      });
    } finally {
      setCostLoading(false);
    }
  }, [getRunCostEstimate, runId]);

  const load = useCallback(async () => {
    setPhase('loading');
    setErrorMessage(null);
    try {
      const [loadedRun, loadedTasks] = await Promise.all([
        getRun(runId),
        listTasksForRun(runId),
      ]);
      setRun(loadedRun);
      setTasks(loadedTasks);
      setPhase('ready');

      // Fetch the static graph once the run is known so we have its workflow id
      // and version name (Req 7.1). This is decoupled from the run/tasks load:
      // any failure degrades to `null` (Inferred DAG fallback) and MUST NOT
      // surface an error banner or block the run/tasks that already loaded
      // (Req 7.3, 8.4). Skip entirely when the run has no workflow id.
      const workflowId = loadedRun?.workflowId ?? null;
      if (workflowId != null) {
        const versionName = loadedRun?.workflowVersionName ?? 'DEFAULT';
        try {
          const graph = await getStaticGraph(workflowId, versionName);
          setFetchedGraph(graph);
        } catch {
          // Degrade to the Inferred DAG; do not disturb the ready run/tasks view.
          setFetchedGraph(null);
        }
      } else {
        setFetchedGraph(null);
      }

      // Fetch measured metrics alongside the rest (Req 5.1, 5.2). This is
      // independent of the run/tasks/static-graph ready state above: it never
      // blocks or fails it. Pass the run's own window when known so the
      // Lambda skips its GetRun fallback (design §"Run window"); when the run
      // isn't loaded yet, omit start/end so that fallback kicks in.
      void loadMetrics(loadedRun);

      // Fetch the estimated per-run cost breakdown alongside the metrics (Req
      // 5.2). Same contract as `loadMetrics`: independent of the ready state
      // above, it never blocks or fails it, and `RunCostPanel` owns its own
      // loading/error/unavailable/ready presentation.
      void loadCost();

      // Fetch a best-effort error excerpt for a FAILED run (Option B). Reset
      // first so a stale excerpt from a previous run never lingers, then
      // fetch only when the run actually failed — never for a healthy run.
      // Independent of the rest of `load`: any failure/absence just means no
      // excerpt is shown, never an error of its own.
      setRunErrorExcerpt(null);
      if (loadedRun?.status === 'FAILED') {
        setRunExcerptLoading(true);
        try {
          const excerpt = await getErrorExcerpt({ runId, stream: 'ENGINE' });
          setRunErrorExcerpt(excerpt);
        } catch {
          setRunErrorExcerpt(null);
        } finally {
          setRunExcerptLoading(false);
        }
      }
    } catch (error) {
      // Retain previously loaded content; only swap in the error state (Req 10.2).
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Run details could not be loaded.',
      );
      setPhase('error');
    }
  }, [
    getRun,
    listTasksForRun,
    getStaticGraph,
    runId,
    loadMetrics,
    loadCost,
    getErrorExcerpt,
  ]);

  useEffect(() => {
    if (hasQueried.current) {
      return;
    }
    hasQueried.current = true;
    void load();
  }, [load]);

  // Subscribe to task updates for the run and apply each into the task list in
  // place (Req 9.7, 9.8). The reconnecting manager keeps the stream live across
  // transient drops; on a genuine reconnect the view is refetched through
  // `load` so we resync current data (Req 10.6) without a page reload.
  useEffect(() => {
    // The manager fires `onReconnect` on its very first connection too; the
    // initial `load` effect has already fetched once (Req 10.4), so skip that
    // first callback and only refetch on subsequent reconnects.
    let seenFirstConnect = false;
    const managed = createReconnectingSubscription<Task>({
      subscribe: (handlers) => onTaskUpdated(runId, handlers),
      onNext: (task) => {
        if (task.runId !== runId) {
          return;
        }
        setTasks((prev) => applyTaskUpdate(prev, task));
      },
      onReconnect: () => {
        if (!seenFirstConnect) {
          seenFirstConnect = true;
          return;
        }
        void load();
      },
    });
    return () => managed.stop();
  }, [runId, onTaskUpdated, load]);

  // Retry re-issues the queries on demand (Req 9.2). Allowed because it is a
  // user-initiated action, not the automatic per-mount query.
  const handleRetry = useCallback(() => {
    void load();
  }, [load]);

  // Deep-link from the run-failure banner straight into the Engine logs tab
  // (Option A: make the CloudWatch log-stream reference actionable instead of
  // dead text). Sets the RUN_ENGINE selection pre-selected on the Engine tab,
  // which opens the SplitPanel fly-out (via `splitPanelOpen`, brought into view
  // by the shell opening the panel). The retained `scrollIntoView` guard brings
  // the panel into view in the inline-fallback path (no `Dashboard` shell); it
  // no-ops when the ref is absent (fly-out hosted by the shell) or unsupported.
  const openEngineLogs = useCallback(() => {
    setLogsSelection({ kind: 'RUN_ENGINE' });
    setRunLogsTabId('engine');
    requestAnimationFrame(() => scrollLogsPanelIntoView(logsPanelRef.current));
  }, []);

  // Deep-link from the failed-tasks list straight into that task's logs
  // (mirrors the existing DAG-node-click path, but reachable from the failure
  // list without hunting for the node in the diagram). Sets the TASK selection,
  // opening the fly-out on that task; the retained `scrollIntoView` guard brings
  // the panel into view in the inline-fallback path and no-ops otherwise.
  const openTaskLogs = useCallback((taskId: string, label: string) => {
    setLogsSelection({ kind: 'TASK', taskId, label });
    requestAnimationFrame(() => scrollLogsPanelIntoView(logsPanelRef.current));
  }, []);

  // The graph actually used: an explicit prop wins over the fetched graph
  // (backward compatibility for callers/tests that supply one out of band),
  // otherwise the fetched graph (or `null` on miss/failure).
  const staticGraph = staticGraphProp ?? fetchedGraph;

  // The layer chosen from the available data (Req 7.2–7.4): True_DAG when the
  // graph has ≥1 node, else Inferred_DAG/Timeline_View.
  const selectedLayer = useMemo(
    () => selectLayer(staticGraph, tasks),
    [staticGraph, tasks],
  );

  // A Static (True) DAG is available iff layer selection landed on it. The
  // "show static DAG" toggle is only meaningful (and only rendered) in that
  // case (Req 8.3).
  const staticDagAvailable = selectedLayer === 'True_DAG';

  // The layer effectively rendered. When a Static DAG is available we DEFAULT to
  // the Inferred (timing) DAG for the same tasks and only switch up to the
  // Static (True) DAG when the operator opts in via the toggle — a view-only
  // override with no refetch (Req 8.3). When no Static DAG is available,
  // `selectedLayer` is already Inferred_DAG/Timeline_View and is used as-is.
  const layer: LayerKind = staticDagAvailable
    ? (showStatic ? 'True_DAG' : 'Inferred_DAG')
    : selectedLayer;

  const progress = useMemo(() => computeProgress(tasks, run), [tasks, run]);

  // Failed/cancelled tasks (Req 4.1) and the count for the badge (Req 4.2).
  // The count is over the full task set and does not depend on the toggle.
  const failedTasks = useMemo(() => failedOrCancelledTasks(tasks), [tasks]);
  const failedCount = failedTasks.length;

  // Tasks actually rendered in the graph/timeline: the full set, or only the
  // failed/cancelled subset when the quick filter is on (Req 4.1).
  const visibleTasks = useMemo(
    () => (showFailedOnly ? failedTasks : tasks),
    [showFailedOnly, failedTasks, tasks],
  );

  // Resolve `now` ONCE per mount (or when the injected `now` prop changes) so
  // every analytics panel below computes deterministically against the same
  // instant (Req 1.5, 10.4). Injectable via the `now` prop for tests; defaults
  // to the current time. Memoized so `nowMs` is a STABLE reference across
  // renders: a bare `now ?? Date.now()` would mint a fresh timestamp every
  // render, giving `detailPanel` → `flyoutNode` new identities and retriggering
  // the fly-out slot-registration effect below, which sets parent state and
  // re-renders us — an infinite render loop (React #185) the moment a task is
  // selected. The memo preserves the "same instant" semantic and breaks that loop.
  const nowMs = useMemo(() => now ?? Date.now(), [now]);

  // Per-run resource summary (peak concurrent CPUs, CPU-hours, peak memory) —
  // each metric reports "unavailable" rather than a fabricated 0 when its input
  // field is absent, and the summary is flagged partial while any task is still
  // running (Req 2.4–2.7, 10.4, 11.1). Computed over the full task set, not the
  // failed-only view, so the footprint reflects the whole run.
  const resourceSummary = useMemo(
    () => summarizeResources(tasks, nowMs),
    [tasks, nowMs],
  );

  // Longest-running tasks (top 5) and the single slowest task id used to
  // highlight a DAG node (Req 3.3, 3.4, 3.6). This is a wall-clock
  // approximation labeled "longest-running tasks", NOT a dependency-graph
  // critical path (Req 3.7). Computed over the full task set.
  const longestTasks = useMemo(() => topLongest(tasks, 5, nowMs), [tasks, nowMs]);
  const slowestId = useMemo(() => slowestTaskId(tasks, nowMs), [tasks, nowMs]);

  // Per-task queue-wait vs run-time segments (Req 8.1–8.4, 12.x). Queue-wait is
  // rendered under the unconfirmed-`createdAt` caveat; run-time is not.
  const segments = useMemo(() => segmentsForAll(tasks, nowMs), [tasks, nowMs]);

  const engineVersion = run?.engineVersion ?? null;

  // Selecting a task node opens its logs. Initializing/True-DAG nodes whose id
  // is a static-graph node (not a taskId) are matched back to a task by name so
  // the correct task stream is shown; if no task matches, selection is ignored.
  const handleNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      if (node.id === '__initializing__') {
        return;
      }
      // Inferred-DAG nodes are keyed by taskId; True-DAG nodes by static-graph
      // node id with the task name as the label. Resolve to a real task.
      const byId = tasks.find((t) => t.taskId === node.id);
      const label = (node.data as { label?: string } | undefined)?.label;
      const byName = label ? tasks.find((t) => t.name === label) : undefined;
      const task = byId ?? byName;
      if (task) {
        setLogsSelection({
          kind: 'TASK',
          taskId: task.taskId,
          label: task.name ?? task.taskId,
        });
      }
    },
    [tasks],
  );

  // Build the React Flow node/edge model for the node-edge layers. Recomputed
  // whenever tasks change so a live task update recolors its node (Req 9.8).
  // The taskId whose logs panel is open, so its DAG node shows the selection
  // ring. Null when the panel is closed or showing run/engine logs.
  const selectedTaskId =
    logsSelection != null && logsSelection.kind === 'TASK'
      ? logsSelection.taskId
      : null;

  // The task a TASK selection resolves to, or null. A RUN_ENGINE selection (or
  // no selection) resolves to null by design.
  const selectedTask = useMemo(
    () =>
      logsSelection != null && logsSelection.kind === 'TASK'
        ? tasks.find((t) => t.taskId === logsSelection.taskId) ?? null
        : null,
    [logsSelection, tasks],
  );

  // Per-task metric join (STAGE 2, Req 9.1, 9.2). Computed ONCE here from the
  // already-fetched measured series and the run's tasks, using the existing
  // pure `joinMetricsToTasks` UNCHANGED — this is presentation-only plumbing
  // (Req 10.4). The selected task's slice (`matched` entry with the matching
  // `taskId`, or `null` when it has no measured series) is handed to
  // `TaskDetailPanel` so it can render that task's utilization charts above its
  // log tail — or an explicit "utilization unavailable" state when null.
  const taskMetricsMatched = useMemo(
    () => joinMetricsToTasks(metricsResult?.series ?? [], tasks).matched,
    [metricsResult, tasks],
  );
  // The selected TASK's metric slice, or null. For a RUN_ENGINE / null
  // selection (or a task with no matching series) this is null, so the panel
  // shows the honest "utilization unavailable for this task" state rather than
  // a fabricated chart.
  const selectedTaskMetrics: TaskMetrics | null = useMemo(() => {
    if (logsSelection == null || logsSelection.kind !== 'TASK') {
      return null;
    }
    return (
      taskMetricsMatched.find((m) => m.taskId === logsSelection.taskId) ?? null
    );
  }, [logsSelection, taskMetricsMatched]);

  // Whether the detail panel should show the run-level context (resource summary
  // + failed-tasks list) instead of handing off to `TaskDetailPanel`. True with
  // no selection, AND for a STALE task selection whose `taskId` is no longer in
  // the task list (e.g. after a live task-list update): rather than erroring or
  // showing an empty task detail, it resolves to the run-level context (Req 4.7,
  // design §Error Handling). A RUN_ENGINE selection still legitimately resolves
  // `selectedTask` to null and MUST keep showing the run/engine logs, so it is
  // deliberately excluded here.
  const showRunLevelContext =
    logsSelection == null ||
    (logsSelection.kind === 'TASK' && selectedTask == null);

  // Clear a STALE task selection so the selection state stays consistent with
  // the closed fly-out (Req 4.7, 5.3). When a live task-list update removes the
  // selected task, `showRunLevelContext` flips true and the fly-out closes —
  // but `logsSelection` would otherwise linger as a `{ kind: 'TASK', taskId }`
  // pointing at a task that no longer exists, leaving a stale DAG selection ring
  // and a non-null selection behind a closed panel. This effect resets it to
  // `null` in that case (a TASK selection whose `taskId` is gone), so the
  // fly-out is genuinely a total function of a valid selection rather than
  // merely hiding its body. A RUN_ENGINE selection is deliberately untouched:
  // it legitimately resolves `selectedTask` to null and must stay open.
  useEffect(() => {
    if (logsSelection?.kind === 'TASK' && selectedTask == null) {
      setLogsSelection(null);
    }
  }, [logsSelection, selectedTask]);

  // ── Detail fly-out (Cloudscape SplitPanel) ──────────────────────────────
  // The selected task's (or the run/engine logs') detail is presented in the
  // shell's right-side resizable SplitPanel rather than an inline block. The
  // fly-out is a TOTAL function of the selection (design §Property 2): a `null`
  // selection — and a STALE task selection whose `taskId` is gone
  // (`showRunLevelContext`) — closes it; a live TASK or RUN_ENGINE selection
  // opens it on exactly that detail. The full-width DAG stays rendered and
  // interactive while the panel is open.
  const splitPanelOpen = !showRunLevelContext;

  // Header names the selection: "Logs — task <name>" for a task, "Logs — run &
  // engine" for the run/engine logs (design §The fly-out).
  const splitPanelHeader =
    logsSelection != null && logsSelection.kind === 'TASK'
      ? `Logs — task ${logsSelection.label}`
      : 'Logs — run & engine';

  // The `TaskDetailPanel` rendered for the current selection. Reused for BOTH
  // the SplitPanel body (when the shell slot is available) and the inline
  // fallback (when it is not — e.g. tests rendering `RunDetailView` without the
  // `Dashboard` provider). Rendered only when the fly-out is open so a `null` /
  // stale selection produces no panel.
  const detailPanel = useMemo(
    () =>
      splitPanelOpen ? (
        <TaskDetailPanel
          runId={run?.runId ?? runId}
          task={selectedTask}
          selection={logsSelection}
          taskMetrics={selectedTaskMetrics}
          runLogsTabId={runLogsTabId}
          onRunLogsTabChange={setRunLogsTabId}
          getErrorExcerpt={getErrorExcerpt}
          runFailed={run?.status === 'FAILED'}
          now={nowMs}
          onClose={() => setLogsSelection(null)}
        />
      ) : null,
    [
      splitPanelOpen,
      run?.runId,
      run?.status,
      runId,
      selectedTask,
      logsSelection,
      selectedTaskMetrics,
      runLogsTabId,
      getErrorExcerpt,
      nowMs,
    ],
  );

  // Fill the shell's view-agnostic split-panel slot (task 1) with a real
  // Cloudscape `SplitPanel` wrapping the detail panel. `null` when there is no
  // active selection so the shell clears the slot. The slot is absent (`null`)
  // when `RunDetailView` is rendered outside the `Dashboard` provider (some
  // tests); in that case we degrade to an inline render below.
  const splitPanelSlot = useSplitPanelSlot();
  // Memoized so the slot-registration effect below doesn't re-fire on every
  // render (only when the panel body or header actually changes).
  const flyoutNode = useMemo(
    () =>
      detailPanel != null ? (
        <SplitPanel
          header={splitPanelHeader}
          hidePreferencesButton
          i18nStrings={{
            preferencesTitle: 'Split panel preferences',
            preferencesPositionLabel: 'Split panel position',
            preferencesPositionDescription:
              'Choose the default split panel position.',
            preferencesPositionSide: 'Side',
            preferencesPositionBottom: 'Bottom',
            preferencesConfirm: 'Confirm',
            preferencesCancel: 'Cancel',
            closeButtonAriaLabel: 'Close panel',
            openButtonAriaLabel: 'Open panel',
            resizeHandleAriaLabel: 'Resize split panel',
          }}
        >
          {detailPanel}
        </SplitPanel>
      ) : null,
    [detailPanel, splitPanelHeader],
  );

  // Register the fly-out node + open state + toggle with the shell slot,
  // reacting to selection changes. The toggle clears the selection (Req 2.4):
  // the shell only fires it with `open === false` (native close / toggle-off),
  // so any invocation means "close" → clear the selection to `null`. When the
  // slot is null (no `Dashboard` provider) this effect is a no-op and the
  // inline fallback below renders instead.
  useEffect(() => {
    if (splitPanelSlot == null) {
      return;
    }
    splitPanelSlot.setSplitPanel(flyoutNode);
    splitPanelSlot.setOpen(splitPanelOpen);
    splitPanelSlot.setOnToggle(() => setLogsSelection(null));
    return () => {
      // Clear the slot when this view unmounts so a stale panel can't linger.
      splitPanelSlot.setSplitPanel(null);
      splitPanelSlot.setOpen(false);
      splitPanelSlot.setOnToggle(undefined);
    };
  }, [splitPanelSlot, flyoutNode, splitPanelOpen]);

  const flow = useMemo(() => {
    if (visibleTasks.length === 0) {
      return { nodes: [], edges: [] };
    }
    if (layer === 'True_DAG' && staticGraph != null) {
      return buildTrueDagFlow(
        buildTrueDagOverlay(staticGraph, visibleTasks),
        slowestId,
        selectedTaskId,
      );
    }
    if (layer === 'Inferred_DAG') {
      return buildInferredDagFlow(
        buildInferredDagOrdering(visibleTasks),
        slowestId,
        selectedTaskId,
      );
    }
    return { nodes: [], edges: [] };
  }, [layer, staticGraph, visibleTasks, slowestId, selectedTaskId]);

  // Node-search matches over the current flow nodes (Req: node search). Keyed off
  // the debounced query so matching/dimming/fit only recompute after typing
  // settles. An empty (debounced) query yields an empty set (no active search).
  const searchMatchIds = useMemo(
    () => matchNodeIds(flow.nodes, debouncedNodeSearchQuery),
    [flow.nodes, debouncedNodeSearchQuery],
  );
  const searchActive =
    searchMatchIds.size > 0 || debouncedNodeSearchQuery.trim() !== '';

  // Decorate flow nodes with search emphasis/dimming. When no search is active,
  // nodes are returned unchanged (referentially, per node) so nothing dims.
  const displayNodes = useMemo<Node<TaskNodeData>[]>(() => {
    if (!searchActive) {
      return flow.nodes;
    }
    return flow.nodes.map((node) => {
      const isMatch = searchMatchIds.has(node.id);
      return {
        ...node,
        data: { ...node.data, searchMatch: isMatch, dimmed: !isMatch },
      };
    });
  }, [flow.nodes, searchActive, searchMatchIds]);

  // When the query changes and there are matches, fit the view to them so the
  // user is taken to the results without losing the surrounding structure.
  useEffect(() => {
    const instance = flowInstanceRef.current;
    if (instance == null || searchMatchIds.size === 0) {
      return;
    }
    const matchNodes = flow.nodes.filter((n) => searchMatchIds.has(n.id));
    if (matchNodes.length > 0) {
      instance.fitView({ nodes: matchNodes, padding: 0.3, duration: 300, maxZoom: 1.5 });
    }
  }, [searchMatchIds, flow.nodes]);

  const timeline = useMemo(
    () => (layer === 'Timeline_View' ? buildTimelineView(visibleTasks) : null),
    [layer, visibleTasks],
  );

  // A run that has started but reported no tasks yet is "initializing" (e.g.
  // PENDING/STARTING, or RUNNING while the engine stages inputs and pulls
  // containers before the first process launches). Show a single Initializing
  // DAG node in that window instead of an empty canvas; a genuinely finished
  // run with no tasks falls through to the empty state below.
  const ACTIVE_PRE_TASK: ReadonlyArray<NonNullable<Run['status']>> = [
    'PENDING',
    'STARTING',
    'RUNNING',
    'STOPPING',
  ];
  const isInitializing =
    tasks.length === 0 &&
    run?.status != null &&
    ACTIVE_PRE_TASK.includes(run.status);
  const initializingFlow = useMemo(
    () => (isInitializing ? buildInitializingFlow(run?.status) : null),
    [isInitializing, run?.status],
  );

  // Header actions: a Refresh button (re-runs getRun + listTasksForRun for the
  // current run) plus the Back-to-fleet button when navigation is available.
  const headerActions = (
    <SpaceBetween direction="horizontal" size="xs">
      <Button
        ariaLabel="View run and engine logs"
        onClick={() => setLogsSelection({ kind: 'RUN_ENGINE' })}
      >
        View run &amp; engine logs
      </Button>
      <Button
        iconName="refresh"
        ariaLabel="Refresh run details"
        loading={phase === 'loading'}
        onClick={handleRetry}
      >
        Refresh
      </Button>
      {onBack && (
        <Button iconName="arrow-left" onClick={onBack}>
          Back to fleet
        </Button>
      )}
    </SpaceBetween>
  );

  if (phase === 'loading') {
    return (
      <Container header={<Header variant="h1" actions={headerActions}>Run detail</Header>}>
        <div aria-label="run detail">
          <Box padding="l" textAlign="center">
            <Spinner size="large" /> <span role="status">Loading run details…</span>
          </Box>
        </div>
      </Container>
    );
  }

  if (phase === 'error') {
    return (
      <SpaceBetween size="m">
        {headerActions}
        <Alert
          type="error"
          header="Run details could not be loaded"
          action={<Button onClick={handleRetry}>Retry</Button>}
        >
          <span aria-label="run detail">
            {errorMessage ?? 'Run details could not be loaded.'}
          </span>
        </Alert>
      </SpaceBetween>
    );
  }

  return (
    <Container
      header={
        <Header
          variant="h1"
          actions={headerActions}
          description={
            <SpaceBetween direction="horizontal" size="xs">
              {/* Inferred label when the Inferred_DAG is shown (Req 7.3). */}
              {!isInitializing && layer === 'Inferred_DAG' && (
                <span data-testid="inferred-label">
                  <Badge color="grey">inferred</Badge>
                </span>
              )}
              {/* When a Static (True) DAG is available, the Inferred (timing)
                  DAG is shown by default and this toggle switches UP to the
                  Static DAG for the same tasks — a view-only override with no
                  refetch (Req 8.3). Shown only while a Static DAG exists. */}
              {!isInitializing && staticDagAvailable && (
                <span data-testid="static-toggle">
                  <Toggle
                    checked={showStatic}
                    onChange={({ detail }) => setShowStatic(detail.checked)}
                  >
                    Show static DAG
                  </Toggle>
                </span>
              )}
              {/* Engine version badge (Req 7.1, 7.2). Shows the run's engine
                  version, or an Unknown_State ("—"/Unknown) when absent so no
                  value is fabricated. */}
              <span aria-label="engine version badge" data-testid="engine-version-badge">
                <Badge color={engineVersion != null ? 'blue' : 'grey'}>
                  {engineVersion != null
                    ? `Engine ${engineVersion}`
                    : 'Engine — (Unknown)'}
                </Badge>
              </span>
            </SpaceBetween>
          }
        >
          {run?.name ?? run?.runId ?? runId}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {/* Zone 1 — always-visible orientation strip (Req 1.1–1.3). A compact
            header zone rendered unconditionally above the working area so an
            operator keeps orientation regardless of the current selection or
            which analysis sections are expanded: run status badge, run name,
            progress (completed/total + elapsed HH:MM:SS), and the layer
            indicator badge. It is intentionally selection-independent — none of
            its content is gated on `logsSelection` or any analysis-section
            state — so it never scrolls away or disappears when a task is
            selected. */}
        <RunOrientationStrip
          run={run}
          runId={runId}
          progress={progress}
          layerIndicator={
            <span aria-label="layer indicator" data-testid="layer-indicator">
              {isInitializing ? (
                <Badge color="blue">Initializing</Badge>
              ) : layer === 'True_DAG' ? (
                // Fidelity-honest label so an approximate graph is never
                // presented as authoritative (Req 8.1, 8.2, 8.5). A missing
                // fidelity is treated as `approximate`.
                <span data-testid="fidelity-label">
                  <Badge color="green">
                    {staticGraph?.fidelity === 'exact'
                      ? 'True dependency graph'
                      : 'Static DAG (approximate)'}
                  </Badge>
                </span>
              ) : (
                <Badge color="blue">{LAYER_LABEL[layer]}</Badge>
              )}
            </span>
          }
        />

        {/* Run-level failure banner (zone 1, Req 2.1–2.4): surfaces
            HealthOmics' own `statusMessage` (and `failureReason` when present)
            plus the Option-B engine error excerpt as soon as the run is known
            to have failed, so the operator sees WHY without digging through the
            AWS CLI or CloudWatch logs. Rendered here — directly under the
            orientation strip and ABOVE the master-detail working area — so a
            failed run is never hidden by the current selection (Req 2.3). Shown
            ONLY when the run status is FAILED and a message was captured; never
            rendered for a non-FAILED run and never fabricated (Req 2.4). */}
        {run?.status === 'FAILED' && run.statusMessage != null && (
          <Alert
            type="error"
            header="Run failed"
            data-testid="run-failure-banner"
            action={
              <Button
                onClick={openEngineLogs}
                data-testid="run-failure-view-logs"
              >
                View engine logs
              </Button>
            }
          >
            <SpaceBetween size="xxs">
              <span data-testid="run-failure-message">{run.statusMessage}</span>
              {run.failureReason != null && (
                <Box variant="small" color="text-status-inactive">
                  Reason code: <span data-testid="run-failure-reason">{run.failureReason}</span>
                </Box>
              )}
              {/* Option B: the actual error line(s) extracted from the engine
                  log stream, when found — makes the often-generic
                  statusMessage above ("...review the CloudWatch logs to debug
                  the failure") actionable without a manual log dig. Never
                  shown when nothing was found (never a fabricated excerpt). */}
              {/* While the excerpt is being extracted from the engine log
                  stream, show a small progress indicator so the operator knows
                  error details are being fetched (the read is fast but not
                  instant). Once done, either the excerpt or nothing is shown. */}
              {runExcerptLoading ? (
                <Box
                  variant="small"
                  color="text-status-inactive"
                  data-testid="run-error-excerpt-loading"
                >
                  <Spinner size="normal" /> Extracting error details from the
                  engine log…
                </Box>
              ) : (
                runErrorExcerpt?.found && (
                  <ErrorExcerptBlock excerpt={runErrorExcerpt} testIdPrefix="run" />
                )
              )}
            </SpaceBetween>
          </Alert>
        )}

        {/* Zone 2 — full-width DAG + run-level context band (Req 1.1–1.3, 1.5,
            4.2, 6.4). The task DAG is the primary element of the run detail view
            (Req 1.1, 1.2), so it now renders at the FULL content width — no
            two-column Grid, no partial-width column, and no reserved blank
            detail region beside it when nothing is selected (Req 1.5). Its
            controls stay consolidated into a single compact toolbar ON the DAG
            (Req 1.3). The selection-driven detail (`TaskDetailPanel`) and the
            SplitPanel fly-out are wired in a later task; for now a selection
            renders the detail inline below the DAG so every element stays
            reachable (no content removed, Req 6.4). */}
        <div data-testid="dag-master" aria-label="task DAG">
          <SpaceBetween size="s">
            {/* Consolidated DAG toolbar (Req 3.3): node search + match badge,
                the failed/cancelled quick-filter + count badge, and the
                task-status legend — one toolbar instead of three stacked blocks.
                Shown only when real tasks exist (not while initializing / empty);
                node search is hidden for the Timeline_View fallback. */}
            {!isInitializing && tasks.length > 0 && (
              <DagToolbar
                tasks={tasks}
                slowestId={slowestId}
                showFailedOnly={showFailedOnly}
                onShowFailedOnlyChange={setShowFailedOnly}
                failedCount={failedCount}
                onDebouncedQueryChange={setDebouncedNodeSearchQuery}
                searchMatchCount={searchMatchIds.size}
                showNodeSearch={
                  visibleTasks.length > 0 && layer !== 'Timeline_View'
                }
              />
            )}

            {isInitializing && initializingFlow != null ? (
          // Run started but no tasks reported yet: show an Initializing node so
          // the diagram reflects the run's initial status (not an empty canvas).
          <div
            data-testid="task-graph"
            data-initializing="true"
            className="task-graph"
            style={{ width: '100%', height: 460 }}
          >
            <ReactFlow
              nodes={initializingFlow.nodes}
              edges={initializingFlow.edges}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.5}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1.4}
                color="#c3ccd8"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        ) : tasks.length === 0 ? (
          // Zero-task empty state for a run with no tasks and not initializing
          // (e.g. a finished run that never launched a task) (Req 9.4).
          <Box textAlign="center" color="inherit" padding="l">
            <b>No tasks exist for this run.</b>
          </Box>
        ) : visibleTasks.length === 0 ? (
          // Failed-only filter is on but the run has no failed/cancelled tasks.
          <Box textAlign="center" color="inherit" padding="l">
            <b>No failed or cancelled tasks in this run.</b>
          </Box>
        ) : layer === 'Timeline_View' && timeline != null ? (
          <TimelineList timeline={timeline} />
        ) : (
          <div
            data-testid="task-graph"
            className={
              layer === 'True_DAG'
                ? 'task-graph'
                : 'task-graph task-graph-no-edges'
            }
            style={{ width: '100%', height: 460 }}
          >
            {/* React Flow node-edge DAG. The True_DAG draws real dependency
                edges; the Inferred_DAG is edge-free (timing rows), so its node
                connection handles are hidden via `task-graph-no-edges`. Nodes
                are selectable: clicking a task node opens its detail (its
                Selection becomes `{ kind: 'TASK', taskId }`, Req 3.4). */}
            <ReactFlow
              nodes={displayNodes}
              edges={flow.edges}
              nodeTypes={NODE_TYPES}
              onNodeClick={handleNodeClick}
              onInit={(instance) => {
                flowInstanceRef.current = instance;
              }}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.5}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1.4}
                color="#c3ccd8"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
            )}
          </SpaceBetween>
        </div>

        {/* Run-level context band (full width, below the DAG) (Req 4.2, 6.4,
            8.1). In the shipped two-column layout this was the detail column's
            default state; with the DAG now full-width there is no side column,
            so it moves to a full-width band directly below the DAG. It is always
            rendered (independent of the selection) so the run-level context is
            reachable whenever nothing is selected — never blank space beside the
            DAG, never hidden behind a selection (Req 4.2). The derived resource
            summary card renders unconditionally over the full task set (never
            blanked by a measured-metrics outcome, Req 8.1); the failed-tasks
            list surfaces the scannable "why" with its per-task "view logs" deep
            link. Skipped only while initializing / empty, matching the previous
            guards. */}
        {!isInitializing && tasks.length > 0 && (
          <div
            data-testid="run-level-context"
            aria-label="run-level context"
          >
            <SpaceBetween size="l">
              <ResourceSummaryCard summary={resourceSummary} />
              {failedTasks.length > 0 && (
                <FailedTasksList tasks={failedTasks} onViewLogs={openTaskLogs} />
              )}
            </SpaceBetween>
          </div>
        )}

        {/* Selection-driven detail (Req 2.1–2.6, 4.1). An active TASK/RUN_ENGINE
            selection is normally presented in the shell's right-side Cloudscape
            SplitPanel fly-out (registered through the view-agnostic slot above);
            the DAG stays full-width and interactive while it is open, and the
            fly-out's native close / toggle clears the selection to `null`.

            The inline render here is a FALLBACK for when the shell slot is
            absent (`splitPanelSlot == null`) — e.g. tests rendering
            `RunDetailView` without the `Dashboard` provider. In that case the
            fly-out has no host, so the same `TaskDetailPanel` renders inline so
            its detail + logs stay reachable rather than vanishing. When the slot
            IS present the panel lives in the fly-out, so nothing renders here (no
            double render). A `null` selection, and a STALE task selection whose
            `taskId` is no longer in the task list (`showRunLevelContext`), render
            nothing either way: the run-level context band above already covers
            "nothing selected" and the stale selection resolves to it rather than
            erroring (Req 2.9, 4.7). The region is wrapped in `logsPanelRef` so a
            cross-zone deep link can bring it into view. */}
        {splitPanelSlot == null && detailPanel != null && (
          <div ref={logsPanelRef} data-testid="detail-panel" aria-label="detail panel">
            {detailPanel}
          </div>
        )}

        {/* Zone 3 — the analysis stack (Req 6.1–6.4). The researcher's depth,
            laid out as a SINGLE-COLUMN stack of collapsed-by-default
            `ExpandableSection`s BELOW the full-width DAG + run-level context
            band so it is available but out of the operator's primary path. It is
            no longer a 2-up grid, so no section scrolls sideways at supported
            viewport widths (Req 6.3). Every analysis element remains here
            unchanged — estimated cost, longest-running tasks, the queue-wait vs
            run-time timeline, inputs & outputs, and the run-level (non
            task-scoped) measured utilization — so no content is removed and
            everything remains reachable (Req 6.4); only its arrangement changes.
            Rendered whenever real tasks exist (skipped while initializing /
            empty, matching the sections' previous guards). Each section keeps
            its own testid and its own loading / error / unavailable / ready
            presentation. */}
        {!isInitializing && tasks.length > 0 && (
          <div data-testid="analysis-stack" aria-label="analysis sections">
            <SpaceBetween size="l">
              {/* Estimated cost (Req 6.1). A list-price ESTIMATE (measured
                  runtime × the published AWS price list), never the actual
                  bill; the panel handles its own loading/error/unavailable/
                  ready states. */}
              <ExpandableSection
                variant="container"
                headerText="Estimated cost"
                defaultExpanded={false}
                data-testid="cost-section"
              >
                <RunCostPanel
                  runId={run?.runId ?? runId}
                  result={costResult}
                  isLoading={costLoading}
                  onRefresh={() => void loadCost()}
                />
              </ExpandableSection>

              {/* Longest-running tasks (Req 6.1; formerly Req 3.3, 3.7). A
                  wall-clock approximation, not a dependency-graph critical
                  path; the slowest task is highlighted on the DAG above via
                  `slowestId`. Wrapped in a collapsed section here so it matches
                  the rest of the analysis grid; its `longest-tasks` list is
                  rendered whenever there is at least one timed task. */}
              <ExpandableSection
                variant="container"
                headerText="Longest-running tasks"
                defaultExpanded={false}
                data-testid="longest-tasks-section"
              >
                {longestTasks.length > 0 ? (
                  <LongestTasksList
                    tasks={longestTasks}
                    slowestId={slowestId}
                    nowMs={nowMs}
                  />
                ) : (
                  <Box textAlign="center" color="inherit">
                    No timed tasks yet.
                  </Box>
                )}
              </ExpandableSection>

              {/* Per-task queue-wait vs run-time timeline (Req 6.1; formerly
                  Req 8.1–8.4, 12.3, 12.4). Queue-wait renders under the
                  unconfirmed-`createdAt` caveat; run-time renders without a
                  caveat. */}
              <ExpandableSection
                variant="container"
                headerText="Task timeline (queue-wait vs run-time)"
                defaultExpanded={false}
                data-testid="task-segments"
              >
                <TaskSegmentsPanel tasks={tasks} segments={segments} />
              </ExpandableSection>

              {/* Inputs & outputs (Req 6.1; QoL #7 reproducibility, #8 output
                  link). Parses the run's parameters/tags and surfaces the
                  output location + engine version; `RunInputsOutputs` renders
                  its own collapsed section, so it drops straight into the
                  grid. */}
              <RunInputsOutputs run={run} />

              {/* Run-level measured utilization (Req 6.1). This stays in the
                  analysis grid rather than the task detail panel because it is
                  run-level and NOT attributable to a selected node (e.g. the
                  `RUN_FILESYSTEM` run-level series, `taskId === null`). It
                  augments, never replaces, the derived resource summary in the
                  detail panel, and handles its own loading/error/unavailable/
                  ready states. */}
              <ExpandableSection
                variant="container"
                headerText="Measured utilization"
                defaultExpanded={false}
                data-testid="metrics-section"
              >
                <RunMetricsPanel
                  runId={run?.runId ?? runId}
                  tasks={tasks}
                  result={metricsResult}
                  isLoading={metricsLoading}
                  onRefresh={() => void loadMetrics()}
                />
              </ExpandableSection>
            </SpaceBetween>
          </div>
        )}
      </SpaceBetween>
    </Container>
  );
}

/**
 * Run inputs, parameters, and outputs (QoL #7 reproducibility, #8 output link).
 *
 * Parses the run's `parameters` JSON (free-form per workflow) and renders each
 * key/value; values that look like S3 URIs are shown as console deep links.
 * Also surfaces the run's output location and engine version. Collapsed by
 * default. Read-only.
 */
function RunInputsOutputs({
  run,
}: {
  run: Run | null;
}): React.JSX.Element | null {
  const params = useMemo<Record<string, unknown> | null>(
    () => parseRunParameters(run?.parameters),
    [run?.parameters],
  );

  // Tags (e.g. cost-allocation tags) — a string->string map delivered as an
  // AWSJSON string. Reuse the same double-decode-tolerant parser as parameters.
  const tags = useMemo<Record<string, unknown> | null>(
    () => parseRunParameters(run?.tags),
    [run?.tags],
  );
  const tagEntries = tags != null ? Object.entries(tags) : [];

  const outputUri = run?.outputUri ?? null;
  const engineVersion = run?.engineVersion ?? null;

  // Run configuration used to launch the run (reproducibility). Only fields the
  // pipeline actually captured are shown — never a fabricated value. Storage
  // capacity is only meaningful for STATIC storage, so it is appended to the
  // storage value rather than shown as a bare number.
  const storageValue =
    run?.storageType != null
      ? run.storageType === 'STATIC' && run.storageCapacity != null
        ? `${run.storageType} (${run.storageCapacity} GiB)`
        : run.storageType
      : null;
  const cacheValue =
    run?.cacheId != null
      ? run.cacheBehavior != null
        ? `${run.cacheId} (${run.cacheBehavior})`
        : run.cacheId
      : null;
  const networkingValue =
    run?.networkingMode != null
      ? run.configurationName != null
        ? `${run.networkingMode} — ${run.configurationName}`
        : run.networkingMode
      : run?.configurationName ?? null;
  const runConfigEntries: Array<{ key: string; label: string; value: string }> =
    [
      { key: 'role', label: 'IAM role', value: run?.roleArn ?? '' },
      { key: 'storage', label: 'Storage', value: storageValue ?? '' },
      { key: 'cache', label: 'Run cache', value: cacheValue ?? '' },
      { key: 'networking', label: 'Networking', value: networkingValue ?? '' },
      { key: 'logLevel', label: 'Log level', value: run?.logLevel ?? '' },
    ].filter((e) => e.value !== '');

  // Nothing to show yet (e.g. enrichment hasn't populated these).
  if (
    params == null &&
    outputUri == null &&
    engineVersion == null &&
    runConfigEntries.length === 0 &&
    tagEntries.length === 0
  ) {
    return null;
  }

  return (
    <ExpandableSection
      variant="container"
      headerText="Inputs & outputs"
      defaultExpanded={false}
    >
      <SpaceBetween size="m">
        {(outputUri != null || engineVersion != null) && (
          <ColumnLayout columns={2} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">Output location</Box>
              {outputUri != null ? (
                <span data-testid="output-uri">
                  <S3Value uri={outputUri} isPrefix />
                </span>
              ) : (
                <span>—</span>
              )}
            </div>
            <div>
              <Box variant="awsui-key-label">Engine version</Box>
              <span data-testid="engine-version">{engineVersion ?? '—'}</span>
            </div>
          </ColumnLayout>
        )}

        {params != null && (
          <div data-testid="run-parameters">
            <Box variant="awsui-key-label">Parameters</Box>
            <Table<{ key: string; value: unknown }>
              variant="embedded"
              items={Object.entries(params)
                .map(([key, value]) => ({ key, value }))
                .sort((a, b) => a.key.localeCompare(b.key))}
              trackBy="key"
              ariaLabels={{ tableLabel: 'Run parameters' }}
              columnDefinitions={[
                {
                  id: 'parameter',
                  header: 'Parameter',
                  cell: (item) => <Box variant="samp">{item.key}</Box>,
                },
                {
                  id: 'value',
                  header: 'Value',
                  cell: (item) => <ParamValue value={item.value} />,
                },
              ]}
              empty={
                <Box textAlign="center" color="inherit">
                  No parameters.
                </Box>
              }
            />
          </div>
        )}

        {runConfigEntries.length > 0 && (
          <div data-testid="run-configuration">
            <Box variant="awsui-key-label">Run configuration</Box>
            <Table<{ key: string; label: string; value: string }>
              variant="embedded"
              items={runConfigEntries}
              trackBy="key"
              ariaLabels={{ tableLabel: 'Run configuration' }}
              columnDefinitions={[
                {
                  id: 'setting',
                  header: 'Setting',
                  cell: (item) => item.label,
                },
                {
                  id: 'value',
                  header: 'Value',
                  cell: (item) => <Box variant="samp">{item.value}</Box>,
                },
              ]}
              empty={
                <Box textAlign="center" color="inherit">
                  No run configuration.
                </Box>
              }
            />
          </div>
        )}

        {tagEntries.length > 0 && (
          <div data-testid="run-tags">
            <Box variant="awsui-key-label">Tags</Box>
            <Table<{ key: string; value: unknown }>
              variant="embedded"
              items={tagEntries
                .map(([key, value]) => ({ key, value }))
                .sort((a, b) => a.key.localeCompare(b.key))}
              trackBy="key"
              ariaLabels={{ tableLabel: 'Run tags' }}
              columnDefinitions={[
                {
                  id: 'key',
                  header: 'Tag',
                  cell: (item) => <Box variant="samp">{item.key}</Box>,
                },
                {
                  id: 'value',
                  header: 'Value',
                  cell: (item) => (
                    <Box variant="samp">
                      {item.value == null ? '—' : String(item.value)}
                    </Box>
                  ),
                },
              ]}
              empty={
                <Box textAlign="center" color="inherit">
                  No tags.
                </Box>
              }
            />
          </div>
        )}
      </SpaceBetween>
    </ExpandableSection>
  );
}

/** Renders a parameter value: S3 URIs as console links, else plain text. */
function ParamValue({ value }: { value: unknown }): React.JSX.Element {
  if (typeof value === 'string' && value.startsWith('s3://')) {
    return <S3Value uri={value} />;
  }
  const text =
    value === null || value === undefined
      ? '—'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return <Box variant="samp">{text}</Box>;
}

/**
 * Renders an s3:// URI as a link to the S3 console for that location, so
 * bioinformaticians can jump straight to inputs/outputs. Falls back to plain
 * text for non-S3 values.
 *
 * When `isPrefix` is set (e.g. a run's output location, which is a folder rather
 * than a single object), the console deep link's `prefix` param is completed
 * with a trailing '/' so S3 opens the folder/prefix view instead of trying to
 * resolve the path as an object. The displayed `s3://` text is left unchanged —
 * only the console link's prefix is normalized.
 */
function S3Value({
  uri,
  isPrefix = false,
}: {
  uri: string;
  isPrefix?: boolean;
}): React.JSX.Element {
  if (!uri.startsWith('s3://')) {
    return <Box variant="samp">{uri}</Box>;
  }
  // s3://bucket/key... -> console object browser URL.
  const withoutScheme = uri.slice('s3://'.length);
  const slash = withoutScheme.indexOf('/');
  const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const rawPrefix = slash === -1 ? '' : withoutScheme.slice(slash + 1);
  // For a prefix/folder link, ensure the prefix ends with '/' (only when there
  // is a non-empty prefix and it does not already end with one) so the console
  // completes the prefix and opens the folder view.
  const prefix =
    isPrefix && rawPrefix !== '' && !rawPrefix.endsWith('/')
      ? `${rawPrefix}/`
      : rawPrefix;
  const consoleUrl = `https://s3.console.aws.amazon.com/s3/buckets/${bucket}?prefix=${encodeURIComponent(
    prefix,
  )}`;
  return (
    <Link href={consoleUrl} external>
      {uri}
    </Link>
  );
}

/**
 * Color legend for task-status node colors in the DAG (Req 9.5).
 *
 * Renders a compact row of colored swatches with their status labels. To stay
 * relevant, it shows only the statuses actually present in the run's current
 * task set (in a stable canonical order), plus an "Unknown" swatch when any
 * task has no status. Colors come from the same `taskStatusColor` map the graph
 * nodes use, so the legend and nodes always agree.
 */
const LEGEND_STATUS_ORDER: readonly TaskStatus[] = [
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
];

function TaskStatusLegend({
  tasks,
  slowestId,
}: {
  tasks: readonly Task[];
  slowestId: string | null;
}): React.JSX.Element | null {
  // Which statuses are present in the current tasks?
  const present = new Set<TaskStatus>();
  let hasUnknown = false;
  for (const t of tasks) {
    if (t.status == null) {
      hasUnknown = true;
    } else {
      present.add(t.status);
    }
  }

  const entries: Array<{ key: string; label: string; color: string }> = [];
  for (const status of LEGEND_STATUS_ORDER) {
    if (present.has(status)) {
      entries.push({ key: status, label: status, color: taskStatusColor(status) });
    }
  }
  if (hasUnknown) {
    entries.push({ key: 'UNKNOWN', label: 'Unknown', color: taskStatusColor(null) });
  }

  if (entries.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="task status legend"
      data-testid="task-status-legend"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '12px',
        alignItems: 'center',
        rowGap: '6px',
      }}
    >
      <Box variant="awsui-key-label">Task status</Box>
      {entries.map((e) => (
        <span
          key={e.key}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 3,
              background: e.color,
              border: '1px solid rgba(0,0,0,0.2)',
            }}
          />
          <Box variant="small">{e.label}</Box>
        </span>
      ))}
      {/* Slowest-task cue is a ring on the DAG node, not a status fill — its
          swatch is an outline so the legend reads it as a highlight, not a
          status color. Shown only when a slowest task exists. */}
      {slowestId != null && (
        <span
          data-testid="legend-slowest"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 3,
              background: 'transparent',
              border: `2px solid ${SLOWEST_TASK_COLOR}`,
              boxSizing: 'border-box',
            }}
          />
          <Box variant="small">Slowest task</Box>
        </span>
      )}
    </div>
  );
}

/**
 * Self-contained DAG node-search box (perf isolation).
 *
 * PROBLEM this solves: previously the search input was bound directly to a
 * state variable owned by {@link RunDetailView}. That view is very large — it
 * renders the full-width ReactFlow DAG (which can hold hundreds of nodes), the
 * analysis stack, the run-level context band, and the (unmemoized) toolbar +
 * legend. Binding the input at that level meant EVERY keystroke re-rendered the
 * entire view and forced React to reconcile that whole subtree, which is the
 * source of the typing lag in the search box.
 *
 * FIX: this component owns the immediate, per-keystroke input value locally, so
 * typing re-renders ONLY this small box. It debounces that value internally
 * (~200ms) and pushes just the settled value up to the parent via
 * `onDebouncedQueryChange`. The parent therefore re-renders (and recomputes the
 * expensive match/dim/fitView work) at most once per settled query rather than
 * once per keystroke. The component is wrapped in `React.memo` so a parent
 * re-render for unrelated reasons (e.g. a live task update) does not re-render
 * or reset the box while the operator is typing.
 *
 * The match-count badge is rendered here (keyed off the local query being
 * non-empty, matching the previous "show while typing" behavior) using the
 * `searchMatchCount` the parent computes from the debounced query.
 */
const NodeSearchBox = memo(function NodeSearchBox({
  onDebouncedQueryChange,
  searchMatchCount,
}: {
  onDebouncedQueryChange: (value: string) => void;
  searchMatchCount: number;
}): React.JSX.Element {
  // Instant, fully-controlled input value — updates synchronously on every
  // keystroke so the box never feels laggy. Local to this small component.
  const [query, setQuery] = useState('');

  // Debounce the local query and push only the settled value to the parent.
  // A pending timeout is cleared on each change (and on unmount) so only the
  // last keystroke takes effect, throttling the parent's expensive downstream
  // work (match computation, per-node re-decoration, animated fitView).
  useEffect(() => {
    const handle = setTimeout(() => {
      onDebouncedQueryChange(query);
    }, 200);
    return () => clearTimeout(handle);
  }, [query, onDebouncedQueryChange]);

  return (
    <div
      data-testid="node-search"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        maxWidth: 420,
        flex: '1 1 240px',
      }}
    >
      <div style={{ flex: 1 }}>
        <Input
          type="search"
          value={query}
          onChange={({ detail }) => setQuery(detail.value)}
          placeholder="Search tasks by name…"
          ariaLabel="Search task nodes by name"
          data-testid="node-search-input"
        />
      </div>
      {query.trim() !== '' && (
        <span data-testid="node-search-count">
          <Badge color={searchMatchCount > 0 ? 'blue' : 'grey'}>
            {searchMatchCount} match
            {searchMatchCount === 1 ? '' : 'es'}
          </Badge>
        </span>
      )}
    </div>
  );
});

/**
 * Consolidated DAG toolbar (Req 3.3): the DAG's controls presented as a single
 * compact toolbar ON the DAG rather than as separate stacked blocks. It groups,
 * on one wrapping row directly above the diagram:
 *
 *  - the node search box + its match-count badge (emphasize matches / dim the
 *    rest / fit the view to the matches — behavior unchanged, only relocated),
 *  - the failed/cancelled quick-filter toggle + its count badge (the badge always
 *    reflects the full failure count regardless of the toggle, Req 4.2), and
 *  - the task-status legend ({@link TaskStatusLegend}), which stays present so
 *    the node colors remain explained.
 *
 * This is presentation-only: it renders the same controls with the same testids
 * and callbacks the view already owned, merely composed into one toolbar so the
 * operator reads/acts on them in place beside the DAG rather than scrolling past
 * separate blocks. The node search is only meaningful for the node-edge layers,
 * so it is gated by `showNodeSearch` (hidden for the Timeline_View fallback).
 */
function DagToolbar({
  tasks,
  slowestId,
  showFailedOnly,
  onShowFailedOnlyChange,
  failedCount,
  onDebouncedQueryChange,
  searchMatchCount,
  showNodeSearch,
}: {
  tasks: readonly Task[];
  slowestId: string | null;
  showFailedOnly: boolean;
  onShowFailedOnlyChange: (checked: boolean) => void;
  failedCount: number;
  /**
   * Called with the DEBOUNCED search query (~200ms after typing settles). The
   * immediate per-keystroke value is owned by {@link NodeSearchBox}, so the
   * parent view only re-renders on the settled value — see the perf note on
   * `debouncedNodeSearchQuery` in {@link RunDetailView}.
   */
  onDebouncedQueryChange: (value: string) => void;
  searchMatchCount: number;
  showNodeSearch: boolean;
}): React.JSX.Element {
  return (
    <div
      aria-label="DAG toolbar"
      data-testid="dag-toolbar"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '10px 20px',
        rowGap: '10px',
      }}
    >
      {/* Node search: emphasize matching task nodes, dim the rest, and fit the
          view to the matches. Empty query restores the normal view. Hidden for
          the Timeline_View fallback, where there are no diagram nodes. The box
          owns its own instant input + debounce so typing does not re-render the
          parent view (perf). */}
      {showNodeSearch && (
        <NodeSearchBox
          onDebouncedQueryChange={onDebouncedQueryChange}
          searchMatchCount={searchMatchCount}
        />
      )}

      {/* Failed-task quick filter and count badge (Req 4.1, 4.2). The badge
          shows the number of FAILED/CANCELLED tasks in the run; the toggle
          restricts the graph/timeline to just those tasks. */}
      <div
        aria-label="failed task filter"
        style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
      >
        <Toggle
          checked={showFailedOnly}
          onChange={({ detail }) => onShowFailedOnlyChange(detail.checked)}
          data-testid="failed-filter-toggle"
        >
          Show failed / cancelled only
        </Toggle>
        <span aria-label="failed task count" data-testid="failed-count-badge">
          <Badge color={failedCount > 0 ? 'red' : 'grey'}>
            {failedCount} failed / cancelled
          </Badge>
        </span>
      </div>

      {/* Task-status color legend, kept in the toolbar so the DAG node colors
          stay explained without a separate stacked block (Req 3.3, 9.5). */}
      <TaskStatusLegend tasks={tasks} slowestId={slowestId} />
    </div>
  );
}

/** Grouped-by-status list for the Timeline_View layer (Req 7.4, 7.6). */
function TimelineList({
  timeline,
}: {
  timeline: ReturnType<typeof buildTimelineView>;
}): React.JSX.Element {
  return (
    <div data-testid="timeline-view">
      <SpaceBetween size="m">
        {timeline.orderingUnavailable && (
          <Alert type="info" data-testid="ordering-unavailable">
            Ordering data unavailable.
          </Alert>
        )}
        {timeline.groups.map((group) => (
          <Container
            key={group.status}
            header={
              <Header variant="h3">
                <StatusIndicator
                  type={statusIndicatorType(
                    group.status === 'UNKNOWN' ? null : group.status,
                  )}
                >
                  {group.status}
                </StatusIndicator>
              </Header>
            }
          >
            <ul>
              {group.tasks.map((task) => (
                <li key={task.taskId}>{task.name ?? task.taskId}</li>
              ))}
            </ul>
          </Container>
        ))}
      </SpaceBetween>
    </div>
  );
}

/**
 * Format a nullable millisecond duration as `HH:MM:SS`, or the Unknown_State
 * dash when the value is `null` (no fabrication — an unknown segment shows `—`).
 */
function formatMsOrDash(ms: number | null): string {
  return ms == null ? '—' : formatDuration(ms);
}

/**
 * Per-run resource summary card (enhancement 2, Req 2.4–2.7, 11.1).
 *
 * Renders peak concurrent tasks/CPUs, CPU-hours, and peak memory. Each metric
 * that is `available: false` renders an explicit "unavailable" affordance
 * rather than a fabricated `0`. The peak-memory metric always shows its
 * unconfirmed-units caveat (the metric's `note`). When the summary is `partial`
 * (a task is still running), a provisional indicator is shown because the
 * values are lower bounds.
 */
function ResourceSummaryCard({
  summary,
}: {
  summary: ResourceSummary;
}): React.JSX.Element {
  const metricText = (value: number | null): string =>
    value == null ? '' : String(value);

  // A single metric shown inline as "Label: value". Unavailable metrics render
  // an "n/a" affordance rather than a fabricated 0 (Req 2.5, 2.6). `trailing`
  // carries the memory units-caveat popover next to its value.
  const metric = (
    label: string,
    testid: string,
    available: boolean,
    valueNode: React.ReactNode,
    trailing?: React.ReactNode,
  ): React.JSX.Element => (
    <span
      style={{ display: 'inline-flex', alignItems: 'baseline', gap: '4px' }}
    >
      <Box variant="awsui-key-label" display="inline">
        {label}
      </Box>
      {available ? (
        <span data-testid={testid}>{valueNode}</span>
      ) : (
        <span
          data-testid={`${testid}-unavailable`}
          title="unavailable"
          aria-label="unavailable"
        >
          <Box variant="small" color="text-status-inactive" display="inline">
            n/a
          </Box>
        </span>
      )}
      {trailing}
    </span>
  );

  // The memory metric now carries a confirmed unit (GiB) plus a short note
  // explaining it is the peak SUM of reserved memory across concurrent tasks.
  // The note is tucked behind an info popover so it costs no vertical space in
  // the strip; the unit is shown inline next to the value (below).
  const memoryCaveat =
    summary.peakConcurrentMemory.note != null ? (
      <Popover
        dismissButton={false}
        position="top"
        size="medium"
        triggerType="custom"
        content={
          <span data-testid="memory-units-caveat">
            {summary.peakConcurrentMemory.note}
          </span>
        }
      >
        <Box
          variant="small"
          color="text-status-info"
          data-testid="memory-units-info"
        >
          <StatusIndicator type="info" />
        </Box>
      </Popover>
    ) : undefined;

  // Format the peak-memory value with its confirmed unit (e.g. "128 GiB"); an
  // unavailable metric renders the "n/a" affordance instead (handled below).
  const memoryValueText =
    summary.peakConcurrentMemory.value != null
      ? summary.peakConcurrentMemory.unit != null
        ? `${summary.peakConcurrentMemory.value} ${summary.peakConcurrentMemory.unit}`
        : String(summary.peakConcurrentMemory.value)
      : '';

  return (
    <div
      data-testid="resource-summary"
      aria-label="resource summary"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: '6px 20px',
        rowGap: '6px',
      }}
    >
      <Box variant="awsui-key-label" display="inline">
        Resource summary
      </Box>
      {metric(
        'Peak tasks',
        'metric-peak-tasks',
        true,
        summary.peakConcurrentTasks,
      )}
      {metric(
        'Peak vCPUs',
        'metric-peak-cpus',
        summary.peakConcurrentCpus.available,
        metricText(summary.peakConcurrentCpus.value),
      )}
      {metric(
        'CPU-hours',
        'metric-cpu-hours',
        summary.cpuHours.available,
        summary.cpuHours.value != null ? summary.cpuHours.value.toFixed(2) : '',
      )}
      {metric(
        'Peak memory',
        'metric-peak-memory',
        summary.peakConcurrentMemory.available,
        memoryValueText,
        memoryCaveat,
      )}
      {summary.partial && (
        <span data-testid="resource-summary-partial">
          <Badge color="blue">provisional — run in progress</Badge>
        </span>
      )}
    </div>
  );
}

/**
 * Failed/cancelled task detail list (surfaces HealthOmics' `statusMessage` /
 * `failureReason` per task so an operator can see WHY each task failed without
 * opening its logs).
 *
 * Renders one row per failed/cancelled task with its own status detail; a
 * task whose `statusMessage` was never captured (e.g. a CANCELLED task, or a
 * FAILED task enriched before HealthOmics attached a message) shows an
 * explicit "No status detail captured" affordance rather than a fabricated
 * value. The task's `taskId` is always shown so it can be cross-referenced
 * with the DAG/timeline above.
 */
function FailedTasksList({
  tasks,
  onViewLogs,
}: {
  tasks: readonly Task[];
  /** Opens the given task's logs (deep link, mirrors clicking its DAG node). */
  onViewLogs: (taskId: string, label: string) => void;
}): React.JSX.Element {
  return (
    <Container
      data-testid="failed-tasks-list"
      header={
        <Header variant="h3">
          Failed / cancelled tasks
        </Header>
      }
    >
      <Table<Task>
        variant="embedded"
        items={tasks as Task[]}
        trackBy={(item) => item.taskId}
        columnDefinitions={[
          {
            id: 'name',
            header: 'Task',
            width: 240,
            cell: (item) => (
              <SpaceBetween direction="horizontal" size="xs">
                <span>{item.name ?? item.taskId}</span>
                <StatusIndicator type={statusIndicatorType(item.status ?? null)}>
                  {item.status ?? 'UNKNOWN'}
                </StatusIndicator>
              </SpaceBetween>
            ),
          },
          {
            id: 'detail',
            header: 'Status detail',
            cell: (item) =>
              item.statusMessage != null ? (
                // Wrap long status messages instead of forcing horizontal
                // scroll: `overflowWrap: anywhere` breaks even long unbroken
                // tokens (e.g. ARNs / paths) so the cell grows in height, not
                // width, keeping the actions column (the View logs button)
                // visible without sideways scrolling.
                <div style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                  <SpaceBetween size="xxs">
                    <span data-testid="failed-task-message">{item.statusMessage}</span>
                    {item.failureReason != null && (
                      <Box variant="small" color="text-status-inactive">
                        Reason code:{' '}
                        <span data-testid="failed-task-reason">{item.failureReason}</span>
                      </Box>
                    )}
                  </SpaceBetween>
                </div>
              ) : (
                <Box variant="small" color="text-status-inactive">
                  No status detail captured.
                </Box>
              ),
          },
          {
            id: 'actions',
            header: '',
            width: 130,
            minWidth: 130,
            cell: (item) => (
              <Button
                onClick={() => onViewLogs(item.taskId, item.name ?? item.taskId)}
                data-testid="failed-task-view-logs"
              >
                View logs
              </Button>
            ),
          },
        ]}
        empty={<Box textAlign="center">No failed or cancelled tasks.</Box>}
      />
    </Container>
  );
}

/**
 * Longest-running tasks list (enhancement 3, Req 3.3, 3.7).
 *
 * Ranks the run's top-N tasks by wall-clock duration. Labeled explicitly as
 * "longest-running tasks" — a wall-clock approximation, NOT a dependency-graph
 * critical path (Req 3.7). The slowest task (also highlighted on the DAG via
 * `slowestId`) is flagged in the list. Running tasks show elapsed-so-far and a
 * provisional marker.
 */
function LongestTasksList({
  tasks,
  slowestId,
  nowMs,
}: {
  tasks: readonly RankedTask[];
  slowestId: string | null;
  nowMs: number;
}): React.JSX.Element {
  return (
    <Container
      data-testid="longest-tasks"
      header={
        <Header variant="h3" description="Wall-clock approximation, not a dependency-graph critical path.">
          Longest-running tasks
        </Header>
      }
    >
      <Table<RankedTask>
        variant="embedded"
        items={tasks as RankedTask[]}
        trackBy={(item) => item.task.taskId}
        columnDefinitions={[
          {
            id: 'rank',
            header: 'Rank',
            cell: (item) => item.rank,
          },
          {
            id: 'name',
            header: 'Task',
            cell: (item) => (
              <SpaceBetween direction="horizontal" size="xs">
                <span>{item.task.name ?? item.task.taskId}</span>
                {slowestId != null && item.task.taskId === slowestId && (
                  <span data-testid="longest-tasks-slowest">
                    <Badge color="severity-medium">slowest</Badge>
                  </span>
                )}
              </SpaceBetween>
            ),
          },
          {
            id: 'duration',
            header: 'Duration',
            cell: (item) => (
              <SpaceBetween direction="horizontal" size="xxs">
                <span>{taskDuration(item.task, nowMs)}</span>
                {item.running && <Badge color="blue">running</Badge>}
              </SpaceBetween>
            ),
          },
        ]}
        empty={<Box textAlign="center">No timed tasks yet.</Box>}
      />
    </Container>
  );
}

/**
 * Per-task queue-wait vs run-time timeline (enhancement 8, Req 8.1–8.4, 12.x).
 *
 * Each task's time is split into queue-wait (`createdAt`→`startedAt`) and
 * run-time (`startedAt`→`stoppedAt`/now). Queue-wait is rendered under an
 * explicit unconfirmed-`createdAt` caveat (Req 12.3); run-time is rendered
 * WITHOUT the caveat because it does not depend on `createdAt` (Req 12.4).
 * Unknown segments show the Unknown_State dash rather than a fabricated value.
 */
function TaskSegmentsPanel({
  tasks,
  segments,
}: {
  tasks: readonly Task[];
  segments: readonly TaskSegments[];
}): React.JSX.Element {
  const nameById = new Map<string, string>();
  for (const t of tasks) {
    nameById.set(t.taskId, t.name ?? t.taskId);
  }

  return (
    <div data-testid="task-segments-body">
      <SpaceBetween size="s">
        {/* The queue-wait caveat is surfaced once for the whole panel (Req
            12.3); run-time carries no caveat (Req 12.4). */}
        <Alert type="info" data-testid="queue-wait-caveat">
          Queue-wait is derived from each task&apos;s <code>createdAt</code>, whose
          semantics are unconfirmed pending AWS documentation confirmation. Treat
          queue-wait as approximate; run-time does not depend on{' '}
          <code>createdAt</code>.
        </Alert>
        <Table<TaskSegments>
          variant="embedded"
          items={segments as TaskSegments[]}
          trackBy={(item) => item.taskId}
          columnDefinitions={[
            {
              id: 'name',
              header: 'Task',
              cell: (item) => nameById.get(item.taskId) ?? item.taskId,
            },
            {
              id: 'queueWait',
              header: 'Queue-wait (unconfirmed)',
              cell: (item) => (
                <span data-testid="segment-queue-wait">
                  {formatMsOrDash(item.queueWaitMs)}
                </span>
              ),
            },
            {
              id: 'runTime',
              header: 'Run-time',
              cell: (item) => (
                <SpaceBetween direction="horizontal" size="xxs">
                  <span data-testid="segment-run-time">
                    {formatMsOrDash(item.runTimeMs)}
                  </span>
                  {item.running && <Badge color="blue">running</Badge>}
                </SpaceBetween>
              ),
            },
          ]}
          empty={<Box textAlign="center">No task timing yet.</Box>}
        />
      </SpaceBetween>
    </div>
  );
}
