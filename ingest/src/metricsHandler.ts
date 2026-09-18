/**
 * Metrics Lambda — AppSync Lambda-data-source resolver for measured HealthOmics
 * resource-utilization metrics.
 *
 * Mirrors `logsHandler.ts`'s shape: this is invoked by AppSync as a Lambda resolver, so the
 * event is the resolver payload `{ arguments: { runId, startTime?, endTime?, stepSeconds?,
 * families? } }`, and the return value matches the GraphQL `RunMetrics` type exactly. Unlike
 * the logs Lambda, there is no single AWS SDK operation backing this query: CloudWatch's
 * Prometheus-compatible PromQL API is reached via a hand-built, SigV4-signed HTTPS POST
 * (`./metrics/signedQuery.ts`), so this module's job is purely **orchestration** — resolving
 * the query window, expanding the requested metric families into concrete selectors, firing
 * one `query_range` request per selector concurrently, and merging the typed results.
 *
 * Two decoupled concerns fall out of the design's "Run window" decision (Req 8.2):
 *   - The common path: the frontend already holds the run's `startedAt`/`stoppedAt` and
 *     passes them as `startTime`/`endTime`, so no extra AWS call is made.
 *   - The fallback path: when either bound is missing, this Lambda calls `omics:GetRun`
 *     itself and derives the window from `run.startTime`..`run.stopTime ?? now` (a live run
 *     with no stop time gets `end = now`, Req 7.1).
 *
 * Failure handling follows the design's Error Handling table: a failed window-resolution
 * GetRun call surfaces as a **typed error** `RunMetrics` (`error != null`, `series: []`),
 * never an unhandled Lambda exception; the same is true for any per-selector HTTP failure or
 * Prometheus `status: "error"` response, via `mapEnvelopeToResult`/`mergeRunMetrics`. The
 * one deliberate exception — matching `logsHandler`'s convention — is `runId` validation,
 * which `throw`s so it surfaces as a GraphQL error.
 *
 * @see Requirements 1.2, 1.3, 1.4, 2.1, 2.2, 3.1, 3.2, 8.1, 8.2, 9.1, 9.2, 9.3, 9.5, 9.7,
 *   10.3, 10.4 (Design §1 "MetricsLambda", "Run window" decision).
 */
import { OmicsClient, GetRunCommand } from '@aws-sdk/client-omics';

import { resolveSelectors, type MetricFamily } from './metrics/registry.js';
import { buildSelector } from './metrics/promql.js';
import { buildRangeBody, clampStepSeconds, signAndPost } from './metrics/signedQuery.js';
import {
  mapEnvelopeToResult,
  mergeRunMetrics,
  type RunMetrics,
  type MetricsWindow,
} from './metrics/resultMapping.js';

/** The AppSync Lambda-resolver event shape for `getRunMetrics`. */
interface GetRunMetricsEvent {
  arguments: {
    runId: string;
    /** Optional explicit RFC3339 window; when absent (or partial) the Lambda derives it via GetRun. */
    startTime?: string | null;
    endTime?: string | null;
    /** Numeric-seconds resolution; clamped to >= 30 by {@link clampStepSeconds} (Req 8.2). */
    stepSeconds?: number | null;
    /** Optional metric-family filter to bound cost (Req 8); defaults to CORE (cpu+memory) via `resolveSelectors`. */
    families?: MetricFamily[] | null;
  };
}

/**
 * The region used both for signing the CloudWatch PromQL request and for the `GetRun`
 * window-resolution fallback. Defaults to the Lambda's own region when `METRICS_REGION` is
 * not set (Req 8.2, design §1 env vars).
 */
const REGION = process.env.METRICS_REGION ?? process.env.AWS_REGION ?? '';

/** The CloudWatch PromQL API host. Defaults to the regional `monitoring` endpoint. */
const MONITORING_HOST = process.env.MONITORING_HOST ?? `monitoring.${REGION}.amazonaws.com`;

/** The SigV4 signing service name for the PromQL API. Always `monitoring` in production. */
const SIGNING_SERVICE = process.env.SIGNING_SERVICE ?? 'monitoring';

