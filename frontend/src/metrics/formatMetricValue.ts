/**
 * Human-readable formatting for measured HealthOmics utilization values.
 *
 * The raw values HealthOmics/CloudWatch return are not meaningful to a human
 * observer at a glance: CPU usage is a tiny fractional `{cpu}` number (e.g.
 * `0.0014807881773399015`), and memory is a raw byte count (e.g.
 * `6442450944`). This module converts those raw values (never the underlying
 * data) into display strings, keyed off the metric's declared `unit`
 * (`{cpu}`, `By`, `%`, `{operation}`) so charts/tooltips read naturally
 * without guessing at units elsewhere. Purely a display concern: it never
 * changes what is plotted, only how a value is labeled.
 */

/** Binary byte-size thresholds/labels (KiB/MiB/GiB/TiB), matching AWS convention. */
const BYTE_UNITS: ReadonlyArray<{ threshold: number; suffix: string }> = [
  { threshold: 1024 ** 4, suffix: 'TiB' },
  { threshold: 1024 ** 3, suffix: 'GiB' },
  { threshold: 1024 ** 2, suffix: 'MiB' },
  { threshold: 1024, suffix: 'KiB' },
];

/**
 * Format a byte count as a human-readable size with an adaptively-chosen
 * binary unit (KiB/MiB/GiB/TiB), e.g. `6442450944` -> `"6.00 GiB"`.
 * Values under 1 KiB are shown in bytes, e.g. `512` -> `"512 B"`.
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  for (const { threshold, suffix } of BYTE_UNITS) {
    if (abs >= threshold) {
      return `${(value / threshold).toFixed(2)} ${suffix}`;
    }
  }
  return `${value.toFixed(0)} B`;
}

/**
 * Format a fractional vCPU count (HealthOmics' `{cpu}` unit, e.g. `1` = one
 * full vCPU) as millicores — the Kubernetes-style convention where 1000m
 * equals one full vCPU — which reads far more naturally than a fraction for
 * the small values these tasks typically report, e.g. `0.0014807881773399015`
 * -> `"1m"`, `1` -> `"1000m"`.
 */
export function formatCpu(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const millicores = value * 1000;
  return `${Math.round(millicores)}m`;
}

/** Format a `{operation}` count (e.g. filesystem operations) with a thousands separator. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return Math.round(value).toLocaleString();
}

/** Format a `%` utilization value (e.g. GPU utilization) to one decimal place. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(1)}%`;
}

/**
 * Format a raw measured value for display, choosing the conversion by the
 * metric's declared CloudWatch unit label. Unrecognized/absent units fall
 * back to a plain rounded number rather than guessing at a conversion.
 */
export function formatMetricValue(value: number, unit: string | null): string {
  switch (unit) {
    case 'By':
      return formatBytes(value);
    case '{cpu}':
      return formatCpu(value);
    case '%':
      return formatPercent(value);
    case '{operation}':
      return formatCount(value);
    default:
      return Number.isFinite(value) ? value.toLocaleString() : '—';
  }
}
