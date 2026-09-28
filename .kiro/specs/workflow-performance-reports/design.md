# Design Document: Workflow/Version Aggregate Performance Reports

## Overview

This feature adds a **Reports** area that aggregates performance across many runs of the same workflow + version over a user-selected time window, presenting mean/median/p90 for each tracked metric as an appealing dashboard, downloadable as CSV and print-to-PDF.

The design follows Option B: the ingest pipeline computes a compact **Run_Summary** rollup once when a run reaches a terminal state and persists it into the existing DynamoDB single table under a new item type and a new GSI. Reports are then cheap indexed range reads aggregated server-side into statistics. A one-time backfill populates history. Grouping and display use the friendly `(workflowName, workflowVersionName)` pair; `workflowId` is stored as a hidden collision guard. Cost is out of scope. The design preserves the Dashboard's standing no-fabrication rule at the aggregate level: a run missing a metric is excluded from that metric's statistics (never zero), with an explicit "N of M runs" denominator.

This design reuses existing, proven building blocks rather than inventing parallel ones:
- the pure resource-summary helpers (`frontend/src/metrics/resourceSummary.ts`, `intervals.ts`) for per-run derivations,
- the measured-metrics read path (`getRunMetrics` Lambda over CloudWatch PromQL) for utilization,
- the single-table repository and monotonic-`updatedAt` upsert (`ingest/src/repository.ts`),
- the Lambda-backed AppSync query pattern used by `getRunLogs`/`getRunMetrics`/`getRunCostEstimate`,
- Cloudscape components and the SPA's existing chart usage.

## Architecture

```
Run reaches Terminal_State
        │  (existing status-change event → ingest Lambda)
        ▼
Ingest completion hook ──► compute Run_Summary (reuse resourceSummary + one CloudWatch PromQL sweep)
        │
        ▼
DynamoDB single table
   Run_Summary item:  PK=RUN#<runId>  SK=SUMMARY#<runId>
   GSI2:  GSI2PK=WF#<workflowName>#<versionName>   GSI2SK=<stoppedAt ISO8601>
        ▲
        │  (indexed range read per group over window)
        │
AppSync ── Groups_Query / Report_Query ──► Reports_Lambda ──► aggregate mean/median/p90
        ▲
        │  (Cognito-authorized GraphQL)
        ▼
Reports_View (React/Cloudscape)  ──► charts + cards ──► CSV_Export / PDF_Export (client-side)

One-time: Backfill_Job (scripts/*.mjs) ──► writes Run_Summary rows for existing terminal runs
```

No new persistent infrastructure beyond one GSI on the existing table. The design stays fully serverless and scales-to-zero, consistent with the project's cost model.

## Components and Interfaces

### 1. Run_Summary item (data model)

New item type in the single table, co-located with the run and indexed for group queries.

| Item | PK | SK | GSI2PK | GSI2SK |
|------|----|----|--------|--------|
| Summary | `RUN#<runId>` | `SUMMARY#<runId>` | `WF#<workflowName>#<versionName>` | `<stoppedAt ISO8601>` |
| Group   | `GROUPS`      | `WF#<workflowName>#<versionName>` | — | — |

The **Group** item is the Group_Registry (Req 11.4): one small item per distinct `(name, version)` under a single `GROUPS` partition, carrying `workflowName`, `versionName`, the observed `workflowIds` (a string set, for the Collision_State), and a `lastSeen` timestamp. `listWorkflowGroups` reads this one partition instead of scanning the table, so group enumeration stays bounded as the summary count grows to 50k+.

Attributes:
- Discriminator: `entityType = "SUMMARY"`.
- Labels: `runId`, `workflowName`, `workflowVersionName` (normalized to `"(unversioned)"`), `workflowId` (hidden collision guard), `status`, `stoppedAt`, `updatedAt`.
- Metrics (each with an availability flag): `durationMs`, `meanCpu`, `peakCpu`, `meanMemoryGiB`, `peakMemoryGiB`, `cpuHours`, `peakConcurrentTasks`, `taskCount`, `failedTaskCount`.
- Availability flags: `durationAvailable`, `cpuAvailable`, `memoryAvailable`, `cpuHoursAvailable`, `concurrencyAvailable` (task counts are always available for a terminal run with tasks).

