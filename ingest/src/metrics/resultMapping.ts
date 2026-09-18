/**
 * Empty-vs-error result mapping for HealthOmics utilization metrics.
 *
 * `metricsHandler.ts` issues one `query_range` request per registry selector and must turn
 * each outcome into the `RunMetrics`-shaped result the GraphQL `getRunMetrics` query
 * returns. This module is the single place that decides, per Requirements 10.3/10.4 and the
 * design's Error Handling table, whether an outcome is:
 *
 *   - a **typed error** (`error: <message>`, `series: []`) — a non-2xx HTTP response, or a
 *     Prometheus envelope whose `status` is `"error"`; or
 *   - the **honest unavailable/success** case (`error: null`, `series` possibly `[]`) — a
 *     Prometheus `status: "success"` envelope, even when its `result` is empty.
 *
 * These two outcomes must never be conflated: an empty `series` array is only ever paired
 * with `error: null`, and a non-null `error` is only ever paired with `series: []`. Both are
 * pure and total — this module never throws and never fabricates a data point.
 */
import { parseMatrix, type MetricSeries, type PrometheusEnvelope } from './parse.js';
import type { MetricFamily, MetricRole } from './registry.js';

/** The RFC3339 query window actually used for the request, or `null` if unresolved. */
export interface MetricsWindow {
  start: string;
  end: string;
  stepSeconds: number;
}

/**
 * The resolver result returned by `getRunMetrics` (mirrors the GraphQL `RunMetrics` type).
 *
 * `series` is empty and `error` is `null` for the honest "unavailable" case (Req 10.4);
 * `error` is non-null and `series` is empty for the typed-error case (Req 10.3). The two are
 * never conflated.
 */
export interface RunMetrics {
  runId: string;
  window: MetricsWindow | null;
  series: MetricSeries[];
  error: string | null;
}

/**
 * Derive a human-readable message from a Prometheus `status: "error"` envelope.
 *
 * Falls back to a generic message when neither `error` nor `errorType` is present, since the
 * envelope is untrusted, caller-supplied JSON and must be handled totally.
 */
function deriveErrorMessage(env: PrometheusEnvelope): string {
  if (env.error) {
    return env.errorType ? `${env.errorType}: ${env.error}` : env.error;
  }
  if (env.errorType) {
    return env.errorType;
  }
  return 'PromQL query failed';
}

/**
 * Map a single selector's outcome (HTTP result + parsed Prometheus envelope) to a typed
 * {@link RunMetrics} result.
 *
 * Precedence (Req 10.3, 10.4; design Error Handling table):
 *   1. `httpErrorMessage` non-null (caller detected a non-2xx HTTP response) → typed error.
 *      `env` is never inspected in this case — a non-2xx body is not trustworthy Prometheus
 *      JSON and must not be parsed.
 *   2. `env` is `null`, or `env.status === 'error'` → typed error, using a message derived
 *      from `env.error`/`env.errorType` when available, else a generic message.
 *   3. Otherwise (`env.status === 'success'`) → parse via {@link parseMatrix} and return the
 *      series with `error: null`. An empty parsed `series` here is the honest
 *      unavailable/success case, not an error.
 *
 * Pure and total: never throws, regardless of how malformed `env` is.
 */
export function mapEnvelopeToResult(
  runId: string,
  window: MetricsWindow | null,
  env: PrometheusEnvelope | null,
  httpErrorMessage: string | null,
  family: MetricFamily,
  role: MetricRole,
): RunMetrics {
  if (httpErrorMessage !== null) {
    return { runId, window, series: [], error: httpErrorMessage };
  }

  if (env === null || env.status === 'error') {
    const error = env === null ? 'PromQL query failed' : deriveErrorMessage(env);
    return { runId, window, series: [], error };
  }

  return { runId, window, series: parseMatrix(env, family, role), error: null };
}

/**
 * Merge multiple per-selector {@link RunMetrics} results into one combined result for the
 * handler to return.
 *
 * - If every result is error-free, the merged result concatenates all series and carries
 *   `error: null` (an all-empty combination is still the honest unavailable case).
 * - If any result carries a typed error, the merge surfaces the **first** such error and
 *   discards partial series, so a failure is never masked by other selectors' success (Req
 *   10.3) — the caller must not present a partially-successful multi-selector fetch as if it
 *   fully succeeded.
 * - Returns the shared `runId`/`window` from the first result (all results for a single
 *   `getRunMetrics` call share the same `runId`/`window`); returns a `runId`-empty,
 *   `window: null`, `series: [], error: null` result for an empty input list, since there is
 *   nothing to report as either a success or a failure.
 */
export function mergeRunMetrics(results: RunMetrics[]): RunMetrics {
  if (results.length === 0) {
    return { runId: '', window: null, series: [], error: null };
  }

  const { runId, window } = results[0];

  const firstError = results.find((r) => r.error !== null);
  if (firstError) {
    return { runId, window, series: [], error: firstError.error };
  }

  const series = results.flatMap((r) => r.series);
  return { runId, window, series, error: null };
}
