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
 * Progressive render: the load follows `nextToken` page-by-page and merges
 * each page into state as it arrives ({@link mergeRunPage}, deduped by runId,
 * newer `updatedAt` wins), so the first page's rows show immediately while the
 * rest load behind an aria-live "Loading more runs… (N loaded)" status. Every
 * load takes a generation number; a superseded or unmounted load stops at its
 * next await without touching state. A failure after rows are on screen keeps
 * them and shows a non-blocking, retryable warning instead of the full error.
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
import DateRangePicker, {
  type DateRangePickerProps,
} from '@cloudscape-design/components/date-range-picker';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Spinner from '@cloudscape-design/components/spinner';
import TextFilter from '@cloudscape-design/components/text-filter';
import Pagination from '@cloudscape-design/components/pagination';
import { listRuns as defaultListRuns, onRunUpdated } from '../api/client';
import type { Subscription, SubscriptionHandlers } from '../api/client';
import type { Run, RunConnection, RunStatus } from '../api/types';
import { createReconnectingSubscription } from '../api/subscriptionManager';
import { mergeRunPage, mergeRunUpdate } from './ordering';
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
import { resolveRange } from '../reports/dateRange';
import CopyId from '../components/CopyId';

/**
 * Loading/error/ready phases of the fleet query (Req 10.1–10.3). `loading` is
 * the BLOCKING state (table spinner, nothing to show yet); a progressive load
 * leaves it as soon as its first page lands, and a load that starts with rows
 * already on screen never enters it.
 */
type LoadPhase = 'loading' | 'error' | 'ready';

/** What triggered a fleet load: mount, Refresh/Retry, or a reconnect re-sync. */
type FleetLoadKind = 'cold' | 'refresh' | 'reconnect';

/**
 * Options for one fleet load. `reset` clears the current rows first (a window
 * change: the previous window's rows must not mix into the new one).
 */
interface LoadOptions {
  readonly kind: FleetLoadKind;
  readonly reset?: boolean;
}

/**
 * Background progress of an in-flight load once rows are visible. `more` =>
 * the first page is shown and later pages are still arriving; `updating` =>
 * a load started with rows already on screen (Refresh/reconnect).
 */
interface LoadProgress {
  readonly loaded: number;
  readonly mode: 'more' | 'updating';
}

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
    start?: string;
    end?: string;
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

/**
 * Relative-range presets for the time-window picker, mirroring the Reports view
 * (7/30/90 days). The default (no explicit range) resolves to the last 30 days.
 */
const FLEET_RELATIVE_OPTIONS: DateRangePickerProps.RelativeOption[] = [
  { key: 'prev-7', amount: 7, unit: 'day', type: 'relative' },
  { key: 'prev-30', amount: 30, unit: 'day', type: 'relative' },
  { key: 'prev-90', amount: 90, unit: 'day', type: 'relative' },
];

