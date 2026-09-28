#!/usr/bin/env node
/**
 * repair-task-status.mjs — correct stored task `status` to match the
 * authoritative HealthOmics `ListRunTasks` status.
 *
 * Fixes the "stuck RUNNING despite a COMPLETED run" defect: under out-of-order /
 * at-least-once EventBridge delivery, a redelivered non-terminal task event
 * could overwrite the terminal status while leaving `stoppedAt` set — producing
 * a task item that is internally inconsistent (has stoppedAt but status
 * RUNNING). The ingest handler now carries a status-monotonic guard so this can
 * no longer happen going forward; this script repairs items written before the
 * fix.
 *
 * For each run (via --batch-id or --run-ids) it:
 *   1. reads the authoritative task statuses from HealthOmics ListRunTasks
 *      (paginated, rate-limited to the ~10 TPS budget),
 *   2. compares to the stored DynamoDB task items,
 *   3. for any mismatch, writes the correct status (and stoppedAt when the
 *      authoritative task has a stopTime) with a freshly-bumped updatedAt so it
 *      wins the monotonic upsert guard.
 *
 * Usage:
 *   scripts/repair-task-status.mjs --batch-id <id> [--dry-run] [--tps 10] \
 *       --table-name <table> --region us-east-1
 *   scripts/repair-task-status.mjs --run-ids 111,222 --table-name <t> --region <r>
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const DRY = process.argv.includes('--dry-run');
const BATCH_ID = arg('batch-id');
const RUN_IDS = arg('run-ids');
const TABLE = arg('table-name');
const REGION = arg('region', 'us-east-1');
const TPS = Number(arg('tps', '10'));

if (process.argv.includes('--help') || (!BATCH_ID && !RUN_IDS) || !TABLE) {
  console.log(
    'usage: repair-task-status.mjs (--batch-id <id> | --run-ids a,b) --table-name <t> [--region us-east-1] [--tps 10] [--dry-run]',
  );
  process.exit(process.argv.includes('--help') ? 0 : 1);
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'DELETED']);

// Resolve the AWS SDK v3 from the ingest package (same pattern as
// repair-bare-tasks.mjs) so the script works without its own node_modules.
const scriptDir = nodePath.dirname(fileURLToPath(import.meta.url));
const ingestRequire = createRequire(nodePath.join(scriptDir, '..', 'ingest', 'package.json'));
const { DynamoDBClient } = await import(ingestRequire.resolve('@aws-sdk/client-dynamodb'));
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = await import(
  ingestRequire.resolve('@aws-sdk/lib-dynamodb')
);
const { OmicsClient, ListRunTasksCommand, ListRunsInBatchCommand } = await import(
  ingestRequire.resolve('@aws-sdk/client-omics')
);

const omics = new OmicsClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
// Simple TPS pacer for the HealthOmics reads.
let lastCall = 0;
const minGapMs = 1000 / Math.max(1, TPS);
async function paced(fn) {
  const now = Date.now();
  const wait = Math.max(0, lastCall + minGapMs - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

async function resolveRunIds() {
  if (RUN_IDS) return String(RUN_IDS).split(',').map((s) => s.trim()).filter(Boolean);
  const ids = [];
  let startingToken;
  do {
    const res = await paced(() =>
      omics.send(new ListRunsInBatchCommand({ batchId: BATCH_ID, startingToken })),
    );
    for (const r of res.items ?? res.runs ?? []) ids.push(r.runId ?? r.id);
    startingToken = res.nextToken;
  } while (startingToken);
  return ids;
}

async function authoritativeTasks(runId) {
  const map = new Map(); // taskId -> { status, stopTime }
  let startingToken;
  do {
    const res = await paced(() =>
      omics.send(new ListRunTasksCommand({ id: runId, startingToken })),
    );
    for (const t of res.items ?? []) {
      map.set(String(t.taskId), {
        status: t.status,
        stopTime: t.stopTime instanceof Date ? t.stopTime.toISOString() : t.stopTime,
      });
    }
    startingToken = res.nextToken;
  } while (startingToken);
  return map;
}

async function storedTasks(runId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :t)',
        ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':t': 'TASK#' },
        ExclusiveStartKey,
      }),
    );
    items.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function main() {
  const runIds = await resolveRunIds();
  console.log(`Repairing task status for ${runIds.length} run(s); DRY_RUN=${DRY}`);
  let totalFixed = 0;
  let runsAffected = 0;

  for (const runId of runIds) {
    const [truth, stored] = await Promise.all([authoritativeTasks(runId), storedTasks(runId)]);
    const fixes = [];
    for (const item of stored) {
      const taskId = String(item.taskId);
      const auth = truth.get(taskId);
      if (!auth || !auth.status) continue;
      if (item.status !== auth.status) {
        fixes.push({ taskId, from: item.status, to: auth.status, stopTime: auth.stopTime });
      }
    }
    if (fixes.length === 0) continue;
    runsAffected += 1;
    console.log(`  run ${runId}: ${fixes.length} status mismatch(es)`);
    for (const f of fixes) {
      totalFixed += 1;
      console.log(`    task ${f.taskId}: ${f.from} -> ${f.to}`);
      if (DRY) continue;
      const now = new Date().toISOString();
      const names = { '#s': 'status', '#u': 'updatedAt' };
      const values = { ':s': f.to, ':u': now };
      let expr = 'SET #s = :s, #u = :u';
      if (f.stopTime && TERMINAL.has(f.to)) {
        names['#st'] = 'stoppedAt';
        values[':st'] = f.stopTime;
        expr += ', #st = :st';
      }
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `RUN#${runId}`, SK: `TASK#${f.taskId}` },
          UpdateExpression: expr,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    }
  }
  console.log(
    `\nDone. runs affected: ${runsAffected}/${runIds.length}; task statuses ${DRY ? 'to fix' : 'fixed'}: ${totalFixed}`,
  );
}

main().catch((e) => {
  console.error('repair-task-status failed:', e);
  process.exit(1);
});
