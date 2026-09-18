/**
 * Cost Lambda — AppSync Lambda-data-source resolver for the estimated per-run
 * cost breakdown (`getRunCostEstimate`).
 *
 * Mirrors `metricsHandler.ts`'s shape: this is invoked by AppSync as a Lambda
 * resolver, so the event is the resolver payload `{ arguments: { runId } }`, and
 * the return value matches the GraphQL `RunCostEstimate` type exactly. This
 * module's job is purely **orchestration** — it wires together the pure cost
 * math (`./cost/estimate.ts`), the cache-first rate-card service
 * (`./cost/rateCard.ts` + `./cost/priceList.ts`), the run's task items (a
 * DynamoDB query), and — for DYNAMIC storage only — the measured RUN_FILESYSTEM
 * usage series (`./cost/filesystemUsage.ts`), all of which already exist.
 *
 * The estimate is a **list-price ESTIMATE** (measured task runtime × the
 * published AWS price list), never the actual billed amount. The load-bearing
 * theme, inherited from the sibling metrics Lambda and Req 6, is **honesty about
 * availability**: every line item is real/measured/priced or explicitly
 * unavailable — never fabricated or zero-filled. `total` is the sum of the
 * available line items (`null` when none are available, Req 6.4); `partial` is
 * `true` when any line item is unavailable (Req 6.3).
 *
 * Failure handling follows `metricsHandler.ts`'s error-as-typed-result
 * convention: only `runId` validation `throw`s (surfacing as a GraphQL error →
 * frontend error state, Req 5.7); every other failure flows into the typed
 * `error`/`available` fields rather than an unhandled Lambda exception. The
 * distinct degrade states are kept deliberately separate:
 *   - a failed `omics:GetRun` or a failed task `Query` → the whole estimate
 *     genuinely could not be read → typed `error` result (a broken task query is
 *     NOT conflated with a run that legitimately has no tasks);
 *   - an unexpectedly-throwing rate-card load → an unavailable rate map, so
 *     line items are honestly `available: false` (the estimate still succeeds);
 *   - an absent/failed RUN_FILESYSTEM series → the storage line item alone is
 *     unavailable.
 * A top-level backstop wraps the whole post-validation body so any unexpected
 * escape still returns the typed `error` result instead of throwing.
 *
 * @see Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6,
 *   4.1, 5.7, 6.3, 6.4 (Design §2 "CostHandler").
 */
import { OmicsClient, GetRunCommand } from '@aws-sdk/client-omics';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { DynamoRepository, runPk, type TaskItem } from './repository.js';
import { fetchRateMap } from './cost/priceList.js';
import { loadRateCard } from './cost/rateCard.js';
import { fetchRunFilesystemUsage } from './cost/filesystemUsage.js';
import {
  aggregateComputeHours,
  computeComputeLineItems,
  computeStorageLineItem,
  instanceHours,
  type CostCategory,
  type CostLineItem,
  type RateMap,
  type TaskLike,
  type UsagePoint,
} from './cost/estimate.js';

export type { CostCategory, CostLineItem };

/** The AppSync Lambda-resolver event shape for `getRunCostEstimate`. */
interface GetRunCostEstimateEvent {
  arguments: { runId: string };
}

/**
 * The resolver result (mirrors the GraphQL `RunCostEstimate` type). Every value
 * is real/measured/priced or explicitly unavailable; nothing is fabricated.
 */
export interface RunCostEstimate {
  runId: string;
  lineItems: CostLineItem[];
  /** Sum of available line items' `estimatedCost`; `null` when none are available (Req 6.4). */
  total: number | null;
  currency: string | null;
  /** ISO date the rate card was retrieved from the Price List API. */
  effectiveDate: string | null;
  /** `true` => at least one line item unavailable, so `total` is partial (Req 6.3). */
  partial: boolean;
  /** non-null => the whole query failed (distinct from a per-line-item unavailable, Req 5.7). */
  error: string | null;
}

/**
 * The region used both for the rate card / Price List lookup and for signing the
 * CloudWatch PromQL request (DYNAMIC storage). Defaults to the Lambda's own
 * region when `COST_REGION` is not set (design §2 env vars).
 */
const REGION = process.env.COST_REGION ?? process.env.AWS_REGION ?? '';

/** The DynamoDB single table holding the run's task items + the rate-card cache. */
const TABLE_NAME = process.env.COST_TABLE_NAME ?? '';

/** The CloudWatch PromQL API host. Defaults to the regional `monitoring` endpoint. */
const MONITORING_HOST = process.env.MONITORING_HOST ?? `monitoring.${REGION}.amazonaws.com`;

/** The SigV4 signing service name for the PromQL API. Always `monitoring` in production. */
const SIGNING_SERVICE = process.env.SIGNING_SERVICE ?? 'monitoring';

