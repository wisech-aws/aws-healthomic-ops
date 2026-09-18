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

import type { RunRecord, TaskRecord } from './domain/records.js';
import { TaskStatus } from './domain/status.js';
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

  // Step 2: enrich on demand (event-triggered) when render fields are missing.
  // Fetch ONLY the task named by this event (one GetRunTask), not the whole
  // run, then merge with the event winning on conflict (Req 2.4). Fetching per
  // task avoids the amplification storm (a full-run sweep on every task event
  // throttles HealthOmics and drops timing/name for large runs).
  let record: Partial<TaskRecord> = mapped;
  // Always enrich when render fields are missing, AND always enrich on a
  // terminal status (COMPLETED/FAILED/CANCELLED) so the final timing
  // (startedAt/stoppedAt) and name are captured even if an earlier event's
  // enrichment failed. The terminal event carries the freshest `updatedAt`, so
  // the monotonic upsert lets this fully-enriched record overwrite any earlier
  // status-only record for the task.
  if (taskNeedsEnrichment(mapped) || isTerminalTaskStatus(mapped.status)) {
    const enriched = await deps.enricher.enrichTask(mapped.runId, mapped.taskId);
    record = mergeRecords<TaskRecord>(mapped, enriched);
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
 * Whether a mapped task record is missing fields needed to render it and should
 * be enriched on demand (Req 2, design step 2).
 */
function taskNeedsEnrichment(task: Partial<TaskRecord>): boolean {
  return (
    task.status === undefined ||
    task.name === undefined ||
    task.createdAt === undefined ||
    task.startedAt === undefined ||
    task.cpus === undefined ||
    task.memory === undefined
  );
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

  return createHandler({ repository, enricher, publisher });
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
