/**
 * Run and task enrichment over the HealthOmics read APIs.
 *
 * When the fields extracted from an EventBridge event are insufficient to
 * render a Run or Task, the ingest Lambda enriches state by calling the
 * HealthOmics read APIs — and ONLY the four allowed read operations
 * `GetRun`, `ListRunTasks`, `GetRunTask`, `GetWorkflow` (Req 2.1). This module
 * owns run/task enrichment via `GetRun`, `ListRunTasks`, and `GetRunTask`;
 * workflow-definition enrichment via `GetWorkflow` lives in `./workflow.ts`.
 *
 * Every call is wrapped by {@link callWithRetry} so each has a 10s timeout and
 * up to 3 attempts; on persistent failure the operation and affected identifier
 * are logged and the function returns only what was derivable, leaving the
 * unretrieved fields unset (Req 2.5, 2.6). None of the functions here throw for
 * an API failure.
 *
 * ============================================================================
 * CONFIRM AGAINST AWS DOCS — HealthOmics read-API field mappings
 * ----------------------------------------------------------------------------
 * This file is one of the designated "confirm against AWS docs" locations (see
 * the table in design.md and Req 14.3): the mapping from `GetRun` /
 * `ListRunTasks` / `GetRunTask` response fields to our domain records is
 * isolated in `mapRunResponse()` and `mapTaskListItem()` / `mapRunTaskResponse()`
 * below. The field names used are taken from the `@aws-sdk/client-omics` model
 * types, but the *semantics* (which timestamp maps to createdAt vs startedAt,
 * memory units, etc.) must be confirmed against the AWS HealthOmics API
 * reference before relying on them in production. If the API shape differs,
 * update ONLY the mapping functions in this file.
 * ============================================================================
 */

import {
  GetRunCommand,
  GetRunTaskCommand,
  ListRunTasksCommand,
  type OmicsClient,
  type GetRunCommandOutput,
  type GetRunTaskCommandOutput,
  type TaskListItem,
} from '@aws-sdk/client-omics';

import type { RunRecord, TaskRecord } from '../domain/records.js';
import { isRunStatus, isTaskStatus } from '../domain/status.js';
import { callWithRetry, type RetryOptions } from './retry.js';

/**
 * Convert a HealthOmics `Date` (or missing value) to an ISO 8601 string, or
 * `undefined` when absent. Domain records store timestamps as ISO 8601 strings
 * (see records.ts), while the SDK surfaces them as `Date` objects.
 */
function toIso(value: Date | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : undefined;
}

