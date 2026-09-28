/**
 * Ingest Lambda entry point and pipeline (task 8.2).
 *
 * This module wires the previously-built, individually-tested blocks into the
 * end-to-end processing pipeline described in design.md ("Ingest Lambda Design"
 * → "Processing pipeline", steps 1–5, and "Failure isolation"):
 *
 *   1. Classify + map      — `detectKind` / `mapRunEvent` / `mapTaskEvent`
 *   2. Enrich on demand     — `enrichRun` / `enrichTasks` (event-triggered only)
 *   3. Resolve static graph — cache-gated by the version-qualified key
 *                             (`workflowId` + `workflowVersionName`), 30s budget,
 *                             reuse cache, record failure preserving prior state
 *   4. Persist              — `upsertRun` / `upsertTask` (monotonic guard)
 *   5. Publish              — `publishRunUpdate` / `publishTaskUpdate`
 *
 * Failure isolation (design.md; Req 4.1, 4.2, 6.2, 7.1): enrichment, graph
 * resolution, and publish are handled independently so a downstream failure
 * never discards already-persisted state. Persistence happens BEFORE publish,
 * and publish returns a result rather than throwing, so a failed/rejected
 * publish is logged and swallowed. Graph resolution is likewise best-effort and
 * records its failure on the workflow item without touching run/task state.
 *
 * The parser language modules are imported for their self-registration side
 * effects so `parseDefinition` can dispatch WDL / Nextflow / CWL definitions.
 */