Key normalization: `WF#<workflowName>#<versionName>` uses the same normalization as the item's stored `workflowVersionName` (Unversioned_Label when absent). Names are used verbatim in the key; a delimiter-safe encoding is applied so names containing `#` cannot corrupt the composite key (design detail: encode name/version segments, e.g. length-prefixed or percent-encoded, resolved in tasks).

Rationale: co-locating under `RUN#<runId>` makes the summary a cheap sibling write; `GSI2` keyed by group + terminal timestamp makes a report a single time-ordered range query per group.

### 2. Ingest completion hook

Extends the existing terminal-state handling in the ingest Lambda.

- Trigger: the run reaches a Terminal_State during event processing (the handler already knows the run status and has the enriched run + tasks).
- Computation (pure, reused):
  - duration, task counts, peak concurrency, CPU-hours, and derived peaks from `summarizeResources`/`intervals` over the run's tasks;
  - measured mean/peak CPU and mean/peak memory (GiB) via one CloudWatch PromQL sweep for this run (same signed read path as `getRunMetrics`), converted to GiB for memory.
- Availability: any metric whose inputs are absent (no tasks with the field; no measured series) is flagged unavailable, never zeroed.
- Persistence: build the `SUMMARY` item and upsert with the existing monotonic-`updatedAt` guard (idempotent). The write is decoupled from the run/task upsert — a summary failure logs and does not fail the run/task path.
- Group_Registry maintenance (Req 11.4): the hook also upserts a small **Group_Registry** item for the summary's `(workflowName, versionName)` — `PK = GROUPS`, `SK = WF#<name>#<version>` — carrying/merging the observed `workflowId`(s). This is an idempotent, keyed upsert (a set-add of the id), so `listWorkflowGroups` reads a single partition (`PK = GROUPS`) instead of scanning the table. The registry write is best-effort and failure-isolated like the summary write.

### 3. Data store / repository additions

In `ingest/src/repository.ts`:
- `EntityType` gains `"SUMMARY"` and `"GROUP"` (the Group_Registry item).
- Key derivations `summarySk(runId)`, `groupGsi2Pk(name, version)`, `groupGsi2Sk(stoppedAt)`, and the Group_Registry keys (`GROUPS_PK = "GROUPS"`, `groupRegistrySk(name, version)`).
- `buildSummaryItem(record)` mapping (each metric written only when defined; availability flags always written).
- `upsertSummary(...)` mirroring the existing conditional monotonic upsert.
- `upsertGroupRegistry(name, version, workflowId)` — an idempotent update that adds the `workflowId` to the item's id set and bumps a `lastSeen`; used by the completion hook and the backfill.
- A time-window filter on the registry is not required for correctness: `listWorkflowGroups` reads the registry partition and, if a window filter is desired, intersects with a cheap per-group existence check; the registry keeps enumeration bounded either way.

In the CDK `DataStack`: add `GSI2` (`GSI2PK` hash, `GSI2SK` range) to the table with projection sufficient for the report (all summary attributes).

### 4. AppSync GraphQL surface

New read-only, Cognito-authorized types and queries in `infra/graphql/schema.graphql`:

