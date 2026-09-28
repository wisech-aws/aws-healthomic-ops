#!/usr/bin/env node
/**
 * backfill-run-summaries.mjs — one-time, idempotent backfill of per-run
 * performance rollups (Run_Summary) for pre-existing terminal runs
 * (workflow-performance-reports Req 9.x).
 *
 * The Reports feature aggregates over persisted Run_Summary items that the
 * ingest pipeline writes when a run reaches a terminal state. Runs that
 * completed BEFORE the feature shipped have no such rollup, so this script
 * creates them from data already stored in the single table:
 *
 *   - Run-level facts (duration, status, task shape, workflow name/version/id)
 *     come from the stored RUN + TASK items — always available.
 *   - Utilization (CPU/memory means & peaks) comes from a bounded CloudWatch
 *     PromQL sweep, ONLY for runs still within the ~15-month retention window;
 *     for older runs (or any sweep failure) utilization is flagged UNAVAILABLE
 *     rather than fabricated (Req 9.2, 9.3).
 *
 * It is SAFE TO RE-RUN: each Run_Summary is written through the repository's
 * idempotent monotonic upsert, so re-running never duplicates or corrupts rows
 * (Req 9.4). CloudWatch requests are rate-limited (Req 9.5).
 *
 * The `--help` path never imports the AWS SDK and never touches AWS, so usage
 * can be checked without credentials. `--dry-run` performs the read-only scans
 * (and, unless --skip-metrics, the CloudWatch sweep) but is GUARANTEED to skip
 * the summary WRITE — it only reports what would be written.
 *
 * This script reuses the ingest package's COMPILED helpers, so build ingest
 * first:  (cd ingest && npm run build)
 *
 * Usage:
 *   scripts/backfill-run-summaries.mjs [options]
 *
 * Options:
 *   --table-name <name>   DynamoDB single table (or $TABLE_NAME). Required.
 *   --region <region>     AWS region (or $AWS_REGION). Required.
 *   --retention-days <n>  CloudWatch retention window in days for the
 *                          utilization sweep (default 450 ≈ 15 months). Runs
 *                          whose stopTime is older are backfilled with
 *                          utilization unavailable.
 *   --rate-ms <n>         Minimum delay between CloudWatch sweeps, ms
 *                          (default 250) to stay within API limits.
 *   --skip-metrics        Skip the CloudWatch sweep entirely; backfill only
 *                          run-level facts (utilization unavailable for all).
 *   --limit <n>           Process at most N runs (for a bounded trial run).
 *   --dry-run              Scan/compute and report; never write summaries.
 *   --help, -h             Print this help and exit. Never imports the SDK.
 *
 * Examples:
 *   scripts/backfill-run-summaries.mjs --help
 *   scripts/backfill-run-summaries.mjs --dry-run --table-name MyTable --region us-east-1
 *   scripts/backfill-run-summaries.mjs --table-name MyTable --region us-east-1
 */

import process from 'node:process';

const HELP = process.argv.includes('--help') || process.argv.includes('-h');