import type { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { OmicsClient } from '@aws-sdk/client-omics';

import type { RunRecord, TaskRecord, RunSummaryRecord } from './domain/records.js';
import { RunStatus, TaskStatus } from './domain/status.js';
import { computeRunSummary } from './metrics/computeRunSummary.js';
import type { MetricSeries } from './metrics/parse.js';
import { parseMatrix } from './metrics/parse.js';
import { CORE_FAMILIES, resolveSelectors } from './metrics/registry.js';
import { buildSelector } from './metrics/promql.js';
import { buildRangeBody, clampStepSeconds, signAndPost } from './metrics/signedQuery.js';
import type { TaskItem } from './repository.js';
import {
  detectKind,
  mapRunEvent,
  mapTaskEvent,
} from './eventMapper.js';
import { enrichRun, enrichTask } from './enrichment/tasks.js';
import { getWorkflowDefinition } from './enrichment/workflow.js';
import { mergeRecords } from './enrichment/merge.js';
import { parseDefinition, type StaticGraph, type WorkflowDefinition } from './parser/types.js';
import { DynamoRepository } from './repository.js';
import { AppSyncPublisher } from './publisher.js';

// Import the language parsers for their self-registration side effects so the
// parser dispatcher (`parseDefinition`) can resolve WDL / Nextflow / CWL
// definitions. These modules register themselves on import (Req 6.12).
import './parser/wdl.js';
import './parser/nextflow.js';
import './parser/cwl.js';

/** Budget for resolving a workflow's static graph on first sighting (Req 6.1). */
export const GRAPH_RESOLUTION_BUDGET_MS = 30_000;

/**
 * The repository surface the handler depends on. A narrow interface (rather than
 * the concrete `DynamoRepository`) keeps the handler testable with a fake that
 * needs no DynamoDB client (Req 13.1).
 */
export interface IngestRepository {
  upsertRun(run: RunRecord): Promise<unknown>;
  upsertTask(task: TaskRecord): Promise<unknown>;
  getStaticGraph(
    workflowId: string,
    workflowVersionName: string,
  ): Promise<StaticGraph | null>;
  putStaticGraph(
    workflowId: string,
    workflowVersionName: string,
    graph: StaticGraph,
    language?: string,
  ): Promise<void>;
  recordGraphFailure(
    workflowId: string,
    workflowVersionName: string,
    reason: string,
  ): Promise<void>;
  /**
   * Persist a per-run performance rollup at terminal state
   * (workflow-performance-reports Req 1.1, 1.5). Idempotent via the monotonic
   * guard. Optional on the interface so tests that don't exercise the
   * completion hook need not implement it.
   */
  upsertSummary?(summary: RunSummaryRecord): Promise<unknown>;
  /**
   * List a run's task items, used by the completion hook to compute the rollup
   * (workflow-performance-reports Req 1.1). Optional for the same reason.
   */
  listTaskItemsForRun?(runId: string): Promise<TaskItem[]>;
  /**
   * Idempotently record a Workflow_Group in the Group_Registry so
   * `listWorkflowGroups` needs no table scan (workflow-performance-reports
   * Req 11.4). Optional so tests that don't exercise it need not implement it.
   */
  upsertGroupRegistry?(
    workflowName: string,
    versionName: string,
    workflowId: string | undefined,
  ): Promise<unknown>;
}

/**
 * The measured-utilization sweep the completion hook uses to derive mean/peak
 * CPU & memory for a terminal run (workflow-performance-reports design §"Ingest
 * completion hook"). It MUST be best-effort: an implementation returns an empty
 * series list on any failure (never throws), so utilization is flagged
 * unavailable rather than fabricated. Optional on the deps so the summary can
 * still be written (with utilization unavailable) when no summarizer is wired.
 */
export interface IngestSummarizer {
  fetchRunMetricSeries(run: RunRecord): Promise<MetricSeries[]>;
}

/**
 * The enrichment surface the handler depends on. Wraps the HealthOmics read-API
 * enrichment functions so tests can inject deterministic results without an
 * `OmicsClient` (Req 13.1). Implementations must never throw for an API failure
 * (they return only what they could retrieve).
 */
export interface IngestEnricher {
  enrichRun(runId: string): Promise<Partial<RunRecord>>;
  /**
   * Enrich the SINGLE task named by a task event. This is the per-event path;
   * fetching only the changed task (one GetRunTask) avoids the API-call
   * amplification that a full-run sweep causes on large runs.
   */
  enrichTask(runId: string, taskId: string): Promise<Partial<TaskRecord>>;
  getWorkflowDefinition(workflowId: string): Promise<WorkflowDefinition | null>;
}

/**
 * The publish surface the handler depends on. Mirrors `AppSyncPublisher`, whose
 * methods return a `PublishResult` and never throw (Req 4.8, 4.9).
 */
export interface IngestPublisher {
  publishRunUpdate(run: RunRecord): Promise<{ outcome: string }>;
  publishTaskUpdate(task: TaskRecord): Promise<{ outcome: string }>;
}

/** The collaborators the pipeline is built from; all are injectable for tests. */
export interface HandlerDependencies {
  repository: IngestRepository;
  enricher: IngestEnricher;
  publisher: IngestPublisher;
  /** Budget for graph resolution; overridable in tests. Defaults to 30s. */
  graphBudgetMs?: number;
  /**
   * Optional measured-utilization sweep for the terminal-state Run_Summary
   * rollup. When absent, the summary is still written with utilization flagged
   * unavailable (workflow-performance-reports Req 1.1).
   */
  summarizer?: IngestSummarizer;
}

/** The Lambda handler signature. */
export type IngestHandler = (
  event: EventBridgeEvent<string, unknown>,
) => Promise<void>;

/**
 * Normalize an event timestamp (or "now") into an ISO 8601 UTC millisecond
 * timestamp for `updatedAt` (Req 3.3). Uses `event.time` when it is a valid
 * timestamp, otherwise the current time; an unparseable `event.time` falls back
 * to now so a malformed time never blocks ingest.
 */
function resolveUpdatedAt(eventTime: string | undefined): string {
  if (typeof eventTime === 'string' && eventTime.trim() !== '') {
    const parsed = Date.parse(eventTime);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

/**
 * Whether a mapped run record is missing fields needed to render it, and should
 * therefore be enriched on demand (Req 2, design step 2). Enrichment is only
 * ever triggered by a real event reaching this point — never on a timer
 * (Req 2.2).
 */
function runNeedsEnrichment(run: Partial<RunRecord>): boolean {
  return (
    run.status === undefined ||
    run.name === undefined ||
    run.createdAt === undefined ||
    run.startedAt === undefined ||
    run.workflowId === undefined
  );
}

/**
 * Resolve and cache the static graph for a run's workflow version on first
 * sighting (design §7; Req 1.9, 5.3, 5.4, 5.5, 5.6, 5.7).
 *
 * The cache is gated by the version-qualified key `(workflowId,
 * workflowVersionName)`: a usable cached graph short-circuits the work and never
 * re-fetches (Req 5.3, 5.4). On a miss, it fetches the definition bundle
 * (`GetWorkflow` → download → unzip) and parses it within a 30s budget, then
 * caches the graph together with its language (Req 5.5, 5.6). Any failure
 * (fetch/download/unzip returning `null`, parse error, or budget exceeded) is
 * best-effort: it records the failure reason under the version key while
 * preserving any prior graph data, and never throws — so it cannot discard the
 * run/task state persisted earlier in the pipeline (Req 5.7, 7.1).
 *
 * `workflowVersionName` is required; the caller supplies the `DEFAULT` sentinel
 * (see {@link processRunEvent}) when the run has no version name, keeping the
 * version-qualified key well-formed (Req 5.1).
 */
async function resolveStaticGraph(
  deps: HandlerDependencies,
  workflowId: string,
  workflowVersionName: string,
): Promise<void> {
  const budgetMs = deps.graphBudgetMs ?? GRAPH_RESOLUTION_BUDGET_MS;

  try {
    // Reuse the cache: if a graph is already stored, never re-fetch (Req 6.9, 6.13).
    const cached = await deps.repository.getStaticGraph(
      workflowId,
      workflowVersionName,
    );
    if (cached !== null) {
      return;
    }

    // First sighting with no cached graph: fetch + parse within the 30s budget.
    const definition = await withBudget(
      budgetMs,
      () => deps.enricher.getWorkflowDefinition(workflowId),
    );

    if (definition === null) {
      // GetWorkflow/download/unzip failed or the budget elapsed, so there is no
      // usable definition bundle. Record the failure while preserving any prior
      // graph data (Req 5.7, 7.1).
      await deps.repository.recordGraphFailure(
        workflowId,
        workflowVersionName,
        'GetWorkflow returned no usable definition (fetch/download/unzip failed or timed out)',
      );
      return;
    }

    let graph: StaticGraph;
    try {
      graph = parseDefinition(definition);
    } catch (err) {
      await deps.repository.recordGraphFailure(
        workflowId,
        workflowVersionName,
        `parse failed: ${errorMessage(err)}`,
      );
      return;
    }

    // Cache the parsed graph under the version key, forwarding the definition's
    // language so the stored item records it (Req 5.6).
    await deps.repository.putStaticGraph(
      workflowId,
      workflowVersionName,
      graph,
      definition.language,
    );
  } catch (err) {
    // Any unexpected failure in graph resolution must not discard persisted
    // run/task state; log and (best-effort) record the failure (Req 6.2, 7.1).
    console.error(
      `handler: static graph resolution for workflow ${workflowId} failed`,
      err,
    );
    try {
      await deps.repository.recordGraphFailure(
        workflowId,
        workflowVersionName,
        `graph resolution error: ${errorMessage(err)}`,
      );
    } catch (recordErr) {
      console.error(
        `handler: recording graph failure for workflow ${workflowId} also failed`,
        recordErr,
      );
    }
  }
}

/**
 * Run `task` under a timeout budget. Resolves to the task's value, or to the
 * provided timeout value (`null`) when the budget elapses first. The underlying
 * work is not cancelled, but its late result is ignored.
 */
function withBudget<T>(
  budgetMs: number,
  task: () => Promise<T | null>,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, budgetMs);
    // Avoid keeping the event loop alive solely for this timer.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    task().then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          console.error('handler: graph definition fetch threw', err);
          resolve(null);
        }
      },
    );
  });
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Whether a run status is terminal (COMPLETED/FAILED/CANCELLED) — the trigger
 * for computing the Run_Summary rollup (workflow-performance-reports Req 1.1).
 * DELETED is intentionally excluded: a deleted run has no meaningful
 * performance rollup.
 */
