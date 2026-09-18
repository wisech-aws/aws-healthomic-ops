# Requirements Document

## Introduction

This feature adds an **estimated per-run cost breakdown** to the dashboard's Run Detail page, plus two smaller related enhancements to the run detail experience. The estimate is styled after AWS Cost Explorer's "usage type + quantity + cost" table but is computed **from measured task data multiplied by the published AWS price list** — it is a **list-price estimate**, not the actual billed amount. It is computed immediately from data already flowing through the pipeline (plus one newly captured task field), with no dependence on Cost Explorer's 24–48-hour billing lag and no polling.

The three capabilities in this spec are:

1. **Estimated run cost (the main build).** A collapsible "Estimated cost" panel on the Run Detail page presenting a compute + storage cost breakdown per run: usage type, resource (instance) type, quantity (instance-hours or GB-hours), published rate, and estimated cost, with a total, currency, and the rate card's effective date. The compute estimate is `Σ per-instance-type (instance-hours) × published On-Demand rate`; the storage estimate prices run storage GB-hours by storage family. The panel is clearly labeled as an **estimate** based on measured task runtime at list price, excluding credits, discounts, and provisioning/rounding overhead — and therefore expected to differ from (typically run under) the eventual actual bill.

2. **Resource type on task selection (small).** When an operator selects a task (clicking its DAG node already opens a per-task logs panel), the run detail view shows that task's resource/instance type alongside its already-available cpus/memory. This reuses the same `instanceType` capture that the cost estimate requires.

3. **Storage and network in the measured-usage section (mostly wiring).** The measured-metrics pipeline already implements the NETWORK, FILESYSTEM, SCRATCH, GPU, and RUN_FILESYSTEM metric families end to end, and `RunMetricsPanel.tsx` already renders secondary families behind an expandable section — but the Run Detail view only requests the CORE (CPU + MEMORY) families, so storage and network series are never fetched. This capability makes the storage and network measured details viewable in the measured-usage section with human-readable units, while keeping the default query cost bounded.

### Grounding facts (verified live against AWS during investigation; treated as constraints, not assumptions)

- **`instanceType` is available per task but not currently captured.** Every task's `GetRunTask` response includes an `instanceType` (e.g. `omics.m.large`). The ingest pipeline's task mapping (`ingest/src/enrichment/tasks.ts` `mapTaskFields`) maps only `cpus`, `memory`, timing, and status — it does **not** capture `instanceType`. Capturing it requires additions to task enrichment, the `TaskRecord`/repository persistence, the AppSync `Task` type + `TaskInput`, and the publisher mutation selection set.
- **Compute rates come from the AWS Price List API.** `pricing:GetProducts` with ServiceCode `AmazonOmics`, filtered by `regionCode` + `workflowType=Private`, returns exact per-instance-type On-Demand rates keyed by the `resourceType` attribute (= the omics instance type), unit `Instance-hrs`, in USD. 60 instance types are available for us-east-1. Verified example rates (us-east-1, Private): `omics.m.large` = $0.1296/hr, `omics.r.large` = $0.1701/hr, `omics.r.2xlarge` = $0.6804/hr.
- **Storage is also priced via the Price List API,** distinguished by `productFamily`, all unit **GB-Hours** (us-east-1 verified): "Dynamic Run Storage" = $0.000411/GB-hr, "Run Storage" (= STATIC) = $0.0001918/GB-hr, "Ephemeral Storage" = $0.000111/GB-hr. The run's `storageType` (DYNAMIC vs STATIC — already captured on `RunRecord`) selects the family.
- **Storage GB-hours source differs by storage type.** For STATIC storage, GB-hours = `storageCapacity` (GiB, already captured) × run wall-clock hours. For DYNAMIC storage, `GetRun` does **not** return a GB-hours figure; the measured metric family RUN_FILESYSTEM (`aws.omics.run.filesystem.usage`, already implemented in the metrics pipeline) is the run-level filesystem usage-over-time and is the honest source for a dynamic-storage GB-hours integral. Dynamic-storage GB-hours is therefore only estimable when that measured series is available; when it is not, the estimate must show an explicit "unavailable" state, never a fabricated 0.
- **End-to-end verified on real run 3388513:** compute estimate ≈ $0.0611 (`omics.m.large` 0.137 hr, `omics.r.large` 0.189 hr, `omics.r.2xlarge` 0.0165 hr). The estimate runs **lower** than the eventual actual bill because AWS bills provisioning/rounding overhead beyond raw task start→stop runtime (Cost Explorer showed 0.353 `m.large`-hrs vs 0.137 measured). The UI must clearly label this as a list-price estimate based on measured task runtime, excluding credits/discounts/overhead, that will differ from (typically under) the actual bill.
- **Rate cards are cached in DynamoDB, not fetched per request.** The region's rate card is fetched from the Price List API once and cached in the DynamoDB single table using the same keyed-item, lazily-refreshed pattern as the existing static-graph cache (`WF#...` item with `updatedAt`, best-effort refresh, no polling). A staleness threshold of ~7 days is proposed. No polling.
- **The Price List IAM grant follows the existing documented wildcard-resource exception.** The estimate's Lambda needs `pricing:GetProducts` + `pricing:DescribeServices` (read-only). The Price List API does not support resource-level scoping, so the resource is `*` — an intentional exception exactly like the existing CloudWatch metrics grant in `infra/lib/api-stack.ts` (`cloudwatch:GetMetricData`, `cloudwatch:ListMetrics` on `resources: ['*']`), which is documented as "a documented exception to the no-wildcard-resource pattern … but it is NOT a wildcard action".

