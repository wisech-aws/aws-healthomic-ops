/**
 * Fleet view (Cloudscape).
 *
 * On mount, queries `listRuns` exactly once (Req 8.1, 10.4) and renders each
 * run's status, workflow name, start time, and duration in a Cloudscape Table,
 * ordered by descending `updatedAt` with ties broken by descending start time
 * (Req 8.4, 8.7). Handles the loading (Req 10.1), error-with-retry
 * (Req 8.2, 10.2), and empty (Req 8.3, 10.3) states through the Table's built-in
 * `loading` and `empty` slots and a Cloudscape Alert.
 *
 * Live updates: a reconnecting `onRunUpdated` subscription feeds every incoming
 * run into {@link mergeRunUpdate}, so a displayed run is updated in place
 * (Req 8.5) and an undisplayed run is inserted in its ordered position
 * (Req 8.6), always subject to the fleet ordering (Req 8.10) and without a page
 * reload. When an update cannot be applied promptly a per-run loading indicator
 * is shown for the affected run instead of reloading the page (Req 8.11).
 *
 * Filtering, sorting, grouping (enhancements #5, #7): the run list is passed
 * through {@link applyFleetControls}, which composes a multi-status filter
 * (Req 5.1), a workflow filter (Req 5.2), and a recency-or-duration sort
 * (Req 5.5) while delegating recency to the existing `compareRuns` comparator so
 * the default ordering is preserved exactly (Req 5.4). An optional
 * engine-version grouping toggle renders one sub-table per engine version via
 * {@link groupByEngineVersion} (Req 7.3, 7.4); with grouping off the flat
 * ordered table is shown.
 *
 * Stale runs (enhancement #9): each row is evaluated with
 * {@link evaluateStaleness}, and a non-terminal run that has gone quiet past the
 * staleness threshold gets a warning badge (Req 9.1).
 *
 * Duration column (enhancement #1): each row shows its wall-clock duration via
 * `runDuration` (Req 1.1–1.3).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Table from '@cloudscape-design/components/table';
import type { TableProps } from '@cloudscape-design/components/table';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Link from '@cloudscape-design/components/link';
import Alert from '@cloudscape-design/components/alert';
import Header from '@cloudscape-design/components/header';
import Badge from '@cloudscape-design/components/badge';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import Multiselect from '@cloudscape-design/components/multiselect';
import type { MultiselectProps } from '@cloudscape-design/components/multiselect';
import Toggle from '@cloudscape-design/components/toggle';
import FormField from '@cloudscape-design/components/form-field';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Spinner from '@cloudscape-design/components/spinner';
import TextFilter from '@cloudscape-design/components/text-filter';
import Pagination from '@cloudscape-design/components/pagination';
import { listRuns as defaultListRuns, onRunUpdated } from '../api/client';
import type { Subscription, SubscriptionHandlers } from '../api/client';
import type { Run, RunConnection, RunStatus } from '../api/types';
import { createReconnectingSubscription } from '../api/subscriptionManager';
import { mergeRunUpdate } from './ordering';
import {
  applyFleetControls,
  groupByEngineVersion,
  groupByBatchId,
  workflowOptions,
  searchRuns,
  paginate,
} from './runFilters';
import type {
  FleetControls,
  FleetSortKey,
  SortDirection,
} from './runFilters';
import { evaluateStaleness } from './staleness';
import { statusIndicatorType } from './statusIndicator';
import { formatStartTime, runDuration } from './duration';

/** Loading/error/ready phases of the initial `listRuns` query (Req 10.1–10.3). */
type LoadPhase = 'loading' | 'error' | 'ready';

/** All selectable run statuses, used to populate the status-filter control. */
const RUN_STATUSES: readonly RunStatus[] = [
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'DELETED',
  'CANCELLED',
  'FAILED',
];

/** The "all workflows" sentinel option for the workflow-filter Select. */
const ALL_WORKFLOWS_OPTION: SelectProps.Option = {
  label: 'All workflows',
  value: '',
};

/** Sort key options for the sort Select. */
const SORT_KEY_OPTIONS: readonly SelectProps.Option[] = [
  { label: 'Recency', value: 'recency' },
  { label: 'Duration', value: 'duration' },
];

/** Sort direction options for the direction Select. */
const SORT_DIRECTION_OPTIONS: readonly SelectProps.Option[] = [
  { label: 'Descending', value: 'desc' },
  { label: 'Ascending', value: 'asc' },
];