function isTerminalRunStatus(status: RunRecord['status'] | undefined): boolean {
  return (
    status === RunStatus.COMPLETED ||
    status === RunStatus.FAILED ||
    status === RunStatus.CANCELLED
  );
}

/** Map a persisted {@link TaskItem} back to a {@link TaskRecord} for computation. */
function taskItemToRecord(item: TaskItem): TaskRecord {
  return {
    runId: item.runId,
    taskId: item.taskId,
    status: item.status as TaskRecord['status'],
    name: item.name,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    stoppedAt: item.stoppedAt,
    updatedAt: item.updatedAt,
    cpus: item.cpus,
    memory: item.memory,
    instanceType: item.instanceType,
    statusMessage: item.statusMessage,
    failureReason: item.failureReason,
  };
}

/**
 * Compute and persist the per-run performance rollup when a run reaches a
 * terminal state (workflow-performance-reports Req 1.1, 1.5, 1.6).
 *
 * FAILURE ISOLATION: this is best-effort and fully wrapped — any failure
 * (missing repository capability, task-list read error, metrics sweep error,
 * or summary write error) is logged and swallowed so it NEVER affects the
 * run/task upsert or publish that already succeeded (Req 1.6). Utilization is
 * derived from a best-effort sweep; when the summarizer is absent or returns no
 * series, utilization is flagged unavailable rather than fabricated. The write
 * is idempotent via the repository's monotonic guard (Req 1.5).
 */