```graphql
type WorkflowGroup @aws_cognito_user_pools {
  workflowName: String!
  versionName: String!          # "(unversioned)" for versionless
  workflowIds: [String!]!       # >1 => Collision_State
  runCount: Int!
}

type AggregateMetric @aws_cognito_user_pools {
  key: String!                  # "durationMs" | "meanCpu" | "peakMemoryGiB" | ...
  unit: String                  # "GiB" | "vCPU" | "ms" | "count" | ...
  mean: Float
  median: Float
  p90: Float
  availableCount: Int!          # N
  totalCount: Int!              # M
}

type RunPoint @aws_cognito_user_pools {   # per-run points for a SAMPLE / CSV rows
  runId: ID!
  stoppedAt: String!
  status: RunStatus
  durationMs: Float
  meanCpu: Float
  peakCpu: Float
  meanMemoryGiB: Float
  peakMemoryGiB: Float
  cpuHours: Float
  peakConcurrentTasks: Int
  taskCount: Int
  failedTaskCount: Int
}

# Fixed-size distribution of one metric (server-computed; bounded bucket count).
type HistogramBucket @aws_cognito_user_pools {
  lo: Float!            # bucket lower bound (inclusive), in the metric's unit
  hi: Float!            # bucket upper bound (exclusive)
  count: Int!           # runs whose value falls in [lo, hi)
}
type MetricHistogram @aws_cognito_user_pools {
  key: String!          # which Tracked_Metric this distribution is for
  unit: String
  buckets: [HistogramBucket!]!   # bounded (e.g. <= ~30) regardless of run count
  availableCount: Int!  # N runs with the metric available (histogram basis)
  totalCount: Int!      # M runs in the group
}

# Fixed-size time-binned trend (server-computed; bounded bin count).
type TimeBin @aws_cognito_user_pools {
  start: String!        # bin start (ISO)
  end: String!          # bin end (ISO)
  runCount: Int!
  durationMeanMs: Float # per-bin stat; null when no available runs in the bin
  durationP90Ms: Float
}

type WorkflowReport @aws_cognito_user_pools {
  workflowName: String!
  versionName: String!
  window: MetricWindow!         # reuses existing MetricWindow type
  runCount: Int!
  succeeded: Int!
  failed: Int!
  cancelled: Int!
  collision: Boolean!
  metrics: [AggregateMetric!]!          # exact stats, bounded size
  durationHistogram: MetricHistogram    # fixed-size chart series (Req 11.2)
  timeBins: [TimeBin!]!                 # fixed-size trend series (Req 11.2)
  # A SMALL bounded sample of recent runs for on-screen context only (Req 11.3);
  # the COMPLETE per-run dataset comes from the paginated export path, not here.
  sample: [RunPoint!]!
  sampleCapped: Boolean!                # true => more runs exist than `sample`
}

extend type Query {
  listWorkflowGroups(start: String!, end: String!): [WorkflowGroup!]!
    @aws_cognito_user_pools
  getWorkflowReport(
    workflowName: String!
    versionName: String!
    start: String!
    end: String!
  ): WorkflowReport @aws_cognito_user_pools
  # Bounded/paginated per-run rows for the CSV export path (Req 7.2, 11.3),
  # kept OUT of getWorkflowReport so the report payload stays size-bounded.
  listWorkflowRunPoints(
    workflowName: String!
    versionName: String!
    start: String!
    end: String!
    limit: Int
    nextToken: String
  ): RunPointConnection @aws_cognito_user_pools
}

type RunPointConnection @aws_cognito_user_pools {
  items: [RunPoint!]!
  nextToken: String
}
```

Backed by a new **Reports_Lambda** data source (mirroring the `getRunMetrics`/`getRunCostEstimate` Lambda pattern):
- `listWorkflowGroups`: reads the **Group_Registry** (a small maintained set of group items / dedicated index), NOT a full-table scan (Req 11.4), returning each group's `(name, version)`, run count, and distinct `workflowId` set.
- `getWorkflowReport`: streams the `GSI2` range for the one group over `[start, end]` and computes, in a single pass, the exact Aggregate_Statistics + outcome counts + collision, plus the **fixed-size** `durationHistogram`, `timeBins`, and a capped `sample` (Sample_Limit). The response size is bounded independent of run count (Req 11.1, 11.2).
- `listWorkflowRunPoints`: paginated per-run rows (via the `GSI2` range with `nextToken`) used only by the CSV export path (Req 7.2, 11.3).