const omicsClient = new OmicsClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const repository = new DynamoRepository(docClient, TABLE_NAME);

/** The run's storage/window fields resolved from `omics:GetRun`. */
interface RunContext {
  storageType: string | null;
  storageCapacityGb: number | null;
  /** RFC3339 window start (run `startTime`). */
  windowStart: string;
  /** RFC3339 window end (run `stopTime ?? now`). */
  windowEnd: string;
  /** Wall-clock hours over the run window; `null` when it cannot be computed. */
  runHours: number | null;
}

/** The outcome of resolving the run context via `omics:GetRun`. */
type RunContextResolution =
  | { ok: true; context: RunContext }
  | { ok: false; errorMessage: string };

/**
 * Resolve the run's storage fields and wall-clock window via `omics:GetRun`
 * (design §2 step 2). The window is `run.startTime`..`run.stopTime ?? now`, so a
 * still-running run with no stop time gets `end = now` (mirroring
 * `metricsHandler`'s `resolveWindow`). A failed `GetRun` (or a run with no
 * `startTime`) is reported as a typed failure rather than thrown, so the caller
 * surfaces it as `RunCostEstimate.error` (Req 5.7).
 */
async function resolveRunContext(runId: string): Promise<RunContextResolution> {
  try {
    const run = await omicsClient.send(new GetRunCommand({ id: runId }));

    if (!(run.startTime instanceof Date)) {
      return {
        ok: false,
        errorMessage: `GetRun did not return a startTime for run "${runId}"`,
      };
    }

    const windowStart = run.startTime.toISOString();
    const windowEnd =
      run.stopTime instanceof Date ? run.stopTime.toISOString() : new Date().toISOString();

    return {
      ok: true,
      context: {
        storageType: typeof run.storageType === 'string' ? run.storageType : null,
        storageCapacityGb:
          typeof run.storageCapacity === 'number' ? run.storageCapacity : null,
        windowStart,
        windowEnd,
        runHours: instanceHours(windowStart, windowEnd),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage: `GetRun failed while resolving the cost estimate for run "${runId}": ${message}`,
    };
  }
}

/**
 * Load the run's task items from the single table via a `Query` on
 * `PK = RUN#<runId>`, `SK begins_with TASK#` (design §2 step 3). The repository
 * exposes no task-query method, so this issues the `QueryCommand` directly on
 * the shared document client, paginating over `LastEvaluatedKey`. Only the
 * `instanceType`/`startedAt`/`stoppedAt` fields are needed downstream.
 */
async function loadRunTasks(runId: string): Promise<TaskLike[]> {
  const tasks: TaskLike[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :taskPrefix)',
        ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
        ExpressionAttributeValues: { ':pk': runPk(runId), ':taskPrefix': 'TASK#' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const raw of result.Items ?? []) {
      const item = raw as TaskItem;
      tasks.push({
        instanceType: item.instanceType ?? null,
        startedAt: item.startedAt ?? null,
        stoppedAt: item.stoppedAt ?? null,
      });
    }

    exclusiveStartKey = result.LastEvaluatedKey ?? undefined;
  } while (exclusiveStartKey !== undefined);

  return tasks;
}

/**
 * Build the typed "the whole estimate failed" result shape (Req 5.7).
 *
 * A single helper so every hard-failure path — a failed `omics:GetRun`, a failed
 * task `Query`, and the top-level backstop — produces the *identical* shape:
 * empty line items, everything `null`, `partial: false`, and a non-null `error`.
 * This is deliberately distinct from a per-line-item `available: false`: `error`
 * being non-null means the estimate as a whole could not be read (the frontend
 * shows an error state), whereas an empty-but-successful `lineItems` with
 * `error: null` is a legitimate "run with nothing to price" result.
 */
function costError(runId: string, message: string): RunCostEstimate {
  return {
    runId,
    lineItems: [],
    total: null,
    currency: null,
    effectiveDate: null,
    partial: false,
    error: message,
  };
}

/**
 * Assemble the final {@link RunCostEstimate} from the computed line items and
 * rate-card metadata (design §2 step 7). `total` is the sum of the `estimatedCost`
 * of the `available: true` line items — `null` when none are available (Req 6.4);
 * `partial` is `true` when any line item is unavailable (Req 6.3).
 */
function assembleEstimate(
  runId: string,
  lineItems: CostLineItem[],
  currency: string | null,
  effectiveDate: string | null,
): RunCostEstimate {
  const available = lineItems.filter((item) => item.available);
  const total =
    available.length === 0
      ? null
      : available.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0);
  const partial = lineItems.some((item) => !item.available);

  return { runId, lineItems, total, currency, effectiveDate, partial, error: null };
}