async function maybePersistRunSummary(
  deps: HandlerDependencies,
  run: RunRecord,
): Promise<void> {
  if (!isTerminalRunStatus(run.status)) {
    return;
  }
  // The completion hook needs both capabilities; if the wired repository does
  // not provide them, skip silently (e.g. a test fake that doesn't exercise it).
  if (
    typeof deps.repository.upsertSummary !== 'function' ||
    typeof deps.repository.listTaskItemsForRun !== 'function'
  ) {
    return;
  }

  try {
    const taskItems = await deps.repository.listTaskItemsForRun(run.runId);
    const tasks = taskItems.map(taskItemToRecord);

    // Best-effort measured-utilization sweep; empty on absence/any failure so
    // utilization is flagged unavailable, never fabricated.
    let series: MetricSeries[] = [];
    if (deps.summarizer !== undefined) {
      try {
        series = await deps.summarizer.fetchRunMetricSeries(run);
      } catch (err) {
        console.error(
          `handler: metrics sweep for run ${run.runId} summary failed; ` +
            `utilization will be unavailable`,
          err,
        );
        series = [];
      }
    }

    const summary = computeRunSummary(run, tasks, series, Date.now());
    await deps.repository.upsertSummary(summary);

    // Maintain the Group_Registry so listWorkflowGroups needs no table scan at
    // scale (Req 11.4). Best-effort and separately isolated: a registry failure
    // must not undo the already-persisted summary.
    if (typeof deps.repository.upsertGroupRegistry === 'function') {
      try {
        await deps.repository.upsertGroupRegistry(
          summary.workflowName ?? '',
          summary.workflowVersionName,
          summary.workflowId,
        );
      } catch (err) {
        console.error(
          `handler: Group_Registry upsert for run ${run.runId} failed; ` +
            `summary retained`,
          err,
        );
      }
    }
  } catch (err) {
    // Never let a summary failure disturb the already-persisted run/task state
    // or the publish (Req 1.6).
    console.error(
      `handler: computing/persisting Run_Summary for run ${run.runId} failed; ` +
        `run/task state retained`,
      err,
    );
  }
}

/**
 * Process a run status-change event (design steps 1–5 for a run).
 */