// ============================================================================
// CONFIRM AGAINST AWS DOCS — GetRun response -> RunRecord
// ----------------------------------------------------------------------------
// Maps the `GetRun` response to the enrichable subset of RunRecord. Notes:
//   - `name`      <- GetRunResponse.name        (the run's display name)
//   - `status`    <- GetRunResponse.status      (kept only if a known enum)
//   - `workflowId`<- GetRunResponse.workflowId
//   - `workflowVersionName` <- GetRunResponse.workflowVersionName (may be absent)
//   - `createdAt` <- GetRunResponse.creationTime (CONFIRM: creation vs start)
//   - `startedAt` <- GetRunResponse.startTime
//   - `stoppedAt` <- GetRunResponse.stopTime
//   - `outputUri`     <- runOutputUri (fallback outputUri) — for #8 output link
//   - `parameters`    <- parameters (JSON-stringified) — for #7 reproducibility
//   - `engineVersion` <- engineVersion
// `GetRun` does not return a workflow *name*; workflowName comes from the event
// (or is left unset). `updatedAt` is set by the pipeline, not by enrichment, so
// it is intentionally omitted here.
// ============================================================================
function mapRunResponse(res: GetRunCommandOutput): Partial<RunRecord> {
  const record: Partial<RunRecord> = {};

  if (typeof res.name === 'string' && res.name.length > 0) {
    record.name = res.name;
  }
  // Keep the status only when it is a recognized enum member (Req 1.6 vocab);
  // an unknown spelling is left unset rather than persisted.
  if (isRunStatus(res.status)) {
    record.status = res.status;
  }
  if (typeof res.workflowId === 'string' && res.workflowId.length > 0) {
    record.workflowId = res.workflowId;
  }
  // `workflowVersionName` sources the version-qualified static-graph cache key
  // (Req 1.9, 5.1); it may be absent, so set it only for a non-empty string.
  if (typeof res.workflowVersionName === 'string' && res.workflowVersionName.length > 0) {
    record.workflowVersionName = res.workflowVersionName;
  }

  const createdAt = toIso(res.creationTime);
  if (createdAt !== undefined) {
    record.createdAt = createdAt;
  }
  const startedAt = toIso(res.startTime);
  if (startedAt !== undefined) {
    record.startedAt = startedAt;
  }
  const stoppedAt = toIso(res.stopTime);
  if (stoppedAt !== undefined) {
    record.stoppedAt = stoppedAt;
  }

  // Output location for the "view outputs" link (#8). GetRun returns both
  // `outputUri` (the base) and `runOutputUri` (run-specific); prefer the
  // run-specific one when present.
  const outputUri =
    (typeof res.runOutputUri === 'string' && res.runOutputUri.length > 0
      ? res.runOutputUri
      : undefined) ??
    (typeof res.outputUri === 'string' && res.outputUri.length > 0
      ? res.outputUri
      : undefined);
  if (outputUri !== undefined) {
    record.outputUri = outputUri;
  }

  // Input parameters for reproducibility (#7). Free-form per workflow, so store
  // as a JSON string; the UI parses and renders it. Only persist a non-empty
  // object.
  if (
    res.parameters !== undefined &&
    res.parameters !== null &&
    typeof res.parameters === 'object' &&
    Object.keys(res.parameters as Record<string, unknown>).length > 0
  ) {
    record.parameters = JSON.stringify(res.parameters);
  }

  if (typeof res.engineVersion === 'string' && res.engineVersion.length > 0) {
    record.engineVersion = res.engineVersion;
  }

  // Status detail (Req: surface run failures) — a human-readable statusMessage
  // and a machine-readable failureReason, most useful when status is FAILED.
  // Both are optional and simply absent for a healthy/in-progress run.
  if (typeof res.statusMessage === 'string' && res.statusMessage.length > 0) {
    record.statusMessage = res.statusMessage;
  }
  if (typeof res.failureReason === 'string' && res.failureReason.length > 0) {
    record.failureReason = res.failureReason;
  }

  // Run configuration used to launch the run, for reproducibility. All optional;
  // stored only when present. CONFIRM AGAINST AWS DOCS: field names/nesting on
  // the GetRun response (roleArn, storageType/Capacity, cacheId/Behavior,
  // networkingMode, configuration.name, logLevel).
  const setStr = (
    key:
      | 'roleArn'
      | 'storageType'
      | 'cacheId'
      | 'cacheBehavior'
      | 'logLevel'
      | 'networkingMode'
      | 'configurationName'
      | 'batchId',
    value: unknown,
  ): void => {
    if (typeof value === 'string' && value.length > 0) {
      record[key] = value;
    }
  };
  setStr('roleArn', res.roleArn);
  setStr('storageType', res.storageType);
  if (typeof res.storageCapacity === 'number') {
    record.storageCapacity = res.storageCapacity;
  }
  setStr('cacheId', res.cacheId);
  setStr('cacheBehavior', res.cacheBehavior);
  setStr('logLevel', res.logLevel);
  // networkingMode and configuration are newer GetRun fields; read defensively
  // in case the pinned SDK model does not type them yet.
  const resAny = res as unknown as {
    networkingMode?: string;
    configuration?: { name?: string };
  };
  setStr('networkingMode', resAny.networkingMode);
  setStr('configurationName', resAny.configuration?.name);
  // Batch ID: present only when the run was started as part of a batch.
  setStr('batchId', res.batchId);

  // Tags (e.g. cost-allocation tags) as a string->string map. Serialize to a
  // JSON string, mirroring `parameters`; only persist a non-empty map.
  if (
    res.tags !== undefined &&
    res.tags !== null &&
    typeof res.tags === 'object' &&
    Object.keys(res.tags as Record<string, unknown>).length > 0
  ) {
    record.tags = JSON.stringify(res.tags);
  }

  // Capture the full raw GetRun response for audit/completeness (Interpretation
  // A): persist everything the API returned, even fields not modeled as
  // first-class attributes. Strip the SDK's `$metadata` (HTTP transport info,
  // not run data) before serializing. Guarded so a serialization failure never
  // breaks enrichment.
  try {
    const { $metadata: _ignored, ...runData } = res as Record<string, unknown> & {
      $metadata?: unknown;
    };
    record.rawGetRun = JSON.stringify(runData);
  } catch {
    // Never fail enrichment because the raw response could not be serialized.
  }

  return record;
}

