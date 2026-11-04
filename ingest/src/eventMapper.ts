/**
 * EventMapper — the isolated classify-and-map surface for HealthOmics
 * EventBridge events (design.md "Ingest Lambda internal interfaces" and
 * "Ingest Lambda Design" → step 1 "Classify and map").
 *
 * This module is the single place where the *real shape* of a HealthOmics
 * EventBridge event is assumed. Everything the code believes about
 * `detail-type` strings and `detail` field names lives behind the clearly
 * commented "CONFIRM AGAINST AWS DOCS" constants below, so that when the real
 * event vocabulary is verified it can be corrected here alone (Req 14.3; see
 * the "Confirm Against AWS Docs" table in design.md, which names
 * `detectKind()`, `mapRunEvent()`, and `mapTaskEvent()` as the code elements to
 * update).
 *
 * Extraction is strictly *defensive* (Requirements 1.3–1.6):
 *   - Only fields that are actually present are extracted; a missing field is
 *     simply omitted from the returned Partial record — never defaulted,
 *     coerced, or allowed to throw.
 *   - When any REQUIRED field (identity + status) is missing, the complete
 *     event is logged and processing continues on the remaining fields
 *     (Req 1.5). Optional fields that are legitimately absent at early
 *     statuses (e.g. a task's instanceType/startTime before RUNNING) never
 *     trigger that log.
 *   - A status value that is not a member of its enum is logged and skipped
 *     (left unset) without failing the whole event (Req 1.6).
 *
 * The mapping functions return `Partial<RunRecord>` / `Partial<TaskRecord>`
 * (no `updatedAt`, no key-completeness guarantees); assembling a full record,
 * setting `updatedAt`, enrichment, and persistence all happen in later
 * pipeline stages.
 */

import type { EventBridgeEvent } from 'aws-lambda';
import type { RunRecord, TaskRecord } from './domain/records.js';
import { isRunStatus, isTaskStatus } from './domain/status.js';

export type EventKind = 'RUN' | 'TASK' | 'UNKNOWN';

// ============================================================================
// CONFIRM AGAINST AWS DOCS — event `detail-type` classifiers
// ----------------------------------------------------------------------------
// `detectKind()` classifies a run vs task event by the top-level `detail-type`
// string. Confirmed against the AWS HealthOmics EventBridge examples
// ("Using EventBridge with AWS HealthOmics" → Event message examples):
//   run  events use detail-type "Run Status Change"
//   task events use detail-type "Task Status Change"
// If HealthOmics changes these strings, update ONLY these two constants.
// ============================================================================
const RUN_DETAIL_TYPE = 'Run Status Change';
const TASK_DETAIL_TYPE = 'Task Status Change';

// ============================================================================
// CONFIRM AGAINST AWS DOCS — run event `detail` field names
// ----------------------------------------------------------------------------
// Field paths within the run event `detail` object. Confirmed against real
// captured "Run Status Change" events (omicsVersion "1.0.0", run 8508632),
// whose `detail` carries: omicsVersion, arn, runId, status, uuid, runOutputUri,
// runName, workflowName, workflowId, workflowVersionName, workflowUuid.
//
// Notes on the mapping to RunRecord:
//   - HealthOmics names the run's display name `runName`; RunRecord calls it
//     `name`. `runOutputUri` maps to `outputUri`.
//   - `workflowVersionName` and `runOutputUri` are OPTIONAL (absent on older
//     event schemas / versionless runs) and never trigger the full-event log.
//   - The run event does NOT carry createdAt / startedAt / stoppedAt,
//     parameters, configuration or status messages; those come from GetRun
//     (or are derived from event.time by the handler).
// If HealthOmics renames any of these fields, update ONLY these constants.
// ============================================================================
const RUN_FIELDS = {
  runId: 'runId',
  status: 'status',
  name: 'runName',
  workflowId: 'workflowId',
  workflowName: 'workflowName',
} as const;
/** Optional run event fields (never trigger the missing-field log). */
const RUN_OPTIONAL_FIELDS = {
  workflowVersionName: 'workflowVersionName',
  outputUri: 'runOutputUri',
} as const;