async function processRunEvent(
  deps: HandlerDependencies,
  event: EventBridgeEvent<string, unknown>,
  updatedAt: string,
): Promise<void> {
  // Step 1: map event fields.
  const mapped = mapRunEvent(event);
  if (mapped.runId === undefined) {
    // Without a runId there is no key to persist against; log and ignore
    // (mapRunEvent has already logged the full event).
    console.warn('handler: run event has no runId; ignoring');
    return;
  }

  // Step 2: enrich on demand (event-triggered) when render fields are missing;
  // merge with the event winning on conflict (Req 2.4).
  let record: Partial<RunRecord> = mapped;
  if (runNeedsEnrichment(mapped)) {
    const enriched = await deps.enricher.enrichRun(mapped.runId);
    record = mergeRecords<RunRecord>(mapped, enriched);
  }

  // Assemble the full record: runId (validated above) + updatedAt (Req 3.3).
  const run: RunRecord = {
    ...record,
    runId: mapped.runId,
    updatedAt,
  };

  // Step 4: persist FIRST so downstream failures cannot discard state
  // (Req 4.1, 4.2). A persistence failure throws to the DLQ path (Req 3.10).
  await deps.repository.upsertRun(run);

  // Step 3: resolve/cache the static graph for this run's workflow version.
  // Best-effort and after persist: a graph failure never discards the persisted
  // run (Req 5.7, 7.1). The `DEFAULT` sentinel keeps the version-qualified cache
  // key well-formed when a run has no version name (Req 5.1).
  if (run.workflowId !== undefined) {
    await resolveStaticGraph(
      deps,
      run.workflowId,
      run.workflowVersionName ?? 'DEFAULT',
    );
  }

  // Step 5: publish. Never throws; log a non-published outcome and move on so a
  // publish failure does not discard the persisted run (Req 4.8, 4.9).
  const result = await deps.publisher.publishRunUpdate(run);
  if (result.outcome !== 'published') {
    console.error(
      `handler: publishRunUpdate for run ${run.runId} returned "${result.outcome}"; ` +
        `persisted data retained`,
    );
  }

  // Step 6 (workflow-performance-reports Req 1.1): when the run is terminal,
  // compute and persist its performance rollup. Best-effort and failure-isolated
  // — it never disturbs the run/task state or publish above (Req 1.6).
  await maybePersistRunSummary(deps, run);
}

/**
 * Process a task status-change event (design steps 1–5 for a task).
 *
 * The task event carries a single task; when enrichment is needed we fetch the
 * run's tasks and merge the matching one (by taskId) into the event fields, the
 * event winning on conflict (Req 2.4).
 */