Percentile definition (p90) is fixed in the design and unit-tested: nearest-rank on the sorted available values. At High_Volume the Lambda computes median/p90 from the streamed values without materializing a full sort where avoidable (e.g. a bounded value-bucket/streaming estimator); the mean and all counts stay exact, and any percentile approximation is within a documented error bound and labeled (Req 11.6, 11.7). Client, CSV, and PDF use the same server-computed statistics so they always agree.

### 5. Reports_View (frontend)

New route/view alongside fleet and run detail (the app shell already routes between views).
- Controls: Cloudscape date-range (calendar) picker defaulting to last 30 days; workflow and version selectors populated from `listWorkflowGroups`.
- Body: summary cards (run count, outcomes, duration mean/median/p90); charts driven by the **server-computed fixed-size** series — a duration **Histogram** (bar chart over bounded buckets) and/or a **Time_Bins** trend (mean/p90 per day/week) — NOT one bar per run (Req 5.2, 11.2, 11.5); a utilization panel showing mean/median/p90 with the "N of M" denominator and GiB unit; an outcomes breakdown.
- The number of on-screen chart elements is bounded (buckets/bins), so rendering is O(buckets) regardless of run count (Req 11.5).
- Honesty affordances: Metric_Unavailable_State rendering (no zeros/blanks), the Collision_State badge, an explanatory note that utilization requires the run role's metric-emission permission at run start, and — when a percentile is approximated at High_Volume — an "approximate" label (Req 11.7).
- Empty state when no runs fall in the window.

### 6. CSV_Export and PDF_Export

- CSV: the aggregate block comes from the `WorkflowReport` (size-bounded); the per-run rows are fetched through the **paginated `listWorkflowRunPoints`** path so the export scales to High_Volume without bloating the on-screen report payload (Req 7.2, 11.3). Unavailable metrics render as empty cells (explicit), never zero. Reuses a small pure `toCsv` helper (unit-tested); serialization is streamed/appended per page.
- PDF: client-side print-to-PDF via a dedicated print stylesheet and `window.print()`, rendering the cards + fixed-size charts in a print layout. Carries the group label, window, and any collision/unavailable/approximation affordances so the document is as honest as the screen.

### 7. Backfill_Job

New `scripts/backfill-run-summaries.mjs` (mirrors existing operational scripts, with `--dry-run`):
- Enumerate existing terminal runs from the table.
- For each: compute run-level facts from stored run/task data; if within the Metrics_Retention_Window, do a bounded CloudWatch sweep for utilization, else flag utilization unavailable.
- Write `SUMMARY` rows idempotently (monotonic guard), rate-limited to respect CloudWatch API limits.
- Upsert the **Group_Registry** item for each run's `(name, version)` (idempotent id-set-add), so groups created by the backfill are enumerable by `listWorkflowGroups` without a scan (Req 11.4).

## Data Models

Ingest `RunSummaryRecord` (new, in `ingest/src/domain/records.ts`):
```
runId, workflowName?, workflowVersionName (normalized), workflowId?, status, stoppedAt?, updatedAt,
durationMs? + durationAvailable,
meanCpu? peakCpu? + cpuAvailable,
meanMemoryGiB? peakMemoryGiB? + memoryAvailable,
cpuHours? + cpuHoursAvailable,
peakConcurrentTasks? + concurrencyAvailable,
taskCount, failedTaskCount
```

Frontend types (new, in `frontend/src/api/types.ts`): `WorkflowGroup`, `AggregateMetric`, `RunPoint`, `HistogramBucket`, `MetricHistogram`, `TimeBin`, `WorkflowReport` (with `durationHistogram`, `timeBins`, capped `sample`, `sampleCapped`), and `RunPointConnection`, mirroring the schema.

