/**
 * UtilizationBars — a compact peak/mean-vs-limit view of a task's measured
 * utilization (design §Components and Interfaces "UtilizationBars"; Req 3.1–3.5,
 * 8.4). Replaces the per-family time-series `LineChart`s that previously lived
 * in {@link TaskDetailPanel}, so the log tail stays reachable without extended
 * scrolling.
 *
 * PRESENTATIONAL and PURE w.r.t. data. It takes the already-joined per-task
 * metric slice (`taskMetrics: TaskMetrics | null`) and shapes it with the
 * existing pure `chartSeries` helper (consumed UNCHANGED) into one
 * `ChartSeriesPair` per metric family. For each family it derives, ONLY from
 * measured points:
 *
 *  - a **peak** = max of the `actual` point values,
 *  - a **mean** = arithmetic mean of the `actual` point values,
 *  - a **limit ceiling** = max of the `limit` point values, when a limit
 *    series was measured for that family.
 *
 * It renders one compact horizontal bar per family showing peak AND mean as
 * EXPLICITLY LABELED values against the measured limit as the track (e.g.
 * "CPU — peak 3.9 / mean 1.2 of 4 vCPU"). Showing both peak and mean is a
 * deliberate honesty choice: peak alone can look alarming for a brief spike,
 * and mean alone hides the spike that may have caused an OOM/throttle. When no
 * limit series was measured, the bar shows peak+mean with NO ceiling — never a
 * fabricated limit (Req 3.3, 8.4).
 *
 * The MEMORY family's values are raw byte counts (CloudWatch `__unit__` = `By`)
 * and are formatted into adaptive binary units (…/MiB/GiB) by
 * {@link formatMetricValue}, so the bar reads e.g. "6.00 GiB". A short note
 * ({@link MEASURED_MEMORY_NOTE}) clarifies these are measured (actual) bytes,
 * distinguishing them from the reservation-based derived resource summary.
 *
 * When `taskMetrics` is `null` OR yields no chart pairs, it renders an explicit
 * "utilization unavailable for this task" state
 * (`data-testid="task-utilization-unavailable"`) — NEVER a zero/placeholder bar
 * (Req 3.5, 8.4). Region testid: `task-utilization`; per-bar testid:
 * `task-metric-bar-<taskId>-<metricName>`.
 */
import { useMemo } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { MetricPoint } from '../api/types';
import type { TaskMetrics } from '../metrics/joinMetricsToTasks';
import { chartSeries } from '../metrics/chartSeries';
import type { ChartSeriesPair } from '../metrics/chartSeries';
import { formatMetricValue } from '../metrics/formatMetricValue';

/**
 * Clarifying note for the measured MEMORY bar. These are ACTUAL measured byte
 * counts from CloudWatch (`__unit__` = `By`), formatted into binary units
 * (MiB/GiB) for display — distinct from the reservation-based derived resource
 * summary (which reports reserved GiB). The unit is confirmed, so this states
 * what the number is rather than flagging it as unknown.
 */
export const MEASURED_MEMORY_NOTE =
  'Measured (actual) memory use, reported by CloudWatch in bytes and shown here in binary units (MiB/GiB).';

/**
 * Turns a dotted metric name (e.g. `aws.omics.task.cpu.usage`) into a short
 * human-readable label (e.g. "Cpu usage") for a bar title. Display-only; never
 * used for any data decision. Mirrors the helper in `RunMetricsPanel` /
 * `TaskDetailPanel` so the compact bars read identically to the charts they
 * replace (unchanged behavior).
 */