const omicsClient = new OmicsClient({ region: REGION });

/** The outcome of resolving the query window, either directly from args or via `GetRun`. */
type WindowResolution =
  | { ok: true; start: string; end: string }
  | { ok: false; errorMessage: string };

/**
 * Resolve the RFC3339 `start`/`end` window for a `getRunMetrics` call (Req 8.2, "Run window"
 * decision).
 *
 * When both `startTime` and `endTime` are supplied by the caller, they are used exactly as
 * given (RFC3339 strings, never reformatted) — the fast path that avoids an extra AWS call.
 * When either is absent, this calls `omics:GetRun` and derives the window from
 * `run.startTime`..`run.stopTime ?? now`, so a still-running (live) run with no stop time
 * gets `end = now`. A failed `GetRun` call (or a run with no `startTime` at all) is reported
 * as a typed failure rather than thrown, so the caller can surface it as `RunMetrics.error`.
 */
async function resolveWindow(
  runId: string,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): Promise<WindowResolution> {
  if (
    typeof startTime === 'string' &&
    startTime.trim() !== '' &&
    typeof endTime === 'string' &&
    endTime.trim() !== ''
  ) {
    return { ok: true, start: startTime, end: endTime };
  }

  try {
    const run = await omicsClient.send(new GetRunCommand({ id: runId }));

    if (!(run.startTime instanceof Date)) {
      return {
        ok: false,
        errorMessage: `GetRun did not return a startTime for run "${runId}"`,
      };
    }

    const end = run.stopTime instanceof Date ? run.stopTime.toISOString() : new Date().toISOString();
    return { ok: true, start: run.startTime.toISOString(), end };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage: `GetRun failed while resolving the metrics window for run "${runId}": ${message}`,
    };
  }
}

/**
 * AppSync Lambda resolver for `getRunMetrics`.
 *
 * Validates `runId`, resolves the query window (direct args or `GetRun` fallback), clamps
 * the requested step, expands the requested (or default CORE) families into concrete
 * `{ metricName, family, role }` selectors via `resolveSelectors`, fires one SigV4-signed
 * `query_range` POST per selector concurrently, maps each outcome to a typed `RunMetrics`
 * via `mapEnvelopeToResult`, and merges them via `mergeRunMetrics` into the single result
 * returned to AppSync.
 *
 * Only `runId` validation throws; every other failure (a failed window-resolution `GetRun`
 * call, a non-2xx PromQL response, or a Prometheus `status: "error"` envelope) flows into
 * the typed `RunMetrics.error` field instead of an unhandled exception.
 */
export async function handler(event: GetRunMetricsEvent): Promise<RunMetrics> {
  const { runId, startTime, endTime, stepSeconds, families } = event.arguments;

  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('runId is required');
  }

  const stepSecondsString = clampStepSeconds(stepSeconds);

  const resolvedWindow = await resolveWindow(runId, startTime, endTime);
  if (!resolvedWindow.ok) {
    return { runId, window: null, series: [], error: resolvedWindow.errorMessage };
  }

  const window: MetricsWindow = {
    start: resolvedWindow.start,
    end: resolvedWindow.end,
    stepSeconds: Number(stepSecondsString),
  };

  const selectors = resolveSelectors(families ?? undefined);

  const perSelectorResults = await Promise.all(
    selectors.map(async ({ metricName, family, role }) => {
      const query = buildSelector(metricName, runId);
      const body = buildRangeBody({
        query,
        start: window.start,
        end: window.end,
        step: stepSecondsString,
      });

      const posted = await signAndPost(
        MONITORING_HOST,
        REGION,
        SIGNING_SERVICE,
        '/api/v1/query_range',
        body,
      );

      return mapEnvelopeToResult(
        runId,
        window,
        posted.ok ? posted.envelope : null,
        posted.ok ? null : posted.httpErrorMessage,
        family,
        role,
      );
    }),
  );

  return mergeRunMetrics(perSelectorResults);
}