// ============================================================================
// CONFIRM AGAINST AWS DOCS — ListRunTasks item / GetRunTask response -> TaskRecord
// ----------------------------------------------------------------------------
// Both `ListRunTasks` items (TaskListItem) and the `GetRunTask` response share
// the enrichable task fields we care about:
//   - `taskId`    <- taskId
//   - `name`      <- name
//   - `status`    <- status         (kept only if a known enum)
//   - `cpus`      <- cpus
//   - `memory`    <- memory         (CONFIRM: units — API doc says gigabytes)
//   - `createdAt` <- creationTime   (CONFIRM: creation vs start)
//   - `startedAt` <- startTime
//   - `stoppedAt` <- stopTime
// `runId` is supplied by the caller (it is the list/enrich argument, not a
// field on the task item). `updatedAt` is set by the pipeline, not enrichment.
// ============================================================================
type EnrichableTask = Pick<
  TaskListItem & GetRunTaskCommandOutput,
  | 'taskId'
  | 'name'
  | 'status'
  | 'cpus'
  | 'memory'
  | 'instanceType'
  | 'creationTime'
  | 'startTime'
  | 'stopTime'
  | 'statusMessage'
  | 'failureReason'
>;

function mapTaskFields(runId: string, item: EnrichableTask): Partial<TaskRecord> {
  const record: Partial<TaskRecord> = { runId };

  if (typeof item.taskId === 'string' && item.taskId.length > 0) {
    record.taskId = item.taskId;
  }
  if (typeof item.name === 'string' && item.name.length > 0) {
    record.name = item.name;
  }
  if (isTaskStatus(item.status)) {
    record.status = item.status;
  }
  if (typeof item.cpus === 'number') {
    record.cpus = item.cpus;
  }
  if (typeof item.memory === 'number') {
    record.memory = item.memory;
  }
  // The task's compute instance type (e.g. `omics.m.large`); the join key used
  // to price compute against the published rate card (Req 1.1). Persist only a
  // non-empty string; leave it unset otherwise rather than storing a fabricated
  // value (Req 1.4).
  if (typeof item.instanceType === 'string' && item.instanceType.length > 0) {
    record.instanceType = item.instanceType;
  }

  const createdAt = toIso(item.creationTime);
  if (createdAt !== undefined) {
    record.createdAt = createdAt;
  }
  const startedAt = toIso(item.startTime);
  if (startedAt !== undefined) {
    record.startedAt = startedAt;
  }
  const stoppedAt = toIso(item.stopTime);
  if (stoppedAt !== undefined) {
    record.stoppedAt = stoppedAt;
  }

  // Status detail (Req: surface task failures) — human-readable statusMessage
  // and machine-readable failureReason, most useful when status is FAILED.
  // Present on both ListRunTasks items and GetRunTask responses.
  if (typeof item.statusMessage === 'string' && item.statusMessage.length > 0) {
    record.statusMessage = item.statusMessage;
  }
  if (typeof item.failureReason === 'string' && item.failureReason.length > 0) {
    record.failureReason = item.failureReason;
  }

  return record;
}

/**
 * Enrich a run via `GetRun` (Req 2.1). Returns the retrieved subset of a
 * RunRecord on success, or an empty object when the call fails after retries —
 * in which case the failed operation and `runId` have already been logged and
 * the caller persists from event fields only, leaving these fields unset
 * (Req 2.5, 2.6).
 *
 * @param client  The HealthOmics SDK client.
 * @param runId   The run to enrich; echoed into failure logs.
 * @param options Retry/timeout overrides (defaults to 10s / 3 attempts).
 */
