/**
 * Reconciler Lambda — the deferred re-sweep.
 *
 * WHY: the ingest completion hook computes a run's final Run_Summary at the
 * TERMINAL INSTANT. At that moment two things are often not yet settled:
 *   1. Task states — EventBridge delivers at-least-once and out of order, so a
 *      RUNNING task event can be processed after the task actually finished;
 *      the authoritative-terminal-override in the ingest handler catches most,
 *      but a sub-second enrichment-lag tail can still leave a task stored as
 *      non-terminal when HealthOmics already has it terminal (and no further
 *      event arrives to correct it).
 *   2. Utilization metrics — HealthOmics emits CPU/MEMORY at a 30s interval and
 *      CloudWatch ingestion lags the terminal event by tens of seconds to
 *      minutes, so the completion-hook sweep frequently records "utilization
 *      unavailable" even though the data lands shortly after.
 *
 * This Lambda runs ONCE per terminal run, a few minutes later (scheduled by the
 * ingest completion hook via a one-shot EventBridge Scheduler), by which point
 * both have settled. It:
 *   1. re-enriches the run + ALL its tasks from the HealthOmics read APIs
 *      (authoritative), correcting any stored task whose status/timing drifted;
 *   2. re-sweeps CloudWatch for the (now-available) utilization series;
 *   3. recomputes and re-upserts the Run_Summary with a freshly-bumped
 *      `updatedAt` so it wins the monotonic guard, and refreshes the
 *      Group_Registry;
 *   4. deletes its own one-shot schedule so nothing accumulates.
 *
 * It is idempotent and failure-isolated: if everything already settled
 * correctly it is a harmless no-op (the monotonic + terminal-status guards
 * reject stale/no-op writes), and any single step failing is logged without
 * discarding the already-persisted state. The invoke event is
 * `{ runId: string, scheduleName?: string }`.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { OmicsClient } from '@aws-sdk/client-omics';
import {
  SchedulerClient,
  DeleteScheduleCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-scheduler';

import { DynamoRepository } from './repository.js';
import { enrichRun, enrichTasks } from './enrichment/tasks.js';
import { computeRunSummary } from './metrics/computeRunSummary.js';
import { makeRunMetricSweep } from './metrics/runMetricSweep.js';
import type { RunRecord, TaskRecord } from './domain/records.js';
import { isTerminalStatus } from './domain/status.js';

/** The invoke event shape (from the one-shot EventBridge Scheduler target). */
export interface ReconcilerEvent {
  runId: string;
  /** The one-shot schedule to delete after reconciling (self-cleanup). */
  scheduleName?: string;
  /** The scheduler group the schedule lives in (defaults to env). */
  scheduleGroup?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

// Lazily-built singletons (reused across warm invocations).
let deps:
  | (ReconcileDeps & {
      scheduler: SchedulerClient;
      scheduleGroup: string;
      repo: DynamoRepository;
    })
  | undefined;

function buildDeps(): NonNullable<typeof deps> {
  if (deps) return deps;
  const region = requireEnv('AWS_REGION');
  const tableName = requireEnv('RECONCILER_TABLE_NAME');
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const repo = new DynamoRepository(docClient, tableName);
  const omics = new OmicsClient({ region, retryMode: 'adaptive', maxAttempts: 5 });
  const scheduler = new SchedulerClient({ region });
  const sweep = makeRunMetricSweep({
    region,
    monitoringHost: process.env.MONITORING_HOST ?? `monitoring.${region}.amazonaws.com`,
    signingService: process.env.SIGNING_SERVICE ?? 'monitoring',
  });
  const scheduleGroup = process.env.RECONCILER_SCHEDULE_GROUP ?? 'default';
  deps = {
    enrichRun: (runId) => enrichRun(omics, runId),
    enrichTasks: (runId) => enrichTasks(omics, runId),
    sweep,
    repo,
    scheduler,
    scheduleGroup,
  };
  return deps;
}

/**
 * The dependency seam for {@link reconcileRun}, so it can be unit-tested with
 * injected fakes (no real OmicsClient / CloudWatch / DynamoDB). Production wires
 * these from {@link buildDeps}.
 */
export interface ReconcileDeps {
  enrichRun(runId: string): Promise<Partial<RunRecord>>;
  enrichTasks(runId: string): Promise<Partial<TaskRecord>[]>;
  sweep(run: RunRecord): Promise<import('./metrics/parse.js').MetricSeries[]>;
  repo: {
    upsertTask(task: TaskRecord): Promise<{ outcome: string }>;
    upsertSummary(summary: import('./domain/records.js').RunSummaryRecord): Promise<{ outcome: string }>;
    upsertGroupRegistry(
      workflowName: string,
      versionName: string,
      workflowId: string | undefined,
    ): Promise<unknown>;
  };
}

/**
 * Reconcile a single run: correct task statuses, re-sweep utilization, rebuild
 * the summary. Returns a small report for the log/tests. Never throws for a
 * per-step failure (each is isolated); a total failure propagates so the
 * scheduler/Lambda retry can re-run it.
 */
export async function reconcileRun(
  d: ReconcileDeps,
  runId: string,
): Promise<{ tasksCorrected: number; withUtilization: boolean; summaryWritten: boolean }> {
  // 1. Authoritative run + task state from HealthOmics.
  const runFields = await d.enrichRun(runId);
  const run: RunRecord = {
    runId,
    updatedAt: new Date().toISOString(),
    ...runFields,
  };

  const authoritativeTasks = await d.enrichTasks(runId);

  // 2. Correct any stored task whose authoritative state differs. The
  //    repository's monotonic + terminal-status guards make a redundant write a
  //    harmless no-op, so we can upsert every authoritative task; count only
  //    the ones that actually carried a terminal status (the correction target).
  let tasksCorrected = 0;
  for (const t of authoritativeTasks) {
    if (t.taskId === undefined) continue;
    const task: TaskRecord = {
      ...t,
      runId,
      taskId: t.taskId,
      updatedAt: new Date().toISOString(),
    };
    try {
      const res = await d.repo.upsertTask(task);
      if (res.outcome === 'written' && isTerminalStatus(task.status)) {
        tasksCorrected += 1;
      }
    } catch (err) {
      console.error(`reconciler: upsertTask ${runId}/${t.taskId} failed`, err);
    }
  }

  // 3. Re-sweep CloudWatch (metrics have settled by now) and recompute the
  //    summary. Force-win the monotonic guard by stamping a fresh updatedAt.
  let withUtilization = false;
  let summaryWritten = false;
  try {
    const series = await d.sweep(run);
    withUtilization = series.length > 0;
    const summary = computeRunSummary(run, authoritativeTasks as TaskRecord[], series, Date.now());
    summary.updatedAt = new Date().toISOString();
    const res = await d.repo.upsertSummary(summary);
    summaryWritten = res.outcome === 'written';
    try {
      await d.repo.upsertGroupRegistry(
        summary.workflowName ?? '',
        summary.workflowVersionName,
        summary.workflowId,
      );
    } catch (err) {
      console.error(`reconciler: Group_Registry upsert for ${runId} failed`, err);
    }
  } catch (err) {
    console.error(`reconciler: summary re-sweep for ${runId} failed`, err);
  }

  return { tasksCorrected, withUtilization, summaryWritten };
}

/**
 * Delete the one-shot schedule that invoked this reconcile, so schedules never
 * accumulate. A missing schedule is not an error (it may have been cleaned up
 * already, or the invoke was manual/test).
 */
async function deleteOwnSchedule(
  d: NonNullable<typeof deps>,
  scheduleName: string | undefined,
  group: string,
): Promise<void> {
  if (!scheduleName) return;
  try {
    await d.scheduler.send(
      new DeleteScheduleCommand({ Name: scheduleName, GroupName: group }),
    );
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    console.error(`reconciler: could not delete schedule ${scheduleName}`, err);
  }
}

/** Lambda entry point. */
export async function handler(event: ReconcilerEvent): Promise<unknown> {
  const runId = event?.runId;
  if (typeof runId !== 'string' || runId.trim() === '') {
    console.warn('reconciler: event missing runId; ignoring', JSON.stringify(event));
    return { ok: false, reason: 'missing runId' };
  }
  const d = buildDeps();
  const report = await reconcileRun(d, runId);
  await deleteOwnSchedule(d, event.scheduleName, event.scheduleGroup ?? d.scheduleGroup);
  console.log(`reconciler: run ${runId} reconciled`, JSON.stringify(report));
  return { ok: true, runId, ...report };
}
