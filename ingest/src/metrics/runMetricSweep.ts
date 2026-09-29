/**
 * Shared CloudWatch measured-utilization sweep for a terminal run.
 *
 * Both the ingest completion hook (handler.ts) and the deferred Reconciler
 * (reconcilerHandler.ts) need to fetch a run's CPU/MEMORY series from
 * CloudWatch's PromQL `query_range` API to compute the Run_Summary's
 * mean/peak utilization. This factory builds that sweep once so the two call
 * sites cannot drift.
 *
 * The returned sweep is BEST-EFFORT and TOTAL: it returns an empty series list
 * on any failure (never throws), so utilization is flagged unavailable rather
 * than fabricated (workflow-performance-reports Req 1.1, 10.1).
 */
import type { RunRecord } from '../domain/records.js';
import { CORE_FAMILIES, resolveSelectors } from './registry.js';
import { buildSelector } from './promql.js';
import { buildRangeBody, clampStepSeconds, signAndPost } from './signedQuery.js';
import { parseMatrix, type MetricSeries } from './parse.js';

/** Config for the run metric sweep (all resolved from env at the call site). */
export interface RunMetricSweepConfig {
  region: string;
  /** CloudWatch monitoring host, e.g. `monitoring.us-east-1.amazonaws.com`. */
  monitoringHost: string;
  /** SigV4 signing service, e.g. `monitoring`. */
  signingService: string;
}

/**
 * Build the best-effort run metric sweep. Returns a function that, given a
 * terminal run with resolved `startedAt`/`stoppedAt`, queries the CPU + MEMORY
 * families over the run window and returns the parsed series (empty on any
 * failure or when the window is unresolved).
 */
export function makeRunMetricSweep(
  config: RunMetricSweepConfig,
): (run: RunRecord) => Promise<MetricSeries[]> {
  const { region, monitoringHost, signingService } = config;
  return async function fetchRunMetricSeries(run: RunRecord): Promise<MetricSeries[]> {
    // Need a resolved window; a terminal run normally has both timestamps.
    if (run.startedAt == null || run.stoppedAt == null) {
      return [];
    }
    try {
      const selectors = resolveSelectors(CORE_FAMILIES);
      const step = clampStepSeconds(30);
      const perSelector = await Promise.all(
        selectors.map(async (sel) => {
          const body = buildRangeBody({
            query: buildSelector(sel.metricName, run.runId),
            start: run.startedAt as string,
            end: run.stoppedAt as string,
            step,
          });
          const result = await signAndPost(
            monitoringHost,
            region,
            signingService,
            '/api/v1/query_range',
            body,
          );
          if (!result.ok) {
            return [] as MetricSeries[];
          }
          return parseMatrix(result.envelope, sel.family, sel.role);
        }),
      );
      return perSelector.flat();
    } catch (err) {
      console.error('runMetricSweep: metrics sweep failed', err);
      return [];
    }
  };
}
