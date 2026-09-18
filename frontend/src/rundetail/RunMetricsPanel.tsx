/**
 * RunMetricsPanel — measured HealthOmics resource-utilization metrics for a
 * run, read on demand via `getRunMetrics` (design §9; Req 2–10).
 *
 * Purely presentational: the parent (`RunDetailView`, task 8.2) owns the
 * fetch and passes the latest `result`/`isLoading` plus an `onRefresh`
 * callback. This panel only derives what to render from those inputs via the
 * pure helpers already implemented in `frontend/src/metrics/`:
 *
 *  - `deriveMeasuredPresentation` (Req 5.1, 5.2, 10.1–10.4) picks exactly one
 *    of four honest states — loading, error, unavailable, ready — and never
 *    touches the derived `ResourceSummary` (that card is rendered separately
 *    by `RunDetailView`; this panel is additive, never a replacement).
 *  - `joinMetricsToTasks` (Req 6) joins the ready state's series to the run's
 *    tasks by `taskId`, so per-task charts render in the context of the DAG
 *    node without any name-based matching.
 *  - `chartSeries` (Req 2.3–2.5, 3.3–3.5, 9.8) shapes a group of series into
 *    actual-vs-limit pairs, one per metric family present in the group, never
 *    fabricating a limit line when none was measured.
 *
 * Every measured value is labeled with a "Measured" Cloudscape `Badge` so it
 * reads as visually distinct from the derived `ResourceSummaryCard` (Req 5.3,
 * 5.5). CPU/memory ("core") charts are always shown at the top level of each
 * task's section; network/filesystem/scratch/GPU ("secondary") charts are
 * tucked behind an `ExpandableSection` so they stay visually secondary and
 * degrade gracefully (a family with no measured series for a task simply
 * produces no chart — never an error, never a fabricated empty chart, Req
 * 9.1–9.8). Run-level series (e.g. `RUN_FILESYSTEM`, `taskId === null`) are
 * rendered in their own run-scoped section, separate from any task.
 *
 * A single Refresh button (mirroring `LogsPanel`'s pattern) is usable in any
 * phase and re-issues the on-demand query via `onRefresh`; there is no
 * high-frequency automatic poll (Req 7.4, 8.3, 8.4).
 */
import { useMemo } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Alert from '@cloudscape-design/components/alert';
import Spinner from '@cloudscape-design/components/spinner';
import SpaceBetween from '@cloudscape-design/components/space-between';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import LineChart from '@cloudscape-design/components/line-chart';
import type { MixedLineBarChartProps } from '@cloudscape-design/components/mixed-line-bar-chart';
import type { RunMetrics, Task } from '../api/types';
import { deriveMeasuredPresentation } from '../metrics/runMetricsPresentation';
import { joinMetricsToTasks } from '../metrics/joinMetricsToTasks';
import { chartSeries } from '../metrics/chartSeries';
import type { ChartSeriesPair } from '../metrics/chartSeries';
import { formatMetricValue } from '../metrics/formatMetricValue';

export interface RunMetricsPanelProps {
  readonly runId: string;
  readonly tasks: readonly Task[];
  readonly result: RunMetrics | null;
  readonly isLoading: boolean;
  /** Re-issues the on-demand `getRunMetrics` query. Usable in any phase. */
  readonly onRefresh: () => void;
}

/**
 * Turns a dotted metric name (e.g. `aws.omics.task.cpu.usage`) into a short
 * human-readable label (e.g. "Cpu usage") for a chart title. Display-only;
 * never used for any data decision.
 */
