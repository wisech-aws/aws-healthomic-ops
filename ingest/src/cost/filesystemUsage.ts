/**
 * Filesystem usage source for DYNAMIC-storage GB-hours (Req 3.3).
 *
 * For a DYNAMIC-storage run the cost estimate needs the run's measured
 * filesystem-usage-over-time series to integrate into GB-hours. Rather than
 * re-implement any of the measured-metrics query path, this module reuses the
 * existing one end to end:
 *
 *   `buildSelector('aws.omics.run.filesystem.usage', runId)` (`../metrics/promql.ts`)
 *     -> `buildRangeBody` + `signAndPost('/api/v1/query_range', ...)` (`../metrics/signedQuery.ts`)
 *     -> `parseMatrix(..., 'RUN_FILESYSTEM', 'usage')` (`../metrics/parse.ts`)
 *
 * The RUN_FILESYSTEM family is emitted at the **run** level (a grounding fact
 * from the sibling utilization-metrics design): run-level series carry only the
 * run id and no task id, i.e. `taskId === null`. This module returns the
 * concatenated `points` of that run-level series (`{ timestamp: epoch ms, value:
 * bytes }`, matching {@link UsagePoint}), or `null` when the series is absent or
 * the query failed — which the caller maps to the storage
 * Estimate_Unavailable_State (Req 3.4). It never fabricates or zero-fills a
 * series.
 *
 * The signing/host contract mirrors `metricsHandler.ts` exactly (service
 * `monitoring`, host/region/service/path/body passed to {@link signAndPost} in
 * the same positional order), so the same esbuild ESM `createRequire` banner
 * shim used for the metrics Lambda covers this module's transitive
 * `@smithy/signature-v4` / `@aws-crypto/sha256-js` CJS-in-ESM deps.
 */
import { buildSelector } from '../metrics/promql.js';
import { buildRangeBody, clampStepSeconds, signAndPost } from '../metrics/signedQuery.js';
import { parseMatrix } from '../metrics/parse.js';
import type { UsagePoint } from './estimate.js';

/** The dotted metric name of the run-level filesystem-usage series (registry RUN_FILESYSTEM/usage). */
const RUN_FILESYSTEM_USAGE_METRIC = 'aws.omics.run.filesystem.usage';

/**
 * The query window + resolution for a single RUN_FILESYSTEM usage fetch.
 *
 * Injectable so the caller (the CostHandler, deriving the run's
 * `startTime`..`stopTime ?? now` window) supplies the window and the module
 * stays free of window-resolution I/O. `start`/`end` are RFC3339 strings and
 * `stepSeconds` is clamped to the 30s emission floor via {@link clampStepSeconds}.
 */
export interface FilesystemUsageWindow {
  /** RFC3339 range start. */
  start: string;
  /** RFC3339 range end. */
  end: string;
  /** Requested resolution in seconds; clamped to >= 30. */
  stepSeconds?: number | null;
}

/** The signing params for the CloudWatch PromQL POST, mirroring `metricsHandler.ts`. */
export interface FilesystemUsageSigningParams {
  /** The monitoring API host, e.g. `monitoring.us-east-1.amazonaws.com`. */
  host: string;
  /** The signing region. */
  region: string;
  /** The signing service name — always `monitoring` in production. */
  service: string;
}

/**
 * Fetch the run's RUN_FILESYSTEM usage series and return its run-level `points`
 * (Req 3.3).
 *
 * Builds the `aws.omics.run.filesystem.usage` selector scoped to `runId`, form-
 * encodes a `query_range` body over the supplied window, and issues the same
 * SigV4-signed POST `metricsHandler.ts` uses (`signAndPost(host, region,
 * service, '/api/v1/query_range', body)`). On a 2xx response with a Prometheus
 * `status: "success"` envelope, the matrix is parsed via
 * `parseMatrix(env, 'RUN_FILESYSTEM', 'usage')` and the **run-level** series is
 * selected (`taskId === null`); its `points` (concatenated across any run-level
 * series) are returned.
 *
 * Returns `null` — never a fabricated or empty-but-present series — when:
 *   - the HTTP POST failed (non-2xx), or
 *   - the Prometheus envelope's `status` is `"error"`, or
 *   - no run-level series is present (the series is absent).
 *
 * The `null` return is the honest Estimate_Unavailable_State for dynamic storage
 * (Req 3.4). This function performs the network POST but is otherwise total: it
 * does not throw on a malformed-but-typed envelope.
 */
export async function fetchRunFilesystemUsage(
  runId: string,
  window: FilesystemUsageWindow,
  signing: FilesystemUsageSigningParams,
): Promise<UsagePoint[] | null> {
  const query = buildSelector(RUN_FILESYSTEM_USAGE_METRIC, runId);
  const body = buildRangeBody({
    query,
    start: window.start,
    end: window.end,
    step: clampStepSeconds(window.stepSeconds),
  });

  const posted = await signAndPost(
    signing.host,
    signing.region,
    signing.service,
    '/api/v1/query_range',
    body,
  );

  // HTTP-level failure => unavailable (never parse a non-2xx body). (Req 3.4)
  if (!posted.ok) {
    return null;
  }

  // Prometheus-level failure => unavailable. (Req 3.4)
  if (posted.envelope.status === 'error') {
    return null;
  }

  const series = parseMatrix(posted.envelope, 'RUN_FILESYSTEM', 'usage');

  // Run-level series carry only the run id (taskId === null). Concatenate their
  // points; when no run-level series is present, the series is absent => null.
  const runLevelSeries = series.filter((s) => s.taskId === null);
  if (runLevelSeries.length === 0) {
    return null;
  }

  const points: UsagePoint[] = [];
  for (const s of runLevelSeries) {
    for (const point of s.points) {
      points.push({ timestamp: point.timestamp, value: point.value });
    }
  }

  return points;
}
