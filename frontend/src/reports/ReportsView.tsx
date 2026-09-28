/**
 * Reports view — aggregate workflow/version performance
 * (workflow-performance-reports Req 4.x, 5.x, 6.x, 7.x, 8.x, 10.x).
 *
 * Presents mean/median/p90 for each tracked metric across all runs of one
 * workflow+version over a calendar window (default last 30 days), as summary
 * cards, an aggregate table, and a duration trend chart. Availability is honest:
 * an unavailable metric shows an explicit affordance plus its "N of M runs"
 * denominator, never a fabricated 0; memory is GiB. A same-name collision is
 * flagged. The report is downloadable as CSV (analytics) and via print-to-PDF
 * (executive visual).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Badge from '@cloudscape-design/components/badge';
import Alert from '@cloudscape-design/components/alert';
import Spinner from '@cloudscape-design/components/spinner';
import SpaceBetween from '@cloudscape-design/components/space-between';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Table from '@cloudscape-design/components/table';
import Select from '@cloudscape-design/components/select';
import DateRangePicker, {
  type DateRangePickerProps,
} from '@cloudscape-design/components/date-range-picker';
import BarChart from '@cloudscape-design/components/bar-chart';
import type { SelectProps } from '@cloudscape-design/components/select';
import {
  listWorkflowGroups as defaultListWorkflowGroups,
  getWorkflowReport as defaultGetWorkflowReport,
  listWorkflowRunPoints as defaultListWorkflowRunPoints,
} from '../api/client';
import type {
  WorkflowGroup,
  WorkflowReport,
  AggregateMetric,
  RunPoint,
} from '../api/types';
import { toReportCsv } from './reportCsv';
import './reportsPrint.css';

/** Default window: last 30 days (Req 4.2). */
const DEFAULT_RANGE_DAYS = 30;

type LoadPhase = 'idle' | 'loading' | 'error' | 'ready' | 'empty';

export interface ReportsViewProps {
  readonly onBack?: () => void;
  readonly listWorkflowGroups?: (variables: {
    start: string;
    end: string;
  }) => Promise<WorkflowGroup[]>;
  readonly getWorkflowReport?: (variables: {
    workflowName: string;
    versionName: string;
    start: string;
    end: string;
  }) => Promise<WorkflowReport | null>;
  readonly listWorkflowRunPoints?: (variables: {
    workflowName: string;
    versionName: string;
    start: string;
    end: string;
    limit?: number;
    nextToken?: string | null;
  }) => Promise<{ items: readonly RunPoint[]; nextToken?: string | null }>;
  /** Injected clock for deterministic default window in tests. */
  readonly now?: number;
}

/** True when a Cloudscape date value carries no time-of-day (date-only). */
function isDateOnly(value: string): boolean {
  // Date-only is "YYYY-MM-DD"; anything with a "T" carries a time component.
  return !value.includes('T');
}

/**
 * Floor an absolute-range START to an inclusive ISO instant. A date-only value
 * ("2026-09-28") becomes the start of that day in UTC; a datetime is passed
 * through as its parsed instant. An unparseable value falls back to itself.
 */