function prettifyMetricName(metricName: string): string {
  const parts = metricName.split('.');
  const label = parts.slice(3).join(' ');
  if (label.length === 0) {
    return metricName;
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** One actual-vs-limit line chart for a single metric family, badged "Measured". */
function MetricChart({
  pair,
  runId,
  taskId,
}: {
  readonly pair: ChartSeriesPair;
  readonly runId: string;
  readonly taskId: string | null;
}): React.JSX.Element {
  const title = prettifyMetricName(pair.metricName);
  const series: MixedLineBarChartProps.LineDataSeries<Date>[] = [];
  if (pair.actual) {
    series.push({
      type: 'line',
      title: 'Actual',
      data: pair.actual.map((p) => ({ x: new Date(p.timestamp), y: p.value })),
    });
  }
  if (pair.limit) {
    series.push({
      type: 'line',
      title: 'Limit',
      data: pair.limit.map((p) => ({ x: new Date(p.timestamp), y: p.value })),
    });
  }

  return (
    <div data-testid={`metric-chart-${taskId ?? 'run'}-${pair.metricName}`}>
      <SpaceBetween size="xs">
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <Box variant="awsui-key-label" display="inline">
            {title}
          </Box>
          <Badge color="blue">Measured</Badge>
        </SpaceBetween>
        <LineChart<Date>
          series={series}
          height={200}
          xScaleType="time"
          xTitle="Time"
          yTitle={humanUnitLabel(pair.unit)}
          yTickFormatter={(value) => formatMetricValue(value, pair.unit)}
          detailPopoverSeriesContent={({ series: s, y }) => ({
            key: s.title,
            value: formatMetricValue(y, pair.unit),
          })}
          hideFilter
          ariaLabel={`${title} for run ${runId}${taskId ? `, task ${taskId}` : ''}`}
          i18nStrings={{
            legendAriaLabel: 'Legend',
            chartAriaRoleDescription: 'line chart',
          }}
          empty={
            <Box textAlign="center" color="inherit">
              No data points.
            </Box>
          }
        />
      </SpaceBetween>
    </div>
  );
}

/**
 * A short, human-readable axis label for a metric's declared unit, used in
 * place of the raw CloudWatch unit string (e.g. `{cpu}`, `By`) which is not
 * meaningful to a human observer at a glance.
 */
function humanUnitLabel(unit: string | null): string {
  switch (unit) {
    case 'By':
      return 'Memory';
    case '{cpu}':
      return 'CPU (millicores)';
    case '%':
      return 'Utilization (%)';
    case '{operation}':
      return 'Operations';
    default:
      return unit ?? 'Value';
  }
}

/** Whether a family belongs to the "core" (always-visible) set. */
function isCoreFamily(family: string): boolean {
  return family === 'CPU' || family === 'MEMORY';
}

export default function RunMetricsPanel({
  runId,
  tasks,
  result,
  isLoading,
  onRefresh,
}: RunMetricsPanelProps): React.JSX.Element {
  const { phase, series, errorMessage } = deriveMeasuredPresentation(
    result,
    isLoading,
  );

  const { matched } = useMemo(
    () => joinMetricsToTasks(series, tasks),
    [series, tasks],
  );
  const tasksById = useMemo(
    () => new Map(tasks.map((t) => [t.taskId, t])),
    [tasks],
  );
  const runLevelSeries = useMemo(
    () => series.filter((s) => s.taskId == null),
    [series],
  );
  const runLevelPairs = useMemo(
    () => chartSeries(runLevelSeries),
    [runLevelSeries],
  );

  const refreshButton = (
    <Button
      iconName="refresh"
      ariaLabel="Refresh measured utilization"
      loading={isLoading}
      onClick={onRefresh}
    >
      Refresh
    </Button>
  );

  return (
    <Container
      data-testid="metrics-panel"
      header={
        <Header
          variant="h2"
          actions={refreshButton}
          info={<Badge color="blue">Measured</Badge>}
        >
          Measured utilization
        </Header>
      }
    >
      {phase === 'loading' && (
        <Box padding="s" data-testid="metrics-loading">
          <Spinner /> <span>Loading measured utilization…</span>
        </Box>
      )}

      {phase === 'error' && (
        <Alert
          type="error"
          header="Measured utilization could not be loaded"
          data-testid="metrics-error"
          action={<Button onClick={onRefresh}>Retry</Button>}
        >
          {errorMessage}
        </Alert>
      )}

      {phase === 'unavailable' && (
        <Alert type="info" header="Measured utilization unavailable" data-testid="metrics-unavailable">
          Measured utilization unavailable for this run. This can happen when
          the run started before the HealthOmics run role was granted
          permission to emit metrics, or when every task in the run completed
          in under 30 seconds — too short for a measurement to be emitted. No
          measured chart is shown; this is never a fabricated zero.
        </Alert>
      )}

      {phase === 'ready' && (
        <div data-testid="metrics-ready">
          <SpaceBetween size="l">
            {matched.length === 0 && runLevelPairs.length === 0 && (
              <Box color="text-status-inactive" padding="s">
                No measured metrics could be matched to the current tasks.
              </Box>
            )}

            {matched.map(({ taskId, series: taskSeries }) => {
              const task = tasksById.get(taskId);
              const corePairs = chartSeries(
                taskSeries.filter((s) => isCoreFamily(s.family)),
              );
              const secondaryPairs = chartSeries(
                taskSeries.filter((s) => !isCoreFamily(s.family)),
              );

              return (
                <Container
                  key={taskId}
                  variant="stacked"
                  header={
                    <Header variant="h3" info={<Badge color="blue">Measured</Badge>}>
                      {task?.name ?? taskId}
                    </Header>
                  }
                >
                  <SpaceBetween size="m">
                    {corePairs.length === 0 ? (
                      <Box color="text-status-inactive">
                        No CPU/memory metrics measured for this task.
                      </Box>
                    ) : (
                      corePairs.map((pair) => (
                        <MetricChart
                          key={pair.metricName}
                          pair={pair}
                          runId={runId}
                          taskId={taskId}
                        />
                      ))
                    )}

                    {secondaryPairs.length > 0 && (
                      <ExpandableSection
                        headerText="Additional metrics (network, filesystem, scratch, GPU)"
                        variant="footer"
                      >
                        <SpaceBetween size="m">
                          {secondaryPairs.map((pair) => (
                            <MetricChart
                              key={pair.metricName}
                              pair={pair}
                              runId={runId}
                              taskId={taskId}
                            />
                          ))}
                        </SpaceBetween>
                      </ExpandableSection>
                    )}
                  </SpaceBetween>
                </Container>
              );
            })}

            {runLevelPairs.length > 0 && (
              <Container
                variant="stacked"
                header={
                  <Header variant="h3" info={<Badge color="blue">Measured</Badge>}>
                    Run-level filesystem
                  </Header>
                }
              >
                <SpaceBetween size="m">
                  {runLevelPairs.map((pair) => (
                    <MetricChart
                      key={pair.metricName}
                      pair={pair}
                      runId={runId}
                      taskId={null}
                    />
                  ))}
                </SpaceBetween>
              </Container>
            )}
          </SpaceBetween>
        </div>
      )}
    </Container>
  );
}