/** Label used for the group whose runs have no engine version (Req 7.2/7.4). */
const UNKNOWN_ENGINE_LABEL = 'Unknown engine version';

/** Label used for the group whose runs were not started as part of a batch. */
const NO_BATCH_LABEL = 'No batch';

/**
 * Opens the live `onRunUpdated` subscription. Matches the injectable
 * `SubscribeFactory<Run>` shape so tests can supply a stub that drives updates
 * synchronously; defaults to the real client subscription.
 */
export type SubscribeRuns = (handlers: SubscriptionHandlers<Run>) => Subscription;

const defaultSubscribeRuns: SubscribeRuns = (handlers) => onRunUpdated(handlers);

/**
 * Imperative controls the view can hand back to a parent (or a test) so an
 * update source that cannot apply an update promptly can flag the affected run
 * as pending (Req 8.11). `markRunPending(runId)` shows the per-run loading
 * indicator; the next applied update for that run clears it.
 */
export interface FleetViewControls {
  readonly markRunPending: (runId: string) => void;
  readonly applyRunUpdate: (updatedRun: Run) => void;
}

/**
 * Props for {@link FleetView}. `listRuns` and `subscribe` are injectable so
 * tests (and later a different data source) can supply stubs; both default to
 * the real client. `onReady` receives the imperative {@link FleetViewControls}
 * once the view is mounted, used to drive the transient per-run pending state
 * (Req 8.11). `now` and `staleThresholdMs` are injectable so staleness is
 * deterministic in tests (Req 1.5, 9.2).
 */
export interface FleetViewProps {
  readonly listRuns?: (variables?: {
    limit?: number;
    nextToken?: string;
  }) => Promise<RunConnection>;
  readonly subscribe?: SubscribeRuns;
  readonly onReady?: (controls: FleetViewControls) => void;
  /**
   * Called with a run's id when the operator selects its row, so a parent can
   * navigate to that run's detail view (the task DAG). When omitted, the
   * workflow cell is plain text rather than a link.
   */
  readonly onSelectRun?: (runId: string) => void;
  /**
   * Called with two run ids when the operator selects exactly two runs and
   * chooses to compare their parameters (enhancement #6, Req 6.7). When
   * omitted, no compare affordance is shown and row selection is disabled, so
   * the fleet behaves exactly as before.
   */
  readonly onCompareRuns?: (leftRunId: string, rightRunId: string) => void;
  /**
   * Fixed "now" in epoch milliseconds for deterministic duration/staleness
   * derivation (Req 1.5). Defaults to the current instant.
   */
  readonly now?: number;
  /** Staleness threshold in milliseconds (Req 9.2). Defaults to one hour. */
  readonly staleThresholdMs?: number;
}

/** A Cloudscape status indicator for a run's `Run_Status` (Req 8.7). */
function StatusCell({
  run,
  pending,
}: {
  run: Run;
  pending: boolean;
}): React.JSX.Element {
  const label = run.status ?? 'UNKNOWN';
  return (
    <SpaceBetween direction="horizontal" size="xs">
      {/* aria-label preserved for accessibility and test selectors. */}
      <span aria-label={`status ${label}`}>
        <StatusIndicator type={statusIndicatorType(run.status)}>
          {label}
        </StatusIndicator>
      </span>
      {pending && (
        <span role="status" aria-label={`updating run ${run.runId}`}>
          <Spinner size="normal" />
        </span>
      )}
    </SpaceBetween>
  );
}
/**
 * Maximum number of runs the fleet loads into memory (hybrid paging cap). The
 * list is fetched by following the `nextToken` cursor page-by-page until this
 * cap is reached, then paged/filtered/sorted/grouped client-side. This bounds
 * memory and network for a large fleet (e.g. 50k+ runs) while keeping the rich
 * client-side controls (status/workflow filter, sort, group, search) working
 * over the loaded set. When the cap is hit, the UI surfaces a "showing first N"
 * notice so the list is never silently presented as complete.
 */
const FLEET_LOAD_CAP = 1000;

/** Per-request page size used while paging the fleet with `nextToken`. */
const FLEET_FETCH_PAGE_SIZE = 100;