async function processTaskEvent(
  deps: HandlerDependencies,
  event: EventBridgeEvent<string, unknown>,
  updatedAt: string,
): Promise<void> {
  // Step 1: map event fields.
  const mapped = mapTaskEvent(event);
  if (mapped.runId === undefined || mapped.taskId === undefined) {
    // Without both identifiers there is no key to persist against; log + ignore
    // (mapTaskEvent has already logged the full event).
    console.warn('handler: task event missing runId/taskId; ignoring');
    return;
  }

  // Step 2: enrich on demand — but ONLY for the status transitions that
  // actually carry new metadata a bare status update cannot supply. A task's
  // lifecycle is PENDING -> STARTING -> RUNNING -> (STOPPING) -> terminal, and
  // GetRunTask only ever adds:
  //   - at RUNNING: name, cpus, memory, instanceType, createdAt, startedAt
  //     (the task has now been scheduled/started, so these first exist);
  //   - at a terminal status (COMPLETED/FAILED/CANCELLED): stoppedAt +
  //     failureReason (plus a backstop for a missed RUNNING enrichment).
  // PENDING, STARTING and STOPPING add nothing beyond `status` (no new timing
  // or metadata), so they are persisted as a cheap status-only DynamoDB update
  // with NO GetRunTask call. This cuts per-task API calls from ~one-per-event
  // (5+) down to ~2 (RUNNING + terminal), removing the enrichment amplification
  // that dominated the HealthOmics call volume for a batch.
  //
  // A safety net covers the (rare) case where a very fast task never emits a
  // standalone RUNNING event: the terminal event still enriches, so timing/name
  // is captured. And if an event unexpectedly arrives already missing its
  // status (should not happen for a well-formed task event) we still enrich so
  // we never persist a status-less task.
  let record: Partial<TaskRecord> = mapped;
  const terminal = isTerminalTaskStatus(mapped.status);
  if (taskEventNeedsEnrichment(mapped)) {
    const enriched = await deps.enricher.enrichTask(mapped.runId, mapped.taskId);
    record = mergeRecords<TaskRecord>(mapped, enriched);

    // Do NOT silently persist a BARE terminal task (status only, no timing):
    // that permanently loses the task's timing/name and produces the "weird"
    // empty rows in the task timeline. When a terminal task still has no
    // `startedAt` after enrichment, the enrichment call was throttled/failed —
    // THROW so EventBridge retries (and ultimately DLQs) this event rather than
    // committing an unenriched record. The global 10 TPS rate limiter means the
    // retry is very likely to succeed once the burst subsides. A non-terminal
    // task (e.g. PENDING) legitimately has no timing yet, so it is unaffected.
    if (terminal && record.startedAt === undefined) {
      throw new Error(
        `enrichment incomplete for terminal task ${mapped.runId}/${mapped.taskId} ` +
          `(no startedAt after GetRunTask); throwing so the event is retried/DLQ'd ` +
          `rather than persisting a bare task`,
      );
    }
  }

  // Assemble the full record: identifiers (validated above) + updatedAt.
  const task: TaskRecord = {
    ...record,
    runId: mapped.runId,
    taskId: mapped.taskId,
    updatedAt,
  };

  // Step 4: persist FIRST (Req 4.1, 4.2).
  await deps.repository.upsertTask(task);

  // Step 5: publish; never throws — log a non-published outcome (Req 4.8, 4.9).
  const result = await deps.publisher.publishTaskUpdate(task);
  if (result.outcome !== 'published') {
    console.error(
      `handler: publishTaskUpdate for task ${task.runId}/${task.taskId} returned ` +
        `"${result.outcome}"; persisted data retained`,
    );
  }
}

/**
 * Whether a task status is terminal (the task has finished, one way or another).
 * Terminal events must always be enriched so final timing/name are captured
 * even if an earlier event's enrichment failed.
 */
function isTerminalTaskStatus(status: TaskRecord['status'] | undefined): boolean {
  return (
    status === TaskStatus.COMPLETED ||
    status === TaskStatus.FAILED ||
    status === TaskStatus.CANCELLED
  );
}

/**
 * Whether a task status-change event should trigger a GetRunTask enrichment.
 *
 * Enrichment is the sole source of `name`, `cpus`, `memory`, `instanceType`,
 * `createdAt`, `startedAt`, `stoppedAt`, and `failureReason` (the event itself
 * carries only `status` + identifiers). Those fields only *become available* at
 * two points in a task's lifecycle, so we enrich ONLY at those transitions:
 *
 *   - RUNNING  — the task has been scheduled and started, so name/cpus/memory/
 *                instanceType/createdAt/startedAt first exist.
 *   - terminal (COMPLETED/FAILED/CANCELLED) — stoppedAt + failureReason exist,
 *                and this also backstops a task that never emitted a standalone
 *                RUNNING event (e.g. a very fast task).
 *
 * PENDING, STARTING and STOPPING add no new metadata over their `status`, so
 * they are persisted as a cheap status-only update with NO API call — the
 * change that removes the enrichment amplification.
 *
 * As a safety net, an event that somehow lacks a recognized status is enriched
 * too, so a status-less task is never persisted bare.
 */
function taskEventNeedsEnrichment(task: Partial<TaskRecord>): boolean {
  const status = task.status;
  if (status === undefined) {
    // Unrecognized/absent status: enrich defensively rather than persist bare.
    return true;
  }
  return status === TaskStatus.RUNNING || isTerminalTaskStatus(status);
}

