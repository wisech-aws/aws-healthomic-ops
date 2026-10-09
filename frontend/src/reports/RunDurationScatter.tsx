/**
 * Per-run duration scatter (Recharts).
 *
 * One clickable marker per run with a usable duration and a parseable stop
 * time, so an operator can spot a duration outlier, read its run id on hover,
 * and jump straight to that run. There is NO connecting line: a single
 * <Scatter> renders discrete markers only (ScatterChart does not draw a
 * connecting polyline, and `line` is left at its default `false`), which is the
 * whole point of replacing the old meaningless LineChart.
 *
 * Data contract: the component is a thin view over `ScatterDatum[]` already
 * produced by the pure `runPointsToScatterData` transform (x = stop-time epoch
 * ms, y = duration in MINUTES, filtered of null/NaN/Inf/negative durations and
 * unparseable timestamps). It never fabricates a point — zero plottable runs
 * renders an explicit empty affordance, never bare axes.
 *
 * jsdom / ResponsiveContainer caveat: ResponsiveContainer measures its parent's
 * width at runtime; jsdom reports a zero-size layout, so Recharts renders no
 * SVG markers under test. Component tests therefore either mock
 * ResponsiveContainer to a fixed-size div, call the exported tooltip renderer
 * directly, or assert via the keyboard/screen-reader data path below — not via
 * measured SVG geometry.
 *
 * Keyboard / screen-reader path: Recharts' marker click is pointer-oriented, so
 * this also renders a visually-hidden ordered list of focusable <button>s (one
 * per plotted run) that call `onOpenRun(runId)`. That is a complete,
 * keyboard-reachable path to every run — NOT the big visible top-5 "jump to
 * run" list that was removed; it is off-screen for sighted users who use the
 * markers.
 */
import { useMemo } from 'react';
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatDurationMs, type ScatterDatum } from './runScatter';

export interface RunDurationScatterProps {
  readonly points: readonly ScatterDatum[];
  readonly onOpenRun?: (runId: string) => void;
}

/** Visually-hidden style for the keyboard/screen-reader open-run buttons. */
const srOnlyStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** Short date/time tick label for the x-axis (epoch ms). */
function formatXTick(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  // Compact "M/D HH:MM" — enough to disambiguate runs within a window.
  const date = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

interface TooltipPayloadEntry {
  readonly payload?: ScatterDatum;
}

export interface ScatterTooltipProps {
  readonly active?: boolean;
  readonly payload?: readonly TooltipPayloadEntry[];
}

/**
 * Pure Recharts tooltip renderer. Exported so tests can call it directly with a
 * payload (Recharts tooltips do not render under jsdom without pointer+layout).
 * The run id MUST be visible; duration uses the shared formatter so it matches
 * ReportsView; status is shown only when present.
 */
export function renderScatterTooltip({
  active,
  payload,
}: ScatterTooltipProps): React.JSX.Element | null {
  if (!active || payload == null || payload.length === 0) {
    return null;
  }
  const datum = payload[0]?.payload;
  if (datum == null) {
    return null;
  }
  return (
    <div
      data-testid="run-scatter-tooltip"
      style={{
        background: 'var(--color-background-container-content, #fff)',
        border: '1px solid var(--color-border-divider-default, #ccc)',
        borderRadius: 4,
        padding: '6px 8px',
        fontSize: 12,
        boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
      }}
    >
      <div>
        <strong>Run:</strong> {datum.runId}
      </div>
      <div>
        <strong>Duration:</strong> {formatDurationMs(datum.y * 60000)}
      </div>
      {datum.status ? (
        <div>
          <strong>Status:</strong> {datum.status}
        </div>
      ) : null}
    </div>
  );
}

export default function RunDurationScatter({
  points,
  onOpenRun,
}: RunDurationScatterProps): React.JSX.Element {
  // Data-derived outlier emphasis (never fabricated): a run is emphasized when
  // its duration exceeds the 75th percentile + 1.5*IQR of the plotted
  // durations — the classic Tukey upper fence, computed purely from actual y
  // values. Fewer than 4 points: no emphasis (not enough data to define a
  // fence). This only changes marker radius, never which points are plotted.
  const outlierFence = useMemo(() => {
    if (points.length < 4) {
      return Number.POSITIVE_INFINITY;
    }
    const ys = points.map((p) => p.y).sort((a, b) => a - b);
    const q = (frac: number): number => {
      const idx = (ys.length - 1) * frac;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) {
        return ys[lo];
      }
      return ys[lo] + (ys[hi] - ys[lo]) * (idx - lo);
    };
    const q1 = q(0.25);
    const q3 = q(0.75);
    return q3 + 1.5 * (q3 - q1);
  }, [points]);

  const data = points as ScatterDatum[];

  if (points.length === 0) {
    // Zero plottable runs: explicit empty affordance, never bare axes.
    return (
      <div
        role="img"
        aria-label="Per-run duration scatter (no timed runs)"
        data-testid="run-scatter-empty"
        style={{ padding: '24px 0', textAlign: 'center', color: '#5f6b7a' }}
      >
        No timed runs to plot.
      </div>
    );
  }

  const handlePointClick = (datum: ScatterDatum | undefined): void => {
    if (datum?.runId && onOpenRun) {
      onOpenRun(datum.runId);
    }
  };

  return (
    <div role="img" aria-label="Per-run duration scatter">
      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart margin={{ top: 12, right: 24, bottom: 24, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="x"
            name="Run stop time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => formatXTick(v)}
            label={{ value: 'Run stop time', position: 'insideBottom', offset: -12 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="Duration (minutes)"
            label={{ value: 'Duration (minutes)', angle: -90, position: 'insideLeft' }}
          />
          <Tooltip
            content={renderScatterTooltip}
            cursor={{ strokeDasharray: '3 3' }}
          />
          <Scatter
            data={data}
            fill="#0972d3"
            // Each marker is clickable; read the clicked datum's runId and open
            // that run. Recharts hands the datum (with its data props) as the
            // first argument.
            onClick={(datum: unknown) => handlePointClick(datum as ScatterDatum)}
            // Emphasize data-derived outliers with a larger radius; all others
            // get a uniform reasonable radius.
            shape={(props: { cx?: number; cy?: number; payload?: ScatterDatum }) => {
              const { cx, cy, payload } = props;
              if (cx == null || cy == null) {
                return <g />;
              }
              const isOutlier = payload != null && payload.y >= outlierFence;
              return (
                <circle
                  cx={cx}
                  cy={cy}
                  r={isOutlier ? 7 : 4}
                  fill={isOutlier ? '#d91515' : '#0972d3'}
                  stroke="#fff"
                  strokeWidth={1}
                  style={{ cursor: 'pointer' }}
                />
              );
            }}
          />
        </ScatterChart>
      </ResponsiveContainer>

      {/* Keyboard / screen-reader path: one focusable button per plotted run.
          Visually hidden; not the removed visible top-5 jump list. */}
      <ul style={{ ...srOnlyStyle, listStyle: 'none' }} aria-label="Open a run">
        {data.map((d) => (
          <li key={d.runId}>
            <button
              type="button"
              data-testid="run-scatter-sr-open"
              onClick={() => onOpenRun?.(d.runId)}
            >
              Open run {d.runId} ({formatDurationMs(d.y * 60000)})
              {d.status ? ` — ${d.status}` : ''}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