### Always-on (no feature flag)

- The estimated-cost feature is **always on**: it uses only the public AWS Price_List_API and measured/captured run data, so it needs no per-customer toggle. A feature flag is reserved for a **possible future Actual_Cost capability** (Cost Explorer, which reads account-wide billing and may warrant opt-in), which is a documented non-goal for this spec. Capabilities 2 (resource type on task selection) and 3 (storage/network measured details) are likewise always available.

### Scope and non-goals

- **In scope:** the list-price ESTIMATE (compute + storage) computed from measured task data and the published price list; capturing `instanceType`; showing resource type on task selection; surfacing storage/network measured details.
- **Out of scope (documented non-goals):**
  - **Actual / Cost Explorer cost.** Actual billed cost (via Cost Explorer, with its 24–48-hour lag, and any cost-allocation-**tag**-key configuration for actual-cost attribution the user discussed previously) is explicitly **not** part of this spec. This spec is the estimate only. IF an Actual_Cost capability is implemented in the future, a customer-configurable feature flag (and any Cost Explorer / cost-allocation-tag IAM) would live with THAT capability — not with this always-on estimate.
  - **Reserved / spot / savings-plan / credit / discount pricing.** The estimate uses published On-Demand list prices only.
  - **HealthOmics workflow-execution cost forecasting** beyond a single already-executed (or executing) run's measured task data.

### Repo conventions honored by these requirements

- **Strict no-fabrication rule.** Every value shown is real / measured / priced, or explicitly "unavailable" / "—". No guessed or zero-filled numbers.
- **Least-privilege IAM.** No wildcard actions; a wildcard resource only where the AWS API cannot be scoped, documented as an exception.
- **Cognito-authorized interactive queries.** Any new interactive query follows the existing Cognito-user-pool auth pattern.
- **Verification bar.** Builds, lint, and tests must pass; the repo uses property and unit tests.

### Implementation context for later phases (not requirements)

- Language/stack is TypeScript across `ingest/`, `infra/` (CDK v2), and `frontend/` (React + Vite + Cloudscape).
- Task enrichment/persistence: `ingest/src/enrichment/tasks.ts`, `ingest/src/domain/records.ts`, `ingest/src/repository.ts`, `ingest/src/publisher.ts`.
- Rate-card cache pattern to mirror: the static-graph cache methods `getStaticGraph` / `putStaticGraph` in `ingest/src/repository.ts` and their keyed DynamoDB item.
- Schema `infra/graphql/schema.graphql`; the existing Lambda-backed AppSync query precedent is `getRunLogs` / `getRunMetrics`; the metrics Lambda is `ingest/src/metricsHandler.ts`.
- Run Detail view `frontend/src/rundetail/RunDetailView.tsx` (opens the per-task logs panel on DAG-node click, calls `getRunMetrics` with default CORE families); measured-metrics rendering `frontend/src/rundetail/RunMetricsPanel.tsx` (already renders secondary families behind an `ExpandableSection`); metric registry `ingest/src/metrics/registry.ts`.
- This spec must not collide with existing specs (`healthomics-workflow-dashboard`, `run-utilization-metrics`, `dashboard-quality-of-life`, `static-dag-from-definition`).

