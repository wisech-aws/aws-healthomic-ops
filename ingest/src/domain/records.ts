/**
 * Normalized domain records produced from an EventBridge event or from
 * HealthOmics API enrichment, before being persisted to the Data_Store.
 *
 * These interfaces mirror the "Ingest Lambda internal interfaces" section of
 * design.md. Optional fields are those that may be absent on a given event and
 * filled in later via enrichment (Requirement 2); `updatedAt` is always
 * required because it is the basis for last-writer-wins ordering (Req 3.3, 3.8).
 */

import type { RunStatus, TaskStatus } from './status.js';

/**
 * A single HealthOmics run, keyed by `runId`.
 *
 * Persisted attributes (Requirement 3.4): status, name, createdAt, startedAt,
 * stoppedAt, updatedAt, workflowId, workflowName.
 */
export interface RunRecord {
  runId: string;
  status?: RunStatus;
  name?: string;
  /** ISO 8601 timestamp. */
  createdAt?: string;
  /** ISO 8601 timestamp. */
  startedAt?: string;
  /** ISO 8601 timestamp. */
  stoppedAt?: string;
  /** ISO 8601 UTC timestamp with millisecond precision (Req 3.3). */
  updatedAt: string;
  workflowId?: string;
  workflowName?: string;
  /**
   * The workflow version name the run used (HealthOmics `workflowVersionName`).
   * May be absent (some runs have no version name). Filled by GetRun
   * enrichment and used to build the version-qualified static-graph cache key.
   */
  workflowVersionName?: string;
  /**
   * The run's output S3 URI (HealthOmics `runOutputUri`), so the dashboard can
   * link out to results. Filled by GetRun enrichment.
   */
  outputUri?: string;
  /**
   * The run's input parameters (HealthOmics `parameters`) as a JSON string.
   * Free-form per workflow (samplesheet, references, flags, ...), so it is
   * stored serialized and surfaced to the UI for reproducibility. Filled by
   * GetRun enrichment.
   */
  parameters?: string;
  /** The engine version that ran the workflow (e.g. Nextflow "25.10.0"). */
  engineVersion?: string;
  /**
   * Run configuration used to launch the run (from GetRun), surfaced for
   * reproducibility. All optional and filled by GetRun enrichment.
   */
  /** The IAM role ARN the run assumed (HealthOmics `roleArn`). */
  roleArn?: string;
  /** Storage type: "STATIC" or "DYNAMIC" (HealthOmics `storageType`). */
  storageType?: string;
  /** Static storage capacity in GiB, when applicable (HealthOmics `storageCapacity`). */
  storageCapacity?: number;
  /** Run-cache id, when a cache was used (HealthOmics `cacheId`). */
  cacheId?: string;
  /** Run-cache behavior, e.g. "CACHE_ON_FAILURE" (HealthOmics `cacheBehavior`). */
  cacheBehavior?: string;
  /** Networking mode, e.g. "VPC" (HealthOmics `networkingMode`). */
  networkingMode?: string;
  /** Run-configuration name carrying the VPC config (HealthOmics `configuration.name`). */
  configurationName?: string;
  /** Engine log level, e.g. "ALL" / "OFF" (HealthOmics `logLevel`). */
  logLevel?: string;
  /**
   * The run's batch ID, present only when the run was started as part of a
   * batch (HealthOmics `batchId`). Absent for standalone runs. Filled by
   * GetRun enrichment.
   */
  batchId?: string;
  /**
   * The run's tags (HealthOmics `tags`) as a JSON string of a string→string
   * map, e.g. cost-allocation tags. Stored serialized (like `parameters`) and
   * surfaced to the UI. Only persisted when the run has at least one tag.
   * Filled by GetRun enrichment.
   */
  tags?: string;
  /**
   * The full raw GetRun API response as a JSON string, captured for audit /
   * completeness so no field returned by GetRun is lost even if it is not
   * modeled as a first-class attribute. Set ONLY on successful GetRun
   * enrichment (never from a plain event), and persisted with the run item in
   * the Data_Store. Not exposed through the GraphQL API.
   */
  rawGetRun?: string;
  /**
   * A human-readable description of the run's current status (HealthOmics
   * `statusMessage`), most useful when `status` is FAILED — e.g. "Run failed
   * due to task: ... failure." Absent for a healthy/in-progress run. Filled by
   * GetRun enrichment.
   */
  statusMessage?: string;
  /**
   * The machine-readable reason the run failed (HealthOmics `failureReason`,
   * e.g. "WORKFLOW_RUN_FAILED"). Absent unless the run failed. Filled by GetRun
   * enrichment.
   */
  failureReason?: string;
}

