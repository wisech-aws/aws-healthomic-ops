# Requirements Document

## Introduction

This feature surfaces AWS HealthOmics **near-real-time resource-utilization metrics** on the dashboard's Run Detail page so operators can see **ACTUAL measured per-task utilization against reserved limits** — CPU, memory, network, filesystem, scratch, and GPU — instead of relying solely on the existing **derived** resource summary (which is computed from reservations plus timing and carries "unavailable" / "unconfirmed units" caveats). The goal is to help operators spot CPU/memory bottlenecks, memory pressure, scratch exhaustion, and right-size compute for future runs.

HealthOmics publishes these figures as **CloudWatch OpenTelemetry (OTel) metrics** under the `cloudwatch.aws/omics` scope. They are read via **PromQL over CloudWatch's Prometheus-compatible HTTP API**, which is a **SigV4-signed HTTP request** the browser cannot make directly. The read path therefore lives **server-side**, mirroring the dashboard's existing Lambda-backed AppSync query pattern (`getRunLogs`): an AppSync query → a Lambda that issues the signed PromQL query → a typed result returned to the frontend.

The single most important behavioral theme of this feature is **honesty about availability**. Utilization metrics exist only under specific conditions (the run's service role must have held `cloudwatch:PutMetricData` at run start; a task must have been RUNNING for at least one 30-second interval; some series are delayed or absent). The dashboard **MUST NOT fabricate values**. When metrics do not exist for a run or task, the interface must show an explicit "metrics unavailable" state and must not blank out or degrade the existing derived summary for older or finished runs. A core requirements decision below is whether the measured view **augments** or **replaces** the derived summary, and how each value is labeled as **measured** vs **derived**.

### Grounding facts (verified against live run 9955450; treated as constraints, not assumptions)

- Metrics are OTel metrics under the `cloudwatch.aws/omics` scope, **not** the classic CloudWatch `GetMetricData` SDK and **not** a standard metric namespace. The installed AWS SDK/botocore has no PromQL/QueryMetrics operation.
- The read path is a **SigV4-signed HTTP POST** (signing service name `monitoring`) to `https://monitoring.<region>.amazonaws.com/api/v1/query` (instant) or `/api/v1/query_range` (time series).
- PromQL selector syntax: dotted metric names MUST be referenced via `__name__`, e.g. `{__name__="aws.omics.task.cpu.usage", "@resource.aws.omics.run.id"="<runId>"}`. A bare `aws.omics.task.cpu.usage` fails to parse.
- `query_range` requires **RFC3339 timestamps** for `start`/`end` and a **numeric-seconds `step`** (e.g. `"30"`, not `"30s"`); it returns `resultType: matrix` time series.
- Data points carry resource labels including `@resource.aws.omics.run.id`, `@resource.aws.omics.task.id` (task metrics), `@resource.aws.omics.workflow.id`, `@resource.aws.omics.storage.type`, and `__unit__`, enabling a JOIN of metrics to per-task DAG nodes by task id.
- Live-verified: on run 9955450, `aws.omics.task.memory.usage` returned ~757,760 bytes actual vs `aws.omics.task.memory.limit` = 6,442,450,944 bytes (6 GiB reserved) per task; `aws.omics.task.cpu.usage` returned per-task vCPU gauges. Actual-vs-limit utilization is therefore directly available.

### Available metrics (AWS docs: https://docs.aws.amazon.com/omics/latest/dev/monitoring-run-metrics.html)

Emitted per task every 30 seconds while a task is RUNNING unless noted:

- **CPU**: `aws.omics.task.cpu.usage` / `aws.omics.task.cpu.limit` (unit `{cpu}`, gauge)
- **Memory**: `aws.omics.task.memory.usage` / `aws.omics.task.memory.limit` (bytes, gauge)
- **Network**: `aws.omics.task.network.io` (bytes, sum; split by `network.io.direction` = receive/transmit)
- **Filesystem**: `aws.omics.task.filesystem.io` (bytes, sum; `filesystem.io.direction` = read/write); `aws.omics.task.filesystem.operations` (ops, sum; same direction split)
- **Scratch**: `aws.omics.task.filesystem.scratch.storage.usage` / `.limit` (bytes; `scratch.storage.mode` = LOCAL/SHARED; SHARED usage may be delayed/absent)
- **GPU** (accelerator tasks only): `aws.omics.task.gpu.utilization` (%); `aws.omics.task.gpu.memory.usage` / `.limit` (bytes); one series per `gpu.id`
- **Run-level shared filesystem**: `aws.omics.run.filesystem.usage` (bytes, every run) / `aws.omics.run.filesystem.limit` (bytes, STATIC storage only)

### Availability preconditions (drive the honesty requirements)

- Metrics exist only if the run's service role held `cloudwatch:PutMetricData` at run start. The role `OmicsWorkflow-20260224075057` gained this permission recently, so only runs started **after** that emit metrics; runs started before it have **no metrics, ever**.
- Metrics exist only while a task is RUNNING; the first point appears ~30 seconds in. Tasks that ran under 30 seconds may emit nothing.
- DYNAMIC-storage `aws.omics.run.filesystem.usage` may be delayed by more than 30 minutes.
- `aws.omics.run.filesystem.limit` exists only for STATIC storage runs.

### Prioritization for v1 (drives requirement ordering, not scope removal)

- **Core:** per-task CPU actual-vs-limit and per-task memory actual-vs-limit.
- **Secondary:** network, filesystem, scratch, GPU, and the run-level filesystem.
- GPU appears only for accelerator tasks (fetchngs/rnaseq are non-GPU) and must degrade gracefully.

### Implementation context for later phases (not requirements)

- Language/stack is TypeScript. The metrics read path mirrors the existing `getRunLogs` Lambda-backed AppSync query pattern (`infra/lib/api-stack.ts`, the logs Lambda, `frontend/src/rundetail/LogsPanel.tsx`).
- Run Detail page `frontend/src/rundetail/RunDetailView.tsx` already renders a derived `ResourceSummaryCard` (from `frontend/src/metrics/resourceSummary.ts`) and per-task DAG nodes keyed by task id.
- GraphQL schema `infra/graphql/schema.graphql`; Cognito user-pool auth on interactive queries.
- Live TEST environment is account `123456789012` / `us-east-1`; deploys are billable. This requirements phase involves no deploys and no code.
- **Open item for design (do not guess in requirements):** the exact IAM action the metrics Lambda needs to issue a PromQL query against CloudWatch's Prometheus-compatible API (likely a CloudWatch/`aps`-style PromQL query action) is to be confirmed during design.
- This spec must not collide with existing specs `healthomics-workflow-dashboard`, `dashboard-quality-of-life`, or `static-dag-from-definition`.

## Glossary

- **Dashboard**: The AWS HealthOmics visualizer web application (frontend plus its AppSync/Lambda backend).
- **Run_Detail_View**: The frontend run detail component (`RunDetailView.tsx`) that renders per-task DAG nodes and the derived resource summary.
- **Utilization_Metrics**: The set of AWS HealthOmics CloudWatch OTel resource-utilization metrics under the `cloudwatch.aws/omics` scope (CPU, memory, network, filesystem, scratch, GPU, and run-level filesystem).
- **Measured_Metric**: A Utilization_Metric value obtained by querying CloudWatch (an actual observed measurement), as opposed to a Derived_Metric.
- **Derived_Metric**: A value in the existing resource summary computed from task reservations plus timing (`frontend/src/metrics/resourceSummary.ts`), not an actual measurement.
- **Derived_Resource_Summary**: The existing `ResourceSummaryCard` on the Run_Detail_View that presents Derived_Metrics.
- **Metrics_Query**: The new AppSync GraphQL query the Run_Detail_View calls to retrieve Measured_Metrics for a run and/or task.
- **Metrics_Lambda**: The backend Lambda, fronted by AppSync, that issues the SigV4-signed PromQL request to CloudWatch and returns typed Measured_Metrics.
- **PromQL_Query**: A Prometheus query issued by the Metrics_Lambda against CloudWatch's Prometheus-compatible HTTP API using `__name__` selectors and `@resource.*` label matchers.
- **Instant_Query**: A PromQL_Query against the `/api/v1/query` endpoint returning the latest value(s).
- **Range_Query**: A PromQL_Query against the `/api/v1/query_range` endpoint returning `matrix` time series over a start/end window at a numeric-seconds step.
- **Time_Series**: An ordered sequence of timestamped Measured_Metric points for one series (e.g. one task's memory usage over the run window).
- **Run_Id**: The HealthOmics run identifier, matched via the `@resource.aws.omics.run.id` label.
- **Task_Id**: The HealthOmics task identifier, matched via the `@resource.aws.omics.task.id` label; the JOIN key between Measured_Metrics and per-task DAG nodes.
- **Reserved_Limit**: A metric's `.limit` series (e.g. `aws.omics.task.memory.limit`), representing the reserved allocation for a task.
- **Actual_Usage**: A metric's `.usage` or `.io`/`.operations`/`.utilization` series, representing the measured consumption for a task.
- **Metrics_Unavailable_State**: An explicit interface state indicating that no Measured_Metrics exist for the requested run or task, shown instead of any fabricated value.
- **Metrics_Precondition**: The set of conditions required for Measured_Metrics to exist for a run — the service role held `cloudwatch:PutMetricData` at run start, and at least one task was RUNNING for at least one emission interval.
- **Live_Run**: A run whose status indicates it is still executing, for which new Measured_Metrics may continue to appear.
- **Historical_Run**: A completed run whose Measured_Metrics, if any, are read from CloudWatch's retained history.
- **Metrics_Retention_Window**: CloudWatch's 15-month retention window for the stored Utilization_Metrics.

## Requirements

### Requirement 1: Server-side signed metrics read path

**User Story:** As a Dashboard operator, I want the Dashboard to read HealthOmics utilization metrics through a backend query, so that measured utilization can be shown even though the browser cannot sign requests to CloudWatch.

#### Acceptance Criteria

1. THE Dashboard SHALL expose a Metrics_Query on the AppSync GraphQL schema that the Run_Detail_View calls to retrieve Measured_Metrics for a given Run_Id.
2. WHEN the Metrics_Query is invoked, THE Metrics_Lambda SHALL issue the PromQL_Query to CloudWatch's Prometheus-compatible HTTP API using a SigV4-signed HTTP request with signing service name `monitoring`.
3. THE Metrics_Lambda SHALL reference each dotted metric name in a PromQL_Query through a `__name__` selector rather than as a bare identifier.
4. WHEN the Metrics_Lambda issues a Range_Query, THE Metrics_Lambda SHALL send RFC3339 timestamps for the `start` and `end` parameters and a numeric-seconds value for the `step` parameter.
5. THE Metrics_Query SHALL be authorized for the Cognito user pool consistent with the Dashboard's other interactive queries.
6. THE Dashboard SHALL NOT issue the SigV4-signed CloudWatch request from the browser.

### Requirement 2: Per-task CPU actual-vs-limit (core)

**User Story:** As an operator diagnosing compute bottlenecks, I want to see each task's actual CPU usage against its reserved CPU limit, so that I can identify CPU-bound tasks and right-size CPU reservations.

#### Acceptance Criteria

1. WHEN the Run_Detail_View requests metrics for a run that has Measured_Metrics, THE Metrics_Lambda SHALL query `aws.omics.task.cpu.usage` and `aws.omics.task.cpu.limit` for that Run_Id.
2. WHEN CPU Measured_Metrics are returned, THE Metrics_Lambda SHALL associate each series with its Task_Id via the `@resource.aws.omics.task.id` label.
3. WHEN CPU Measured_Metrics exist for a task, THE Run_Detail_View SHALL present that task's Actual_Usage together with its Reserved_Limit as a Time_Series.
4. WHEN both CPU Actual_Usage and CPU Reserved_Limit exist for a task, THE Run_Detail_View SHALL present the Actual_Usage relative to the Reserved_Limit for that task.
5. IF a task has no CPU Measured_Metrics, THEN THE Run_Detail_View SHALL show the Metrics_Unavailable_State for that task's CPU view rather than a fabricated value.

### Requirement 3: Per-task memory actual-vs-limit (core)

**User Story:** As an operator diagnosing memory pressure, I want to see each task's actual memory usage against its reserved memory limit, so that I can detect memory pressure and right-size memory reservations.

#### Acceptance Criteria

1. WHEN the Run_Detail_View requests metrics for a run that has Measured_Metrics, THE Metrics_Lambda SHALL query `aws.omics.task.memory.usage` and `aws.omics.task.memory.limit` for that Run_Id.
2. WHEN memory Measured_Metrics are returned, THE Metrics_Lambda SHALL associate each series with its Task_Id via the `@resource.aws.omics.task.id` label and report the unit from the `__unit__` label as bytes.
3. WHEN memory Measured_Metrics exist for a task, THE Run_Detail_View SHALL present that task's Actual_Usage together with its Reserved_Limit as a Time_Series in bytes.
4. WHEN both memory Actual_Usage and memory Reserved_Limit exist for a task, THE Run_Detail_View SHALL present the Actual_Usage relative to the Reserved_Limit for that task.
5. IF a task has no memory Measured_Metrics, THEN THE Run_Detail_View SHALL show the Metrics_Unavailable_State for that task's memory view rather than a fabricated value.

### Requirement 4: Honest handling of unavailable metrics (critical, non-fabrication)

**User Story:** As an operator, I want the Dashboard to clearly tell me when measured utilization does not exist for a run or task, so that I never mistake an absent measurement for a real value.

#### Acceptance Criteria

1. IF a run has no Measured_Metrics for any of its tasks, THEN THE Run_Detail_View SHALL display the Metrics_Unavailable_State for that run's measured utilization.
2. THE Run_Detail_View SHALL NOT display a fabricated, zero-as-data, or placeholder numeric value in place of an absent Measured_Metric.
3. IF a run was started before its service role held `cloudwatch:PutMetricData`, THEN THE Run_Detail_View SHALL indicate that measured utilization is unavailable for that run.
4. IF a task ran for less than one emission interval and therefore emitted no points, THEN THE Run_Detail_View SHALL show the Metrics_Unavailable_State for that task rather than a fabricated value.
5. WHEN the Run_Detail_View displays the Metrics_Unavailable_State, THE Run_Detail_View SHALL communicate that measured utilization is unavailable and SHALL distinguish this state from a metrics-loading state and from a metrics-error state.

### Requirement 5: Augment, do not replace, the derived resource summary

**User Story:** As an operator viewing older or finished runs, I want the existing derived resource summary to remain intact when measured utilization is unavailable, so that removing the derived view does not leave those runs blank.

#### Acceptance Criteria

1. THE Run_Detail_View SHALL retain the Derived_Resource_Summary and SHALL present Measured_Metrics as an addition to, not a removal of, the Derived_Resource_Summary.
2. WHEN a run has no Measured_Metrics, THE Run_Detail_View SHALL continue to render the Derived_Resource_Summary for that run.
3. WHEN the Run_Detail_View presents a Measured_Metric, THE Run_Detail_View SHALL label the value as measured.
4. WHEN the Run_Detail_View presents a Derived_Metric, THE Run_Detail_View SHALL label the value as derived.
5. WHERE both a Measured_Metric and a corresponding Derived_Metric exist for the same run, THE Run_Detail_View SHALL make the measured and derived values visually distinguishable.

### Requirement 6: Join measured metrics to per-task DAG nodes

**User Story:** As an operator inspecting the run graph, I want each task's measured utilization tied to its DAG node, so that I can read a specific task's actual utilization in context.

#### Acceptance Criteria

1. WHEN Measured_Metrics carry a `@resource.aws.omics.task.id` label, THE Run_Detail_View SHALL associate each series with the per-task DAG node whose Task_Id matches that label.
2. WHERE a task's DAG node has associated Measured_Metrics, THE Run_Detail_View SHALL make that task's measured CPU and memory utilization available in the context of that task's DAG node.
3. IF a Measured_Metric series carries a Task_Id that matches no per-task DAG node, THEN THE Run_Detail_View SHALL omit that series from the per-node presentation without failing the overall metrics view.
4. IF a per-task DAG node has no matching Measured_Metric series, THEN THE Run_Detail_View SHALL show the Metrics_Unavailable_State for that node rather than a fabricated value.

### Requirement 7: Live and historical runs

**User Story:** As an operator, I want measured utilization to work for both currently running and completed runs, so that I can monitor a run in progress and review a finished run's utilization afterward.

#### Acceptance Criteria

1. WHILE a Live_Run is open in the Run_Detail_View and has Measured_Metrics, THE Run_Detail_View SHALL present its near-real-time measured utilization.
2. WHEN a Historical_Run is opened in the Run_Detail_View and has Measured_Metrics within the Metrics_Retention_Window, THE Run_Detail_View SHALL present its measured utilization as a historical Time_Series.
3. IF a Historical_Run's Measured_Metrics fall outside the Metrics_Retention_Window, THEN THE Run_Detail_View SHALL show the Metrics_Unavailable_State for that run.
4. THE Run_Detail_View SHALL retrieve Measured_Metrics on demand when a run is opened rather than by continuous background polling of all runs.

### Requirement 8: Bounded and cost-aware querying

**User Story:** As a Dashboard owner accountable for cost, I want metrics queries scoped and bounded, so that CloudWatch query costs stay proportional to what an operator is actually viewing.

#### Acceptance Criteria

1. WHEN the Metrics_Lambda issues a PromQL_Query, THE Metrics_Lambda SHALL scope the query to the single Run_Id being viewed via the `@resource.aws.omics.run.id` label.
2. WHEN the Metrics_Lambda issues a Range_Query, THE Metrics_Lambda SHALL bound the query to a time window derived from the run's execution window and SHALL use a step of at least the metric emission interval of 30 seconds.
3. THE Dashboard SHALL retrieve Measured_Metrics in response to an operator viewing a run rather than by aggressive continuous polling.
4. WHERE the Run_Detail_View refreshes measured utilization for a Live_Run, THE Run_Detail_View SHALL provide an on-demand or bounded-interval refresh rather than a high-frequency automatic poll.

### Requirement 9: Secondary metrics with graceful degradation

**User Story:** As an operator investigating I/O and scratch usage, I want network, filesystem, scratch, GPU, and run-level filesystem metrics when they exist, so that I can diagnose I/O and storage issues without those views breaking when a metric is absent.

#### Acceptance Criteria

1. WHERE network Measured_Metrics (`aws.omics.task.network.io`) exist for a task, THE Run_Detail_View SHALL present receive and transmit series distinguished by the `network.io.direction` label.
2. WHERE filesystem Measured_Metrics (`aws.omics.task.filesystem.io`, `aws.omics.task.filesystem.operations`) exist for a task, THE Run_Detail_View SHALL present read and write series distinguished by the `filesystem.io.direction` label.
3. WHERE scratch Measured_Metrics (`aws.omics.task.filesystem.scratch.storage.usage` and `.limit`) exist for a task, THE Run_Detail_View SHALL present scratch Actual_Usage against its Reserved_Limit distinguished by the `scratch.storage.mode` label.
4. IF SHARED scratch usage is delayed or absent, THEN THE Run_Detail_View SHALL show the Metrics_Unavailable_State for the scratch view rather than a fabricated value.
5. WHERE GPU Measured_Metrics (`aws.omics.task.gpu.utilization`, `aws.omics.task.gpu.memory.usage`, `aws.omics.task.gpu.memory.limit`) exist for an accelerator task, THE Run_Detail_View SHALL present one series per `gpu.id`.
6. IF a task is not an accelerator task and has no GPU Measured_Metrics, THEN THE Run_Detail_View SHALL omit the GPU view for that task without showing an error.
7. WHERE run-level filesystem Measured_Metrics (`aws.omics.run.filesystem.usage`) exist for a run, THE Run_Detail_View SHALL present the run's filesystem usage as a Time_Series.
8. IF a run uses DYNAMIC storage and its `aws.omics.run.filesystem.limit` series is absent, THEN THE Run_Detail_View SHALL present run filesystem usage without a limit reference rather than fabricating a limit.

### Requirement 10: Metrics loading and error handling

**User Story:** As an operator, I want the metrics view to handle slow or failed queries clearly, so that I can tell a genuine failure apart from unavailable metrics and can retry.

#### Acceptance Criteria

1. WHILE a Metrics_Query is in progress, THE Run_Detail_View SHALL show a loading state distinct from the Metrics_Unavailable_State.
2. IF the Metrics_Query fails, THEN THE Run_Detail_View SHALL show an error state distinct from the Metrics_Unavailable_State and SHALL provide a control to retry the query.
3. IF the Metrics_Lambda receives an error or non-success response from CloudWatch, THEN THE Metrics_Lambda SHALL return a typed error result identifying the failure rather than an empty successful result.
4. WHEN the Metrics_Lambda returns a successful result with no series, THE Run_Detail_View SHALL treat the result as the Metrics_Unavailable_State rather than as an error.
