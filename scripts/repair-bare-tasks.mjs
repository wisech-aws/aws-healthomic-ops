#!/usr/bin/env node
/**
 * repair-bare-tasks.mjs — re-enrich BARE terminal task records and rebuild the
 * affected runs' Run_Summary rollups.
 *
 * A "bare" task is a terminal task item that was persisted with only a status
 * (no startedAt/stoppedAt/name/cpus/memory) because its GetRunTask enrichment
 * was throttled during a large batch (the several-thousand-run storm). Those
 * show up as empty rows in the task timeline. HealthOmics still has the data,
 * so this script re-fetches each bare task via GetRunTask — RATE-LIMITED to the
 * HealthOmics ~10 TPS budget (reusing the ingest limiter) — upserts the repaired
 * task, then recomputes the run's Run_Summary (task-derived fields + a fresh
 * utilization sweep) so utilization/timeline reflect the repaired tasks.
 *
 * Reuses the ingest package's COMPILED helpers, so build ingest first:
 *   (cd ingest && npm run build)
 *
 * Usage:
 *   scripts/repair-bare-tasks.mjs --help
 *   # Repair every run in a batch:
 *   scripts/repair-bare-tasks.mjs --batch-id 8013680 --table-name <T> --region us-east-1
 *   # Repair specific runs:
 *   scripts/repair-bare-tasks.mjs --run-ids 2090617,7177112 --table-name <T> --region us-east-1
 *   # Dry-run (report bare-task counts, re-enrich nothing, write nothing):
 *   scripts/repair-bare-tasks.mjs --batch-id 8013680 --dry-run --table-name <T> --region us-east-1
 *
 * Options:
 *   --table-name <name>  DynamoDB single table (or $TABLE_NAME). Required.
 *   --region <region>    AWS region (or $AWS_REGION). Required.
 *   --batch-id <id>      Repair all runs in this HealthOmics run batch.
 *   --run-ids <a,b,...>  Repair the listed run ids (comma-separated).
 *   --tps <n>            HealthOmics read pace (default 10). Sets OMICS_TPS.
 *   --dry-run            Report bare-task counts; re-enrich/write nothing.
 *   --help, -h           Print help and exit (no SDK import).
 */
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    [
      'repair-bare-tasks.mjs — re-enrich bare terminal tasks + rebuild summaries.',
      '',
      '  --table-name <name>  DynamoDB single table (or $TABLE_NAME). Required.',
      '  --region <region>    AWS region (or $AWS_REGION). Required.',
      '  --batch-id <id>      Repair all runs in a HealthOmics run batch.',
      '  --run-ids <a,b,...>  Repair the listed run ids.',
      '  --tps <n>            HealthOmics read pace (default 10).',
      '  --dry-run            Report only; re-enrich/write nothing.',
      '  --help, -h           Print help and exit.',
      '',
      'Build ingest first: (cd ingest && npm run build)',
    ].join('\n'),
  );
  process.exit(0);
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const DRY_RUN = process.argv.includes('--dry-run');
const TABLE_NAME = arg('--table-name', process.env.TABLE_NAME);
const REGION = arg('--region', process.env.AWS_REGION);
const BATCH_ID = arg('--batch-id');
const RUN_IDS_ARG = arg('--run-ids');
const TPS = String(arg('--tps', '10'));

if (!TABLE_NAME || typeof TABLE_NAME !== 'string') {
  console.error('Error: --table-name (or $TABLE_NAME) is required. Use --help.');
  process.exit(2);
}
if (!REGION || typeof REGION !== 'string') {
  console.error('Error: --region (or $AWS_REGION) is required. Use --help.');
  process.exit(2);
}
if (!BATCH_ID && !RUN_IDS_ARG) {
  console.error('Error: provide --batch-id or --run-ids. Use --help.');
  process.exit(2);
}

// Pace the compiled ingest enricher to the requested TPS (default 10).
process.env.OMICS_TPS = TPS;

// Resolve the AWS SDK + compiled ingest helpers from the ingest package.
const scriptDir = nodePath.dirname(fileURLToPath(import.meta.url));
const ingestRequire = createRequire(nodePath.join(scriptDir, '..', 'ingest', 'package.json'));
const { DynamoDBClient } = await import(ingestRequire.resolve('@aws-sdk/client-dynamodb'));
const { DynamoDBDocumentClient, QueryCommand } = await import(
  ingestRequire.resolve('@aws-sdk/lib-dynamodb')
);
const { OmicsClient } = await import(ingestRequire.resolve('@aws-sdk/client-omics'));
const distUrl = (rel) => fileURLToPath(new URL(`../ingest/dist/${rel}`, import.meta.url));
const { enrichTask } = await import(distUrl('enrichment/tasks.js'));
const { computeRunSummary } = await import(distUrl('metrics/computeRunSummary.js'));
const {
  DynamoRepository,
  runPk,
  buildTaskItem,
} = await import(distUrl('repository.js'));
const { resolveSelectors, CORE_FAMILIES } = await import(distUrl('metrics/registry.js'));
const { buildSelector } = await import(distUrl('metrics/promql.js'));
const { buildRangeBody, clampStepSeconds, signAndPost } = await import(
  distUrl('metrics/signedQuery.js')
);
const { parseMatrix } = await import(distUrl('metrics/parse.js'));

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const repo = new DynamoRepository(doc, TABLE_NAME);
const omics = new OmicsClient({ region: REGION, retryMode: 'adaptive', maxAttempts: 5 });
const MONITORING_HOST = process.env.MONITORING_HOST ?? `monitoring.${REGION}.amazonaws.com`;
const SIGNING_SERVICE = process.env.SIGNING_SERVICE ?? 'monitoring';