/** Parse `--flag value` / `--flag` from argv. */
function argValue(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

if (HELP) {
  // Print the leading block comment's usage without importing anything.
  console.log(
    [
      'backfill-run-summaries.mjs — one-time idempotent Run_Summary backfill.',
      '',
      'Options:',
      '  --table-name <name>   DynamoDB single table (or $TABLE_NAME). Required.',
      '  --region <region>     AWS region (or $AWS_REGION). Required.',
      '  --retention-days <n>  CloudWatch retention window (default 450).',
      '  --rate-ms <n>         Min delay between CloudWatch sweeps (default 250).',
      '  --skip-metrics        Backfill run-level facts only (no CloudWatch).',
      '  --force               Overwrite existing summaries (repair utilization).',
      '  --limit <n>           Process at most N runs.',
      '  --dry-run             Report only; never write summaries.',
      '  --help, -h            Print this help and exit.',
      '',
      'Build ingest first: (cd ingest && npm run build)',
    ].join('\n'),
  );
  process.exit(0);
}

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_METRICS = process.argv.includes('--skip-metrics');
// --force bumps the summary's updatedAt so it wins the monotonic upsert guard,
// letting a re-run REPAIR summaries that were written with stale/absent
// utilization (e.g. when the completion hook swept CloudWatch before metrics
// were ingested). Without --force, an existing summary with an equal-or-newer
// updatedAt is preserved (idempotent no-op).
const FORCE = process.argv.includes('--force');
const TABLE_NAME = argValue('--table-name', process.env.TABLE_NAME);
const REGION = argValue('--region', process.env.AWS_REGION);
const RETENTION_DAYS = Number(argValue('--retention-days', 450));
const RATE_MS = Number(argValue('--rate-ms', 250));
const LIMIT = argValue('--limit') ? Number(argValue('--limit')) : Infinity;

if (!TABLE_NAME || typeof TABLE_NAME !== 'string') {
  console.error('Error: --table-name (or $TABLE_NAME) is required. Use --help.');
  process.exit(2);
}
if (!REGION || typeof REGION !== 'string') {
  console.error('Error: --region (or $AWS_REGION) is required. Use --help.');
  process.exit(2);
}

// Lazily import AWS SDK + compiled ingest helpers only once past --help.
// The AWS SDK is not installed at the repo root — it lives in the ingest
// package (whose compiled dist we reuse). Resolve the SDK from there via a
// require anchored at the ingest package, then import by absolute path so the
// script works regardless of the current working directory.
const { createRequire } = await import('node:module');
const { fileURLToPath } = await import('node:url');
const nodePath = await import('node:path');
const scriptDir = nodePath.dirname(fileURLToPath(import.meta.url));
const ingestRequire = createRequire(
  nodePath.join(scriptDir, '..', 'ingest', 'package.json'),
);
const ddbPath = ingestRequire.resolve('@aws-sdk/client-dynamodb');
const libDdbPath = ingestRequire.resolve('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = await import(ddbPath);
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = await import(libDdbPath);
const distUrl = (rel) =>
  fileURLToPath(new URL(`../ingest/dist/${rel}`, import.meta.url));
const { computeRunSummary } = await import(distUrl('metrics/computeRunSummary.js'));
const { DynamoRepository, runPk } = await import(distUrl('repository.js'));
const { resolveSelectors, CORE_FAMILIES } = await import(distUrl('metrics/registry.js'));
const { buildSelector } = await import(distUrl('metrics/promql.js'));
const { buildRangeBody, clampStepSeconds, signAndPost } = await import(
  distUrl('metrics/signedQuery.js')
);
const { parseMatrix } = await import(distUrl('metrics/parse.js'));

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const repo = new DynamoRepository(doc, TABLE_NAME);

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const MONITORING_HOST = process.env.MONITORING_HOST ?? `monitoring.${REGION}.amazonaws.com`;
const SIGNING_SERVICE = process.env.SIGNING_SERVICE ?? 'monitoring';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scan all terminal RUN items. */
async function* scanTerminalRuns() {
  let exclusiveStartKey;
  do {
    const res = await doc.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: '#et = :run',
        ExpressionAttributeNames: { '#et': 'entityType' },
        ExpressionAttributeValues: { ':run': 'RUN' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of res.Items ?? []) {
      if (TERMINAL.has(item.status)) {
        yield item;
      }
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
}

/** List a run's task items. */
async function listTasks(runId) {
  const items = [];
  let exclusiveStartKey;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :t)',
        ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
        ExpressionAttributeValues: { ':pk': runPk(runId), ':t': 'TASK#' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(res.Items ?? []));
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

/** Best-effort measured-utilization sweep; [] on any failure or outside retention. */
async function sweep(run) {
  if (SKIP_METRICS || !run.startedAt || !run.stoppedAt) return [];
  const stoppedMs = Date.parse(run.stoppedAt);
  if (Number.isNaN(stoppedMs)) return [];
  const ageMs = Date.now() - stoppedMs;
  if (ageMs > RETENTION_DAYS * 86_400_000) return []; // outside retention
  try {
    await sleep(RATE_MS); // rate-limit CloudWatch
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
  } catch (err) {
    console.warn(`  metrics sweep failed for ${run.runId}: ${err?.message ?? err}`);
    return [];
  }
}

async function main() {
  console.log(
    `Backfill Run_Summary — table=${TABLE_NAME} region=${REGION} ` +
      `dryRun=${DRY_RUN} skipMetrics=${SKIP_METRICS} retentionDays=${RETENTION_DAYS}`,
  );
  let processed = 0;
  let written = 0;
  let withUtil = 0;

  for await (const run of scanTerminalRuns()) {
    if (processed >= LIMIT) break;
    processed += 1;

    const taskItems = await listTasks(run.runId);
    // The stored RUN item may lack workflowVersionName (the event mapper does
    // not capture it). The completion hook grouped by the ENRICHED version from
    // GetRun, so to match its grouping, backfill recovers workflowVersionName
    // (and workflowName) from the captured rawGetRun when the item lacks them.
    if ((run.workflowVersionName == null || run.workflowName == null) && run.rawGetRun) {
      try {
        const raw = JSON.parse(run.rawGetRun);
        if (run.workflowVersionName == null && typeof raw.workflowVersionName === 'string') {
          run.workflowVersionName = raw.workflowVersionName;
        }
        if (run.workflowName == null && typeof raw.name === 'string') {
          // GetRun has no workflowName; the ingest mapping derives it elsewhere.
          // Leave workflowName as-is if absent — do not overwrite with run name.
        }
      } catch {
        // Malformed rawGetRun: fall back to the item fields (versionless).
      }
    }
    // TaskItem shape already matches TaskRecord for the fields computeRunSummary reads.
    const series = await sweep(run);
    if (series.length > 0) withUtil += 1;

    const summary = computeRunSummary(run, taskItems, series, Date.now());
    // With --force, bump updatedAt so this recomputed summary strictly exceeds
    // any existing one and the monotonic upsert overwrites it (repair mode).
    if (FORCE) {
      summary.updatedAt = new Date().toISOString();
    }

    if (DRY_RUN) {
      console.log(
        `  [dry-run] ${run.runId} ${summary.workflowName ?? '—'} / ${summary.workflowVersionName} ` +
          `status=${summary.status} tasks=${summary.taskCount} ` +
          `util=${summary.cpuAvailable || summary.memoryAvailable ? 'yes' : 'no'}`,
      );
    } else {
      const res = await repo.upsertSummary(summary);
      if (res.outcome === 'written') written += 1;
      // Maintain the Group_Registry so listWorkflowGroups needs no scan (Req 11.4).
      try {
        await repo.upsertGroupRegistry(
          summary.workflowName ?? '',
          summary.workflowVersionName,
          summary.workflowId,
        );
      } catch (err) {
        console.warn(`  group-registry upsert failed for ${run.runId}: ${err?.message ?? err}`);
      }
      console.log(`  ${run.runId}: ${res.outcome}`);
    }
  }

  console.log(
    `Done. processed=${processed} ${DRY_RUN ? '(dry-run, nothing written)' : `written=${written}`} ` +
      `withUtilization=${withUtil}`,
  );
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