/**
 * A single task within a run, keyed by `runId` + `taskId`.
 *
 * Persisted attributes (Requirement 3.5): status, name, createdAt, startedAt,
 * stoppedAt, updatedAt, cpus, memory.
 */
export interface TaskRecord {
  runId: string;
  taskId: string;
  status?: TaskStatus;
  name?: string;
  /** ISO 8601 timestamp. */
  createdAt?: string;
  /** ISO 8601 timestamp. */
  startedAt?: string;
  /** ISO 8601 timestamp. */
  stoppedAt?: string;
  /** ISO 8601 UTC timestamp with millisecond precision. */
  updatedAt: string;
  cpus?: number;
  memory?: number;
  /**
   * The task's compute instance type (HealthOmics `instanceType`, e.g.
   * `omics.m.large`) — the join key used to price compute against the published
   * rate card. Filled by GetRunTask enrichment; absent when the API response
   * does not include it (never fabricated).
   */
  instanceType?: string;
  /**
   * A human-readable description of the task's current status (HealthOmics
   * `statusMessage`), most useful when `status` is FAILED — e.g. "Run failed
   * due to task: NFCORE_FETCHNGS:SRA:SRA_IDS_TO_RUNINFO (SRR...), id: ...,
   * failure." Absent for a healthy/in-progress task. Filled by GetRunTask
   * enrichment.
   */
  statusMessage?: string;
  /**
   * The machine-readable reason the task failed (HealthOmics `failureReason`,
   * e.g. "RUN_TASK_FAILED"). Absent unless the task failed. Filled by
   * GetRunTask enrichment.
   */
  failureReason?: string;
}

/**
 * The label used for the version bucket of runs that carry no
 * `workflowVersionName` (workflow-performance-reports Req 1.2, 4.5). Versionless
 * runs form their own group under this literal so reports can group and display
 * them consistently.
 */
export const UNVERSIONED_LABEL = '(unversioned)';

/**
 * A compact, persisted per-run performance rollup (Run_Summary), written once
 * when a run reaches a terminal state (workflow-performance-reports Req 1.x).
 *
 * It holds the run's grouping labels and each Tracked_Metric value paired with
 * an Availability_Flag. Per the standing no-fabrication rule, a metric whose
 * inputs were absent is recorded with its flag `false` and its value omitted —
 * never stored as a fabricated `0` — so aggregate statistics can exclude it
 * rather than count it as zero.
 *
 * Grouping and display use the friendly `(workflowName, workflowVersionName)`
 * pair; `workflowId` is recorded (but not used as the group label) purely as a
 * collision guard so the report can detect when one friendly `(name, version)`
 * maps to more than one workflow id (Req 6.x).
 *
 * Memory metrics are in gibibytes (GiB), consistent with the rest of the
 * dashboard (Req 1.4, 10.4).
 */
export interface RunSummaryRecord {
  runId: string;
  /** Friendly workflow name (group label component). May be absent. */
  workflowName?: string;
  /**
   * Friendly workflow version name (group label component), NORMALIZED to
   * {@link UNVERSIONED_LABEL} when the run had no version. Always present on the
   * record so grouping is consistent.
   */
  workflowVersionName: string;
  /** Hidden collision guard — NOT used as the group label (Req 6.1). */
  workflowId?: string;
  /** The run's terminal status (COMPLETED | FAILED | CANCELLED). */
  status: RunStatus;
  /** ISO 8601 terminal timestamp (the run's `stoppedAt`); the report time axis. */
  stoppedAt?: string;
  /** ISO 8601 UTC timestamp; the monotonic-upsert basis (mirrors run/task items). */
  updatedAt: string;

  // ── Tracked metrics, each paired with an Availability_Flag ────────────────
  /** Wall-clock run duration in milliseconds. */
  durationMs?: number;
  durationAvailable: boolean;
  /** Mean measured CPU (vCPU) across the run. */
  meanCpu?: number;
  /** Peak measured CPU (vCPU) across the run. */
  peakCpu?: number;
  cpuAvailable: boolean;
  /** Mean measured memory in GiB across the run. */
  meanMemoryGiB?: number;
  /** Peak measured memory in GiB across the run. */
  peakMemoryGiB?: number;
  memoryAvailable: boolean;
  /** Total CPU-hours (Σ interval-hours × cpus). */
  cpuHours?: number;
  cpuHoursAvailable: boolean;
  /** Peak count of concurrently-running tasks. */
  peakConcurrentTasks?: number;
  concurrencyAvailable: boolean;
  /** Total task count for the run (always available for a terminal run). */
  taskCount: number;
  /** Count of FAILED/CANCELLED tasks in the run. */
  failedTaskCount: number;
}
