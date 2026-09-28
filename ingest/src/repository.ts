/**
 * Repository: DynamoDB single-table persistence for run and task items.
 *
 * This module owns the mapping from normalized domain records (RunRecord,
 * TaskRecord) to DynamoDB items following the single-table design documented in
 * design.md ("DynamoDB single-table design"):
 *
 *   | Item | PK             | SK             | GSI1PK | GSI1SK                  |
 *   |------|----------------|----------------|--------|-------------------------|
 *   | Run  | `RUN#<runId>`  | `RUN#<runId>`  | `RUNS` | `<updatedAt ISO8601>`   |
 *   | Task | `RUN#<runId>`  | `TASK#<taskId>`| —      | —                       |
 *
 * Scope of this module: key derivation, attribute mapping, and GSI1SK
 * normalization (task 4.1); the conditional monotonic upsert logic and
 * identifier validation (Req 3.8–3.10, task 4.2); and static-graph persistence
 * (Req 6.8) in task 4.3. The key/attribute-building functions below are
 * exported so those tasks — and unit tests — can build on them.
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type { RunRecord, TaskRecord, RunSummaryRecord } from './domain/records.js';
import type { Fidelity, StaticGraph } from './parser/types.js';
import { isTerminalStatus, TERMINAL_STATUSES } from './domain/status.js';

/** Discriminator attribute stored on every item for item-type filtering. */
export type EntityType = 'RUN' | 'TASK' | 'GRAPH' | 'RATECARD' | 'SUMMARY' | 'GROUP';

/** GSI1 partition-key constant used by all run items (Req 3.3, 3.7). */
export const RUNS_GSI1PK = 'RUNS';

/**
 * Partition key constant for the Group_Registry
 * (workflow-performance-reports Req 11.4). All Workflow_Group registry items
 * share this single partition so `listWorkflowGroups` reads one partition
 * instead of scanning the table for SUMMARY items.
 */
export const GROUPS_PK = 'GROUPS';

/**
 * Derive the Group_Registry item sort key for a Workflow_Group:
 * `WF#<encoded workflowName>#<encoded workflowVersionName>` — the same
 * delimiter-safe encoding as {@link groupGsi2Pk} so a name containing `#`
 * cannot collide two groups. One registry item per distinct `(name, version)`.
 */
export function groupRegistrySk(workflowName: string, workflowVersionName: string): string {
  return `WF#${encodeGroupSegment(workflowName)}#${encodeGroupSegment(workflowVersionName)}`;
}

/** Derive the run item partition key: `RUN#<runId>`. */
export function runPk(runId: string): string {
  return `RUN#${runId}`;
}

/**
 * Derive the run item sort key. Run items are keyed with PK === SK ===
 * `RUN#<runId>` (design.md item types table).
 */
export function runSk(runId: string): string {
  return `RUN#${runId}`;
}

/** Derive the task item sort key: `TASK#<taskId>`. */
export function taskSk(taskId: string): string {
  return `TASK#${taskId}`;
}

/**
 * Derive the static-graph item partition key. Graph items are keyed with
 * PK === SK === `WF#<workflowId>#<workflowVersionName>` so distinct workflow
 * versions never share a cache entry (Req 5.1, design §6).
 */
export function graphPk(workflowId: string, workflowVersionName: string): string {
  return `WF#${workflowId}#${workflowVersionName}`;
}

/**
 * Derive the static-graph item sort key. Graph items are keyed with
 * PK === SK === `WF#<workflowId>#<workflowVersionName>` so distinct workflow
 * versions never share a cache entry (Req 5.1, design §6).
 */
export function graphSk(workflowId: string, workflowVersionName: string): string {
  return `WF#${workflowId}#${workflowVersionName}`;
}

/**
 * Derive the rate-card item partition key. Rate-card items are keyed with
 * PK === SK === `RATECARD#<region>` so distinct regions never share a cache
 * entry (Req 4.6, design §4).
 */
export function rateCardPk(region: string): string {
  return `RATECARD#${region}`;
}

/**
 * Derive the rate-card item sort key. Rate-card items are keyed with
 * PK === SK === `RATECARD#<region>` so distinct regions never share a cache
 * entry (Req 4.6, design §4).
 */
export function rateCardSk(region: string): string {
  return `RATECARD#${region}`;
}

/**
 * Derive the Run_Summary item sort key: `SUMMARY#<runId>`
 * (workflow-performance-reports Req 2.1). The summary is co-located under the
 * run's partition key (`PK = RUN#<runId>`), so it is a cheap sibling of the run
 * item and read/written alongside it.
 */
export function summarySk(runId: string): string {
  return `SUMMARY#${runId}`;
}

/**
 * Percent-encode a group-key segment so a `workflowName` / `workflowVersionName`
 * containing the `#` delimiter (or `%`) cannot corrupt the composite `GSI2PK`
 * key or leak across groups (workflow-performance-reports Req 2.2; design §1
 * "Key encoding safety"). Only `%` and `#` are encoded, keeping keys readable
 * for every ordinary name while remaining unambiguous. `%` is encoded first so
 * the transform is reversible.
 */