/**
 * AppSync Lambda resolver for `getRunCostEstimate`.
 *
 * Validates `runId`, resolves the run's storage/window via `omics:GetRun`, loads
 * the run's task items, loads the region's rate card (cache-first, lazy-refresh,
 * serve-stale-on-failure, typed-unavailable), computes the compute line items
 * from the aggregated per-instance-type hours, computes the single storage line
 * item (STATIC from capacity × run hours, DYNAMIC from the integrated
 * RUN_FILESYSTEM usage series), and assembles the typed `RunCostEstimate`.
 *
 * Only `runId` validation throws; every other failure (a failed `GetRun`, an
 * unavailable rate card, an absent RUN_FILESYSTEM series) flows into the typed
 * `error`/`available` fields instead of an unhandled exception.
 */
export async function handler(event: GetRunCostEstimateEvent): Promise<RunCostEstimate> {
  const { runId } = event.arguments;

  // runId validation is the ONLY throw path: an invalid argument is a caller
  // error that must surface as a GraphQL error, so it stays OUTSIDE the
  // backstop try/catch below (Req 5.7).
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('runId is required');
  }

  // Everything after validation is best-effort orchestration. Any unexpected
  // escape from the steps below degrades to the typed error result rather than
  // an unhandled Lambda exception — honoring the "only runId validation throws"
  // contract (Req 5.7).
  try {
    // (2) Resolve the run's storage fields + wall-clock window (Req 5.7 on failure).
    const resolvedRun = await resolveRunContext(runId);
    if (!resolvedRun.ok) {
      return costError(runId, resolvedRun.errorMessage);
    }
    const run = resolvedRun.context;

    // (3) Load the run's task items (instanceType, startedAt, stoppedAt).
    //
    // A task-query failure is a genuinely FAILED read of the run's tasks, which
    // is a typed error — NOT "the run has no tasks". Conflating the two would
    // silently report a $0-compute estimate for a run whose task query merely
    // broke, so we catch the query failure here and return the error result
    // (distinct from `loadRunTasks` legitimately returning `[]`).
    let tasks: TaskLike[];
    try {
      tasks = await loadRunTasks(runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return costError(
        runId,
        `Failed to load tasks while resolving the cost estimate for run "${runId}": ${message}`,
      );
    }

    // (4) Load the region's rate card (cache-first, lazy-refresh, serve-stale) (Req 4.1).
    //
    // `loadRateCard` already returns a typed `unavailable` on Price List
    // failure, but its DynamoDB cache read/write (getRateCard/putRateCard/
    // recordRateCardFailure) could still throw. An unexpected throw here must
    // NOT fail the whole estimate: degrade to an unavailable rate map (empty
    // rates, null currency/effectiveDate) exactly like the `status !== 'ok'`
    // branch, so compute/storage line items become honestly `available: false`.
    let rateMap: RateMap = {};
    let currency: string | null = null;
    let effectiveDate: string | null = null;
    try {
      const rateCard = await loadRateCard(repository, { fetchRateMap }, REGION);
      if (rateCard.status === 'ok') {
        rateMap = rateCard.rates;
        currency = rateCard.currency;
        effectiveDate = rateCard.effectiveDate;
      }
    } catch {
      // Fall through with the unavailable-rate-map defaults above.
    }

    // (5) Compute line items (Req 2.2–2.6).
    const computeItems = computeComputeLineItems(aggregateComputeHours(tasks), rateMap);

    // (6) Storage line item: STATIC from capacity × hours, DYNAMIC from the
    // integrated RUN_FILESYSTEM series (Req 3.1–3.6).
    const isDynamic =
      typeof run.storageType === 'string' && run.storageType.toUpperCase() === 'DYNAMIC';
    let filesystemPoints: UsagePoint[] | null = null;
    if (isDynamic) {
      // `fetchRunFilesystemUsage` is designed to return `null` on failure, but
      // guard the call anyway so an unexpected throw degrades the storage line
      // item to unavailable rather than failing the whole estimate (Req 3.4).
      try {
        filesystemPoints = await fetchRunFilesystemUsage(
          runId,
          { start: run.windowStart, end: run.windowEnd },
          { host: MONITORING_HOST, region: REGION, service: SIGNING_SERVICE },
        );
      } catch {
        filesystemPoints = null;
      }
    }

    const storageItem = computeStorageLineItem({
      storageType: run.storageType,
      storageCapacityGb: run.storageCapacityGb,
      runHours: run.runHours,
      filesystemPoints,
      rateMap,
    });

    // (7) Assemble the typed result (Req 6.3, 6.4).
    return assembleEstimate(runId, [...computeItems, storageItem], currency, effectiveDate);
  } catch (err) {
    // Backstop: any unexpected escape from the orchestration above becomes the
    // typed error result — never a rethrown, unhandled Lambda exception (Req 5.7).
    const message = err instanceof Error ? err.message : String(err);
    return costError(runId, message);
  }
}