/** Resolve the target run ids from --batch-id or --run-ids. */
async function resolveRunIds() {
  if (RUN_IDS_ARG) {
    return String(RUN_IDS_ARG).split(',').map((s) => s.trim()).filter(Boolean);
  }
  const out = await omics.send(
    // list-runs-in-batch
    new (await import(ingestRequire.resolve('@aws-sdk/client-omics'))).ListRunsInBatchCommand({
      batchId: BATCH_ID,
    }),
  );
  return (out.runs ?? []).map((r) => r.runId).filter(Boolean);
}

/** List all task items for a run. */
async function listTaskItems(runId) {
  const items = [];
  let start;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :t)',
        ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
        ExpressionAttributeValues: { ':pk': runPk(runId), ':t': 'TASK#' },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return items;
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const isBareTerminal = (t) => TERMINAL.has(t.status) && t.startedAt == null;

/** Read a run item (for the summary recompute). */
async function getRun(runId) {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: '#pk = :pk AND #sk = :sk',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': runPk(runId), ':sk': runPk(runId) },
    }),
  );
  return (res.Items ?? [])[0];
}

/** Utilization sweep for the run window (same signed path as ingest). */
async function sweep(run) {
  if (!run?.startedAt || !run?.stoppedAt) return [];
  try {
    const selectors = resolveSelectors(CORE_FAMILIES);
    const step = clampStepSeconds(30);
    const per = await Promise.all(
      selectors.map(async (sel) => {
        const body = buildRangeBody({
          query: buildSelector(sel.metricName, run.runId),
          start: run.startedAt,
          end: run.stoppedAt,
          step,
        });
        const r = await signAndPost(MONITORING_HOST, REGION, SIGNING_SERVICE, '/api/v1/query_range', body);
        return r.ok ? parseMatrix(r.envelope, sel.family, sel.role) : [];
      }),
    );
    return per.flat();
  } catch {
    return [];
  }
}

async function main() {
  const runIds = await resolveRunIds();
  console.log(
    `Repair bare tasks — table=${TABLE_NAME} region=${REGION} tps=${TPS} ` +
      `dryRun=${DRY_RUN} runs=${runIds.length}`,
  );
  let totalBare = 0;
  let totalRepaired = 0;
  let runsWithBare = 0;

  for (const runId of runIds) {
    const tasks = await listTaskItems(runId);
    const bare = tasks.filter(isBareTerminal);
    if (bare.length === 0) {
      console.log(`  ${runId}: no bare terminal tasks (${tasks.length} tasks)`);
      continue;
    }
    runsWithBare += 1;
    totalBare += bare.length;
    console.log(`  ${runId}: ${bare.length}/${tasks.length} bare terminal tasks`);
    if (DRY_RUN) continue;

    // Re-enrich each bare task via GetRunTask (paced by the ingest limiter at
    // OMICS_TPS). enrichTask returns the retrieved subset; if it still comes
    // back bare (no startedAt), skip writing it (leave for a later retry).
    let repaired = 0;
    for (const bt of bare) {
      const enriched = await enrichTask(omics, runId, bt.taskId);
      if (enriched.startedAt == null) {
        console.warn(`    task ${bt.taskId}: still bare after re-enrich; skipped`);
        continue;
      }
      const record = {
        ...enriched,
        runId,
        taskId: bt.taskId,
        status: bt.status,
        updatedAt: new Date().toISOString(), // win the monotonic guard
      };
      const item = buildTaskItem(record);
      await doc.send(
        new (await import(ingestRequire.resolve('@aws-sdk/lib-dynamodb'))).PutCommand({
          TableName: TABLE_NAME,
          Item: item,
        }),
      );
      repaired += 1;
    }
    totalRepaired += repaired;
    console.log(`    repaired ${repaired}/${bare.length} tasks`);

    // Rebuild the run's Run_Summary from the now-repaired tasks + a fresh sweep.
    const run = await getRun(runId);
    if (run) {
      const freshTasks = (await listTaskItems(runId));
      const series = await sweep(run);
      const summary = computeRunSummary(run, freshTasks, series, Date.now());
      summary.updatedAt = new Date().toISOString(); // force overwrite
      await repo.upsertSummary(summary);
      try {
        await repo.upsertGroupRegistry(
          summary.workflowName ?? '',
          summary.workflowVersionName,
          summary.workflowId,
        );
      } catch { /* best-effort */ }
      console.log(`    summary rebuilt (util=${summary.cpuAvailable || summary.memoryAvailable ? 'yes' : 'no'})`);
    }
  }

  console.log(
    `Done. runsWithBare=${runsWithBare} bareTasks=${totalBare} ` +
      `${DRY_RUN ? '(dry-run, nothing repaired)' : `repaired=${totalRepaired}`}`,
  );
}

main().catch((err) => {
  console.error('repair failed:', err);
  process.exit(1);
});
