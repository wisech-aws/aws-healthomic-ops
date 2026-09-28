/**
 * Reports Lambda — AppSync Lambda-data-source resolver for the aggregate
 * workflow/version performance reports (workflow-performance-reports Req 2.x,
 * 3.x, 5.x, 6.x; design §4 "AppSync GraphQL surface").
 *
 * A single NodejsFunction backs BOTH report fields, dispatched on
 * `info.fieldName` (the same direct-Lambda-resolver `router` pattern as the
 * logs Lambda):
 *   - `listWorkflowGroups(start, end)` — enumerate the distinct
 *     `(workflowName, versionName)` Workflow_Groups whose Run_Summary rows fall
 *     in the window, each with a run count and the set of workflowIds observed
 *     (so the frontend can flag a Collision_State). Backed by a filtered Scan
 *     of the single table (entityType = SUMMARY within the window), grouped
 *     in-memory — acceptable for the picker, which needs all groups at once.
 *   - `getWorkflowReport(workflowName, versionName, start, end)` — read the one
 *     group's Run_Summary rows time-ordered from GSI2 over the window, aggregate
 *     each Tracked_Metric into mean/median/p90 over the runs where it was
 *     available (never counting unavailable as 0), and return the outcome
 *     counts, collision flag, and a per-run timeline.
 *
 * The load-bearing theme, inherited from the sibling metrics/cost Lambdas, is
 * availability honesty: an unavailable metric is excluded from its statistics
 * and surfaced with its "N of M" denominator, never fabricated as 0 (Req 3.2,
 * 3.4, 10.1, 10.2). Memory statistics stay in GiB (Req 10.4).
 *
 * Failure handling mirrors the cost/metrics Lambdas: a genuine read failure is
 * surfaced (thrown → GraphQL error) rather than silently returning an empty
 * report that a caller could mistake for "no runs".
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { groupGsi2Pk, DynamoRepository } from './repository.js';
import type { SummaryItem, GroupRegistryItem } from './repository.js';
import {
  aggregateMetric,
  detectCollision,
  distinctWorkflowIds,
  buildHistogram,
  buildTimeBins,
  type MetricValue,
  type TimeBinPoint,
} from './metrics/aggregate.js';

const REGION = process.env.REPORTS_REGION ?? process.env.AWS_REGION ?? '';
const TABLE_NAME = process.env.REPORTS_TABLE_NAME ?? '';
const GSI2_INDEX_NAME = process.env.REPORTS_GSI2_NAME ?? 'GSI2';

/** Bounded caps so the report payload never grows with run count (Req 11.1-11.3). */
const HISTOGRAM_BUCKETS = 24;
const TIME_BINS = 30;
const SAMPLE_LIMIT = 50;

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const repo = new DynamoRepository(docClient, TABLE_NAME);

/** The Tracked_Metric keys the report aggregates, with their display units. */
const METRIC_KEYS: ReadonlyArray<{ key: keyof SummaryItem; unit: string }> = [
  { key: 'durationMs', unit: 'ms' },
  { key: 'meanCpu', unit: 'vCPU' },
  { key: 'peakCpu', unit: 'vCPU' },
  { key: 'meanMemoryGiB', unit: 'GiB' },
  { key: 'peakMemoryGiB', unit: 'GiB' },
  { key: 'cpuHours', unit: 'CPU-hours' },
  { key: 'peakConcurrentTasks', unit: 'tasks' },
  { key: 'taskCount', unit: 'tasks' },
  { key: 'failedTaskCount', unit: 'tasks' },
];

/** Map a metric key to the SummaryItem availability flag that gates it. */
const AVAILABILITY_FLAG: Partial<Record<keyof SummaryItem, keyof SummaryItem>> = {
  durationMs: 'durationAvailable',
  meanCpu: 'cpuAvailable',
  peakCpu: 'cpuAvailable',
  meanMemoryGiB: 'memoryAvailable',
  peakMemoryGiB: 'memoryAvailable',
  cpuHours: 'cpuHoursAvailable',
  peakConcurrentTasks: 'concurrencyAvailable',
  // taskCount / failedTaskCount are always available for a terminal run.
};

/** GraphQL `AggregateMetric`. */
interface AggregateMetricOut {
  key: string;
  unit: string;
  mean: number | null;
  median: number | null;
  p90: number | null;
  availableCount: number;
  totalCount: number;
}

/** GraphQL `RunPoint`. */
interface RunPointOut {
  runId: string;
  stoppedAt: string;
  status: string | null;
  durationMs: number | null;
  meanCpu: number | null;
  peakCpu: number | null;
  meanMemoryGiB: number | null;
  peakMemoryGiB: number | null;
  cpuHours: number | null;
  peakConcurrentTasks: number | null;
  taskCount: number | null;
  failedTaskCount: number | null;
}

