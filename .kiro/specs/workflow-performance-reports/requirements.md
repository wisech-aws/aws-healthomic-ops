# Requirements Document

## Introduction

This feature adds a new top-level **Reports** area to the Dashboard that presents **aggregate performance across many runs of the same workflow and version over a time period**, so a user can understand how a workflow/version performs in aggregate rather than run-by-run. The existing views are all single-run (the fleet list and one run's detail); this feature introduces the missing dimension: **aggregation across runs, grouped by workflow name + version, over a user-selected time window.**

For each workflow+version group over the window, the Reports view presents **mean, median, and p90** for each tracked performance metric (duration and measured utilization), plus run counts and outcome breakdowns, as visually appealing dashboards. The data is **downloadable** as CSV (for analytics) and as a print-to-PDF (for executive visual reporting).

The load-bearing theme, carried from the existing specs, is **honesty about availability**: measured utilization exists only under specific preconditions (see `run-utilization-metrics`), and the aggregate statistics MUST NOT fabricate values. A run missing a metric is excluded from that metric's statistics (never counted as zero), and each aggregate carries an explicit "N of M runs" denominator.

### Design decisions (locked with the product owner; treated as constraints)

- **Data strategy — persist a rollup at completion (Option B):** measured per-run utilization is read on demand from CloudWatch and is not persisted anywhere today. Aggregating on read does not scale (hundreds of CloudWatch queries per report load) and is bounded by CloudWatch retention. Therefore, when a run reaches a terminal state, the ingest pipeline SHALL compute a compact per-run **Run_Summary** rollup once and persist it, and the Reports feature SHALL aggregate over persisted Run_Summary rows.
- **Grouping by friendly name + version:** groups are keyed and labeled by `(workflowName, workflowVersionName)`, NOT by `workflowId`, to give a friendly reference. The `workflowId` IS stored on the Run_Summary (hidden from the label) as a **collision guard**: when one `(name, version)` group maps to more than one `workflowId`, the report flags a disambiguation state rather than silently blending unrelated workflows.
- **Statistics:** for every tracked metric the report presents **mean, median, and p90**, each computed only over the runs in the group for which that metric was available.
- **Cost excluded:** cost aggregates are explicitly out of scope for this feature.
- **Versionless runs:** a run with no `workflowVersionName` forms its own version bucket, labeled **"(unversioned)"**.
- **One-time backfill:** a one-time backfill populates Run_Summary rows for existing terminal runs. Run-level facts (duration, status, task shape, workflow name/version/id) come from stored run/task data; utilization comes from a bounded CloudWatch sweep for runs still within the Metrics_Retention_Window and is otherwise flagged unavailable.
- **Downloads:** CSV export (analytics) and client-side print-to-PDF (executive visual). No server-side PDF rendering in this feature.
- **Window:** a calendar range picker with a default of the last 30 days.
- **High-volume scale (50k+ runs) — server-side pre-aggregation, bounded payloads:** a Workflow_Group over a window may contain **tens of thousands of runs (design target: ≥ 50,000)**. The report MUST remain responsive and correct at that scale, so:
  - The Dashboard SHALL NOT return the full per-run set to the browser for on-screen charting. Charts are driven by **server-computed, fixed-size** aggregates (a duration **Histogram** of bounded bucket count, and/or **Time_Bins** binned by day/week), not one datum per run.
  - The Report_Query response payload SHALL be **bounded independent of run count** (aggregate statistics + fixed-size chart series + outcome counts), with any raw per-run rows either omitted, capped to a small `Sample_Limit`, or delivered only through the CSV export path.
  - The Groups_Query SHALL enumerate Workflow_Groups via a **bounded, indexed access pattern** (a maintained Group_Registry or a dedicated index), NOT a full-table scan, so listing groups stays cheap as the summary count grows.
  - Aggregate statistics (mean/median/p90, counts) remain exact and are the primary output; only the per-run *visualization* is bucketed. Availability honesty (the "N of M runs" denominator) is preserved at any N.

### Grounding facts (from the existing system; treated as constraints, not assumptions)

- The DynamoDB single table stores Run and Task items under `PK = RUN#<runId>`; run items carry a `GSI1` recency index (`GSI1PK = RUNS`, `GSI1SK = <updatedAt>`). See `ingest/src/repository.ts`.
- Run items carry `workflowName`, `workflowVersionName` (both optional; version frequently absent), and `workflowId`. See `ingest/src/domain/records.ts` and `infra/graphql/schema.graphql`.
- Measured utilization is read on demand via `getRunMetrics` (a Lambda over CloudWatch's PromQL API) and is **never persisted**; memory is reported in gibibytes (GiB, confirmed unit). See `run-utilization-metrics` and `frontend/src/metrics/resourceSummary.ts`.
- Measured utilization exists only for runs whose IAM run role held `cloudwatch:PutMetricData` at run start (the `scripts/ensure-run-metrics-permission.mjs` prerequisite), and is retained by CloudWatch for the Metrics_Retention_Window (15 months). Runs without the grant legitimately have no utilization, ever.
- The pipeline is event-driven: HealthOmics status-change events invoke the ingest Lambda, which enriches via `GetRun`/`ListRunTasks` and upserts items with a monotonic-`updatedAt` guard.
- The frontend is a React + Vite SPA styled with Cloudscape; interactive AppSync queries use Cognito user-pool auth.
- Live TEST environment is account `123456789012` / `us-east-1`; deploys are billable. This requirements phase involves no deploys and no code.
- This spec MUST NOT collide with existing specs (`healthomics-workflow-dashboard`, `dashboard-quality-of-life`, `static-dag-from-definition`, `run-utilization-metrics`, `run-cost-estimation`, `run-detail-dag-flyout`).

## Glossary

- **Dashboard**: The AWS HealthOmics visualizer web application (frontend plus its AppSync/Lambda backend).
- **Reports_View**: The new top-level frontend view that presents aggregate workflow/version performance.
- **Run_Summary**: A compact, persisted per-run rollup item written when a run reaches a terminal state, holding the run's labels and its tracked metric values plus per-metric availability flags.
- **Workflow_Group**: The set of Run_Summary rows sharing the same `(workflowName, workflowVersionName)`, the unit of aggregation and display.
- **Tracked_Metric**: A per-run performance value aggregated by the report — wall-clock duration, mean CPU, peak CPU, mean memory (GiB), peak memory (GiB), CPU-hours, peak concurrent tasks, task count, and failed-task count.
- **Aggregate_Statistic**: For a Tracked_Metric within a Workflow_Group and window, the mean, median, and p90 computed over the runs for which that metric was available.
- **Availability_Flag**: A boolean on a Run_Summary indicating whether a given Tracked_Metric was actually available for that run (vs. absent).
- **Metric_Unavailable_State**: An explicit interface/value state indicating a metric was not available, shown instead of a fabricated value (mirrors the existing "unavailable" convention).
- **Time_Window**: The user-selected `[start, end]` date range the report aggregates over; defaults to the last 30 days.
- **Terminal_State**: A run status of COMPLETED, FAILED, or CANCELLED.
- **Unversioned_Label**: The literal label `"(unversioned)"` used for the version bucket of runs with no `workflowVersionName`.
- **Collision_State**: The state where a single `(workflowName, workflowVersionName)` Workflow_Group maps to more than one `workflowId`.
- **Metrics_Retention_Window**: CloudWatch's 15-month retention window for the utilization metrics.
- **Backfill_Job**: The one-time operational script that populates Run_Summary rows for pre-existing terminal runs.
- **Report_Query**: The AppSync GraphQL query the Reports_View calls to retrieve an aggregated report for a Workflow_Group over a Time_Window.
- **Groups_Query**: The AppSync GraphQL query the Reports_View calls to enumerate the Workflow_Groups available in a Time_Window (for the pickers).
- **Histogram**: A server-computed, fixed-size distribution of a Tracked_Metric (a bounded number of value buckets, each with a run count) used to visualize the metric's spread without one datum per run.
- **Time_Bins**: A server-computed, fixed-size series that bins the window into intervals (e.g. day or week) and reports a per-bin statistic (e.g. mean/p90 duration, run count), used for a trend chart whose size is independent of run count.
- **Group_Registry**: A small maintained set of items (or a dedicated index) enumerating the distinct Workflow_Groups, so the Groups_Query is a bounded query rather than a full-table scan.
- **Sample_Limit**: The small, bounded maximum number of raw per-run rows the Report_Query may return for on-screen use (e.g. a recent-runs sample); the complete per-run dataset is available only via the CSV export path.
- **High_Volume**: The design target that a single Workflow_Group over a window may contain 50,000 or more runs, at which the report must stay responsive and correct.
- **CSV_Export**: A downloadable comma-separated dataset of the report's per-run and aggregate data.
- **PDF_Export**: A client-side print-to-PDF rendering of the Reports_View's visual dashboard.

## Requirements

### Requirement 1: Persist a per-run rollup at completion

**User Story:** As the Dashboard, I want to persist a compact performance rollup when a run finishes, so that aggregate reports can be computed cheaply without re-querying CloudWatch for every run.

#### Acceptance Criteria

1. WHEN a run transitions to a Terminal_State, THE ingest pipeline SHALL compute and persist exactly one Run_Summary for that run.
2. THE Run_Summary SHALL record `workflowName`, `workflowVersionName`, and `workflowId`, normalizing an absent `workflowVersionName` to the Unversioned_Label.
3. THE Run_Summary SHALL record, for each Tracked_Metric, the metric value and its Availability_Flag, setting the Availability_Flag to false when the metric's inputs were absent rather than storing a fabricated or zero value.
4. THE Run_Summary SHALL record memory metrics in gibibytes (GiB) consistent with the rest of the Dashboard.
5. WHEN a Run_Summary is written more than once for the same run, THE ingest pipeline SHALL persist it idempotently using the existing monotonic-`updatedAt` guard so re-processing does not corrupt or duplicate the rollup.
6. THE Run_Summary write SHALL NOT block, fail, or degrade the existing run/task upsert path for that run.

### Requirement 2: Report data store and query access pattern

**User Story:** As the Dashboard backend, I want Run_Summary rows to be queryable by workflow+version over a time window, so that a report is a small indexed range read rather than a table scan.

#### Acceptance Criteria

1. THE Run_Summary SHALL be stored in the existing DynamoDB single table without requiring a separate table or external analytics infrastructure.
2. THE Run_Summary SHALL be indexed such that all Run_Summary rows for one `(workflowName, workflowVersionName)` Workflow_Group can be read time-ordered by the run's terminal timestamp within a Time_Window in a single indexed range query.
3. THE Groups_Query SHALL return, for a Time_Window, the distinct Workflow_Groups present, each with its `workflowName`, `workflowVersionName`, run count, and the set of `workflowId` values observed for that group.
4. THE Report_Query SHALL accept a `workflowName`, a `workflowVersionName`, and a Time_Window, and return the aggregated report for that Workflow_Group.
5. THE Groups_Query and Report_Query SHALL be authorized for the Cognito user pool consistent with the Dashboard's other interactive queries.

### Requirement 3: Aggregate statistics (mean, median, p90)

**User Story:** As a user assessing workflow performance, I want mean, median, and p90 for each metric across the group's runs, so that I understand both typical and tail performance, not just an average that hides outliers.

#### Acceptance Criteria

1. WHEN the Report_Query aggregates a Workflow_Group over a Time_Window, THE Dashboard SHALL compute, for each Tracked_Metric, the mean, the median, and the p90 across the runs in the group.
2. THE Dashboard SHALL compute each Aggregate_Statistic only over the runs whose Availability_Flag for that metric is true.
3. THE Dashboard SHALL report, for each Tracked_Metric, the count of runs for which the metric was available (N) and the total count of runs in the group (M).
4. IF no run in a Workflow_Group has a given Tracked_Metric available, THEN THE Dashboard SHALL present the Metric_Unavailable_State for that metric's statistics rather than a fabricated value.
5. THE Dashboard SHALL report run-outcome counts for the Workflow_Group over the window: total runs, and the number COMPLETED, FAILED, and CANCELLED.

### Requirement 4: Reports view and time-window selection

**User Story:** As a user, I want a Reports menu item with a calendar date range and workflow/version selection, so that I can view aggregate performance for the workflows and period I care about.

#### Acceptance Criteria

1. THE Dashboard SHALL present a top-level Reports_View reachable from the primary navigation, distinct from the fleet and run-detail views.
2. THE Reports_View SHALL provide a calendar range picker for the Time_Window, defaulting to the last 30 days.
3. THE Reports_View SHALL allow the user to select a Workflow_Group by `workflowName` and `workflowVersionName`, populated from the Groups_Query for the selected Time_Window.
4. WHEN the user has no runs in the selected Time_Window, THE Reports_View SHALL present an explicit empty state rather than fabricated or blank charts.
5. THE Reports_View SHALL present each version — including the Unversioned_Label bucket — as its own selectable Workflow_Group.

### Requirement 5: Visual dashboard presentation

**User Story:** As a user, I want the aggregate performance presented as clear, appealing charts and summary cards, so that I can understand the workflow/version's performance at a glance.

#### Acceptance Criteria

1. THE Reports_View SHALL present, for the selected Workflow_Group and Time_Window, summary cards for run count, outcome breakdown, and duration (mean, median, p90).
2. THE Reports_View SHALL present charts of the Tracked_Metrics driven by **server-computed, fixed-size** series (a duration Histogram and/or Time_Bins), whose size is independent of the number of runs, rather than one datum per run (see Requirement 11).
3. WHEN a Tracked_Metric statistic is available, THE Reports_View SHALL label it as measured and display its unit (e.g. GiB for memory), consistent with the rest of the Dashboard.
4. WHEN a Tracked_Metric is in the Metric_Unavailable_State, THE Reports_View SHALL show an explicit unavailable affordance and the "N of M runs" denominator rather than a zero or blank value.
5. THE Reports_View SHALL visually distinguish mean, median, and p90 for each metric it charts or tabulates.

### Requirement 6: Same-name collision safety

**User Story:** As a user, I want to trust that a report row reflects a single workflow, so that friendly name+version grouping never silently blends two unrelated workflows.

#### Acceptance Criteria

1. THE Dashboard SHALL record the `workflowId` on every Run_Summary even though grouping and display use `(workflowName, workflowVersionName)`.
2. WHEN a Workflow_Group over a Time_Window maps to more than one distinct `workflowId`, THE Reports_View SHALL present the Collision_State for that group.
3. WHEN the Collision_State is present, THE Reports_View SHALL make the collision visible to the user rather than presenting the blended aggregate as if it were a single workflow.

### Requirement 7: CSV export (analytics)

**User Story:** As an analyst, I want to download the report as CSV, so that I can do my own analysis in a spreadsheet or notebook.

#### Acceptance Criteria

1. THE Reports_View SHALL provide a CSV_Export of the currently displayed report.
2. THE CSV_Export SHALL include the computed Aggregate_Statistics (mean, median, p90) with their availability denominators, and the per-run Tracked_Metric values for the Workflow_Group and Time_Window; at High_Volume the per-run rows are obtained through the bounded/paginated export path (not the on-screen Report_Query payload, which is size-bounded per Requirement 11).
3. THE CSV_Export SHALL represent an unavailable metric explicitly (e.g. an empty cell or an explicit marker) rather than as a fabricated zero.
4. THE CSV_Export SHALL label the Workflow_Group by `workflowName` and `workflowVersionName`, using the Unversioned_Label where applicable.

### Requirement 8: PDF export (executive visual)

**User Story:** As an executive audience, I want a polished printable/PDF version of the visual dashboard, so that I can share aggregate performance without needing dashboard access.

#### Acceptance Criteria

1. THE Reports_View SHALL provide a PDF_Export produced by a client-side print-to-PDF path (no server-side PDF rendering).
2. THE PDF_Export SHALL render the visual dashboard (summary cards and charts) for the selected Workflow_Group and Time_Window in a print-appropriate layout.
3. THE PDF_Export SHALL carry the Workflow_Group label, the Time_Window, and any Collision_State or Metric_Unavailable_State affordances visible in the view, so the exported document is as honest as the on-screen view.

### Requirement 9: One-time historical backfill

**User Story:** As an operator, I want existing finished runs represented in reports, so that the Reports_View is useful immediately rather than only for runs completed after launch.

#### Acceptance Criteria

1. THE Backfill_Job SHALL create a Run_Summary for each pre-existing Terminal_State run from the run's stored run/task data.
2. WHEN a backfilled run is within the Metrics_Retention_Window, THE Backfill_Job SHALL populate its utilization Tracked_Metrics from a bounded CloudWatch sweep.
3. WHEN a backfilled run is outside the Metrics_Retention_Window or otherwise has no utilization, THE Backfill_Job SHALL set the corresponding Availability_Flags to false while still populating duration, outcome, and task-shape metrics.
4. THE Backfill_Job SHALL be idempotent, so that re-running it does not duplicate or corrupt Run_Summary rows.
5. THE Backfill_Job SHALL bound its CloudWatch request rate so that it does not exceed CloudWatch API limits.

### Requirement 10: Availability honesty across aggregation

**User Story:** As a user relying on these numbers, I want the report to never invent data, so that aggregate performance figures are trustworthy.

#### Acceptance Criteria

1. THE Dashboard SHALL NOT include a run in a Tracked_Metric's Aggregate_Statistic unless that run's Availability_Flag for the metric is true.
2. THE Dashboard SHALL NOT represent an unavailable Tracked_Metric as zero in any statistic, chart, CSV_Export, or PDF_Export.
3. WHEN utilization is unavailable for runs because the Metrics_Precondition was not met, THE Reports_View SHALL make available an explanation that utilization requires the run role's metric-emission permission at run start.
4. THE Dashboard SHALL preserve the memory unit as GiB in every surface (statistics, charts, CSV_Export, PDF_Export), consistent with the rest of the Dashboard.

### Requirement 11: High-volume scalability (50k+ runs)

**User Story:** As a user of a workflow with tens of thousands of runs, I want the report to load quickly and correctly, so that the Reports_View is usable at production scale and not just for small run counts.

#### Acceptance Criteria

1. WHEN a Workflow_Group over a Time_Window contains a High_Volume number of runs (design target ≥ 50,000), THE Report_Query SHALL return a response whose size is **bounded independent of the run count** — the Aggregate_Statistics, the fixed-size chart series (Histogram and/or Time_Bins), and the outcome counts — and SHALL NOT return one row per run for on-screen rendering.
2. THE Dashboard SHALL compute the chart series (Histogram buckets and/or Time_Bins) **server-side** with a bounded number of buckets/bins, so the number of chart data points does not grow with the run count.
3. IF the Report_Query returns any raw per-run rows for on-screen use, THEN it SHALL cap them at the Sample_Limit; the complete per-run dataset SHALL be available only through the bounded/paginated CSV export path.
4. THE Groups_Query SHALL enumerate Workflow_Groups through a bounded, indexed access pattern (a Group_Registry or a dedicated index) rather than a full-table scan, so its cost does not grow linearly with the total Run_Summary count.
5. THE Reports_View SHALL render a bounded number of on-screen chart elements regardless of run count, so the browser does not attempt to render one visual element per run.
6. THE Aggregate_Statistics (mean, median, p90, counts) and the availability denominators SHALL remain exact at High_Volume; only the per-run visualization is bucketed, never the statistics.
7. WHERE median or p90 over a High_Volume set would be prohibitively expensive to compute exactly, THE Dashboard MAY compute them from the persisted per-run values using a streaming/bucketed method, provided the result is within a documented error bound and the mean and counts remain exact; any such approximation SHALL be labeled.
