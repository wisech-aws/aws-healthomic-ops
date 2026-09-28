/**
 * TypeScript mirrors of the AppSync GraphQL schema
 * (`infra/graphql/schema.graphql`). Kept hand-written and minimal rather than
 * codegen'd to avoid pulling a codegen toolchain into the pinned frontend.
 */

/** Run lifecycle status. Mirrors the `RunStatus` enum. */
export type RunStatus =
  | 'PENDING'
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'COMPLETED'
  | 'DELETED'
  | 'CANCELLED'
  | 'FAILED';

/** Task lifecycle status. Mirrors the `TaskStatus` enum. */
export type TaskStatus =
  | 'PENDING'
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

/** A workflow run. Mirrors the `Run` type. */
export interface Run {
  readonly runId: string;
  readonly status?: RunStatus | null;
  readonly name?: string | null;
  readonly createdAt?: string | null;
  readonly startedAt?: string | null;
  readonly stoppedAt?: string | null;
  readonly updatedAt: string;
  readonly workflowId?: string | null;
  readonly workflowName?: string | null;
  /** Workflow version name the run used; drives version-qualified graph lookup (#7.1). */
  readonly workflowVersionName?: string | null;
  /** Output S3 URI for the run's results (#8). */
  readonly outputUri?: string | null;
  /** Input parameters as a JSON string (AWSJSON) (#7). */
  readonly parameters?: string | null;
  /** Engine version that ran the workflow. */
  readonly engineVersion?: string | null;
  /** IAM role ARN the run assumed. */
  readonly roleArn?: string | null;
  /** Storage type: "STATIC" or "DYNAMIC". */
  readonly storageType?: string | null;
  /** Static storage capacity in GiB (when applicable). */
  readonly storageCapacity?: number | null;
  /** Run-cache id (when a cache was used). */
  readonly cacheId?: string | null;
  /** Run-cache behavior, e.g. "CACHE_ON_FAILURE". */
  readonly cacheBehavior?: string | null;
  /** Networking mode, e.g. "VPC". */
  readonly networkingMode?: string | null;
  /** Run-configuration name carrying the VPC config. */
  readonly configurationName?: string | null;
  /** Engine log level, e.g. "ALL" / "OFF". */
  readonly logLevel?: string | null;
  /** Batch ID, present only when the run was started as part of a batch. */
  readonly batchId?: string | null;
  /** Tags (string->string map) as a JSON string (AWSJSON), e.g. cost tags. */
  readonly tags?: string | null;
  /**
   * Human-readable status detail (HealthOmics `statusMessage`), most useful
   * when `status` is FAILED, e.g. "Workflow run failed. Review the CloudWatch
   * logs...". Absent for a healthy/in-progress run.
   */
  readonly statusMessage?: string | null;
  /**
   * Machine-readable failure reason (HealthOmics `failureReason`), e.g.
   * "WORKFLOW_RUN_FAILED". Absent unless the run failed.
   */
  readonly failureReason?: string | null;
}

/** A task within a run. Mirrors the `Task` type. */
export interface Task {
  readonly runId: string;
  readonly taskId: string;
  readonly status?: TaskStatus | null;
  readonly name?: string | null;
  readonly createdAt?: string | null;
  readonly startedAt?: string | null;
  readonly stoppedAt?: string | null;
  readonly updatedAt: string;
  readonly cpus?: number | null;
  readonly memory?: number | null;
  /**
   * The EC2/HealthOmics instance type the task ran on (e.g. "omics.r.2xlarge");
   * drives the per-instance-type compute cost estimate.
   */
  readonly instanceType?: string | null;
  /**
   * Human-readable status detail (HealthOmics `statusMessage`), most useful
   * when `status` is FAILED, e.g. "Run failed due to task: ... failure.".
   * Absent for a healthy/in-progress task.
   */
  readonly statusMessage?: string | null;
  /**
   * Machine-readable failure reason (HealthOmics `failureReason`), e.g.
   * "RUN_TASK_FAILED". Absent unless the task failed.
   */
  readonly failureReason?: string | null;
}