/** i18n strings for the time-window DateRangePicker (mirrors ReportsView). */
const FLEET_DATE_RANGE_I18N: DateRangePickerProps.I18nStrings = {
  relativeModeTitle: 'Relative range',
  absoluteModeTitle: 'Absolute range',
  relativeRangeSelectionHeading: 'Choose a range',
  formatRelativeRange: (e) => {
    const unit = e.amount === 1 ? e.unit : `${e.unit}s`;
    return `Last ${e.amount} ${unit}`;
  },
  formatUnit: (unit, value) => (value === 1 ? unit : `${unit}s`),
  startDateLabel: 'Start date',
  endDateLabel: 'End date',
  startTimeLabel: 'Start time',
  endTimeLabel: 'End time',
  clearButtonLabel: 'Clear',
  cancelButtonLabel: 'Cancel',
  applyButtonLabel: 'Apply',
  customRelativeRangeOptionLabel: 'Custom range',
  customRelativeRangeOptionDescription: 'Set a custom range',
  customRelativeRangeUnitLabel: 'Unit',
  customRelativeRangeDurationLabel: 'Duration',
  todayAriaLabel: 'Today',
  nextMonthAriaLabel: 'Next month',
  previousMonthAriaLabel: 'Previous month',
};


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
  // Background progress of an in-flight load while rows are visible (drives
  // the aria-live "Loading more runs…"/"Updating…" indicator); null when idle.
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  // Non-blocking, retryable notice for a load that failed after rows were
  // already on screen (a later page, or a Refresh/reconnect with rows shown).
  const [partialError, setPartialError] = useState<string | null>(null);
  // Epoch ms of the last load that COMPLETED (drives "Last refreshed").
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
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
  // Server-side time window on `updatedAt`. `null` resolves to the default
  // last-30-days window (resolveRange(null, nowMs)); the DateRangePicker shows
  // its "Last 30 days" placeholder until the operator applies a specific range.
  // A production account with thousands of runs/month narrows the server result
  // by window rather than relying on the client-side FLEET_LOAD_CAP.
  const [range, setRange] = useState<DateRangePickerProps.Value | null>(null);

  // Injected clock makes the default window and tests deterministic (Req 1.5).
  const nowMs = useMemo(() => now ?? Date.now(), [now]);
  // Concrete ISO window bounds as of this render's clock. Drives the live-update
  // window gate and the window-change effect; `load()` re-resolves open-to-now
  // windows at call time instead (see `load`), so only an absolute range's
  // bounds are sent from here verbatim.
  const windowRange = useMemo(() => resolveRange(range, nowMs), [range, nowMs]);
  // Discriminates an OPEN-TO-NOW window (default last-30-days or a relative
  // range, whose `end` is `resolveRange`'s `now`) from an ABSOLUTE past-bounded
  // range (a fixed historical `end`). Read off `range` rather than comparing
  // timestamps: `resolveRange` sets `end = now` only for `null`/relative, so
  // this is the authoritative, clock-free signal (BUG 2 upper-bound gate).
  const windowEndsAtNow = range == null || range.type === 'relative';

  // Guards the "query exactly once per mount" contract (Req 10.4) against React
  // 18/19 StrictMode double-invocation of effects in development.
  const hasQueried = useRef(false);

  // Latest-callback refs so the single subscription effect (below) can call the
  // CURRENT `applyRunUpdate`/`load` closures without being re-created when their
  // identity changes on a window/range change (BUG 1 subscription churn). An
  // effect with no dependency array keeps these pointed at the latest closures
  // every render. `seenFirstConnectRef` persists the skip-first-connect guard
  // across renders so it is not reset by a re-render (which would make every
  // first connect look "initial" and break genuine reconnect-refetch, Req 10.6).
  const applyRunUpdateRef = useRef<(updatedRun: Run) => void>(() => {});
  const loadRef = useRef<(opts: LoadOptions) => void | Promise<void>>(
    () => {},
  );
  const seenFirstConnectRef = useRef(false);

  // Cancellation: every load takes a new generation; a load whose generation
  // is no longer current (a newer Refresh/reconnect/window change started) or
  // whose component unmounted stops at its next await without touching state,
  // so a stale loop can never overwrite newer data. A ref flag (not a
  // generation bump) tracks unmount so StrictMode's mount→unmount→mount does
  // not cancel the one-shot initial load that `hasQueried` will not re-issue.
  const loadGenRef = useRef(0);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Run ids applied by a live update during the current load, so the
  // completion prune (rows the server did not return) never drops them.
  const liveTouchedRef = useRef<Set<string>>(new Set());
  // Mirror of `runs` so `load` can see whether rows are on screen without
  // depending on (and being re-created for) every `runs` change.
  const runsRef = useRef<Run[]>(runs);

  const load = useCallback(
    async ({ reset = false }: LoadOptions) => {
      const gen = ++loadGenRef.current;
      const isCurrent = () => gen === loadGenRef.current && mountedRef.current;
      liveTouchedRef.current = new Set();
      setErrorMessage(null);
      setPartialError(null);
      if (reset) {
        // A different window: the previous window's rows must not mix into
        // this one while it loads (merge semantics would otherwise keep them
        // until the completion prune).
        runsRef.current = [];
        setRuns([]);
        setLoadCapped(false);
        setLastLoadedAt(null);
      }
      // A load that starts with rows on screen keeps them visible and shows a
      // non-blocking "Updating…" indicator; otherwise it shows the blocking
      // table spinner until its first page lands.
      const rowsShownAtStart = runsRef.current.length > 0;
      if (rowsShownAtStart) {
        setPhase('ready');
        setProgress({ loaded: 0, mode: 'updating' });
      } else {
        setPhase('loading');
        setProgress(null);
      }
      // Resolve the window at CALL time for an open-to-now window (default
      // last-30-days or a relative range). `windowRange` is memoized on the
      // mount-time clock, so reusing it would send `end = mount instant` on
      // every later Refresh/Retry/reconnect refetch, excluding runs updated
      // after mount server-side and then pruning them at completion. An
      // absolute range keeps its fixed, explicit bounds. The injected `now`
      // (tests) still pins the clock.
      const bounds = windowEndsAtNow
        ? resolveRange(range, now ?? Date.now())
        : windowRange;
      // Run ids the server returned in THIS load (dedupes overlapping pages
      // and drives the cap and the completion prune).
      const seen = new Set<string>();
      let pages = 0;
      try {
        // Hybrid paging: fetch page-by-page following `nextToken` until the
        // FLEET_LOAD_CAP is reached (or the server has no more pages), then
        // page client-side. Each page is merged into state as it arrives
        // (progressive render) instead of after the whole loop.
        let nextToken: string | undefined;
        let capped = false;
        do {
          const remaining = FLEET_LOAD_CAP - seen.size;
          const limit = Math.min(FLEET_FETCH_PAGE_SIZE, remaining);
          // Push the active window into every page fetch so the SERVER
          // returns only runs whose `updatedAt` is in [start, end]; the
          // FLEET_LOAD_CAP then bounds a very dense window rather than the
          // whole fleet.
          const connection = await listRuns({
            limit,
            nextToken,
            start: bounds.start,
            end: bounds.end,
          });
          if (!isCurrent()) {
            return;
          }
          pages += 1;
          for (const item of connection.items) {
            seen.add(item.runId);
          }
          // Functional merge deduped by runId (newer updatedAt wins), so a
          // live update that landed mid-load is never lost to this page.
          const items = connection.items;
          setRuns((current) => mergeRunPage(current, items));
          if (pages === 1) {
            setPhase('ready');
          }
          nextToken = connection.nextToken ?? undefined;
          if (seen.size >= FLEET_LOAD_CAP) {
            // Hit the cap: there may be more runs server-side than we loaded.
            capped = nextToken !== undefined;
            break;
          }
          if (nextToken !== undefined) {
            setProgress({
              loaded: seen.size,
              mode: rowsShownAtStart ? 'updating' : 'more',
            });
          }
        } while (nextToken !== undefined);

        // The completed server result is authoritative for the window: drop
        // rows it no longer returned (left the window / beyond the cap),
        // except runs a live update touched during this load.
        const touched = liveTouchedRef.current;
        setRuns((current) =>
          current.filter((r) => seen.has(r.runId) || touched.has(r.runId)),
        );
        setLoadCapped(capped);
        setProgress(null);
        setLastLoadedAt(Date.now());
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        const message =
          error instanceof Error ? error.message : 'Runs could not be loaded.';
        setProgress(null);
        if (pages === 0 && !rowsShownAtStart) {
          // Nothing on screen: today's blocking error state (Req 8.2, 10.2).
          setErrorMessage(message);
          setPhase('error');
        } else {
          // Rows are already shown: keep them and surface a non-blocking,
          // retryable notice instead of blanking the table (Req 10.2).
          setPartialError(message);
          setPhase('ready');
        }
      }
      // `load` is re-created when the window changes so a new window
      // re-queries the server (see the window-change effect below).
    },
    [listRuns, range, now, windowEndsAtNow, windowRange],
  );

  // Initial per-mount query (Req 10.4), guarded against StrictMode's double
  // invoke. Subsequent window changes are handled by the window-change effect
  // below (which must NOT be blocked by this one-shot guard).
  useEffect(() => {
    if (hasQueried.current) {
      return;
    }
    hasQueried.current = true;
    void load({ kind: 'cold' });
    // Intentionally runs once on mount; `load` is stable except for window
    // changes, which the dedicated effect below drives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run the load whenever the time window changes (the operator picked a new
  // range), resetting to page 1 so the paged client view starts at the top of
  // the fresh window. Skips the very first run so it does not double-fetch on
  // mount alongside the one-shot initial query above.
  const didInitialWindowLoad = useRef(false);
  useEffect(() => {
    if (!didInitialWindowLoad.current) {
      didInitialWindowLoad.current = true;
      return;
    }
    setCurrentPage(1);
    void load({ kind: 'cold', reset: true });
    // `load` already closes over windowRange.start/end; keying on them makes the
    // reload fire exactly when the window changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowRange.start, windowRange.end]);

  // Applies an incoming run update from any source subject to the fleet
  // ordering (Req 8.5, 8.6, 8.10). Clears any pending indicator for that run
  // once the merge is committed (Req 8.11). No page reload occurs — this is a
  // pure state transition.
  const applyRunUpdate = useCallback(
    (updatedRun: Run) => {
      // Honor the active window: a live update for a run whose `updatedAt` falls
      // OUTSIDE [windowStart, windowEnd] must NOT pop into the current view
      // (that would misrepresent the selected window). ISO-8601 UTC strings
      // sort lexicographically in chronological order, so a plain string
      // compare is a correct inclusive bound check. A run already shown whose
      // update keeps it in-window updates in place via mergeRunUpdate.
      // The lower bound always applies: an OLD run updated before the window
      // start must never pop in. The upper bound is conditional (BUG 2): for an
      // OPEN-TO-NOW window `windowRange.end` is a stale `Date.now()` captured at
      // an earlier render, so a genuinely-current update whose `updatedAt` is
      // slightly AFTER that captured instant would be wrongly rejected — skip
      // the upper bound and let the lower bound alone gate. For an ABSOLUTE
      // past-bounded range the end is a fixed historical instant, so keep the
      // inclusive upper bound to reject updates newer than the selected end.
      const inWindow =
        updatedRun.updatedAt >= windowRange.start &&
        (windowEndsAtNow || updatedRun.updatedAt <= windowRange.end);
      if (inWindow) {
        // Remember the run so an in-flight load's completion prune keeps it.
        liveTouchedRef.current.add(updatedRun.runId);
        setRuns((current) => mergeRunUpdate(current, updatedRun));
      }
      // Always clear any pending indicator for the run, even when the update is
      // dropped for being out of window, so a flagged row never spins forever.
      setPendingRunIds((current) => {
        if (!current.has(updatedRun.runId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(updatedRun.runId);
        return next;
      });
    },
    [windowRange.start, windowRange.end, windowEndsAtNow],
  );

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

  // Keep the latest-callback refs pointed at the current `applyRunUpdate`/`load`
  // closures on every render (no dependency array = runs each render by design).
  // The subscription effect reads these refs, so it always invokes the current
  // closure (current window, current `listRuns`) without being re-created —
  // the decoupling that fixes BUG 1 subscription churn.
  useEffect(() => {
    applyRunUpdateRef.current = applyRunUpdate;
    loadRef.current = load;
    runsRef.current = runs;
  });

  // Open the live, reconnecting subscription for the lifetime of the mount
  // (Req 8.5, 8.6, 10.5, 10.6). The subscribe factory is injectable for tests.
  //
  // IMPORTANT: wire `onReconnect` to refetch the full run list. A WebSocket
  // subscription can drop (network blip, AppSync idle timeout) and the manager
  // reconnects — but a reconnected subscription only delivers FUTURE events, so
  // any run/task changes that occurred DURING the disconnect window are missed.
  // Without a refetch, the list silently goes stale until a manual page refresh
  // (the observed bug). Refetching current state on every (re)connection
  // re-syncs the list so no update is lost across a drop (Req 10.6).
  //
  // BUG 1 fix: depend only on `[subscribe]` so the subscription is created
  // EXACTLY ONCE on mount and torn down (`managed.stop()`) ONLY on unmount. A
  // window/range change or any unrelated re-render no longer churns the
  // subscription (which previously dropped pushed updates in the teardown gap).
  // The manager reads the latest-callback refs instead of closing over
  // `applyRunUpdate`/`load`, so it still sees the current window/`listRuns`.
  useEffect(() => {
    // The manager fires `onReconnect` on its very first connection too; the
    // initial `load` effect has already fetched once (Req 10.4), so skip that
    // first callback and only refetch on subsequent RECONNECTS — matching the
    // run-detail view. On a genuine reconnect we re-sync the full list so
    // updates missed during the disconnect are not lost (the stale-until-
    // refresh bug). `seenFirstConnectRef` persists this guard across renders so
    // a re-render cannot reset it and misclassify a genuine reconnect (Req 10.6).
    const managed = createReconnectingSubscription<Run>({
      subscribe,
      onNext: (value) => applyRunUpdateRef.current(value),
      onReconnect: () => {
        if (!seenFirstConnectRef.current) {
          seenFirstConnectRef.current = true;
          return;
        }
        void loadRef.current({ kind: 'reconnect' });
      },
    });
    return () => managed.stop();
    // Intentionally depends only on `subscribe` (the stable injected factory):
    // the manager uses refs for the per-render closures, so this must NOT
    // re-run on window/state changes (BUG 1). All other values read here
    // (the refs) are stable, so exhaustive-deps is satisfied without a disable.
  }, [subscribe]);

  // Retry re-issues the query on demand (Req 8.2). Allowed because it is a
  // user-initiated action, not the automatic per-mount query.
  const handleRetry = useCallback(() => {
    void load({ kind: 'refresh' });
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
        <FormField label="Time window">
          <DateRangePicker
            value={range}
            onChange={({ detail }) => setRange(detail.value)}
            relativeOptions={FLEET_RELATIVE_OPTIONS}
            isValidRange={() => ({ valid: true })}
            placeholder="Last 30 days"
            data-testid="fleet-date-range"
            i18nStrings={FLEET_DATE_RANGE_I18N}
          />
        </FormField>
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
      Showing the most recent {runs.length.toLocaleString()} runs in this
      window. More runs exist in the selected window than are loaded here —
      narrow the time window, status, workflow, or search to see all.
    </Alert>
  ) : null;

  // Non-blocking notice for a load that failed after rows were already shown:
  // the rows stay and the operator can retry without losing the table.
  const partialLoadNotice =
    partialError != null ? (
      <Alert
        type="warning"
        header="Some runs could not be loaded"
        action={<Button onClick={handleRetry}>Retry loading</Button>}
        data-testid="fleet-partial-load-notice"
      >
        Showing {runs.length.toLocaleString()} runs loaded so far.{' '}
        {partialError}
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
        const version = run.workflowVersionName;
        const hasVersion = version != null && version !== '';
        const primary = onSelectRun ? (
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
        return (
          <div>
            {primary}
            {hasVersion && (
              <Box
                variant="span"
                color="text-body-secondary"
                fontSize="body-s"
                data-testid="workflow-version-sub"
              >
                {/* Light version name inline after the workflow link, offset by
                    a double-space-width gap (CSS, since literal spaces collapse
                    in HTML). No "version" label — the muted text is self-evident. */}
                <span style={{ marginLeft: '0.66em' }}>{version}</span>
              </Box>
            )}
          </div>
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
      cell: (run) => (
        <CopyId value={run.runId} label={`Copy run ID ${run.runId}`} />
      ),
    },
    {
      id: 'workflowId',
      header: 'Workflow ID',
      cell: (run) =>
        run.workflowId != null ? (
          <CopyId value={run.workflowId} label="Copy workflow ID" />
        ) : (
          '—'
        ),
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

  // Background-load status. The live region stays mounted (empty when idle) so
  // screen readers announce each change; it is a polite status, not an alert.
  const progressText =
    progress == null
      ? null
      : progress.mode === 'more'
        ? `Loading more runs… (${progress.loaded.toLocaleString()} loaded)`
        : progress.loaded > 0
          ? `Updating… (${progress.loaded.toLocaleString()} loaded)`
          : 'Updating…';
  // Phrasing content only: Cloudscape renders the Header description in a <p>.
  const loadStatus = (
    <span>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="fleet-load-progress"
      >
        {progressText != null && (
          <StatusIndicator type="loading">{progressText}</StatusIndicator>
        )}
      </span>
      {lastLoadedAt != null && (
        <Box
          variant="span"
          color="text-body-secondary"
          fontSize="body-s"
          margin={{ left: progressText != null ? 's' : 'n' }}
          data-testid="fleet-last-refreshed"
        >
          Last refreshed {new Date(lastLoadedAt).toLocaleTimeString()}
        </Box>
      )}
    </span>
  );

  const header = (
    <Header
      variant="h2"
      counter={`(${displayedRuns.length})`}
      description={loadStatus}
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
            loading={phase === 'loading' || progress !== null}
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
        {partialLoadNotice}
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
        cappedNotice || partialLoadNotice ? (
          <SpaceBetween size="xs">
            {cappedNotice}
            {partialLoadNotice}
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