## Glossary

- **Dashboard**: The AWS HealthOmics visualizer web application (frontend plus its AppSync/Lambda backend).
- **Run_Detail_View**: The frontend run detail component (`RunDetailView.tsx`) that renders per-task DAG nodes, the derived resource summary, and the measured-utilization section.
- **Estimated_Cost**: A list-price cost figure computed from Measured_Task_Data multiplied by the Published_Rate, as distinct from Actual_Cost.
- **Actual_Cost**: The amount AWS actually bills for a run (e.g. via Cost Explorer), including credits, discounts, and provisioning/rounding overhead. Out of scope for this spec.
- **Estimated_Cost_Panel**: The collapsible panel on the Run_Detail_View that presents the Estimated_Cost breakdown for a run.
- **Cost_Line_Item**: One row of the Estimated_Cost breakdown: a usage type, an optional resource (instance) type, a Quantity, a Published_Rate, and an Estimated_Cost value.
- **Compute_Cost**: The portion of the Estimated_Cost attributable to task compute: for each Instance_Type, the sum of that type's Instance_Hours multiplied by its Published_Rate.
- **Storage_Cost**: The portion of the Estimated_Cost attributable to run storage: the run's Storage_GB_Hours multiplied by the Published_Rate for the run's Storage_Family.
- **Instance_Type**: The omics compute instance type for a task (HealthOmics `instanceType`, e.g. `omics.m.large`); the join key between Measured_Task_Data and the compute Published_Rate.
- **Instance_Hours**: A task's measured wall-clock runtime (start→stop) expressed in hours; summed per Instance_Type for the Compute_Cost.
- **Storage_Type**: The run's storage mode, DYNAMIC or STATIC (HealthOmics `storageType`, already captured on the run).
- **Storage_Family**: The Price_List_API storage product family selected by the Storage_Type — "Dynamic Run Storage" for DYNAMIC, "Run Storage" for STATIC.
- **Storage_GB_Hours**: Run storage usage expressed in GB-hours: for STATIC, `storageCapacity` × run wall-clock hours; for DYNAMIC, the integral of the RUN_FILESYSTEM measured usage series over the run window.
- **Measured_Task_Data**: The per-task facts already captured or capturable by the pipeline used as the estimate's basis — task timing (Instance_Hours) and Instance_Type.
- **Price_List_API**: The AWS Price List Query API (`pricing:GetProducts`, `pricing:DescribeServices`) for ServiceCode `AmazonOmics`.
- **Published_Rate**: An On-Demand list-price rate returned by the Price_List_API for a specific Instance_Type (unit Instance-hrs) or Storage_Family (unit GB-Hours), in a Currency.
- **Rate_Card**: The set of Published_Rates for a region (compute rates keyed by Instance_Type and storage rates keyed by Storage_Family) together with an Effective_Date.
- **Rate_Card_Cache**: The DynamoDB single-table item that stores a region's Rate_Card, keyed and lazily refreshed like the existing static-graph cache.
- **Staleness_Threshold**: The age beyond which a cached Rate_Card is considered stale and eligible for lazy refresh (proposed ~7 days).
- **Effective_Date**: The date the cached Rate_Card was retrieved from the Price_List_API, displayed with the Estimated_Cost.
- **Currency**: The currency of the Published_Rates and Estimated_Cost (USD for the verified region).
- **Cost_Estimation_Lambda**: The backend Lambda, fronted by AppSync, that reads/refreshes the Rate_Card_Cache, computes the Estimated_Cost from Measured_Task_Data, and returns the typed breakdown.
- **Cost_Query**: The AppSync GraphQL query the Run_Detail_View calls to retrieve the Estimated_Cost breakdown for a run.
- **Estimate_Unavailable_State**: An explicit interface (or result) state indicating that an Estimated_Cost or one of its components cannot be computed, shown instead of a fabricated value.
- **Estimate_Disclaimer**: The user-visible statement that the Estimated_Cost is a list-price estimate based on measured task runtime, excludes credits/discounts/overhead, and will differ from (typically be lower than) the Actual_Cost.
- **Measured_Usage_Section**: The existing "Measured utilization" section of the Run_Detail_View (rendered via `RunMetricsPanel.tsx`) that presents measured metric series.
- **Storage_Network_Families**: The measured metric families for storage and network — FILESYSTEM, SCRATCH, RUN_FILESYSTEM (storage) and NETWORK (network) — already implemented in the metrics pipeline.