/** Static-graph confidence. Mirrors the `GraphFidelity` enum. */
export type GraphFidelity = 'exact' | 'approximate';

/** A node in a static task graph. Mirrors the `StaticGraphNode` type. */
export interface StaticGraphNode {
  readonly id: string;
  readonly name: string;
}

/** A directed dependency edge (producer → consumer). Mirrors the `StaticGraphEdge` type. */
export interface StaticGraphEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * A source-derived static task graph for a workflow. Mirrors the `StaticGraph`
 * type. `fidelity` distinguishes an authoritative (`exact`) graph from a
 * best-effort (`approximate`) one (#8.1).
 */
export interface StaticGraph {
  readonly workflowId: string;
  readonly nodes: StaticGraphNode[];
  readonly edges: StaticGraphEdge[];
  readonly fidelity: GraphFidelity;
}

/** Paginated run list. Mirrors the `RunConnection` type. */
export interface RunConnection {
  readonly items: Run[];
  readonly nextToken?: string | null;
}


/** Which CloudWatch stream to read for a run. Mirrors the `LogStream` enum. */
export type LogStream = 'RUN' | 'ENGINE' | 'TASK';

/** A single log line. Mirrors the `LogEvent` type. */
export interface LogEvent {
  /** Epoch milliseconds. */
  readonly timestamp: number;
  readonly message: string;
}

/** A page of log events for a run/task stream. Mirrors the `RunLogs` type. */
export interface RunLogs {
  readonly logStreamName: string;
  readonly events: LogEvent[];
  readonly nextToken?: string | null;
}

/**
 * Best-effort extraction of the most relevant error lines from a run/task's
 * CloudWatch log stream. Mirrors the `ErrorExcerpt` type. `found: false`
 * means no error-shaped line was located — never a fabricated excerpt.
 */
export interface ErrorExcerpt {
  readonly found: boolean;
  readonly lines: string[];
  readonly truncated: boolean;
}

/** Resource-metric family. Mirrors the `MetricFamily` enum. */
export type MetricFamily =
  | 'CPU'
  | 'MEMORY'
  | 'NETWORK'
  | 'FILESYSTEM'
  | 'SCRATCH'
  | 'GPU'
  | 'RUN_FILESYSTEM';

/** Whether a series is an actual reading or its configured ceiling. Mirrors the `MetricRole` enum. */
export type MetricRole = 'usage' | 'limit';

/** A single sample in a metric series. Mirrors the `MetricPoint` type. */
export interface MetricPoint {
  /** Epoch milliseconds. */
  readonly timestamp: number;
  readonly value: number;
}

/** A time series of measured resource-utilization samples. Mirrors the `MetricSeries` type. */
export interface MetricSeries {
  readonly metricName: string;
  readonly family: MetricFamily;
  readonly role: MetricRole;
  readonly unit?: string | null;
  /** Null for run-level series. */
  readonly taskId?: string | null;
  /** Network/filesystem io direction. */
  readonly direction?: string | null;
  /** LOCAL | SHARED. */
  readonly scratchMode?: string | null;
  readonly gpuId?: string | null;
  readonly points: MetricPoint[];
}

/** The queried time range and resolution. Mirrors the `MetricWindow` type. */
export interface MetricWindow {
  readonly start: string;
  readonly end: string;
  readonly stepSeconds: number;
}

/** The result of a `getRunMetrics` query. Mirrors the `RunMetrics` type. */
export interface RunMetrics {
  readonly runId: string;
  readonly window?: MetricWindow | null;
  /** Empty array => metrics unavailable. */
  readonly series: MetricSeries[];
  /** Non-null => query failed. */
  readonly error?: string | null;
}

/** Cost-line-item category. Mirrors the `CostCategory` enum. */
export type CostCategory = 'COMPUTE' | 'STORAGE';

/**
 * A single line in a run's estimated cost breakdown. Mirrors the
 * `CostLineItem` type. A list-price ESTIMATE (measured runtime × published
 * price list), never the actual billed amount. `available: false` means this
 * line could not be priced (`quantity`/`ratePerUnit`/`estimatedCost` are null,
 * never zero-filled).
 */
export interface CostLineItem {
  readonly category: CostCategory;
  readonly usageType: string;
  /** Instance type (compute) or storage family (storage). */
  readonly resourceType?: string | null;
  /** Instance-hrs or GB-Hours; null => unavailable. */
  readonly quantity?: number | null;
  readonly unit: string;
  /** Null => unavailable. */
  readonly ratePerUnit?: number | null;
  /** Null => unavailable. */
  readonly estimatedCost?: number | null;
  /** False => Estimate_Unavailable_State for this line. */
  readonly available: boolean;
  readonly unavailableReason?: string | null;
}

/**
 * The result of a `getRunCostEstimate` query. Mirrors the `RunCostEstimate`
 * type. A list-price ESTIMATE, never the actual billed amount, and never
 * persisted.
 */
export interface RunCostEstimate {
  readonly runId: string;
  readonly lineItems: CostLineItem[];
  /** Null => no line item computable. */
  readonly total?: number | null;
  readonly currency?: string | null;
  readonly effectiveDate?: string | null;
  /** True => total is partial. */
  readonly partial: boolean;
  /** Non-null => query failed. */
  readonly error?: string | null;
}

// ── Aggregate workflow/version performance reports (workflow-performance-reports) ──

/** A distinct workflow+version group in a window (for the report pickers). */
export interface WorkflowGroup {
  readonly workflowName: string;
  readonly versionName: string;
  /** Distinct workflow ids observed for this friendly group; >1 => collision. */
  readonly workflowIds: readonly string[];
  readonly runCount: number;
}

/** Aggregated statistics for one tracked metric across a group's runs. */
export interface AggregateMetric {
  readonly key: string;
  readonly unit?: string | null;
  /** null => Metric_Unavailable_State (no run had this metric). */
  readonly mean?: number | null;
  readonly median?: number | null;
  readonly p90?: number | null;
  /** N — runs with this metric available. */
  readonly availableCount: number;
  /** M — total runs in the group. */
  readonly totalCount: number;
}

/** One run's tracked-metric values for trend charts / CSV rows (null = unavailable). */
export interface RunPoint {
  readonly runId: string;
  readonly stoppedAt: string;
  readonly status?: RunStatus | null;
  readonly durationMs?: number | null;
  readonly meanCpu?: number | null;
  readonly peakCpu?: number | null;
  readonly meanMemoryGiB?: number | null;
  readonly peakMemoryGiB?: number | null;
  readonly cpuHours?: number | null;
  readonly peakConcurrentTasks?: number | null;
  readonly taskCount?: number | null;
  readonly failedTaskCount?: number | null;
}

/** One bucket of a fixed-size metric distribution. */
export interface HistogramBucket {
  readonly lo: number;
  readonly hi: number;
  readonly count: number;
}

/** A server-computed, fixed-size distribution of one metric (bounded buckets). */
export interface MetricHistogram {
  readonly key: string;
  readonly unit?: string | null;
  readonly buckets: readonly HistogramBucket[];
  readonly availableCount: number;
  readonly totalCount: number;
}

/** A server-computed, fixed-size time bin (bounded bin count). */
export interface TimeBin {
  readonly start: string;
  readonly end: string;
  readonly runCount: number;
  readonly durationMeanMs?: number | null;
  readonly durationP90Ms?: number | null;
}

/** A paginated page of per-run rows for the CSV export path. */
export interface RunPointConnection {
  readonly items: readonly RunPoint[];
  readonly nextToken?: string | null;
}

/** Aggregated report for one workflow+version over a window (size-bounded). */
export interface WorkflowReport {
  readonly workflowName: string;
  readonly versionName: string;
  readonly window: MetricWindow;
  readonly runCount: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  /** true => multiple workflow ids share this friendly (name, version). */
  readonly collision: boolean;
  readonly metrics: readonly AggregateMetric[];
  /** Fixed-size chart series (bounded regardless of run count). */
  readonly durationHistogram?: MetricHistogram | null;
  readonly timeBins: readonly TimeBin[];
  /** A small bounded recent-run sample for on-screen context only. */
  readonly sample: readonly RunPoint[];
  readonly sampleCapped: boolean;
}