// ============================================================================
// CONFIRM AGAINST AWS DOCS — task event `detail` field names
// ----------------------------------------------------------------------------
// Field paths within the task event `detail` object. Confirmed against real
// captured "Task Status Change" events (omicsVersion "1.0.0", run 8508632; all
// 828 events), whose `detail` carries at EVERY status: omicsVersion, arn,
// status, runArn, runId, runName, runUuid, workflowName, workflowId,
// workflowVersionName, workflowUuid, taskName, cpus, gpus, memory (GiB),
// creationTime. RUNNING adds instanceType + startTime; COMPLETED adds stopTime.
// Numeric values arrive as STRINGS ("cpus":"2"); timestamps are ISO 8601 with
// milliseconds and match GetRunTask exactly. NOT carried: statusMessage,
// failureReason (GetRunTask-only). The FAILED/CANCELLED shape is unverified.
//
// IMPORTANT — task identifier:
//   The task "Task Status Change" example `detail` has NO dedicated `taskId`
//   field. The task's identity is carried only by the task `arn`
//   (e.g. "arn:aws:omics:...:task/8888888"), whose trailing segment after
//   "task/" is the task id. `TASK_ARN_FIELD` + `parseTaskIdFromArn()` isolate
//   that assumption. If HealthOmics later exposes an explicit taskId field,
//   prefer it here.
//
//   The descriptive fields (taskName, cpus, memory, instanceType, creationTime,
//   startTime, stopTime) are OPTIONAL: some are legitimately absent at early
//   statuses, so their absence never triggers the full-event log. `taskName`
//   is the current field; the legacy `name` is still read as a fallback.
//   `gpus` is carried but not mapped (TaskRecord / the GraphQL schema have no
//   gpus field).
// If HealthOmics renames any of these fields, update ONLY these constants.
// ============================================================================
const TASK_FIELDS = {
  runId: 'runId',
  status: 'status',
} as const;
/** Optional task event fields (never trigger the missing-field log). */
const TASK_OPTIONAL_FIELDS = {
  name: 'taskName',
  legacyName: 'name',
  cpus: 'cpus',
  memory: 'memory',
  instanceType: 'instanceType',
  createdAt: 'creationTime',
  startedAt: 'startTime',
  stoppedAt: 'stopTime',
} as const;
const TASK_ARN_FIELD = 'arn';
// The ARN resource segment that precedes the task id, e.g. ".../task/8888888".
const TASK_ARN_RESOURCE_PREFIX = 'task/';

/**
 * The `detail` object of an EventBridge event, treated as an untrusted,
 * loosely-typed bag of unknown values. Every read goes through the safe
 * accessors below so a missing or wrong-typed field can never throw.
 */
type Detail = Record<string, unknown>;

/**
 * Safely obtain the `detail` object as a record. Returns an empty object when
 * `detail` is absent or is not a plain object, so callers never dereference
 * `undefined` (Req 1.5).
 */
function getDetail(event: EventBridgeEvent<string, unknown>): Detail {
  const detail = event.detail;
  if (detail !== null && typeof detail === 'object') {
    return detail as Detail;
  }
  return {};
}

/**
 * Extract a non-empty string field from `detail`, or `undefined` when the field
 * is absent, not a string, or an empty/whitespace-only string. Never throws.
 */