## Requirements

### Requirement 1: Capture task instance type

**User Story:** As a Dashboard operator, I want each task's compute instance type captured through the pipeline, so that the estimated cost can be priced per instance type and the selected task can show its resource type.

#### Acceptance Criteria

1. WHEN the ingest pipeline enriches a task via `GetRunTask`, THE Dashboard SHALL capture the task's Instance_Type from the `GetRunTask` response.
2. WHEN a task's Instance_Type is captured, THE Dashboard SHALL persist the Instance_Type on that task's stored record in the DynamoDB single table.
3. THE Dashboard SHALL expose the Instance_Type on the AppSync `Task` type so that interactive queries can read it.
4. IF a task's `GetRunTask` response does not include an Instance_Type, THEN THE Dashboard SHALL leave the Instance_Type unset for that task rather than storing a fabricated value.
5. WHEN the ingest pipeline publishes a task update, THE Dashboard SHALL include the Instance_Type in the published task fields WHERE the Instance_Type is present.

### Requirement 2: Estimated compute cost from measured task runtime

**User Story:** As an operator accountable for cost, I want an estimated compute cost per run computed from each task's measured runtime and instance type at published list prices, so that I can see an immediate per-run cost estimate without waiting for the actual bill.

#### Acceptance Criteria

1. WHEN the Cost_Query is invoked for a run, THE Cost_Estimation_Lambda SHALL compute Instance_Hours for each task as that task's measured wall-clock runtime from its start time to its stop time.
2. WHEN computing the Compute_Cost, THE Cost_Estimation_Lambda SHALL group Instance_Hours by Instance_Type and SHALL multiply each Instance_Type's summed Instance_Hours by that Instance_Type's Published_Rate.
3. WHEN the Compute_Cost is returned, THE Cost_Estimation_Lambda SHALL provide, per Instance_Type, a Cost_Line_Item containing the Instance_Type, the summed Instance_Hours as the Quantity, the Published_Rate, and the Estimated_Cost.
4. IF a task has no Instance_Type, THEN THE Cost_Estimation_Lambda SHALL show the Estimate_Unavailable_State for that task's compute contribution rather than pricing it against a fabricated Instance_Type.
5. IF a task has no measured start-to-stop runtime, THEN THE Cost_Estimation_Lambda SHALL exclude that task from the Instance_Hours total and SHALL indicate the excluded contribution rather than fabricating a runtime.
6. IF the Rate_Card contains no Published_Rate for a task's Instance_Type, THEN THE Cost_Estimation_Lambda SHALL show the Estimate_Unavailable_State for that Instance_Type's Cost_Line_Item rather than fabricating a rate.

### Requirement 3: Estimated storage cost from measured usage

**User Story:** As an operator accountable for cost, I want an estimated run-storage cost priced by storage type, so that the estimate reflects storage as well as compute.

#### Acceptance Criteria