function normalizeRangeStart(value: string): string {
  if (isDateOnly(value)) {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/**
 * Raise an absolute-range END to an INCLUSIVE ISO instant so the whole end date
 * is covered. A date-only value ("2026-09-28") becomes the very end of that day
 * in UTC ("2026-09-28T23:59:59.999Z"), so same-day timestamps (e.g. a run that
 * stopped at 17:29Z today) are included rather than excluded by a naive
 * date-only upper bound. A datetime is passed through as its parsed instant.
 */
function normalizeRangeEnd(value: string): string {
  if (isDateOnly(value)) {
    const ms = Date.parse(`${value}T23:59:59.999Z`);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** Resolve a Cloudscape date-range value to concrete ISO start/end. */
export function resolveRange(
  value: DateRangePickerProps.Value | null,
  nowMs: number,
): { start: string; end: string } {
  if (value == null) {
    const end = new Date(nowMs);
    const start = new Date(nowMs - DEFAULT_RANGE_DAYS * 86_400_000);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (value.type === 'absolute') {
    // Normalize the picker's start/end to INCLUSIVE ISO instants before they
    // become GSI2SK BETWEEN bounds (GSI2SK is a full ISO timestamp like
    // "2026-09-28T17:29:09.792Z"). Cloudscape may hand back a date-only string
    // ("2026-09-28") or a datetime; a raw date-only end bound sorts BEFORE any
    // real timestamp on that day, so "today only" would wrongly return nothing.
    // Floor the start to the beginning of its day and raise the end to the very
    // end of its day so the whole selected end date is included.
    return {
      start: normalizeRangeStart(value.startDate),
      end: normalizeRangeEnd(value.endDate),
    };
  }
  // Relative range: compute from unit/amount back from now.
  const unitMs: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000, // 30d approximation for the query window
    year: 31_536_000_000,
  };
  const spanMs = (unitMs[value.unit] ?? 86_400_000) * value.amount;
  return {
    start: new Date(nowMs - spanMs).toISOString(),
    end: new Date(nowMs).toISOString(),
  };
}

/** Human label for a metric key. */
const METRIC_LABEL: Record<string, string> = {
  durationMs: 'Duration',
  meanCpu: 'Mean CPU',
  peakCpu: 'Peak CPU',
  meanMemoryGiB: 'Mean memory',
  peakMemoryGiB: 'Peak memory',
  cpuHours: 'CPU-hours',
  peakConcurrentTasks: 'Peak concurrent tasks',
  taskCount: 'Tasks per run',
  failedTaskCount: 'Failed tasks per run',
};

/** Format a duration in ms as a compact H:MM:SS-ish minutes string, else the raw number. */
function fmtStat(m: AggregateMetric, value: number | null | undefined): string {
  if (value == null) {
    return '—';
  }
  if (m.key === 'durationMs') {
    const totalSec = Math.round(value / 1000);
    const h = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    return `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  const rounded = Math.round(value * 100) / 100;
  return m.unit ? `${rounded} ${m.unit}` : String(rounded);
}

export default function ReportsView({
  onBack,
  listWorkflowGroups = defaultListWorkflowGroups,
  getWorkflowReport = defaultGetWorkflowReport,
  listWorkflowRunPoints = defaultListWorkflowRunPoints,
  now,
}: ReportsViewProps): React.JSX.Element {
  const nowMs = useMemo(() => now ?? Date.now(), [now]);
  // Start with no explicit range so the query uses the default last-30-days
  // window immediately on mount (resolveRange(null)); the DateRangePicker shows
  // its "Last 30 days" placeholder until the user applies a specific range.
  const [range, setRange] = useState<DateRangePickerProps.Value | null>(null);
  const [groups, setGroups] = useState<WorkflowGroup[]>([]);
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [report, setReport] = useState<WorkflowReport | null>(null);
  const [phase, setPhase] = useState<LoadPhase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const windowRange = useMemo(() => resolveRange(range, nowMs), [range, nowMs]);

  const groupKey = (g: WorkflowGroup): string => `${g.workflowName}\u0000${g.versionName}`;
  const selectedGroup = useMemo(
    () => groups.find((g) => groupKey(g) === selectedGroupKey) ?? null,
    [groups, selectedGroupKey],
  );

  // Load the group list whenever the window changes.
  const loadGroups = useCallback(async () => {
    setPhase('loading');
    setErrorMessage(null);
    try {
      const gs = await listWorkflowGroups({ start: windowRange.start, end: windowRange.end });
      setGroups(gs);
      if (gs.length === 0) {
        setReport(null);
        setSelectedGroupKey(null);
        setPhase('empty');
        return;
      }
      // Keep the current selection if still present, else default to the group
      // with the MOST runs so the operator lands on a populated report rather
      // than an alphabetically-first group that may have only one (or zero-
      // utilization) run.
      setSelectedGroupKey((prev) => {
        if (prev != null && gs.some((g) => groupKey(g) === prev)) {
          return prev;
        }
        const mostRuns = [...gs].sort((a, b) => b.runCount - a.runCount)[0];
        return groupKey(mostRuns);
      });
      setPhase('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load workflow groups.');
      setPhase('error');
    }
  }, [listWorkflowGroups, windowRange.start, windowRange.end]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  // Load the report whenever the selected group or window changes.
  useEffect(() => {
    if (selectedGroup == null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await getWorkflowReport({
          workflowName: selectedGroup.workflowName,
          versionName: selectedGroup.versionName,
          start: windowRange.start,
          end: windowRange.end,
        });
        if (!cancelled) {
          setReport(r);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(
            err instanceof Error ? err.message : 'Failed to load the report.',
          );
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedGroup, getWorkflowReport, windowRange.start, windowRange.end]);

  const groupOptions: SelectProps.Option[] = groups.map((g) => ({
    value: groupKey(g),
    label: `${g.workflowName} — ${g.versionName}`,
    description: `${g.runCount} run${g.runCount === 1 ? '' : 's'}`,
  }));

  const [csvBusy, setCsvBusy] = useState(false);
  const handleExportCsv = useCallback(async () => {
    if (report == null || selectedGroup == null) {
      return;
    }
    setCsvBusy(true);
    try {
      // Page through the paginated per-run path so the export scales to 50k+
      // without depending on the size-bounded report payload (Req 7.2, 11.3).
      const rows: RunPoint[] = [];
      let nextToken: string | null | undefined;
      let guard = 0;
      do {
        const page = await listWorkflowRunPoints({
          workflowName: selectedGroup.workflowName,
          versionName: selectedGroup.versionName,
          start: windowRange.start,
          end: windowRange.end,
          limit: 1000,
          nextToken,
        });
        rows.push(...page.items);
        nextToken = page.nextToken ?? null;
        guard += 1;
      } while (nextToken && guard < 1000);

      const csv = toReportCsv(report, rows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `report-${report.workflowName}-${report.versionName}.csv`.replace(
        /[^a-z0-9.\-_]+/gi,
        '_',
      );
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setCsvBusy(false);
    }
  }, [report, selectedGroup, listWorkflowRunPoints, windowRange.start, windowRange.end]);

  const handleExportPdf = useCallback(() => {
    // Client-side print-to-PDF: the print stylesheet (reports-print.css, loaded
    // by index) constrains the printed area to the report region.
    window.print();
  }, []);

  const headerActions = (
    <SpaceBetween direction="horizontal" size="xs">
      <Button
        iconName="download"
        onClick={() => void handleExportCsv()}
        disabled={report == null}
        loading={csvBusy}
        data-testid="reports-export-csv"
      >
        Export CSV
      </Button>
      <Button
        iconName="file"
        onClick={handleExportPdf}
        disabled={report == null}
        data-testid="reports-export-pdf"
      >
        Export PDF
      </Button>
      {onBack && (
        <Button iconName="arrow-left" onClick={onBack}>
          Back to fleet
        </Button>
      )}
    </SpaceBetween>
  );

  const durationMetric = report?.metrics.find((m) => m.key === 'durationMs');

  return (
    <Container
      data-testid="reports-view"
      header={
        <Header variant="h1" actions={headerActions} description="Aggregate performance across runs of a workflow version.">
          Reports
        </Header>
      }
    >
      <div id="reports-printable">
        <SpaceBetween size="l">
          {/* Controls: window + workflow/version selection (Req 4.2, 4.3). */}
          <ColumnLayout columns={2} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">Time window</Box>
              <DateRangePicker
                value={range}
                onChange={({ detail }) => setRange(detail.value)}
                relativeOptions={[
                  { key: 'prev-7', amount: 7, unit: 'day', type: 'relative' },
                  { key: 'prev-30', amount: 30, unit: 'day', type: 'relative' },
                  { key: 'prev-90', amount: 90, unit: 'day', type: 'relative' },
                ]}
                isValidRange={() => ({ valid: true })}
                placeholder="Last 30 days"
                data-testid="reports-date-range"
                i18nStrings={{
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
                }}
              />
            </div>
            <div>
              <Box variant="awsui-key-label">Workflow / version</Box>
              <Select
                selectedOption={
                  groupOptions.find((o) => o.value === selectedGroupKey) ?? null
                }
                onChange={({ detail }) =>
                  setSelectedGroupKey(detail.selectedOption.value ?? null)
                }
                options={groupOptions}
                placeholder="Select a workflow version"
                empty="No workflows in this window"
                data-testid="reports-group-select"
              />
            </div>
          </ColumnLayout>

          {phase === 'loading' && (
            <Box textAlign="center" padding="l">
              <Spinner /> <span>Loading reports…</span>
            </Box>
          )}

          {phase === 'error' && (
            <Alert type="error" header="Report could not be loaded">
              {errorMessage ?? 'Unknown error.'}
            </Alert>
          )}

          {phase === 'empty' && (
            <Box textAlign="center" padding="l" data-testid="reports-empty">
              <b>No runs in the selected time window.</b>
            </Box>
          )}

          {report != null && (
            <>
              {/* Collision affordance (Req 6.2, 6.3). */}
              {report.collision && (
                <Alert type="warning" data-testid="reports-collision">
                  This workflow name + version maps to more than one workflow ID.
                  The figures below combine multiple distinct workflows; interpret
                  them with care.
                </Alert>
              )}

              {/* Utilization-permission honesty note (Req 10.3). */}
              <Alert type="info" data-testid="reports-utilization-note">
                Utilization metrics (CPU, memory) exist only for runs whose IAM
                run role held <code>cloudwatch:PutMetricData</code> at run start.
                Runs without it are excluded from utilization statistics (shown as
                the “N of M runs” denominator), never counted as zero.
              </Alert>

              {/* Summary cards (Req 5.1). */}
              <ColumnLayout columns={4} variant="text-grid">
                <div>
                  <Box variant="awsui-key-label">Runs</Box>
                  <span data-testid="reports-run-count">{report.runCount}</span>
                </div>
                <div>
                  <Box variant="awsui-key-label">Outcomes</Box>
                  <SpaceBetween direction="horizontal" size="xs">
                    <Badge color="green">{report.succeeded} ok</Badge>
                    <Badge color="red">{report.failed} failed</Badge>
                    <Badge color="grey">{report.cancelled} cancelled</Badge>
                  </SpaceBetween>
                </div>
                <div>
                  <Box variant="awsui-key-label">Duration (median)</Box>
                  <span>
                    {durationMetric
                      ? fmtStat(durationMetric, durationMetric.median)
                      : '—'}
                  </span>
                </div>
                <div>
                  <Box variant="awsui-key-label">Duration (p90)</Box>
                  <span>
                    {durationMetric ? fmtStat(durationMetric, durationMetric.p90) : '—'}
                  </span>
                </div>
              </ColumnLayout>

              {/* Aggregate metrics table: mean/median/p90 + N-of-M (Req 5.4, 5.5). */}
              <Table<AggregateMetric>
                data-testid="reports-metrics-table"
                variant="embedded"
                items={report.metrics as AggregateMetric[]}
                trackBy={(m) => m.key}
                columnDefinitions={[
                  {
                    id: 'metric',
                    header: 'Metric',
                    cell: (m) => METRIC_LABEL[m.key] ?? m.key,
                  },
                  { id: 'mean', header: 'Mean', cell: (m) => fmtStat(m, m.mean) },
                  { id: 'median', header: 'Median', cell: (m) => fmtStat(m, m.median) },
                  { id: 'p90', header: 'p90', cell: (m) => fmtStat(m, m.p90) },
                  {
                    id: 'availability',
                    header: 'Runs with data',
                    cell: (m) =>
                      m.availableCount < m.totalCount ? (
                        <span data-testid="reports-availability">
                          <Badge color={m.availableCount === 0 ? 'grey' : 'blue'}>
                            {m.availableCount} / {m.totalCount}
                          </Badge>
                        </span>
                      ) : (
                        <span>
                          {m.availableCount} / {m.totalCount}
                        </span>
                      ),
                  },
                ]}
                empty={<Box textAlign="center">No metrics.</Box>}
              />

              {/* Duration distribution — a fixed-size histogram computed
                  server-side, so the chart has a bounded number of bars
                  regardless of run count (Req 5.2, 11.2, 11.5). */}
              {report.durationHistogram != null &&
                report.durationHistogram.buckets.length > 0 && (
                  <div data-testid="reports-duration-chart">
                    <Box variant="awsui-key-label">
                      Duration distribution (minutes) — {report.durationHistogram.availableCount} of{' '}
                      {report.durationHistogram.totalCount} runs
                    </Box>
                    {(() => {
                      // Bar per histogram bucket: x = the bucket's minute range
                      // (categorical, bounded count), y = run count in the bucket.
                      const toMin = (ms: number) => Math.round(ms / 60000);
                      const bars = report.durationHistogram!.buckets.map((b) => ({
                        x: `${toMin(b.lo)}–${toMin(b.hi)}`,
                        y: b.count,
                      }));
                      const maxY = bars.reduce((m, d) => (d.y > m ? d.y : m), 0);
                      return (
                        <BarChart
                          hideFilter
                          hideLegend
                          height={240}
                          series={[
                            { title: 'Runs', type: 'bar', data: bars },
                          ]}
                          xDomain={bars.map((d) => d.x)}
                          yDomain={[0, Math.max(1, Math.ceil(maxY * 1.1))]}
                          xTitle="Duration bucket (minutes)"
                          yTitle="Runs"
                          ariaLabel="Duration distribution histogram"
                          empty={<Box textAlign="center">No timed runs.</Box>}
                        />
                      );
                    })()}
                  </div>
                )}

              {/* Duration trend over time — a fixed-size time-binned series
                  (bounded bin count), independent of run count (Req 11.2). */}
              {report.timeBins.some((b) => b.runCount > 0) && (
                <div data-testid="reports-timebins-chart">
                  <Box variant="awsui-key-label">Runs over time (per bin)</Box>
                  {(() => {
                    const bars = report.timeBins.map((b) => ({
                      x: b.start.slice(0, 10), // YYYY-MM-DD label
                      y: b.runCount,
                    }));
                    const maxY = bars.reduce((m, d) => (d.y > m ? d.y : m), 0);
                    return (
                      <BarChart
                        hideFilter
                        hideLegend
                        height={200}
                        series={[{ title: 'Runs', type: 'bar', data: bars }]}
                        xDomain={bars.map((d) => d.x)}
                        yDomain={[0, Math.max(1, Math.ceil(maxY * 1.1))]}
                        xTitle="Time bin"
                        yTitle="Runs"
                        ariaLabel="Runs over time"
                        empty={<Box textAlign="center">No runs in window.</Box>}
                      />
                    );
                  })()}
                </div>
              )}
            </>
          )}
        </SpaceBetween>
      </div>
    </Container>
  );
}