function readString(detail: Detail, key: string): string | undefined {
  const value = detail[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

/**
 * Extract a finite number from `detail`, accepting either a number or a
 * numeric string (HealthOmics events carry "cpus":"2"). Returns `undefined`
 * for an absent, empty, non-numeric, or non-finite value. Never throws.
 */
function readNumber(detail: Detail, key: string): number | undefined {
  const value = detail[key];
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = Number(value);
  } else {
    return undefined;
  }
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Extract a timestamp from `detail` and normalize it to ISO 8601 UTC with
 * milliseconds. Returns `undefined` when absent or unparseable. Never throws.
 */
function readTimestamp(detail: Detail, key: string): string | undefined {
  const value = readString(detail, key);
  if (value === undefined) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * Derive the task id from a task ARN by taking the segment after "task/".
 * Returns `undefined` when the ARN is absent or does not contain the expected
 * resource prefix. Never throws.
 */
function parseTaskIdFromArn(arn: string | undefined): string | undefined {
  if (arn === undefined) {
    return undefined;
  }
  const idx = arn.indexOf(TASK_ARN_RESOURCE_PREFIX);
  if (idx === -1) {
    return undefined;
  }
  const taskId = arn.slice(idx + TASK_ARN_RESOURCE_PREFIX.length).trim();
  return taskId.length > 0 ? taskId : undefined;
}

/**
 * Log the complete event. Used whenever an expected field is missing (Req 1.5)
 * or a status value falls outside its enum (Req 1.6), so the raw event is
 * always available for diagnosis while processing continues.
 */
function logFullEvent(reason: string, event: EventBridgeEvent<string, unknown>): void {
  console.log(`eventMapper: ${reason}`, JSON.stringify(event));
}

/**
 * Classify an event as a run event, a task event, or unknown, based solely on
 * its `detail-type` (see RUN_DETAIL_TYPE / TASK_DETAIL_TYPE). Never throws.
 */
export function detectKind(event: EventBridgeEvent<string, unknown>): EventKind {
  const detailType = event['detail-type'];
  if (detailType === RUN_DETAIL_TYPE) {
    return 'RUN';
  }
  if (detailType === TASK_DETAIL_TYPE) {
    return 'TASK';
  }
  return 'UNKNOWN';
}

/**
 * Map a run status-change event to a Partial<RunRecord>, extracting only the
 * fields present in `detail`. Missing fields are omitted and the full event is
 * logged (Req 1.3, 1.5); an out-of-enum status is logged and left unset
 * (Req 1.6). Never throws.
 */
export function mapRunEvent(
  event: EventBridgeEvent<string, unknown>,
): Partial<RunRecord> {
  const detail = getDetail(event);
  const record: Partial<RunRecord> = {};
  let missingField = false;

  const runId = readString(detail, RUN_FIELDS.runId);
  if (runId !== undefined) {
    record.runId = runId;
  } else {
    missingField = true;
  }

  const rawStatus = detail[RUN_FIELDS.status];
  if (rawStatus === undefined) {
    missingField = true;
  } else if (isRunStatus(rawStatus)) {
    record.status = rawStatus;
  } else {
    // Out-of-enum status: log the full event and skip the value (Req 1.6).
    logFullEvent(
      `run event has unrecognized status "${String(rawStatus)}"; skipping status`,
      event,
    );
  }

  const name = readString(detail, RUN_FIELDS.name);
  if (name !== undefined) {
    record.name = name;
  } else {
    missingField = true;
  }

  const workflowId = readString(detail, RUN_FIELDS.workflowId);
  if (workflowId !== undefined) {
    record.workflowId = workflowId;
  } else {
    missingField = true;
  }

  const workflowName = readString(detail, RUN_FIELDS.workflowName);
  if (workflowName !== undefined) {
    record.workflowName = workflowName;
  } else {
    missingField = true;
  }

  const workflowVersionName = readString(detail, RUN_OPTIONAL_FIELDS.workflowVersionName);
  if (workflowVersionName !== undefined) {
    record.workflowVersionName = workflowVersionName;
  }
  const outputUri = readString(detail, RUN_OPTIONAL_FIELDS.outputUri);
  if (outputUri !== undefined) {
    record.outputUri = outputUri;
  }

  if (missingField) {
    // At least one required field was absent: log the complete event and
    // continue on the remaining fields (Req 1.5).
    logFullEvent('run event missing one or more expected fields', event);
  }

  return record;
}

/**
 * Map a task status-change event to a Partial<TaskRecord>, extracting only the
 * fields present in `detail`. The task id is derived from the task `arn`
 * (see TASK_ARN_FIELD). String numbers are converted with `Number()` and
 * timestamps normalized to ISO 8601. Missing required fields (runId, arn,
 * status) are omitted and the full event is logged
 * (Req 1.4, 1.5); an out-of-enum status is logged and left unset (Req 1.6).
 * Never throws.
 */
export function mapTaskEvent(
  event: EventBridgeEvent<string, unknown>,
): Partial<TaskRecord> {
  const detail = getDetail(event);
  const record: Partial<TaskRecord> = {};
  let missingField = false;

  const runId = readString(detail, TASK_FIELDS.runId);
  if (runId !== undefined) {
    record.runId = runId;
  } else {
    missingField = true;
  }

  const taskId = parseTaskIdFromArn(readString(detail, TASK_ARN_FIELD));
  if (taskId !== undefined) {
    record.taskId = taskId;
  } else {
    missingField = true;
  }

  const rawStatus = detail[TASK_FIELDS.status];
  if (rawStatus === undefined) {
    missingField = true;
  } else if (isTaskStatus(rawStatus)) {
    record.status = rawStatus;
  } else {
    // Out-of-enum status: log the full event and skip the value (Req 1.6).
    logFullEvent(
      `task event has unrecognized status "${String(rawStatus)}"; skipping status`,
      event,
    );
  }

  // Optional descriptive fields: set only when present; absence is normal at
  // early statuses and never marks the event as missing fields.
  const name =
    readString(detail, TASK_OPTIONAL_FIELDS.name) ??
    readString(detail, TASK_OPTIONAL_FIELDS.legacyName);
  if (name !== undefined) {
    record.name = name;
  }
  const cpus = readNumber(detail, TASK_OPTIONAL_FIELDS.cpus);
  if (cpus !== undefined) {
    record.cpus = cpus;
  }
  const memory = readNumber(detail, TASK_OPTIONAL_FIELDS.memory);
  if (memory !== undefined) {
    record.memory = memory;
  }
  const instanceType = readString(detail, TASK_OPTIONAL_FIELDS.instanceType);
  if (instanceType !== undefined) {
    record.instanceType = instanceType;
  }
  const createdAt = readTimestamp(detail, TASK_OPTIONAL_FIELDS.createdAt);
  if (createdAt !== undefined) {
    record.createdAt = createdAt;
  }
  const startedAt = readTimestamp(detail, TASK_OPTIONAL_FIELDS.startedAt);
  if (startedAt !== undefined) {
    record.startedAt = startedAt;
  }
  const stoppedAt = readTimestamp(detail, TASK_OPTIONAL_FIELDS.stoppedAt);
  if (stoppedAt !== undefined) {
    record.stoppedAt = stoppedAt;
  }

  if (missingField) {
    // At least one required field was absent: log the complete event and
    // continue on the remaining fields (Req 1.5).
    logFullEvent('task event missing one or more expected fields', event);
  }

  return record;
}