export async function enrichRun(
  client: OmicsClient,
  runId: string,
  options?: RetryOptions,
): Promise<Partial<RunRecord>> {
  const result = await callWithRetry(
    'GetRun',
    runId,
    () => client.send(new GetRunCommand({ id: runId })),
    options,
  );
  if (!result.ok) {
    return {};
  }
  return mapRunResponse(result.value);
}

/**
 * Enrich a SINGLE task via one `GetRunTask` call (Req 2.1).
 *
 * This is the per-event enrichment path: a task status-change event names the
 * one task that changed, so we fetch only that task's detail — not the whole
 * run. This avoids the API-call amplification that occurs when every task event
 * triggers a full `ListRunTasks` + N×`GetRunTask` sweep of the entire run,
 * which for large (100+ task) runs produces a self-inflicted
 * `ThrottlingException` storm that drops task timing/name.
 *
 * Returns the retrieved subset of a TaskRecord on success, or an empty object
 * (just `runId`) when the call fails after retries — the caller then persists
 * from event fields only, leaving the unretrieved fields unset (Req 2.5, 2.6).
 * Never throws for an API failure.
 *
 * @param client  The HealthOmics SDK client.
 * @param runId   The task's run.
 * @param taskId  The task to enrich.
 * @param options Retry/timeout overrides (defaults to 10s / 3 attempts).
 */
export async function enrichTask(
  client: OmicsClient,
  runId: string,
  taskId: string,
  options?: RetryOptions,
): Promise<Partial<TaskRecord>> {
  const detail = await callWithRetry(
    'GetRunTask',
    `${runId}/${taskId}`,
    () => client.send(new GetRunTaskCommand({ id: runId, taskId })),
    options,
  );
  if (!detail.ok) {
    return { runId };
  }
  return mapTaskFields(runId, detail.value);
}

/**
 * Enrich a run's tasks via `ListRunTasks` and `GetRunTask` (Req 2.1).
 *
 * Uses `ListRunTasks` to page through the run's tasks (following `nextToken`),
 * then `GetRunTask` to fetch the fuller per-task detail for each. Both are the
 * only task read operations invoked. Returns one `Partial<TaskRecord>` per task
 * discovered; a task whose `GetRunTask` enrichment fails falls back to the
 * fields already present on its `ListRunTasks` item, and if `ListRunTasks`
 * itself fails after retries the function logs the failure and returns an empty
 * array (persist nothing extra; leave fields unset) (Req 2.5, 2.6).
 *
 * @param client  The HealthOmics SDK client.
 * @param runId   The run whose tasks to enrich; echoed into failure logs.
 * @param options Retry/timeout overrides (defaults to 10s / 3 attempts).
 */
export async function enrichTasks(
  client: OmicsClient,
  runId: string,
  options?: RetryOptions,
): Promise<Partial<TaskRecord>[]> {
  const listed: TaskListItem[] = [];
  let startingToken: string | undefined;

  // Page through ListRunTasks. Each page is a separate time-boxed, retried
  // call; a page that fails after retries aborts listing and we return what we
  // gathered so far (Req 2.5).
  do {
    const token = startingToken;
    const page = await callWithRetry(
      'ListRunTasks',
      runId,
      () => client.send(new ListRunTasksCommand({ id: runId, startingToken: token })),
      options,
    );
    if (!page.ok) {
      break;
    }
    for (const item of page.value.items ?? []) {
      listed.push(item);
    }
    startingToken = page.value.nextToken;
  } while (startingToken !== undefined && startingToken !== '');

  // For each listed task, fetch the fuller GetRunTask detail. On failure, fall
  // back to the fields already on the ListRunTasks item (Req 2.5).
  const records: Partial<TaskRecord>[] = [];
  for (const item of listed) {
    const taskId = item.taskId;
    const listFields = mapTaskFields(runId, item);

    if (typeof taskId !== 'string' || taskId.length === 0) {
      // No usable task id: keep whatever the list item gave us; the caller's
      // identifier validation will reject an unusable record at persistence.
      records.push(listFields);
      continue;
    }

    const detail = await callWithRetry(
      'GetRunTask',
      `${runId}/${taskId}`,
      () => client.send(new GetRunTaskCommand({ id: runId, taskId })),
      options,
    );
    if (!detail.ok) {
      records.push(listFields);
      continue;
    }
    records.push(mapTaskFields(runId, detail.value));
  }

  return records;
}