1. WHEN the Cost_Query is invoked for a run, THE Cost_Estimation_Lambda SHALL select the Storage_Family from the run's Storage_Type, using "Run Storage" for STATIC and "Dynamic Run Storage" for DYNAMIC.
2. WHERE a run uses STATIC storage, THE Cost_Estimation_Lambda SHALL compute Storage_GB_Hours as the run's `storageCapacity` in GiB multiplied by the run's wall-clock hours.
3. WHERE a run uses DYNAMIC storage AND the RUN_FILESYSTEM measured usage series is available, THE Cost_Estimation_Lambda SHALL compute Storage_GB_Hours as the integral of that measured usage series over the run window.
4. IF a run uses DYNAMIC storage AND the RUN_FILESYSTEM measured usage series is not available, THEN THE Cost_Estimation_Lambda SHALL show the Estimate_Unavailable_State for the Storage_Cost rather than computing a fabricated or zero Storage_GB_Hours.
5. WHEN the Storage_Cost is computed, THE Cost_Estimation_Lambda SHALL multiply the Storage_GB_Hours by the Published_Rate for the run's Storage_Family and SHALL provide a Cost_Line_Item containing the Storage_Family, the Storage_GB_Hours as the Quantity, the Published_Rate, and the Estimated_Cost.
6. IF the Rate_Card contains no Published_Rate for the run's Storage_Family, THEN THE Cost_Estimation_Lambda SHALL show the Estimate_Unavailable_State for the Storage_Cost rather than fabricating a rate.

### Requirement 4: Rate card retrieval and caching

**User Story:** As a Dashboard owner accountable for cost and reliability, I want published rates fetched once and cached rather than fetched on every request, so that the estimate is cheap to serve and resilient to Price List API hiccups.

#### Acceptance Criteria

1. WHEN the Cost_Estimation_Lambda needs a Rate_Card for a region AND a non-stale Rate_Card_Cache item exists for that region, THE Cost_Estimation_Lambda SHALL reuse the cached Rate_Card without calling the Price_List_API.
2. WHEN the Cost_Estimation_Lambda needs a Rate_Card for a region AND no Rate_Card_Cache item exists for that region, THE Cost_Estimation_Lambda SHALL fetch the Rate_Card from the Price_List_API for that region's `AmazonOmics` products filtered to `workflowType=Private` and SHALL store it in the Rate_Card_Cache with its Effective_Date.
3. WHILE a cached Rate_Card is older than the Staleness_Threshold, THE Cost_Estimation_Lambda SHALL lazily refresh the Rate_Card from the Price_List_API on the next request rather than polling on a schedule.
4. IF the Price_List_API is unavailable AND a cached Rate_Card exists, THEN THE Cost_Estimation_Lambda SHALL serve the cached Rate_Card rather than failing the estimate.
5. IF the Price_List_API is unavailable AND no cached Rate_Card exists, THEN THE Cost_Estimation_Lambda SHALL return the Estimate_Unavailable_State rather than fabricating rates.
6. WHEN the Cost_Estimation_Lambda stores a Rate_Card, THE Cost_Estimation_Lambda SHALL key the Rate_Card_Cache item so that distinct regions never share a cache entry.

### Requirement 5: Estimated cost query and presentation

**User Story:** As an operator, I want an estimated-cost breakdown on the run detail page styled like a usage-type/quantity/cost table, so that I can read the per-run cost estimate at a glance.

#### Acceptance Criteria

1. THE Dashboard SHALL expose a Cost_Query on the AppSync GraphQL schema, authorized for the Cognito user pool consistent with the Dashboard's other interactive queries, that the Run_Detail_View calls to retrieve the Estimated_Cost breakdown for a given run.
2. WHEN the Estimated_Cost breakdown is available for a run, THE Run_Detail_View SHALL present the Estimated_Cost_Panel as a collapsible panel showing the Cost_Line_Items with columns for usage type, resource (instance) type, Quantity, Published_Rate, and Estimated_Cost.
3. WHEN the Estimated_Cost_Panel is shown, THE Run_Detail_View SHALL display the total Estimated_Cost, the Currency, and the Rate_Card's Effective_Date.
4. WHEN the Estimated_Cost_Panel is shown, THE Run_Detail_View SHALL display the Estimate_Disclaimer stating that the value is a list-price estimate based on measured task runtime, excludes credits, discounts, and overhead, and will differ from (typically be lower than) the Actual_Cost.
5. WHEN the Run_Detail_View presents the Estimated_Cost, THE Run_Detail_View SHALL badge it as an estimate and SHALL make it visually distinct from any measured or actual value.
6. WHILE the Cost_Query is in progress, THE Run_Detail_View SHALL show a loading state distinct from the Estimate_Unavailable_State.
7. IF the Cost_Query fails, THEN THE Run_Detail_View SHALL show an error state distinct from the Estimate_Unavailable_State and SHALL provide a control to retry the query.