## Error Handling

- Summary computation failure at ingest: logged, does not fail the run/task upsert (Req 1.6). The summary is retried on the next status event for the run via the idempotent upsert.
- Report query with no rows in window: returns an empty `WorkflowReport`/empty group list; the view shows an empty state (Req 4.4).
- CloudWatch unavailable during summary/backfill: utilization flagged unavailable (never fabricated); duration/outcome/task-shape still recorded.
- Collision: surfaced as a state, never resolved by silently merging (Req 6).

## Testing Strategy

Correctness properties (each implemented by exactly one property test at ≥100 iterations, tagged `Feature: workflow-performance-reports, Property {n}`):

1. **Availability gating** — a metric's Aggregate_Statistic is computed over exactly the runs whose Availability_Flag is true; unavailable runs never contribute (Req 3.2, 10.1).
2. **No zero fabrication** — an unavailable metric never appears as 0 in any statistic or export; it renders as unavailable (Req 3.4, 10.2).
3. **Percentile correctness** — mean/median/p90 equal an independent reference over the available values; p90 uses the fixed nearest-rank definition (Req 3.1).
4. **Denominator correctness** — reported N equals the count of available runs and M the group's total run count (Req 3.3).
5. **Version normalization** — a run with no `workflowVersionName` maps to the Unversioned_Label group in both the key and the report (Req 1.2, 4.5).
6. **Collision detection** — `collision` is true iff the group's Run_Summary rows carry more than one distinct `workflowId` (Req 6.2).
7. **Idempotent summary upsert** — writing a Run_Summary twice yields one row and the monotonic guard preserves the latest (Req 1.5).
8. **Key encoding safety** — group keys round-trip for names/versions containing delimiter characters without cross-group leakage (data-model integrity).
9. **CSV honesty** — CSV cells for unavailable metrics are empty/explicit, never zero, and memory columns are GiB (Req 7.3, 10.2, 10.4).
10. **Memory unit preservation** — every surfaced memory statistic is GiB across report, CSV, and PDF data (Req 10.4).
11. **Bounded report payload** — the `getWorkflowReport` result size (histogram buckets + time bins + sample) is bounded by fixed caps and does NOT grow with the run count; `sample.length <= Sample_Limit` and `sampleCapped` is true iff more runs exist than the sample (Req 11.1, 11.3).
12. **Histogram completeness** — every available run falls in exactly one histogram bucket, the sum of bucket counts equals `availableCount`, and the bucket count is ≤ the fixed cap regardless of run count (Req 11.2).
13. **Aggregate exactness at scale** — for a large synthetic set (e.g. 50k values), mean and counts are exact; median/p90 match the nearest-rank reference within the documented error bound when the streaming/bucketed estimator is used, and are flagged approximate when so computed (Req 11.6, 11.7).
14. **Group registry equivalence** — the set of groups (and their distinct workflowIds) enumerated from the Group_Registry equals the set derivable from all Run_Summary rows, so replacing the scan with the registry does not change results (Req 11.4).

Plus example-based unit tests for: the ingest completion hook (terminal transition → one summary + registry upsert; failure isolation), repository key derivations/upsert/registry set-add, the Reports_Lambda single-pass aggregation (stats + histogram + time bins + capped sample), the `listWorkflowRunPoints` pagination, the Groups query reading the registry, the view's empty/unavailable/collision/approximate states and bounded chart element count, and the CSV serializer over paginated pages. Frontend view tests follow the existing Cloudscape + reactflow-free testing conventions.

## Deployment / Ops notes

- New GSI on the existing table (DataStack) — an additive schema change.
- New Reports_Lambda + AppSync resolvers (ApiStack), Cognito-authorized.
- Ingest change is additive and failure-isolated.
- Backfill is a one-time, idempotent, rate-limited operational script (not part of `cdk deploy`).
- TEST environment is account `123456789012` / `us-east-1`; deploys are billable.