export default function FleetView({
  listRuns = defaultListRuns,
  subscribe = defaultSubscribeRuns,
  onReady,
  onSelectRun,
  onCompareRuns,
  now,
  staleThresholdMs,
}: FleetViewProps = {}): React.JSX.Element {
  const [phase, setPhase] = useState<LoadPhase>('loading');
  const [runs, setRuns] = useState<Run[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // True when the load hit the FLEET_LOAD_CAP and more runs exist server-side
  // than were loaded, so the UI can honestly say the list is capped.
  const [loadCapped, setLoadCapped] = useState(false);
  // Multi-status filter: an empty set means "all statuses" (Req 5.1).
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<RunStatus>>(
    () => new Set(),
  );
  // Workflow filter: null means "all workflows" (Req 5.2).
  const [workflowFilter, setWorkflowFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<FleetSortKey>('recency');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  // Free-form text search over the loaded runs (name/id/workflow/status/etc.).
  // Empty => no search filtering.
  const [searchQuery, setSearchQuery] = useState('');
  // Client-side pagination of the flat (ungrouped) run list.
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 25;
  // Grouping mode (Req 7.3, 7.4). 'none' => flat ordered table; 'engine' =>
  // one sub-table per engine version; 'batch' => one sub-table per batch id.
  // A single mode keeps the two group-by toggles mutually exclusive.
  const [groupMode, setGroupMode] = useState<'none' | 'engine' | 'batch'>(
    'none',
  );
  // Run ids whose update is still being applied — drives the per-run loading
  // indicator (Req 8.11). A transient state that a caller can set and clear.
  const [pendingRunIds, setPendingRunIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Rows selected for the two-run parameters comparison (enhancement #6,
  // Req 6.7). Only used when `onCompareRuns` is provided; the "Compare
  // parameters" action is enabled once exactly two runs are selected.
  const [selectedRuns, setSelectedRuns] = useState<readonly Run[]>([]);

  // Guards the "query exactly once per mount" contract (Req 10.4) against React
  // 18/19 StrictMode double-invocation of effects in development.
  const hasQueried = useRef(false);

  const load = useCallback(async () => {
    setPhase('loading');
    setErrorMessage(null);
    try {
      // Hybrid paging: fetch page-by-page following `nextToken` until the
      // FLEET_LOAD_CAP is reached (or the server has no more pages), then page
      // client-side. This never loads an unbounded number of runs while still
      // giving the client-side filter/sort/group/search the full loaded set.
      const collected: Run[] = [];
      let nextToken: string | undefined;
      let capped = false;
      do {
        const remaining = FLEET_LOAD_CAP - collected.length;
        const limit = Math.min(FLEET_FETCH_PAGE_SIZE, remaining);
        const connection = await listRuns({ limit, nextToken });
        collected.push(...connection.items);
        nextToken = connection.nextToken ?? undefined;
        if (collected.length >= FLEET_LOAD_CAP) {
          // Hit the cap: there may be more runs server-side than we loaded.
          capped = nextToken !== undefined;
          break;
        }
      } while (nextToken !== undefined);

      setRuns(collected);
      setLoadCapped(capped);
      setPhase('ready');
    } catch (error) {
      // Retain previously loaded content; only swap in the error state (Req 10.2).
      setErrorMessage(
        error instanceof Error ? error.message : 'Runs could not be loaded.',
      );
      setPhase('error');
    }
  }, [listRuns]);

  useEffect(() => {
    if (hasQueried.current) {
      return;
    }
    hasQueried.current = true;
    void load();
  }, [load]);

  // Applies an incoming run update from any source subject to the fleet
  // ordering (Req 8.5, 8.6, 8.10). Clears any pending indicator for that run
  // once the merge is committed (Req 8.11). No page reload occurs — this is a
  // pure state transition.
  const applyRunUpdate = useCallback((updatedRun: Run) => {
    setRuns((current) => mergeRunUpdate(current, updatedRun));
    setPendingRunIds((current) => {
      if (!current.has(updatedRun.runId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(updatedRun.runId);
      return next;
    });
  }, []);

  // Marks a run as awaiting an update so its row shows a loading indicator
  // (Req 8.11). Exposed as a transient state that update sources can trigger
  // when they cannot apply an update promptly; the next `applyRunUpdate` for
  // that run clears it.
  const markRunPending = useCallback((runId: string) => {
    setPendingRunIds((current) => {
      if (current.has(runId)) {
        return current;
      }
      const next = new Set(current);
      next.add(runId);
      return next;
    });
  }, []);

  // Hand the imperative controls back to a parent/test once, after mount, so an
  // update source can flag a run as pending (Req 8.11) or apply an update.
  useEffect(() => {
    onReady?.({ markRunPending, applyRunUpdate });
  }, [onReady, markRunPending, applyRunUpdate]);

  // Open the live, reconnecting subscription for the lifetime of the mount
  // (Req 8.5, 8.6, 10.5, 10.6). The subscribe factory is injectable for tests.
  useEffect(() => {
    const managed = createReconnectingSubscription<Run>({
      subscribe,
      onNext: applyRunUpdate,
    });
    return () => managed.stop();
  }, [subscribe, applyRunUpdate]);

  // Retry re-issues the query on demand (Req 8.2). Allowed because it is a
  // user-initiated action, not the automatic per-mount query.
  const handleRetry = useCallback(() => {
    void load();
  }, [load]);

  const hasStatusFilter = statusFilter.size > 0;
  const hasAnyFilter = hasStatusFilter || workflowFilter != null;

  // The active fleet controls (Req 5.1, 5.2, 5.5). A null status set means
  // "all statuses" for applyFleetControls; an empty UI selection maps to that.
  const controls: FleetControls = useMemo(
    () => ({
      statuses: hasStatusFilter ? statusFilter : null,
      workflowId: workflowFilter,
      sortKey,
      direction: sortDirection,
    }),
    [hasStatusFilter, statusFilter, workflowFilter, sortKey, sortDirection],
  );

  // Filtered + sorted + text-searched list (Req 5.1–5.6). applyFleetControls
  // copies its input and delegates recency to the existing comparator, so the
  // default (recency, no filters, no search) reproduces the existing fleet
  // ordering (Req 5.4). The free-form search is applied last so it narrows the
  // already filtered/sorted set (and feeds both grouping and pagination).
  const displayedRuns = useMemo(
    () => searchRuns(applyFleetControls(runs, controls, now), searchQuery),
    [runs, controls, now, searchQuery],
  );

  // Distinct workflow options for the workflow filter, derived from the loaded
  // runs (Req 5.2). Uses the unfiltered list so the option set is stable.
  const workflowFilterOptions = useMemo(() => workflowOptions(runs), [runs]);

  // Groups for the grouped render (Req 7.3, 7.4). Computed for the active mode
  // only; each is a list of { label, runs } preserving input order per group.
  // Standalone/absent keys render under an explicit "Unknown"/"No batch" label.
  const groups = useMemo<Array<{ key: string; label: string; runs: Run[] }>>(() => {
    if (groupMode === 'engine') {
      return groupByEngineVersion(displayedRuns).map((g) => ({
        key: g.engineVersion ?? '__unknown_engine__',
        label: g.engineVersion ?? UNKNOWN_ENGINE_LABEL,
        runs: g.runs,
      }));
    }
    if (groupMode === 'batch') {
      return groupByBatchId(displayedRuns).map((g) => ({
        key: g.batchId ?? '__no_batch__',
        label: g.batchId ?? NO_BATCH_LABEL,
        runs: g.runs,
      }));
    }
    return [];
  }, [groupMode, displayedRuns]);

  // Client-side pagination of the flat (ungrouped) list. Grouped views are not
  // paged — grouping already partitions the list into sub-tables. `paginate`
  // clamps the page, so a shrinking result set never strands the view on an
  // empty page.
  const page = useMemo(
    () => paginate(displayedRuns, currentPage, PAGE_SIZE),
    [displayedRuns, currentPage],
  );
  // If the clamped current page differs from state (e.g. the list shrank after
  // a filter/search), sync state so the Pagination control reflects reality.
  useEffect(() => {
    if (page.currentPage !== currentPage) {
      setCurrentPage(page.currentPage);
    }
  }, [page.currentPage, currentPage]);

  const handleClearFilters = useCallback(() => {
    setStatusFilter(new Set());
    setWorkflowFilter(null);
  }, []);

  // Whether the compare affordance is enabled: exactly two runs selected
  // (enhancement #6, Req 6.7).
  const canCompare = onCompareRuns != null && selectedRuns.length === 2;

  const handleCompare = useCallback(() => {
    if (onCompareRuns != null && selectedRuns.length === 2) {
      onCompareRuns(selectedRuns[0].runId, selectedRuns[1].runId);
    }
  }, [onCompareRuns, selectedRuns]);

  // Error state: a dismissible-free Alert with a retry action (Req 8.2, 10.2).
  if (phase === 'error') {
    return (
      <Alert
        type="error"
        header="Runs could not be loaded"
        action={<Button onClick={handleRetry}>Retry</Button>}
      >
        {errorMessage ?? 'Runs could not be loaded.'}
      </Alert>
    );
  }

  const selectedStatusOptions: MultiselectProps.Option[] = Array.from(
    statusFilter,
    (status) => ({ label: status, value: status }),
  );

  const selectedWorkflowOption: SelectProps.Option =
    workflowFilter == null
      ? ALL_WORKFLOWS_OPTION
      : {
          label:
            workflowFilterOptions.find((o) => o.id === workflowFilter)?.label ??
            workflowFilter,
          value: workflowFilter,
        };

  const selectedSortKeyOption =
    SORT_KEY_OPTIONS.find((o) => o.value === sortKey) ?? SORT_KEY_OPTIONS[0];
  const selectedSortDirectionOption =
    SORT_DIRECTION_OPTIONS.find((o) => o.value === sortDirection) ??
    SORT_DIRECTION_OPTIONS[0];

  // Filter/sort/group controls, rendered above the table.
  const filterControl = (
    <div data-testid="fleet-controls">
      <SpaceBetween direction="horizontal" size="s">
        <FormField label="Filter by status">
          <Multiselect
            selectedOptions={selectedStatusOptions}
            onChange={({ detail }) => {
              const next = new Set<RunStatus>(
                detail.selectedOptions
                  .map((o) => o.value)
                  .filter((v): v is RunStatus => v != null)
                  .map((v) => v as RunStatus),
              );
              setStatusFilter(next);
            }}
            options={RUN_STATUSES.map((status) => ({
              label: status,
              value: status,
            }))}
            placeholder="All statuses"
            ariaLabel="Filter by status"
            data-testid="fleet-status-filter"
          />
        </FormField>
        <FormField label="Filter by workflow">
          <Select
            selectedOption={selectedWorkflowOption}
            onChange={({ detail }) => {
              const value = detail.selectedOption.value ?? '';
              setWorkflowFilter(value === '' ? null : value);
            }}
            options={[
              ALL_WORKFLOWS_OPTION,
              ...workflowFilterOptions.map((o) => ({
                label: o.label,
                value: o.id,
              })),
            ]}
            ariaLabel="Filter by workflow"
            data-testid="fleet-workflow-filter"
          />
        </FormField>
        <FormField label="Sort by">
          <Select
            selectedOption={selectedSortKeyOption}
            onChange={({ detail }) => {
              setSortKey(
                (detail.selectedOption.value as FleetSortKey) ?? 'recency',
              );
            }}
            options={[...SORT_KEY_OPTIONS]}
            ariaLabel="Sort by"
            data-testid="fleet-sort-key"
          />
        </FormField>
        <FormField label="Direction">
          <Select
            selectedOption={selectedSortDirectionOption}
            onChange={({ detail }) => {
              setSortDirection(
                (detail.selectedOption.value as SortDirection) ?? 'desc',
              );
            }}
            options={[...SORT_DIRECTION_OPTIONS]}
            ariaLabel="Sort direction"
            data-testid="fleet-sort-direction"
          />
        </FormField>
        <FormField label="Group by engine version">
          <Box padding={{ top: 'xxs' }}>
            <Toggle
              checked={groupMode === 'engine'}
              onChange={({ detail }) =>
                setGroupMode(detail.checked ? 'engine' : 'none')
              }
              ariaLabel="Group by engine version"
              data-testid="fleet-group-toggle"
            >
              Group
            </Toggle>
          </Box>
        </FormField>
        <FormField label="Group by batch">
          <Box padding={{ top: 'xxs' }}>
            <Toggle
              checked={groupMode === 'batch'}
              onChange={({ detail }) =>
                setGroupMode(detail.checked ? 'batch' : 'none')
              }
              ariaLabel="Group by batch"
              data-testid="fleet-group-batch-toggle"
            >
              Group
            </Toggle>
          </Box>
        </FormField>
        {hasAnyFilter && (
          <Box padding={{ top: 'l' }}>
            <Button onClick={handleClearFilters} data-testid="fleet-clear-filter">
              Clear filter
            </Button>
          </Box>
        )}
      </SpaceBetween>
    </div>
  );

  // Free-form search box stacked above the filter/sort/group controls. Feeds
  // the same client-side pipeline (search -> filter/sort -> group/paginate), so
  // it is shown in both the flat and grouped renders.
  const searchAndFilter = (
    <SpaceBetween size="xs">
      <TextFilter
        filteringText={searchQuery}
        filteringPlaceholder="Find a run (name, ID, workflow, status, batch…)"
        filteringAriaLabel="Find a run"
        onChange={({ detail }) => {
          setSearchQuery(detail.filteringText);
          setCurrentPage(1);
        }}
        countText={
          searchQuery.trim() !== ''
            ? `${displayedRuns.length} match${displayedRuns.length === 1 ? '' : 'es'}`
            : undefined
        }
        data-testid="fleet-search"
      />
      {filterControl}
    </SpaceBetween>
  );

  // Honest "showing first N" notice when the load hit the cap (more runs exist
  // server-side than are loaded). Filters/search/sort/group operate over the
  // loaded set; narrowing by status/workflow/search helps find capped runs.
  const cappedNotice = loadCapped ? (
    <Alert type="info" data-testid="fleet-capped-notice">
      Showing the most recent {runs.length.toLocaleString()} runs. More runs
      exist than are loaded here — narrow by status, workflow, or search to find
      a specific run.
    </Alert>
  ) : null;

  // Column definitions shared by the flat table and every grouped sub-table.
  const columnDefinitions: TableProps.ColumnDefinition<Run>[] = [
    {
      id: 'status',
      header: 'Status',
      cell: (run) => (
        <SpaceBetween direction="horizontal" size="xs">
          <StatusCell run={run} pending={pendingRunIds.has(run.runId)} />
          <StaleBadge run={run} thresholdMs={staleThresholdMs} now={now} />
        </SpaceBetween>
      ),
    },
    {
      id: 'workflow',
      header: 'Workflow',
      cell: (run) => {
        const workflow = run.workflowName ?? run.workflowId ?? '—';
        return onSelectRun ? (
          <Link
            href="#"
            ariaLabel={`View run ${run.name ?? run.runId}`}
            onFollow={(event) => {
              event.preventDefault();
              onSelectRun(run.runId);
            }}
          >
            {workflow}
          </Link>
        ) : (
          workflow
        );
      },
    },
    {
      id: 'runName',
      header: 'Run name',
      cell: (run) => (
        <span data-testid="run-name">{run.name ?? '—'}</span>
      ),
    },
    {
      id: 'runId',
      header: 'Run ID',
      cell: (run) => run.runId,
    },
    {
      id: 'workflowId',
      header: 'Workflow ID',
      cell: (run) => run.workflowId ?? '—',
    },
    {
      id: 'engineVersion',
      header: 'Engine version',
      cell: (run) => run.engineVersion ?? '—',
    },
    {
      id: 'batchId',
      header: 'Batch ID',
      cell: (run) => (
        <span data-testid="batch-id">{run.batchId ?? '—'}</span>
      ),
    },
    {
      id: 'startTime',
      header: 'Start time',
      cell: (run) => formatStartTime(run.startedAt),
    },
    {
      id: 'duration',
      header: 'Duration',
      cell: (run) => (
        <span aria-label={`duration run ${run.runId}`} data-testid="run-duration">
          {runDuration(run.startedAt, run.stoppedAt, now)}
        </span>
      ),
    },
  ];

  // Empty-state content distinguishes "no runs at all" from "no runs match the
  // active filter" so it is not mistaken for a data-loading problem.
  const emptyContent = (
    <Box textAlign="center" color="inherit">
      <b>{hasAnyFilter ? 'No runs match the active filter.' : 'No runs are available.'}</b>
    </Box>
  );

  const header = (
    <Header
      variant="h2"
      counter={`(${displayedRuns.length})`}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          {onCompareRuns != null && (
            <Button
              disabled={!canCompare}
              onClick={handleCompare}
              data-testid="fleet-compare-button"
            >
              Compare parameters
            </Button>
          )}
          <Button
            iconName="refresh"
            ariaLabel="Refresh runs"
            loading={phase === 'loading'}
            onClick={handleRetry}
          >
            Refresh
          </Button>
        </SpaceBetween>
      }
    >
      Run list
    </Header>
  );

  // Selection props enabling two-run comparison, applied only when a compare
  // handler is provided so the default fleet behaves exactly as before. Only at
  // most two runs may be selected at once (Req 6.7 compares exactly two runs).
  const selectionProps: Partial<TableProps<Run>> = onCompareRuns
    ? {
        selectionType: 'multi',
        selectedItems: [...selectedRuns],
        onSelectionChange: ({ detail }) =>
          setSelectedRuns(detail.selectedItems),
        isItemDisabled: (run: Run) =>
          selectedRuns.length >= 2 &&
          !selectedRuns.some((r) => r.runId === run.runId),
      }
    : {};

  // Aria labels for the fleet table, extended with selection labels when the
  // compare affordance is active so the checkboxes are accessible.
  const tableAriaLabels: TableProps.AriaLabels<Run> = onCompareRuns
    ? {
        tableLabel: 'Runs',
        selectionGroupLabel: 'Runs to compare',
        allItemsSelectionLabel: () => 'Select all runs',
        itemSelectionLabel: (_data, run) =>
          `Select run ${run.name ?? run.runId} for comparison`,
      }
    : { tableLabel: 'Runs' };

  // Grouped render (Req 7.3, 7.4): one sub-table per group (engine version or
  // batch id, per the active groupMode), in group order. The flat table (below)
  // is used when grouping is off. Test ids are prefixed per mode so each
  // grouping is independently targetable.
  if (groupMode !== 'none') {
    const testidPrefix = groupMode === 'engine' ? 'engine-group' : 'batch-group';
    const headerTestid =
      groupMode === 'engine' ? 'engine-group-header' : 'batch-group-header';
    return (
      <SpaceBetween size="l">
        {header}
        {searchAndFilter}
        {cappedNotice}
        {groups.length === 0 ? (
          <Table<Run>
            variant="borderless"
            loading={phase === 'loading'}
            loadingText="Loading runs…"
            items={[]}
            trackBy="runId"
            empty={emptyContent}
            ariaLabels={{ tableLabel: 'Runs' }}
            columnDefinitions={columnDefinitions}
          />
        ) : (
          groups.map((group) => (
            <div key={group.key} data-testid={`${testidPrefix}-${group.label}`}>
              <Table<Run>
                variant="borderless"
                loading={phase === 'loading'}
                loadingText="Loading runs…"
                items={group.runs}
                trackBy="runId"
                header={
                  <Header variant="h3" counter={`(${group.runs.length})`}>
                    <span data-testid={headerTestid}>{group.label}</span>
                  </Header>
                }
                empty={emptyContent}
                ariaLabels={{ tableLabel: `Runs for ${group.label}` }}
                columnDefinitions={columnDefinitions}
              />
            </div>
          ))
        )}
      </SpaceBetween>
    );
  }

  return (
    <Table<Run>
      variant="borderless"
      loading={phase === 'loading'}
      loadingText="Loading runs…"
      items={page.items}
      trackBy="runId"
      header={header}
      filter={
        cappedNotice ? (
          <SpaceBetween size="xs">
            {cappedNotice}
            {searchAndFilter}
          </SpaceBetween>
        ) : (
          searchAndFilter
        )
      }
      pagination={
        <Pagination
          currentPageIndex={page.currentPage}
          pagesCount={page.pageCount}
          onChange={({ detail }) => setCurrentPage(detail.currentPageIndex)}
          ariaLabels={{
            nextPageLabel: 'Next page',
            previousPageLabel: 'Previous page',
            pageLabel: (n) => `Page ${n} of ${page.pageCount}`,
          }}
        />
      }
      empty={emptyContent}
      ariaLabels={tableAriaLabels}
      columnDefinitions={columnDefinitions}
      {...selectionProps}
    />
  );
}

/**
 * Renders a warning badge when a run is stale (Req 9.1). A run is stale only
 * when it is non-terminal and its `updatedAt` is older than the threshold;
 * otherwise nothing is rendered. `now`/`thresholdMs` are injectable for
 * deterministic tests.
 */
function StaleBadge({
  run,
  thresholdMs,
  now,
}: {
  run: Run;
  thresholdMs?: number;
  now?: number;
}): React.JSX.Element | null {
  const staleness = evaluateStaleness(run, thresholdMs, now);
  if (!staleness.stale) {
    return null;
  }
  return (
    <span
      aria-label={`stale run ${run.runId}`}
      data-testid="stale-badge"
      title="This run is non-terminal but has not updated recently and may be stuck."
    >
      <Badge color="red">Stale</Badge>
    </span>
  );
}