/** GraphQL `WorkflowGroup`. */
interface WorkflowGroupOut {
  workflowName: string;
  versionName: string;
  workflowIds: string[];
  runCount: number;
}

/** GraphQL `HistogramBucket` / `MetricHistogram`. */
interface HistogramBucketOut {
  lo: number;
  hi: number;
  count: number;
}
interface MetricHistogramOut {
  key: string;
  unit: string | null;
  buckets: HistogramBucketOut[];
  availableCount: number;
  totalCount: number;
}

/** GraphQL `TimeBin`. */
interface TimeBinOut {
  start: string;
  end: string;
  runCount: number;
  durationMeanMs: number | null;
  durationP90Ms: number | null;
}

/** GraphQL `WorkflowReport` (size-bounded — no per-run list beyond `sample`). */
interface WorkflowReportOut {
  workflowName: string;
  versionName: string;
  window: { start: string; end: string; stepSeconds: number };
  runCount: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  collision: boolean;
  metrics: AggregateMetricOut[];
  durationHistogram: MetricHistogramOut | null;
  timeBins: TimeBinOut[];
  sample: RunPointOut[];
  sampleCapped: boolean;
}

interface ListGroupsArgs {
  start: string;
  end: string;
}
interface GetReportArgs {
  workflowName: string;
  versionName: string;
  start: string;
  end: string;
}
interface ListRunPointsArgs {
  workflowName: string;
  versionName: string;
  start: string;
  end: string;
  limit?: number | null;
  nextToken?: string | null;
}

/** The resolver event: AppSync direct-Lambda context (field + arguments). */
interface ResolverEvent {
  info?: { fieldName?: string };
  arguments: Record<string, unknown>;
}