/**
 * Build the ingest handler from injected collaborators (Req 13.1). The returned
 * function is the EventBridge entry point; a run/task persistence failure is
 * allowed to propagate so EventBridge retries and ultimately routes to the DLQ
 * (Req 1.7, 3.10), while enrichment/graph/publish failures are isolated so they
 * never discard already-persisted state (Req 4.1, 4.2, 6.2, 7.1).
 */
export function createHandler(deps: HandlerDependencies): IngestHandler {
  return async function ingestHandler(
    event: EventBridgeEvent<string, unknown>,
  ): Promise<void> {
    const kind = detectKind(event);

    // Unknown events are logged and ignored (design step 1; Req 1.5).
    if (kind === 'UNKNOWN') {
      console.log(
        'handler: ignoring event with unrecognized detail-type',
        JSON.stringify(event),
      );
      return;
    }

    // Normalize the event timestamp for `updatedAt` (Req 3.3).
    const updatedAt = resolveUpdatedAt(event.time);

    if (kind === 'RUN') {
      await processRunEvent(deps, event, updatedAt);
      return;
    }
    await processTaskEvent(deps, event, updatedAt);
  };
}

/**
 * Read a required environment variable, throwing a clear error when it is unset
 * or empty so a misconfigured Lambda fails fast at cold start rather than
 * silently misbehaving.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/**
 * Construct the production collaborators from environment configuration
 * (`TABLE_NAME`, `APPSYNC_ENDPOINT`, `AWS_REGION`) and wire the handler. Built
 * lazily on first invocation so importing this module (e.g. in unit tests that
 * inject their own dependencies via {@link createHandler}) does not require the
 * environment to be configured.
 */
let cachedHandler: IngestHandler | undefined;

function buildDefaultHandler(): IngestHandler {
  const tableName = requireEnv('TABLE_NAME');
  const region = requireEnv('AWS_REGION');
  const endpoint = requireEnv('APPSYNC_ENDPOINT');

  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const repository = new DynamoRepository(docClient, tableName);

  // Adaptive retry mode enables the SDK's client-side rate limiter, which
  // proactively slows requests when HealthOmics returns ThrottlingException —
  // absorbing bursts before our own retry layer sees them. maxAttempts raises
  // the SDK's internal retries (default 3) so transient throttles are handled
  // inside the SDK with its own exponential backoff.
  const omics = new OmicsClient({
    region,
    retryMode: 'adaptive',
    maxAttempts: 5,
  });
  const enricher: IngestEnricher = {
    enrichRun: (runId) => enrichRun(omics, runId),
    enrichTask: (runId, taskId) => enrichTask(omics, runId, taskId),
    getWorkflowDefinition: (workflowId) => getWorkflowDefinition(omics, workflowId),
  };

  const publisher = new AppSyncPublisher({ endpoint, region });

  // Best-effort measured-utilization sweep for the terminal-state Run_Summary
  // rollup (workflow-performance-reports Req 1.1). Reuses the same signed
  // CloudWatch PromQL building blocks as `getRunMetrics`; returns [] on any
  // failure so utilization is flagged unavailable rather than fabricated.
  const monitoringHost =
    process.env.MONITORING_HOST ?? `monitoring.${region}.amazonaws.com`;
  const signingService = process.env.SIGNING_SERVICE ?? 'monitoring';
  const summarizer: IngestSummarizer = {
    async fetchRunMetricSeries(run) {
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
        console.error('handler: run-summary metrics sweep failed', err);
        return [];
      }
    },
  };

  return createHandler({ repository, enricher, publisher, summarizer });
}

/**
 * The Lambda entry point. Lazily builds the environment-configured handler on
 * first invocation, then delegates to it.
 */
export async function handler(
  event: EventBridgeEvent<string, unknown>,
): Promise<void> {
  if (cachedHandler === undefined) {
    cachedHandler = buildDefaultHandler();
  }
  return cachedHandler(event);
}
