/**
 * Prometheus response parsing for HealthOmics utilization metrics.
 *
 * CloudWatch's PromQL-compatible query API returns the standard Prometheus HTTP API
 * envelope. This module maps that envelope into the typed {@link MetricSeries} shape the
 * rest of the ingest package (and eventually the GraphQL `MetricSeries` type) consumes.
 *
 * VERIFIED grounding facts (from the PoC + AWS docs):
 *   - The response envelope shape is `{ status, data: { resultType, result: [...] } }`.
 *   - Timestamps are unix seconds encoded as a **float** JSON number.
 *   - Values are encoded as **strings** (e.g. `"0.42"`), not JSON numbers, and need parsing.
 *
 * This module only handles the `status: "success"` shape — the caller (task 2.1's
 * `resultMapping`) is responsible for gating on `status` and mapping a `status: "error"`
 * envelope (or a non-2xx HTTP signal) to a typed error before ever calling into
 * {@link parseMatrix} or {@link parseVector}. Both functions are pure and total: they never
 * throw on malformed-but-typed input, and never fabricate a data point for a value that
 * fails to parse to a finite number.
 */
import type { MetricFamily, MetricRole } from './registry.js';

/**
 * The Prometheus HTTP API response envelope returned by the CloudWatch PromQL query API.
 *
 * `data` is `undefined` for some error responses; `data.result` may be an empty array when
 * the query matched no series.
 */
export interface PrometheusEnvelope {
  status: 'success' | 'error';
  errorType?: string;
  error?: string;
  warnings?: string[];
  data?: {
    resultType: 'matrix' | 'vector';
    result: PromResult[];
  };
}

/**
 * One series within a Prometheus `result` array.
 *
 * `value` is present for an instant `vector` result (`[unixSeconds, "valueString"]`);
 * `values` is present for a range `matrix` result (a list of the same tuple shape).
 */
export interface PromResult {
  /** Labels including `__name__`, `__unit__`, and `@resource.*` resource attributes. */
  metric: Record<string, string>;
  value?: [number, string];
  values?: [number, string][];
}

/** A single parsed data point: epoch milliseconds + the parsed numeric value. */
export interface MetricPoint {
  timestamp: number;
  value: number;
}

/**
 * One parsed metric series (mirrors the eventual GraphQL `MetricSeries` type).
 *
 * `family`/`role` are supplied by the caller (the registry entry being queried), not
 * derived from the Prometheus labels, since a single selector always maps to exactly one
 * known family/role.
 */
export interface MetricSeries {
  metricName: string;
  family: MetricFamily;
  role: MetricRole;
  unit: string | null;
  taskId: string | null;
  direction: string | null;
  scratchMode: string | null;
  gpuId: string | null;
  points: MetricPoint[];
}

/**
 * Parse a raw `[unixSeconds, "valueString"]` tuple into a {@link MetricPoint}.
 *
 * `timestamp` is rounded to the nearest millisecond; `value` is dropped (returns `null`)
 * when the string does not parse to a finite number — never fabricated.
 */
function parsePoint(raw: [number, string]): MetricPoint | null {
  const [tsSeconds, valueString] = raw;
  const value = Number(valueString);
  if (!Number.isFinite(value)) {
    return null;
  }
  return { timestamp: Math.round(tsSeconds * 1000), value };
}

/**
 * Parse a list of raw `[unixSeconds, "valueString"]` tuples into {@link MetricPoint}s,
 * dropping any tuple whose value does not parse to a finite number.
 */
function parsePoints(raw: [number, string][]): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const tuple of raw) {
    const point = parsePoint(tuple);
    if (point !== null) {
      points.push(point);
    }
  }
  return points;
}

/**
 * Extract the resource/label fields common to every result, regardless of whether it's a
 * vector or matrix entry.
 */
function extractLabels(
  metric: Record<string, string>,
  fallbackMetricName: string,
): Pick<
  MetricSeries,
  'metricName' | 'unit' | 'taskId' | 'direction' | 'scratchMode' | 'gpuId'
> {
  return {
    metricName: metric['__name__'] ?? fallbackMetricName,
    unit: metric['__unit__'] ?? null,
    taskId: metric['@resource.aws.omics.task.id'] ?? null,
    direction: metric['network.io.direction'] ?? metric['filesystem.io.direction'] ?? null,
    scratchMode: metric['scratch.storage.mode'] ?? null,
    gpuId: metric['gpu.id'] ?? null,
  };
}

/**
 * Map a success `matrix` (`query_range`) envelope into typed series.
 *
 * Each {@link PromResult} becomes exactly one {@link MetricSeries}, with its `values` mapped
 * into `points`. Total: returns `[]` when `env.data` is absent or `env.data.result` is
 * empty, and never throws on malformed-but-typed input.
 *
 * @param env Prometheus response envelope (assumed already gated on `status === 'success'`
 *   by the caller — see module doc).
 * @param family The {@link MetricFamily} of the registry entry this query was for.
 * @param role The {@link MetricRole} (`usage`/`limit`) of the registry entry this query was for.
 */
export function parseMatrix(
  env: PrometheusEnvelope,
  family: MetricFamily,
  role: MetricRole,
): MetricSeries[] {
  const results = env.data?.result ?? [];
  const series: MetricSeries[] = [];
  for (const result of results) {
    const labels = extractLabels(result.metric ?? {}, '');
    series.push({
      ...labels,
      family,
      role,
      points: parsePoints(result.values ?? []),
    });
  }
  return series;
}

/**
 * Map a success `vector` (instant `query`) envelope into typed series.
 *
 * Each {@link PromResult} becomes exactly one {@link MetricSeries}, wrapping its single
 * `value` into a one-element `points` list. Kept for completeness / future instant-query
 * use (`metricsHandler.ts` uses `query_range`/`parseMatrix` for the charted window). Total:
 * returns `[]` when `env.data` is absent or `env.data.result` is empty.
 *
 * @param env Prometheus response envelope (assumed already gated on `status === 'success'`
 *   by the caller — see module doc).
 * @param family The {@link MetricFamily} of the registry entry this query was for.
 * @param role The {@link MetricRole} (`usage`/`limit`) of the registry entry this query was for.
 */
export function parseVector(
  env: PrometheusEnvelope,
  family: MetricFamily,
  role: MetricRole,
): MetricSeries[] {
  const results = env.data?.result ?? [];
  const series: MetricSeries[] = [];
  for (const result of results) {
    const labels = extractLabels(result.metric ?? {}, '');
    series.push({
      ...labels,
      family,
      role,
      points: result.value ? parsePoints([result.value]) : [],
    });
  }
  return series;
}
