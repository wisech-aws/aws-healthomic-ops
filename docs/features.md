# Dashboard features

The dashboard has three views: the fleet view (the run list), the run detail
view (per-run analytics and the task graph), and the Reports view (aggregate
performance). The [README](../README.md#features) has the short version.

Every derived value follows a no-fabrication rule. When the underlying data is
absent, the UI shows an explicit "unavailable" or "unknown" state, or a dash,
rather than a guessed value.

Views are deep-linkable through the History API. A run opens at `#/run/<id>`
and a selected task at `#/run/<id>/task/<id>`, so a URL can be bookmarked or
shared, and browser back and forward restore the view without a reload. All
timestamps are absolute; there is no relative "N ago" rendering.

## Fleet view

- Columns: status (with a stale-run badge), workflow (opens the run detail
  view), run name, run ID, workflow ID, engine version, batch ID, start time,
  and wall-clock duration.
- Time window: a date-range picker on `updatedAt`, defaulting to the last 30
  days. The window is applied on the server, so an account with many runs a
  month narrows the result instead of loading everything.
- Default ordering: non-terminal runs with no start time yet (for example
  `PENDING` or `STARTING`) sort first, since they are the newest. Every other
  run, including terminal runs that never started, is ordered by effective
  recency (`startedAt` if present, else `updatedAt`, ties broken by
  `updatedAt`). A run cancelled before it started therefore appears by when
  it was cancelled, not pinned to the top (`frontend/src/fleet/ordering.ts`).
- Search: a case-insensitive substring filter across run name, run ID,
  workflow name and ID, status, engine version, and batch ID.
- Filtering and sorting: a multi-select status filter, a workflow filter, and
  sort by recency or duration in either direction. The default (recency, no
  filters) keeps the ordering above.
- Copy controls beside the run ID and workflow ID. Absent values keep their
  `—` placeholder with no copy control.
- Grouping: group by engine version or by batch ID (runs started together in
  a batch share a `batchId`). Each group renders as its own table.
- Pagination: 25 runs per page for the flat list. Grouped views are not
  paged. Search resets to page 1.
- Stale-run detection: a non-terminal run whose `updatedAt` is older than a
  threshold gets a warning badge.
- Live updates: runs update in place and new runs insert in order through the
  `onRunUpdated` subscription, with a per-run pending indicator.
- Compare parameters: select two runs to open a side-by-side parameters diff
  (added, removed, changed, unchanged), with parse-error and cross-workflow
  notices.

## Run detail view

- Task graph: rendered with React Flow and a dagre layout, with a layer
  indicator (True DAG, Inferred DAG, or Timeline). Nodes are colored by task
  status, truncate long names with a tooltip, and support a node search that
  highlights matches. The selected node gets an amber ring, and the slowest
  task a magenta ring shown in the legend. The True DAG comes from the stored
  static graph (`getStaticGraph`, keyed by `workflowId` and
  `workflowVersionName`).
- Task detail panel: selecting a node opens the task's resources (start, end,
  duration, instance type), a failure banner with an error excerpt from the
  task log (`getErrorExcerpt`) when one is available, the task's log tail,
  and its measured utilization in a collapsed section.
- Resource summary: peak concurrent tasks and vCPUs, CPU-hours, and peak
  memory. Metrics whose inputs are absent show "unavailable". The memory
  metric carries an "unconfirmed units" note in the UI.
- Utilization metrics panel (`getRunMetrics`): measured CPU and memory per
  task from CloudWatch, labeled "Measured", with network, filesystem,
  scratch, and GPU charts in a secondary section when the data exists. It
  needs the run-metrics permission described in the
  [README](../README.md#enable-run-metrics).
- Cost estimate panel (`getRunCostEstimate`): a list-price estimate of the
  run's HealthOmics cost by usage type, quantity, and rate, labeled
  "Estimate". It excludes credits and discounts and usually differs from the
  bill. Line items that can't be computed show `—`, never zero.
- Longest-running tasks: the top tasks by wall-clock duration. This is an
  approximation labeled as such, not a dependency-graph critical path.
- Task timeline: a collapsible per-task queue-wait versus run-time breakdown.
  Queue-wait is shown with an "unconfirmed `createdAt`" caveat.
- Failed-task filter: a toggle and count badge to show only `FAILED` and
  `CANCELLED` tasks.
- Inputs and outputs: the run's parameters as a table (S3 values link to the
  console, and folder locations keep a trailing slash), plus a run
  configuration table with storage, run cache, networking (VPC and
  configuration name), and log level from `GetRun`. The IAM run role ARN is
  not shown or exposed through GraphQL. An engine-version badge appears in
  the header.
- Logs: read-only CloudWatch logs for a selected task or for the run and
  engine streams, with an in-panel search and a Download button that saves
  exactly the loaded lines as a `.log` file.
- Copy controls beside task IDs, workflow IDs, S3 URIs (the raw `s3://` URI
  alongside its console link), and ARNs.

## Reports view

The Reports view (the "Reports" button in the top navigation) shows aggregate
performance across many runs of the same workflow and version over a time
window.

- Grouping: by workflow name and version. A run with no version name is
  grouped as "(unversioned)". The `workflowId` is tracked, so when one name
  and version maps to more than one workflow, the report flags a collision
  instead of blending unrelated workflows.
- Time window: a date-range picker, defaulting to the last 30 days.
- Statistics: mean, median, and p90 for wall-clock duration, mean and peak
  CPU, mean and peak memory (GiB), CPU-hours, peak concurrent tasks, tasks per
  run, and failed tasks per run, in summary cards and a table. Cost is not
  part of the Reports view (the per-run cost estimate is in the run detail
  view).
- Charts: a duration histogram and a "Runs over time (per bin)" chart, both
  computed on the server with a fixed number of buckets.
- Browse runs by duration bucket: a collapsed section with one control per
  non-empty bucket. Clicking a bucket lists its runs, and each run opens in a
  new tab through its deep link. The per-bucket lists are paged over the full
  window, so outliers are not hidden.
- Availability: each statistic is computed only over runs where that metric
  exists, shown with an "N of M runs" denominator. An unavailable metric is
  never counted as zero. Utilization exists only for runs whose IAM run role
  had `cloudwatch:PutMetricData` when the run started (see
  [Enable run metrics](../README.md#enable-run-metrics)).
- Data source: the pipeline writes a per-run rollup (`Run_Summary`) when a run
  reaches a terminal status, so reports are indexed reads (`GSI2`) rather than
  live CloudWatch queries. Existing finished runs can be filled in with
  [`backfill-run-summaries.mjs`](../scripts/README.md#backfill-run-summariesmjs--one-time-run_summary-backfill-workflow-performance-reports-req-9).
- Downloads: CSV (per-run and aggregate data) and print-to-PDF. Unavailable
  metrics stay blank, never zero, and memory stays in GiB.