function prettifyMetricName(metricName: string): string {
  const parts = metricName.split('.');
  const label = parts.slice(3).join(' ');
  if (label.length === 0) {
    return metricName;
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * A short, human-readable label for a metric's declared unit, used in place of
 * the raw CloudWatch unit string. Mirrors `RunMetricsPanel` / `TaskDetailPanel`
 * (unchanged behavior).
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

/**
 * The memory family reports its values in bytes (`unit === 'By'`) — the same
 * signal the whole app uses to format memory. Its displayed values carry the
 * unconfirmed-units caveat (Req 8.4).
 */
function isMemoryUnit(unit: string | null): boolean {
  return unit === 'By';
}

/** Max of a metric series' point values, or `null` when there are no points. */
function peakOf(points: MetricPoint[] | null): number | null {
  if (points == null || points.length === 0) {
    return null;
  }
  return points.reduce((max, p) => (p.value > max ? p.value : max), points[0].value);
}

/**
 * Arithmetic mean of a metric series' point values, or `null` when there are no
 * points. Derived solely from measured points — never a fabricated value.
 */
function meanOf(points: MetricPoint[] | null): number | null {
  if (points == null || points.length === 0) {
    return null;
  }
  const sum = points.reduce((acc, p) => acc + p.value, 0);
  return sum / points.length;
}

/**
 * One compact horizontal bar for a single metric family: labeled peak AND mean
 * measured values against the measured limit as the track (when a limit was
 * measured). Badged "Measured". Renders the memory units caveat for the memory
 * family. Never fabricates a peak, mean, or limit.
 */
function UtilizationBar({
  pair,
  taskId,
}: {
  readonly pair: ChartSeriesPair;
  readonly taskId: string;
}): React.JSX.Element {
  const title = prettifyMetricName(pair.metricName);
  const unitLabel = humanUnitLabel(pair.unit);
  const peak = peakOf(pair.actual);
  const mean = meanOf(pair.actual);
  const limit = peakOf(pair.limit);
  const isMemory = isMemoryUnit(pair.unit);

  const peakText = peak != null ? formatMetricValue(peak, pair.unit) : '—';
  const meanText = mean != null ? formatMetricValue(mean, pair.unit) : '—';
  const limitText = limit != null ? formatMetricValue(limit, pair.unit) : null;

  // Track fill is a presentation-only ratio of peak against the measured
  // limit; only rendered when a real limit was measured (never fabricated).
  const percent =
    limit != null && limit > 0 && peak != null
      ? Math.min(100, Math.max(0, (peak / limit) * 100))
      : null;

  // e.g. "peak 3.9 / mean 1.2 of 4 vCPU" — both values explicitly labeled;
  // the "of <limit>" clause is present only when a limit was measured.
  const description =
    limitText != null
      ? `peak ${peakText} / mean ${meanText} of ${limitText}`
      : `peak ${peakText} / mean ${meanText}`;

  return (
    <div data-testid={`task-metric-bar-${taskId}-${pair.metricName}`}>
      <SpaceBetween size="xxs">
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <Box variant="awsui-key-label" display="inline">
            {title}
          </Box>
          <Badge color="blue">Measured</Badge>
        </SpaceBetween>
        {percent != null ? (
          <ProgressBar
            value={percent}
            description={description}
            additionalInfo={unitLabel}
            ariaLabel={`${title} utilization for task ${taskId}`}
          />
        ) : (
          // No measured limit: show the labeled peak+mean with no track/ceiling
          // rather than a fabricated full bar (Req 3.3, 8.4).
          <Box variant="p" data-testid={`task-metric-bar-${taskId}-${pair.metricName}-nolimit`}>
            {description}{' '}
            <Box variant="small" color="text-status-inactive" display="inline">
              ({unitLabel}; no measured limit)
            </Box>
          </Box>
        )}
        {isMemory && (
          <Box
            variant="small"
            color="text-status-inactive"
            data-testid={`task-metric-bar-${taskId}-${pair.metricName}-units-note`}
          >
            {MEASURED_MEMORY_NOTE}
          </Box>
        )}
      </SpaceBetween>
    </div>
  );
}

/** Props for {@link UtilizationBars}. */
export interface UtilizationBarsProps {
  /**
   * The selected task's measured metric slice, joined upstream by
   * `RunDetailView` via `joinMetricsToTasks(...).matched`, or `null` when the
   * task has no matching series. Shaped here via the pure `chartSeries` helper.
   */
  readonly taskMetrics: TaskMetrics | null;
}

/**
 * Compact peak/mean-vs-limit utilization bars for a selected task. See the
 * module doc for the full contract. When `taskMetrics` is `null` or yields no
 * chart pairs, renders the explicit "utilization unavailable for this task"
 * state — never a fabricated zero/placeholder bar.
 */
export default function UtilizationBars({
  taskMetrics,
}: UtilizationBarsProps): React.JSX.Element {
  const pairs = useMemo(
    () => (taskMetrics ? chartSeries(taskMetrics.series) : []),
    [taskMetrics],
  );

  if (pairs.length === 0) {
    return (
      <Alert
        type="info"
        header="Measured utilization unavailable"
        data-testid="task-utilization-unavailable"
      >
        Utilization unavailable for this task. No measured metric series was
        matched to this task, so no bar is shown — this is never a fabricated
        zero.
      </Alert>
    );
  }

  const taskId = taskMetrics!.taskId;

  return (
    <div data-testid="task-utilization">
      <SpaceBetween size="s">
        {pairs.map((pair) => (
          <UtilizationBar key={pair.metricName} pair={pair} taskId={taskId} />
        ))}
      </SpaceBetween>
    </div>
  );
}