### Requirement 6: Honest handling of unavailable estimates (critical, non-fabrication)

**User Story:** As an operator, I want the Dashboard to clearly tell me when a cost component cannot be estimated, so that I never mistake an absent estimate for a real cost of zero.

#### Acceptance Criteria

1. THE Run_Detail_View SHALL NOT display a fabricated, zero-as-data, or placeholder numeric value in place of an Estimated_Cost, Quantity, or Published_Rate that cannot be computed.
2. WHEN a Cost_Line_Item cannot be computed, THE Run_Detail_View SHALL show the Estimate_Unavailable_State for that Cost_Line_Item while still presenting the Cost_Line_Items that can be computed.
3. WHEN one or more Cost_Line_Items are in the Estimate_Unavailable_State, THE Run_Detail_View SHALL indicate that the displayed total Estimated_Cost is partial rather than presenting it as complete.
4. IF no Cost_Line_Item can be computed for a run, THEN THE Run_Detail_View SHALL show the Estimate_Unavailable_State for the whole Estimated_Cost_Panel rather than an empty or zero breakdown.
5. WHEN the Run_Detail_View displays the Estimate_Unavailable_State, THE Run_Detail_View SHALL distinguish it from a loading state and from an error state.

### Requirement 7: Least-privilege Price List access

**User Story:** As a security-conscious Dashboard owner, I want the estimate to use only read-only pricing permissions, so that access stays least-privilege.

#### Acceptance Criteria

1. THE Dashboard SHALL grant the Cost_Estimation_Lambda only the read-only `pricing:GetProducts` and `pricing:DescribeServices` actions for Price_List_API access.
2. THE Dashboard SHALL NOT grant any wildcard IAM action for Price_List_API access.
3. WHERE the Price_List_API does not support resource-level scoping, THE Dashboard SHALL scope the Price List permissions with a wildcard resource as a documented exception, consistent with the Dashboard's existing CloudWatch metrics grant.

### Requirement 8: Resource type on task selection

**User Story:** As an operator inspecting a task, I want to see the task's resource (instance) type when I select it, so that I can understand what compute the task ran on alongside its cpus and memory.

#### Acceptance Criteria

1. WHEN a task is selected in the Run_Detail_View AND that task has a captured Instance_Type, THE Run_Detail_View SHALL display the task's Instance_Type alongside its cpus and memory.
2. IF a selected task has no captured Instance_Type, THEN THE Run_Detail_View SHALL show an explicit unavailable affordance for the resource type rather than a fabricated value.

### Requirement 9: Storage and network measured details in the measured-usage section

**User Story:** As an operator investigating I/O and storage, I want the storage and network measured metrics viewable in the measured-usage section, so that I can diagnose storage and network behavior without those series being silently omitted.

#### Acceptance Criteria

1. WHEN the Run_Detail_View requests measured metrics for a run, THE Run_Detail_View SHALL make the Storage_Network_Families (FILESYSTEM, SCRATCH, RUN_FILESYSTEM, NETWORK) retrievable in addition to the CORE (CPU + MEMORY) families.
2. WHERE storage or network measured series exist for a run or task, THE Measured_Usage_Section SHALL present those series in human-readable units, converting byte quantities to KiB/MiB/GiB as appropriate, showing operation counts as counts, and distinguishing network direction as receive/transmit.
3. WHERE the Run_Detail_View retrieves measured metrics by default, THE Run_Detail_View SHALL keep the default query cost bounded, consistent with the Dashboard's existing bound-cost-by-default principle for metrics.
4. IF storage or network measured series do not exist for a run or task, THEN THE Measured_Usage_Section SHALL omit those series without showing an error and without fabricating a value.
