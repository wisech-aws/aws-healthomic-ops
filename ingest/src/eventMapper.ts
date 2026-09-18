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
 *   - When any expected field is missing, the complete event is logged and
 *     processing continues on the remaining fields (Req 1.5).
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
// Field paths within the run event `detail` object. Confirmed against the AWS
// HealthOmics EventBridge run "Run Status Change" example, whose `detail`
// carries: omicsVersion, arn, status, uuid, runId, runName, runOutputUri,
// workflowId, workflowName.
//
// Notes on the mapping to RunRecord:
//   - HealthOmics names the run's display name `runName`; RunRecord calls it
//     `name`.
//   - The run event does NOT carry createdAt / startedAt / stoppedAt; those
//     fields are filled by enrichment (GetRun) in a later stage, so the mapper
//     legitimately leaves them unset.
// If HealthOmics renames any of these fields, update ONLY these constants.
// ============================================================================
const RUN_FIELDS = {
  runId: 'runId',
  status: 'status',
  name: 'runName',
  workflowId: 'workflowId',
  workflowName: 'workflowName',
} as const;

// ============================================================================
// CONFIRM AGAINST AWS DOCS — task event `detail` field names
// ----------------------------------------------------------------------------
// Field paths within the task event `detail` object. Confirmed against the AWS
// HealthOmics EventBridge task "Task Status Change" example, whose `detail`
// carries: omicsVersion, arn, status, runArn, runUuid, runId, runName,
// workflowId, workflowName.
//
// IMPORTANT — task identifier:
//   The task "Task Status Change" example `detail` has NO dedicated `taskId`
//   field. The task's identity is carried only by the task `arn`
//   (e.g. "arn:aws:omics:...:task/8888888"), whose trailing segment after
//   "task/" is the task id. `TASK_ARN_FIELD` + `parseTaskIdFromArn()` isolate
//   that assumption. If HealthOmics later exposes an explicit taskId field,
//   prefer it here.
//
//   Likewise, the task event carries NO cpus / memory / createdAt / startedAt /
//   stoppedAt fields; those are filled by enrichment (ListRunTasks/GetRunTask)
//   in a later stage, so the mapper leaves them unset.
// If HealthOmics renames any of these fields, update ONLY these constants.
// ============================================================================
const TASK_FIELDS = {
  runId: 'runId',
  status: 'status',
  name: 'name',
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

  if (missingField) {
    // At least one expected field was absent: log the complete event and
    // continue on the remaining fields (Req 1.5).
    logFullEvent('run event missing one or more expected fields', event);
  }

  return record;
}

/**
 * Map a task status-change event to a Partial<TaskRecord>, extracting only the
 * fields present in `detail`. The task id is derived from the task `arn`
 * (see TASK_ARN_FIELD). Missing fields are omitted and the full event is logged
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

  const name = readString(detail, TASK_FIELDS.name);
  if (name !== undefined) {
    record.name = name;
  } else {
    missingField = true;
  }

  if (missingField) {
    // At least one expected field was absent: log the complete event and
    // continue on the remaining fields (Req 1.5).
    logFullEvent('task event missing one or more expected fields', event);
  }

  return record;
}
