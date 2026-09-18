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
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type { RunRecord, TaskRecord } from './domain/records.js';
import type { Fidelity, StaticGraph } from './parser/types.js';

/** Discriminator attribute stored on every item for item-type filtering. */
export type EntityType = 'RUN' | 'TASK' | 'GRAPH' | 'RATECARD';

/** GSI1 partition-key constant used by all run items (Req 3.3, 3.7). */
export const RUNS_GSI1PK = 'RUNS';

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
    item: RunItem | TaskItem,
    runId: string,
    taskId: string | undefined,
  ): Promise<UpsertResult> {
    const command = new PutCommand({
      TableName: this.tableName,
      Item: item,
      // Write when the item is new, or when the incoming updatedAt is strictly
      // greater than the stored one (monotonic last-writer-wins, Req 3.8).
      ConditionExpression:
        'attribute_not_exists(PK) OR :incomingUpdatedAt > #storedUpdatedAt',
      ExpressionAttributeNames: {
        '#storedUpdatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':incomingUpdatedAt': item.updatedAt,
      },
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