export function encodeGroupSegment(segment: string): string {
  return segment.replace(/%/g, '%25').replace(/#/g, '%23');
}

/**
 * Derive the Run_Summary GSI2 partition key for a Workflow_Group:
 * `WF#<encoded workflowName>#<encoded workflowVersionName>`
 * (workflow-performance-reports Req 2.2). Both segments are delimiter-safe
 * encoded so distinct groups never collide through a name containing `#`. The
 * caller passes the already-normalized version (Unversioned_Label when absent).
 */
export function groupGsi2Pk(workflowName: string, workflowVersionName: string): string {
  return `WF#${encodeGroupSegment(workflowName)}#${encodeGroupSegment(workflowVersionName)}`;
}

/**
 * Derive the Run_Summary GSI2 sort key: the run's terminal timestamp as an
 * ISO 8601 string, so a group's summaries are time-ordered for a windowed range
 * query (workflow-performance-reports Req 2.2). Falls back to `updatedAt` when
 * `stoppedAt` is absent so every summary is still ordered and queryable.
 */
export function groupGsi2Sk(stoppedAt: string | undefined, updatedAt: string): string {
  const basis = stoppedAt ?? updatedAt;
  return normalizeGsi1Sk(basis) ?? updatedAt;
}

/** GSI2 partition-key constant prefix (documentation aid; keys built via {@link groupGsi2Pk}). */
export const SUMMARY_GSI2_PREFIX = 'WF#';

/**
 * Normalize an `updatedAt` value for use as `GSI1SK`.
 *
 * Per Req 3.3, `GSI1SK` is set only when `updatedAt` is a valid ISO 8601
 * timestamp, and when set it is formatted as an ISO 8601 timestamp in UTC with
 * millisecond precision (the canonical `Date#toISOString()` shape, e.g.
 * `2024-01-02T03:04:05.678Z`).
 *
 * Returns the normalized string when `updatedAt` parses to a valid instant, or
 * `undefined` when it is missing or not a valid ISO 8601 timestamp, in which
 * case the caller omits `GSI1PK`/`GSI1SK` from the item.
 */
export function normalizeGsi1Sk(updatedAt: string | undefined): string | undefined {
  if (typeof updatedAt !== 'string' || updatedAt.trim() === '') {
    return undefined;
  }

  // `Date.parse` is lenient about many non-ISO formats; require that the input
  // actually looks like an ISO 8601 timestamp before accepting it, so that
  // arbitrary date-ish strings do not silently populate the recency index.
  if (!ISO_8601_PATTERN.test(updatedAt)) {
    return undefined;
  }

  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  // Canonical ISO 8601, UTC, millisecond precision.
  return new Date(parsed).toISOString();
}

/**
 * ISO 8601 timestamp matcher (date + time, optional fractional seconds, and a
 * `Z` or numeric UTC offset). Deliberately strict so that only genuine ISO 8601
 * timestamps normalize into `GSI1SK` (Req 3.3).
 */
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Shape of a persisted run item. Attributes mirror the "Run item attributes"
 * list in design.md (Req 3.1, 3.3, 3.4). Optional domain fields that are absent
 * are omitted from the item rather than stored as `undefined`.
 */
export interface RunItem {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  runId: string;
  status?: string;
  name?: string;
  createdAt?: string;
  startedAt?: string;
  stoppedAt?: string;
  updatedAt: string;
  workflowId?: string;
  workflowName?: string;
  /** Workflow version name (from GetRun enrichment); drives report grouping + graph lookup. */
  workflowVersionName?: string;
  outputUri?: string;
  parameters?: string;
  engineVersion?: string;
  roleArn?: string;
  storageType?: string;
  storageCapacity?: number;
  cacheId?: string;
  cacheBehavior?: string;
  networkingMode?: string;
  configurationName?: string;
  logLevel?: string;
  batchId?: string;
  /** Tags (JSON string of a string->string map), e.g. cost-allocation tags. */
  tags?: string;
  /** Full raw GetRun response (JSON string), captured for audit/completeness. */
  rawGetRun?: string;
  /** Human-readable status detail (HealthOmics `statusMessage`), e.g. why a run failed. */
  statusMessage?: string;
  /** Machine-readable failure reason (HealthOmics `failureReason`), e.g. "WORKFLOW_RUN_FAILED". */
  failureReason?: string;
  entityType: 'RUN';
}

/**
 * Shape of a persisted task item. Attributes mirror the "Task item attributes"
 * list in design.md (Req 3.2, 3.5). Optional domain fields that are absent are
 * omitted from the item rather than stored as `undefined`.
 */
export interface TaskItem {
  PK: string;
  SK: string;
  runId: string;
  taskId: string;
  status?: string;
  name?: string;
  createdAt?: string;
  startedAt?: string;
  stoppedAt?: string;
  updatedAt: string;
  cpus?: number;
  memory?: number;
  /** Compute instance type (HealthOmics `instanceType`, e.g. `omics.m.large`); the join key for pricing compute. */
  instanceType?: string;
  /** Human-readable status detail (HealthOmics `statusMessage`), e.g. why a task failed. */
  statusMessage?: string;
  /** Machine-readable failure reason (HealthOmics `failureReason`), e.g. "RUN_TASK_FAILED". */
  failureReason?: string;
  entityType: 'TASK';
}

/**
 * Assign `value` to `target[key]` only when it is defined. DynamoDB items must
 * not carry `undefined` attribute values, and omitting absent attributes keeps
 * the stored item minimal (Req 3.4, 3.5).
 */
function setIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * Build the DynamoDB item for a run record: derive `PK`/`SK`, populate the
 * required run attributes, set `GSI1PK`/`GSI1SK` when `updatedAt` is a valid
 * ISO 8601 timestamp, and tag `entityType = "RUN"` (Req 3.1, 3.3, 3.4).
 */
export function buildRunItem(run: RunRecord): RunItem {
  const item: RunItem = {
    PK: runPk(run.runId),
    SK: runSk(run.runId),
    runId: run.runId,
    updatedAt: run.updatedAt,
    entityType: 'RUN',
  };

  setIfDefined(item, 'status', run.status as string | undefined);
  setIfDefined(item, 'name', run.name);
  setIfDefined(item, 'createdAt', run.createdAt);
  setIfDefined(item, 'startedAt', run.startedAt);
  setIfDefined(item, 'stoppedAt', run.stoppedAt);
  setIfDefined(item, 'workflowId', run.workflowId);
  setIfDefined(item, 'workflowName', run.workflowName);
  setIfDefined(item, 'workflowVersionName', run.workflowVersionName);
  setIfDefined(item, 'outputUri', run.outputUri);
  setIfDefined(item, 'parameters', run.parameters);
  setIfDefined(item, 'engineVersion', run.engineVersion);
  setIfDefined(item, 'roleArn', run.roleArn);
  setIfDefined(item, 'storageType', run.storageType);
  setIfDefined(item, 'storageCapacity', run.storageCapacity);
  setIfDefined(item, 'cacheId', run.cacheId);
  setIfDefined(item, 'cacheBehavior', run.cacheBehavior);
  setIfDefined(item, 'networkingMode', run.networkingMode);
  setIfDefined(item, 'configurationName', run.configurationName);
  setIfDefined(item, 'logLevel', run.logLevel);
  setIfDefined(item, 'batchId', run.batchId);
  setIfDefined(item, 'tags', run.tags);
  setIfDefined(item, 'rawGetRun', run.rawGetRun);
  setIfDefined(item, 'statusMessage', run.statusMessage);
  setIfDefined(item, 'failureReason', run.failureReason);

  const gsi1sk = normalizeGsi1Sk(run.updatedAt);
  if (gsi1sk !== undefined) {
    item.GSI1PK = RUNS_GSI1PK;
    item.GSI1SK = gsi1sk;
  }

  return item;
}

/**
 * Build the DynamoDB item for a task record: derive `PK`/`SK`, populate the
 * required task attributes, and tag `entityType = "TASK"` (Req 3.2, 3.5). Task
 * items are not indexed by GSI1.
 */
export function buildTaskItem(task: TaskRecord): TaskItem {
  const item: TaskItem = {
    PK: runPk(task.runId),
    SK: taskSk(task.taskId),
    runId: task.runId,
    taskId: task.taskId,
    updatedAt: task.updatedAt,
    entityType: 'TASK',
  };

  setIfDefined(item, 'status', task.status as string | undefined);
  setIfDefined(item, 'name', task.name);
  setIfDefined(item, 'createdAt', task.createdAt);
  setIfDefined(item, 'startedAt', task.startedAt);
  setIfDefined(item, 'stoppedAt', task.stoppedAt);
  setIfDefined(item, 'cpus', task.cpus);
  setIfDefined(item, 'memory', task.memory);
  setIfDefined(item, 'instanceType', task.instanceType);
  setIfDefined(item, 'statusMessage', task.statusMessage);
  setIfDefined(item, 'failureReason', task.failureReason);

  return item;
}

/**
 * Shape of a persisted Run_Summary item (workflow-performance-reports Req 1.x,
 * 2.x). Keyed `PK = RUN#<runId>`, `SK = SUMMARY#<runId>` (co-located with the
 * run) and indexed on `GSI2` by Workflow_Group + terminal timestamp so a report
 * is a single time-ordered range query per group. Each Tracked_Metric value is
 * stored only when available; the paired Availability_Flag is always stored, so
 * an unavailable metric is recorded as `available=false` with no value — never a
 * fabricated `0` (Req 1.3, 10.2). Memory is GiB (Req 1.4, 10.4).
 */
export interface SummaryItem {
  PK: string;
  SK: string;
  GSI2PK: string;
  GSI2SK: string;
  runId: string;
  workflowName?: string;
  /** Normalized version label (Unversioned_Label when the run had no version). */
  workflowVersionName: string;
  /** Hidden collision guard — not the group label (Req 6.1). */
  workflowId?: string;
  status: string;
  stoppedAt?: string;
  updatedAt: string;
  durationMs?: number;
  durationAvailable: boolean;
  meanCpu?: number;
  peakCpu?: number;
  cpuAvailable: boolean;
  meanMemoryGiB?: number;
  peakMemoryGiB?: number;
  memoryAvailable: boolean;
  cpuHours?: number;
  cpuHoursAvailable: boolean;
  peakConcurrentTasks?: number;
  concurrencyAvailable: boolean;
  taskCount: number;
  failedTaskCount: number;
  entityType: 'SUMMARY';
}

/**
 * Build the DynamoDB item for a Run_Summary: derive `PK`/`SK`, the `GSI2`
 * Workflow_Group keys, populate the tracked-metric values (only when defined)
 * and their always-present availability flags, and tag `entityType = "SUMMARY"`
 * (workflow-performance-reports Req 1.3, 2.1, 2.2). Absent metric values are
 * omitted from the item rather than stored as `undefined`/`0`.
 */
export function buildSummaryItem(summary: RunSummaryRecord): SummaryItem {
  const item: SummaryItem = {
    PK: runPk(summary.runId),
    SK: summarySk(summary.runId),
    GSI2PK: groupGsi2Pk(
      summary.workflowName ?? '',
      summary.workflowVersionName,
    ),
    GSI2SK: groupGsi2Sk(summary.stoppedAt, summary.updatedAt),
    runId: summary.runId,
    workflowVersionName: summary.workflowVersionName,
    status: summary.status,
    updatedAt: summary.updatedAt,
    durationAvailable: summary.durationAvailable,
    cpuAvailable: summary.cpuAvailable,
    memoryAvailable: summary.memoryAvailable,
    cpuHoursAvailable: summary.cpuHoursAvailable,
    concurrencyAvailable: summary.concurrencyAvailable,
    taskCount: summary.taskCount,
    failedTaskCount: summary.failedTaskCount,
    entityType: 'SUMMARY',
  };

  setIfDefined(item, 'workflowName', summary.workflowName);
  setIfDefined(item, 'workflowId', summary.workflowId);
  setIfDefined(item, 'stoppedAt', summary.stoppedAt);
  setIfDefined(item, 'durationMs', summary.durationMs);
  setIfDefined(item, 'meanCpu', summary.meanCpu);
  setIfDefined(item, 'peakCpu', summary.peakCpu);
  setIfDefined(item, 'meanMemoryGiB', summary.meanMemoryGiB);
  setIfDefined(item, 'peakMemoryGiB', summary.peakMemoryGiB);
  setIfDefined(item, 'cpuHours', summary.cpuHours);
  setIfDefined(item, 'peakConcurrentTasks', summary.peakConcurrentTasks);

  return item;
}

/**
 * Shape of a persisted Group_Registry item (workflow-performance-reports
 * Req 11.4). One item per distinct `(workflowName, workflowVersionName)` under
 * the single `GROUPS` partition. Carries the friendly labels, the set of
 * observed `workflowId`s (for the Collision_State — a DynamoDB string set), the
 * run count seen, and a `lastSeen` timestamp. `listWorkflowGroups` reads this
 * one partition instead of scanning the table for SUMMARY items.
 */
export interface GroupRegistryItem {
  PK: string;
  SK: string;
  workflowName: string;
  versionName: string;
  /** Distinct workflow ids observed for this friendly group (>1 => collision). */
  workflowIds: string[];
  /** Total runs recorded into this group (best-effort counter). */
  runCount: number;
  /** ISO 8601 of the most recent registry update. */
  lastSeen: string;
  entityType: 'GROUP';
}

/**
 * Shape of a persisted static-graph item. Attributes mirror the "Static graph
 * item attributes" list in design.md §6: `PK`/`SK` keyed
 * `WF#<workflowId>#<workflowVersionName>`, the `workflowId`, the
 * `workflowVersionName`, the `nodes` and `edges` lists, an optional `fidelity`
 * and `language`, an `updatedAt` timestamp, and `entityType = "GRAPH"`.
 *
 * On a parse/fetch failure a `failureReason` attribute is recorded while
 * existing graph data is preserved (Req 5.7); this shape therefore also allows
 * an optional `failureReason` and makes `nodes`/`edges` unnecessary for a
 * failure-only marker.
 */
export interface GraphItem {
  PK: string;
  SK: string;
  workflowId: string;
  /** The workflow version this graph belongs to (Req 5.1). */
  workflowVersionName: string;
  nodes: { id: string; name: string }[];
  edges: { from: string; to: string }[];
  /**
   * How complete the stored graph is (Req 4.8). Optional so legacy items
   * written before fidelity was tracked still deserialize; those default to
   * `approximate` on read (design §6).
   */
  fidelity?: Fidelity;
  language?: string;
  updatedAt: string;
  entityType: 'GRAPH';
  failureReason?: string;
}

/**
 * Shape of a persisted rate-card item (mirrors {@link GraphItem}). One item per
 * region, keyed `PK === SK === RATECARD#<region>` so distinct regions never
 * share a cache entry (Req 4.6, design §4). Stores the region's rate map
 * (`resourceType` → published rate, keyed by instance types plus the two
 * storage-family labels), the `currency`, the `effectiveDate` (ISO date the
 * card was retrieved from the Price List API), the `updatedAt` staleness basis
 * (like {@link GraphItem}`.updatedAt`), and `entityType = "RATECARD"`.
 *
 * On a fetch/parse failure a `failureReason` is recorded while any existing
 * `rates` are preserved (Req 4.4 stale-serve); this shape therefore also allows
 * an optional `failureReason`.
 */
export interface RateCardItem {
  PK: string;
  SK: string;
  region: string;
  /** resourceType -> published rate. Keys are instance types + the two storage family labels. */
  rates: Record<string, { pricePerUnit: number; unit: string }>;
  currency: string;
  /** ISO date the card was retrieved from the Price List API. */
  effectiveDate: string;
  /** ISO 8601; the staleness basis (like {@link GraphItem}`.updatedAt`). */
  updatedAt: string;
  entityType: 'RATECARD';
  /** Set on a fetch/parse failure while preserving prior rates (mirrors {@link DynamoRepository.recordGraphFailure}). */
  failureReason?: string;
}

/**
 * Build the DynamoDB item for a static graph: derive `PK`/`SK` keyed
 * `WF#<workflowId>#<workflowVersionName>`, copy the graph's `nodes` and `edges`,
 * carry the graph's `fidelity`, stamp `updatedAt`, record the
 * `workflowVersionName`, and tag `entityType = "GRAPH"` (Req 5.1, 5.6, 4.8). An
 * optional `language` is stored when provided.
 */
export function buildGraphItem(
  workflowId: string,
  workflowVersionName: string,
  graph: StaticGraph,
  updatedAt: string,
  language?: string,
): GraphItem {
  const item: GraphItem = {
    PK: graphPk(workflowId, workflowVersionName),
    SK: graphSk(workflowId, workflowVersionName),
    workflowId,
    workflowVersionName,
    // Copy node/edge lists into the plain attribute shape stored on the item so
    // the persisted item does not alias the caller's graph object.
    nodes: graph.nodes.map((node) => ({ id: node.id, name: node.name })),
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    fidelity: graph.fidelity,
    updatedAt,
    entityType: 'GRAPH',
  };

  setIfDefined(item, 'language', language);

  return item;
}

/**
 * Outcome of an upsert attempt.
 *
 * - `written`  — the item was persisted (new item or a monotonic overwrite
 *   because the incoming `updatedAt` was strictly greater than the stored one).
 * - `preserved` — a matching item already existed with an `updatedAt` greater
 *   than or equal to the incoming one, so the stored item was left unchanged
 *   (Req 3.8). This is a successful no-op, not an error.
 */
export interface UpsertResult {
  outcome: 'written' | 'preserved';
  /** The run identifier of the target item. */
  runId: string;
  /** The task identifier, present only for task upserts. */
  taskId?: string;
}

/**
 * Error raised when an upsert is rejected before any write because a required
 * identifier is absent or empty (Req 3.9). Names the offending attribute so the
 * caller can log an error indication identifying the missing attribute.
 */
export class InvalidIdentifierError extends Error {
  constructor(
    /** The name of the missing/empty identifier attribute (`runId`/`taskId`). */
    public readonly attribute: 'runId' | 'taskId',
  ) {
    super(`Invalid upsert: required identifier "${attribute}" is missing or empty`);
    this.name = 'InvalidIdentifierError';
  }
}

/**
 * Error raised when a write to the Data_Store fails after the configured number
 * of attempts (Req 3.10). Identifies the affected `runId`/`taskId` and retains
 * the underlying cause.
 */
export class UpsertWriteError extends Error {
  constructor(
    public readonly runId: string,
    public readonly taskId: string | undefined,
    /** The last underlying error that caused the write to fail. */
    public readonly cause: unknown,
  ) {
    const target = taskId !== undefined ? `task ${runId}/${taskId}` : `run ${runId}`;
    super(`Failed to write ${target} to the data store after ${MAX_WRITE_ATTEMPTS} attempts`);
    this.name = 'UpsertWriteError';
  }
}

/**
 * Maximum number of write attempts before giving up and leaving the item
 * unchanged (Req 3.10).
 */
export const MAX_WRITE_ATTEMPTS = 3;

/**
 * Determine whether `value` is a non-empty identifier string. Absent, non-string,
 * empty, or whitespace-only values are all rejected (Req 3.9).
 */
function isValidIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * DynamoDB-backed repository.
 *
 * Holds a `DynamoDBDocumentClient` and the target table name (task 4.1) and
 * implements the conditional monotonic upsert methods (`upsertRun`,
 * `upsertTask`, task 4.2) and the static-graph persistence methods
 * (`putStaticGraph`, `getStaticGraph`, `recordGraphFailure`, task 4.3).
 */
export class DynamoRepository {
  constructor(
    private readonly docClient: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** The DynamoDB table this repository writes to. */
  getTableName(): string {
    return this.tableName;
  }

  /** The underlying DynamoDB document client. */
  getClient(): DynamoDBDocumentClient {
    return this.docClient;
  }

  /**
   * Upsert a run item with a monotonic stale-write guard (Req 3.8, 3.9, 3.10).
   *
   * Rejects the write before touching the store when `runId` is absent or empty
   * (Req 3.9). Writes only when no item exists for the key or the incoming
   * `updatedAt` is strictly greater than the stored value; otherwise the stored
   * item is preserved unchanged (Req 3.8). Transient write failures are retried
   * up to {@link MAX_WRITE_ATTEMPTS} times; on persistent failure the item is
   * left unchanged and an {@link UpsertWriteError} identifying the `runId` is
   * thrown (Req 3.10).
   */
  async upsertRun(run: RunRecord): Promise<UpsertResult> {
    if (!isValidIdentifier(run.runId)) {
      throw new InvalidIdentifierError('runId');
    }

    const item = buildRunItem(run);
    return this.conditionalPut(item, run.runId, undefined);
  }

  /**
   * Upsert a task item with a monotonic stale-write guard (Req 3.8, 3.9, 3.10).
   *
   * Rejects the write before touching the store when `runId` or `taskId` is
   * absent or empty (Req 3.9). Writes only when no item exists for the key or
   * the incoming `updatedAt` is strictly greater than the stored value;
   * otherwise the stored item is preserved unchanged (Req 3.8). Transient write
   * failures are retried up to {@link MAX_WRITE_ATTEMPTS} times; on persistent
   * failure the item is left unchanged and an {@link UpsertWriteError}
   * identifying the `runId`/`taskId` is thrown (Req 3.10).
   */
  async upsertTask(task: TaskRecord): Promise<UpsertResult> {
    if (!isValidIdentifier(task.runId)) {
      throw new InvalidIdentifierError('runId');
    }
    if (!isValidIdentifier(task.taskId)) {
      throw new InvalidIdentifierError('taskId');
    }

    const item = buildTaskItem(task);
    return this.conditionalPut(item, task.runId, task.taskId);
  }

  /**
   * Upsert a Run_Summary item with the same monotonic stale-write guard as
   * runs/tasks (workflow-performance-reports Req 1.5). Rejects the write before
   * touching the store when `runId` is absent or empty (mirrors `upsertRun`).
   * Writes only when no summary exists for the key or the incoming `updatedAt`
   * is strictly greater than the stored value; otherwise the stored summary is
   * preserved unchanged. Idempotent: re-processing the same terminal run yields
   * one summary row and never a duplicate or a stale overwrite.
   */
  async upsertSummary(summary: RunSummaryRecord): Promise<UpsertResult> {
    if (!isValidIdentifier(summary.runId)) {
      throw new InvalidIdentifierError('runId');
    }

    const item = buildSummaryItem(summary);
    return this.conditionalPut(item, summary.runId, undefined);
  }

  /**
   * List all task items for a run (`PK = RUN#<runId>`, `begins_with(SK, "TASK#")`),
   * used by the completion hook to compute a Run_Summary rollup
   * (workflow-performance-reports Req 1.1). Paginates the query fully and
   * returns the task items as {@link TaskItem}s (empty when the run has none).
   */
  async listTaskItemsForRun(runId: string): Promise<TaskItem[]> {
    const items: TaskItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :taskPrefix)',
          ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
          ExpressionAttributeValues: {
            ':pk': runPk(runId),
            ':taskPrefix': 'TASK#',
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const it of (result.Items ?? []) as TaskItem[]) {
        items.push(it);
      }
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  /**
   * Idempotently record a Workflow_Group in the Group_Registry
   * (workflow-performance-reports Req 11.4). Adds `workflowId` to the group's
   * `workflowIds` string set (a no-op when already present, so re-processing a
   * run never duplicates), increments the run counter, and refreshes the
   * labels + `lastSeen`. Uses a single `UpdateCommand` with `ADD` (set-add +
   * counter) and `SET`, so concurrent completions for the same group merge
   * correctly without a read-modify-write race.
   *
   * `workflowId` is optional: when absent (a run with no workflow id) the id
   * set is left untouched (DynamoDB string sets cannot be empty), but the group
   * is still registered so it is enumerable.
   */
  async upsertGroupRegistry(
    workflowName: string,
    versionName: string,
    workflowId: string | undefined,
    now: string = new Date().toISOString(),
  ): Promise<void> {
    const hasId = typeof workflowId === 'string' && workflowId.trim() !== '';
    const names: Record<string, string> = {
      '#workflowName': 'workflowName',
      '#versionName': 'versionName',
      '#lastSeen': 'lastSeen',
      '#entityType': 'entityType',
      '#runCount': 'runCount',
    };
    const values: Record<string, unknown> = {
      ':workflowName': workflowName,
      ':versionName': versionName,
      ':lastSeen': now,
      ':entityType': 'GROUP',
      ':one': 1,
    };
    // ADD on a number with if_not_exists-style accumulation: `ADD #runCount :one`
    // creates the attribute at :one when absent, else increments.
    let updateExpr =
      'SET #workflowName = :workflowName, #versionName = :versionName, ' +
      '#lastSeen = :lastSeen, #entityType = :entityType ' +
      'ADD #runCount :one';
    if (hasId) {
      names['#workflowIds'] = 'workflowIds';
      // DynamoDB Document client encodes a JS Set as a DynamoDB string set.
      values[':wid'] = new Set([workflowId as string]);
      updateExpr += ', #workflowIds :wid';
    }

    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: GROUPS_PK, SK: groupRegistrySk(workflowName, versionName) },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  /**
   * Read every Group_Registry item (the single `GROUPS` partition), used by
   * `listWorkflowGroups` to enumerate Workflow_Groups without a table scan
   * (workflow-performance-reports Req 11.4). Fully paginated.
   */
  async listGroupRegistry(): Promise<GroupRegistryItem[]> {
    const items: GroupRegistryItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'PK' },
          ExpressionAttributeValues: { ':pk': GROUPS_PK },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const it of (result.Items ?? []) as GroupRegistryItem[]) {
        items.push(it);
      }
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  /**
   * Persist a static graph for a workflow version, keyed
   * `WF#<workflowId>#<workflowVersionName>` (Req 5.1, 5.6, 5.8).
   *
   * The graph is written unconditionally with a `PutItem`, replacing any prior
   * graph item for that version with a fresh ISO-8601 `updatedAt`. This is the
   * success path after the definition parser produces a graph; callers only
   * invoke it on a successful parse, so the fresh graph always supersedes an
   * earlier one (or a prior failure marker) for the same version.
   */
  async putStaticGraph(
    workflowId: string,
    workflowVersionName: string,
    graph: StaticGraph,
    language?: string,
  ): Promise<void> {
    const item = buildGraphItem(
      workflowId,
      workflowVersionName,
      graph,
      new Date().toISOString(),
      language,
    );
    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      }),
    );
  }

  /**
   * Look up the cached static graph for a workflow version, keyed
   * `WF#<workflowId>#<workflowVersionName>` (Req 5.3, 5.4 cache lookup). Returns
   * the reconstructed {@link StaticGraph} when a usable graph item exists, or
   * `null` when no item is stored for that version (so the caller knows it must
   * fetch and parse the definition).
   *
   * Old items keyed `WF#<workflowId>` (pre-versioning) are simply never read
   * under the version key and therefore treated as a cache miss.
   *
   * A stored failure marker with no graph data (only a `failureReason`) is
   * treated as "no usable cached graph" and returns `null`.
   */
  async getStaticGraph(
    workflowId: string,
    workflowVersionName: string,
  ): Promise<StaticGraph | null> {
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: graphPk(workflowId, workflowVersionName),
          SK: graphSk(workflowId, workflowVersionName),
        },
      }),
    );

    const item = result.Item as GraphItem | undefined;
    if (!item || !Array.isArray(item.nodes) || !Array.isArray(item.edges)) {
      return null;
    }

    return {
      workflowId: item.workflowId ?? workflowId,
      nodes: item.nodes.map((node) => ({ id: node.id, name: node.name })),
      edges: item.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      // Default legacy items (written before fidelity was tracked) to
      // `approximate` (design §6).
      fidelity: item.fidelity ?? 'approximate',
    };
  }

  /**
   * Record a fetch/parse failure reason on the workflow-version item WITHOUT
   * clobbering any existing graph data (Req 5.7).
   *
   * Uses an `UpdateCommand` that sets only the `failureReason` (and refreshes
   * `updatedAt`, `workflowId`, `workflowVersionName`, and `entityType`), leaving
   * any previously stored `nodes`/`edges`/`fidelity` intact. When no item yet
   * exists for the version, the update creates a failure-only marker item; when
   * a graph already exists, its nodes/edges/fidelity are preserved and only the
   * failure reason is layered on.
   */
  async recordGraphFailure(
    workflowId: string,
    workflowVersionName: string,
    reason: string,
  ): Promise<void> {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: graphPk(workflowId, workflowVersionName),
          SK: graphSk(workflowId, workflowVersionName),
        },
        // SET only the failure metadata; do not touch nodes/edges/fidelity so any
        // previously cached graph data is preserved unchanged (Req 5.7).
        UpdateExpression:
          'SET #failureReason = :reason, #updatedAt = :updatedAt, #workflowId = :workflowId, #workflowVersionName = :workflowVersionName, #entityType = :entityType',
        ExpressionAttributeNames: {
          '#failureReason': 'failureReason',
          '#updatedAt': 'updatedAt',
          '#workflowId': 'workflowId',
          '#workflowVersionName': 'workflowVersionName',
          '#entityType': 'entityType',
        },
        ExpressionAttributeValues: {
          ':reason': reason,
          ':updatedAt': new Date().toISOString(),
          ':workflowId': workflowId,
          ':workflowVersionName': workflowVersionName,
          ':entityType': 'GRAPH',
        },
      }),
    );
  }

  /**
   * Look up the cached rate card for a region, keyed `RATECARD#<region>`
   * (Req 4.1 cache lookup). Returns the stored {@link RateCardItem} when an item
   * exists for that region, or `null` when none is stored (so the caller knows
   * it must fetch the card from the Price List API).
   *
   * Mirrors {@link getStaticGraph}: a plain GetItem returning the item or `null`.
   */
  async getRateCard(region: string): Promise<RateCardItem | null> {
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: rateCardPk(region),
          SK: rateCardSk(region),
        },
      }),
    );

    const item = result.Item as RateCardItem | undefined;
    if (!item) {
      return null;
    }

    return item;
  }

  /**
   * Persist a rate card for a region, keyed `RATECARD#<region>` (Req 4.2, 4.6).
   *
   * The card is written unconditionally with a `PutItem`, replacing any prior
   * rate-card item for that region with a fresh ISO-8601 `updatedAt`. This is
   * the success path after the Price List API yields rates; a fresh card always
   * supersedes an earlier one (or a prior failure marker) for the same region.
   *
   * Mirrors {@link putStaticGraph}: an unconditional `PutCommand`.
   */
  async putRateCard(
    region: string,
    rates: Record<string, { pricePerUnit: number; unit: string }>,
    currency: string,
    effectiveDate: string,
  ): Promise<void> {
    const item: RateCardItem = {
      PK: rateCardPk(region),
      SK: rateCardSk(region),
      region,
      rates,
      currency,
      effectiveDate,
      updatedAt: new Date().toISOString(),
      entityType: 'RATECARD',
    };

    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      }),
    );
  }

  /**
   * Record a fetch/parse failure reason on the region's rate-card item WITHOUT
   * clobbering any existing `rates` (Req 4.4 stale-serve).
   *
   * Uses an `UpdateCommand` that sets only the `failureReason` (and refreshes
   * `updatedAt`, `region`, and `entityType`), leaving any previously stored
   * `rates`/`currency`/`effectiveDate` intact. When no item yet exists for the
   * region, the update creates a failure-only marker item; when a card already
   * exists, its rates are preserved and only the failure reason is layered on.
   *
   * Mirrors {@link recordGraphFailure}.
   */
  async recordRateCardFailure(region: string, reason: string): Promise<void> {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: rateCardPk(region),
          SK: rateCardSk(region),
        },
        // SET only the failure metadata; do not touch rates/currency/effectiveDate
        // so any previously cached rate card is preserved unchanged (Req 4.4).
        UpdateExpression:
          'SET #failureReason = :reason, #updatedAt = :updatedAt, #region = :region, #entityType = :entityType',
        ExpressionAttributeNames: {
          '#failureReason': 'failureReason',
          '#updatedAt': 'updatedAt',
          '#region': 'region',
          '#entityType': 'entityType',
        },
        ExpressionAttributeValues: {
          ':reason': reason,
          ':updatedAt': new Date().toISOString(),
          ':region': region,
          ':entityType': 'RATECARD',
        },
      }),
    );
  }

  /**
   * Perform a `PutCommand` guarded by the monotonic condition expression:
   * write only when the item is absent (`attribute_not_exists(PK)`) OR the
   * incoming `updatedAt` is strictly greater than the stored value.
   *
   * A `ConditionalCheckFailedException` means a fresher (or equal) item already
   * exists, so the stored item is preserved unchanged — a successful no-op, not
   * an error (Req 3.8). Any other error is retried up to
   * {@link MAX_WRITE_ATTEMPTS} times before an {@link UpsertWriteError} is
   * thrown (Req 3.10).
   */
  private async conditionalPut(
    item: RunItem | TaskItem | SummaryItem,
    runId: string,
    taskId: string | undefined,
  ): Promise<UpsertResult> {
    // Base guard: write when the item is new, or when the incoming updatedAt is
    // strictly greater than the stored one (monotonic last-writer-wins, Req 3.8).
    const names: Record<string, string> = {
      '#storedUpdatedAt': 'updatedAt',
    };
    const values: Record<string, unknown> = {
      ':incomingUpdatedAt': item.updatedAt,
    };

    // Status-monotonic guard: status transitions are ordered by their position
    // in the lifecycle, not by `updatedAt`, because HealthOmics `event.time` has
    // second resolution and EventBridge delivers at-least-once and out of order.
    // Two rules, independent of updatedAt:
    //   (a) a TERMINAL status (COMPLETED/FAILED/CANCELLED/DELETED) must win over
    //       a non-terminal one, so a terminal write is accepted even when its
    //       updatedAt is not strictly greater than a stored non-terminal item;
    //   (b) a non-terminal status must never overwrite a stored terminal one.
    // The normal monotonic `updatedAt` rule still governs same-terminality
    // transitions (e.g. RUNNING -> STARTING can't go backwards on a stale event,
    // and a re-emitted COMPLETED with an equal/older time is a no-op).
    // Applies only to items carrying a status (runs/tasks); summaries have none.
    const incomingStatus = (item as RunItem | TaskItem).status;
    let statusClause = '';
    if (typeof incomingStatus === 'string') {
      names['#storedStatus'] = 'status';
      const incomingIsTerminal = isTerminalStatus(incomingStatus);
      values[':incomingIsTerminal'] = incomingIsTerminal;
      values[':true'] = true;
      const terminalKeys: string[] = [];
      let i = 0;
      for (const t of TERMINAL_STATUSES) {
        const k = `:term${i}`;
        values[k] = t;
        terminalKeys.push(k);
        i += 1;
      }
      const storedIsTerminal = `#storedStatus IN (${terminalKeys.join(', ')})`;
      const storedHasStatus = 'attribute_exists(#storedStatus)';
      // (a) terminal-wins: incoming terminal AND stored exists but is non-terminal
      const terminalWins =
        `(:incomingIsTerminal = :true AND ${storedHasStatus} AND NOT (${storedIsTerminal}))`;
      // (b) no-revert: reject non-terminal-over-terminal by requiring the
      //     monotonic branch to also satisfy "not reverting a terminal".
      const noRevert =
        `(:incomingIsTerminal = :true OR NOT ${storedHasStatus} OR NOT (${storedIsTerminal}))`;
      // Combined: terminalWins OR (monotonic updatedAt AND noRevert).
      statusClause =
        `${terminalWins} OR (:incomingUpdatedAt > #storedUpdatedAt AND ${noRevert})`;
    } else {
      // Summaries and any status-less item keep the plain monotonic rule.
      statusClause = ':incomingUpdatedAt > #storedUpdatedAt';
    }

    const command = new PutCommand({
      TableName: this.tableName,
      Item: item,
      ConditionExpression: `attribute_not_exists(PK) OR (${statusClause})`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      try {
        await this.docClient.send(command);
        return { outcome: 'written', runId, taskId };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // A fresher-or-equal item already exists; preserve it unchanged.
          // This is a successful no-op (Req 3.8), not a transient failure, so
          // do not retry.
          return { outcome: 'preserved', runId, taskId };
        }
        lastError = err;
        // Otherwise treat as a transient write failure and retry (Req 3.10).
      }
    }

    // Persistent failure after MAX_WRITE_ATTEMPTS: leave the item unchanged and
    // surface an error identifying the affected runId/taskId (Req 3.10).
    throw new UpsertWriteError(runId, taskId, lastError);
  }
}