/** Read a numeric SummaryItem field as a MetricValue, gated by its availability flag. */
function metricValue(item: SummaryItem, key: keyof SummaryItem): MetricValue {
  const flagKey = AVAILABILITY_FLAG[key];
  if (flagKey !== undefined && item[flagKey] !== true) {
    return null;
  }
  const raw = item[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** Map a SummaryItem to a GraphQL RunPoint (availability-gated values). */
function toRunPoint(r: SummaryItem): RunPointOut {
  return {
    runId: r.runId,
    stoppedAt: r.stoppedAt ?? r.updatedAt,
    status: r.status ?? null,
    durationMs: metricValue(r, 'durationMs'),
    meanCpu: metricValue(r, 'meanCpu'),
    peakCpu: metricValue(r, 'peakCpu'),
    meanMemoryGiB: metricValue(r, 'meanMemoryGiB'),
    peakMemoryGiB: metricValue(r, 'peakMemoryGiB'),
    cpuHours: metricValue(r, 'cpuHours'),
    peakConcurrentTasks: metricValue(r, 'peakConcurrentTasks'),
    taskCount: typeof r.taskCount === 'number' ? r.taskCount : null,
    failedTaskCount: typeof r.failedTaskCount === 'number' ? r.failedTaskCount : null,
  };
}

/**
 * Handle `listWorkflowGroups` — reads the Group_Registry (single `GROUPS`
 * partition), NOT a table scan (Req 11.4). The window args are accepted for API
 * compatibility; the registry is the authoritative, bounded enumeration.
 */
async function listWorkflowGroups(_args: ListGroupsArgs): Promise<WorkflowGroupOut[]> {
  const registry: GroupRegistryItem[] = await repo.listGroupRegistry();
  return registry
    .map((g) => ({
      workflowName: g.workflowName,
      versionName: g.versionName,
      workflowIds: distinctWorkflowIds(g.workflowIds ?? []),
      runCount: typeof g.runCount === 'number' ? g.runCount : 0,
    }))
    .sort((a, b) =>
      a.workflowName === b.workflowName
        ? a.versionName.localeCompare(b.versionName)
        : a.workflowName.localeCompare(b.workflowName),
    );
}

/**
 * Handle `getWorkflowReport` — a single streaming pass over the group's GSI2
 * range that produces a SIZE-BOUNDED result: exact aggregate statistics +
 * outcome counts + collision + a fixed-size duration histogram + fixed-size
 * time bins + a capped recent-run sample (Req 11.1, 11.2, 11.3). It never
 * returns one row per run.
 */
async function getWorkflowReport(args: GetReportArgs): Promise<WorkflowReportOut> {
  const gsi2pk = groupGsi2Pk(args.workflowName, args.versionName);
  const startMs = Date.parse(args.start);
  const endMs = Date.parse(args.end);

  // Accumulators — bounded memory except the per-metric value arrays needed for
  // exact median/p90 (nearest-rank). taskCount/failedTaskCount are small ints.
  const metricValues: Record<string, MetricValue[]> = {};
  for (const { key } of METRIC_KEYS) {
    metricValues[String(key)] = [];
  }
  const timeBinPoints: TimeBinPoint[] = [];
  const durationValues: MetricValue[] = [];
  let runCount = 0;
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  const workflowIds: (string | undefined)[] = [];
  // Keep only the most recent SAMPLE_LIMIT rows (GSI2 is ascending by stoppedAt,
  // so keep a trailing window).
  const sampleRows: SummaryItem[] = [];
  let sampleCapped = false;

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: GSI2_INDEX_NAME,
        KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :start AND :end',
        ExpressionAttributeNames: { '#pk': 'GSI2PK', '#sk': 'GSI2SK' },
        ExpressionAttributeValues: { ':pk': gsi2pk, ':start': args.start, ':end': args.end },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const r of (result.Items ?? []) as SummaryItem[]) {
      runCount += 1;
      if (r.status === 'COMPLETED') succeeded += 1;
      else if (r.status === 'FAILED') failed += 1;
      else if (r.status === 'CANCELLED') cancelled += 1;
      workflowIds.push(r.workflowId);
      for (const { key } of METRIC_KEYS) {
        metricValues[String(key)].push(metricValue(r, key));
      }
      const dur = metricValue(r, 'durationMs');
      durationValues.push(dur);
      const stoppedMs = Date.parse(r.stoppedAt ?? r.updatedAt);
      if (!Number.isNaN(stoppedMs)) {
        timeBinPoints.push({ stoppedAtMs: stoppedMs, durationMs: dur });
      }
      // Maintain a trailing recent sample.
      sampleRows.push(r);
      if (sampleRows.length > SAMPLE_LIMIT) {
        sampleRows.shift();
        sampleCapped = true;
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  const metrics: AggregateMetricOut[] = METRIC_KEYS.map(({ key, unit }) => {
    const agg = aggregateMetric(metricValues[String(key)]);
    return { key: String(key), unit, ...agg };
  });

  const durHist = buildHistogram(durationValues, HISTOGRAM_BUCKETS, runCount);
  const durationHistogram: MetricHistogramOut | null =
    durHist.availableCount > 0
      ? {
          key: 'durationMs',
          unit: 'ms',
          buckets: durHist.buckets,
          availableCount: durHist.availableCount,
          totalCount: durHist.totalCount,
        }
      : null;

  const timeBins: TimeBinOut[] =
    !Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs
      ? buildTimeBins(timeBinPoints, startMs, endMs, TIME_BINS)
      : [];

  return {
    workflowName: args.workflowName,
    versionName: args.versionName,
    window: { start: args.start, end: args.end, stepSeconds: 0 },
    runCount,
    succeeded,
    failed,
    cancelled,
    collision: detectCollision(workflowIds),
    metrics,
    durationHistogram,
    timeBins,
    sample: sampleRows.map(toRunPoint),
    sampleCapped,
  };
}

/**
 * Handle `listWorkflowRunPoints` — a single paginated page of per-run rows for
 * the CSV export path (Req 7.2, 11.3), kept OUT of `getWorkflowReport` so the
 * report payload stays bounded. Returns items + an opaque `nextToken`.
 */
async function listWorkflowRunPoints(
  args: ListRunPointsArgs,
): Promise<{ items: RunPointOut[]; nextToken: string | null }> {
  const gsi2pk = groupGsi2Pk(args.workflowName, args.versionName);
  const limit =
    typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 1000) : 500;
  const exclusiveStartKey =
    typeof args.nextToken === 'string' && args.nextToken !== ''
      ? (JSON.parse(Buffer.from(args.nextToken, 'base64').toString('utf8')) as Record<
          string,
          unknown
        >)
      : undefined;

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: GSI2_INDEX_NAME,
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :start AND :end',
      ExpressionAttributeNames: { '#pk': 'GSI2PK', '#sk': 'GSI2SK' },
      ExpressionAttributeValues: { ':pk': gsi2pk, ':start': args.start, ':end': args.end },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );
  const items = ((result.Items ?? []) as SummaryItem[]).map(toRunPoint);
  const lek = result.LastEvaluatedKey;
  const nextToken = lek
    ? Buffer.from(JSON.stringify(lek), 'utf8').toString('base64')
    : null;
  return { items, nextToken };
}

/**
 * AppSync entry point. Dispatches on `info.fieldName` so one Lambda backs all
 * report queries (direct-Lambda-resolver router, like `logsHandler.ts`).
 */
export async function handler(event: ResolverEvent): Promise<unknown> {
  const field = event.info?.fieldName;
  const args = event.arguments ?? {};
  if (field === 'listWorkflowGroups') {
    return listWorkflowGroups(args as unknown as ListGroupsArgs);
  }
  if (field === 'getWorkflowReport') {
    return getWorkflowReport(args as unknown as GetReportArgs);
  }
  if (field === 'listWorkflowRunPoints') {
    return listWorkflowRunPoints(args as unknown as ListRunPointsArgs);
  }
  throw new Error(`reportsHandler: unsupported field "${String(field)}"`);
}
