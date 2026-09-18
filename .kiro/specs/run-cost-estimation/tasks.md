# Implementation Plan: Run Cost Estimation

## Overview

This plan implements an estimated per-run cost breakdown on the Run Detail page — a list-price
ESTIMATE (measured task runtime × the published AWS price list), not the actual billed amount —
plus two related enhancements: showing a selected task's resource (instance) type, and always
fetching the storage/network measured series into the measured-usage section. It reads on demand
from a new AppSync Lambda-backed query `getRunCostEstimate(runId)`, mirroring the existing
`getRunMetrics`/`getRunLogs` read path, and sources rates from the AWS Price List API cached
per region in the DynamoDB single table (same lazily-refreshed pattern as the static-graph
cache). The load-bearing theme is honesty about availability: every value is real/measured/priced
or explicitly unavailable ("—"), never fabricated or zero-filled.

Tasks are ordered by the design's dependency structure so each step builds on prior ones with no
orphaned code. The new `instanceType` field is threaded through the pipeline first, then backend
pure helpers (Price List parser, rate-card cache/service, cost math, filesystem usage source),
then the CostHandler that wires them, then the GraphQL surface, then CDK wiring + IAM, then the
frontend types/client, the pure presentation helper, the RunCostPanel UI, and finally the
RunDetailView wiring (cost panel, task resource type, full metric family set). Each implementation
task pairs with the unit/property tests named in the design's Testing Strategy. The design defines
exactly 13 correctness properties; each is implemented by exactly one property test at ≥100
iterations, tagged `Feature: run-cost-estimation, Property {n}`.

## Tasks

- [x] 1. Capture task `instanceType` through the pipeline
  - [x] 1.1 Capture `instanceType` in task enrichment
    - In `ingest/src/enrichment/tasks.ts`, extend the `EnrichableTask` `Pick<...>` with
      `'instanceType'` and add, inside the `mapTaskFields` "CONFIRM AGAINST AWS DOCS" block
      alongside the existing `cpus`/`memory` mapping, a guarded copy that persists the value only
      for a non-empty string, leaving it unset otherwise
    - _Requirements: 1.1, 1.4_

  - [x] 1.2 Persist `instanceType` on the task record and item
    - In `ingest/src/domain/records.ts`, add `instanceType?: string` to `TaskRecord`; in
      `ingest/src/repository.ts`, add `instanceType?: string` to `TaskItem` and a
      `setIfDefined(item, 'instanceType', task.instanceType)` in `buildTaskItem` (absent → omitted,
      never stored as `undefined`)
    - _Requirements: 1.2_

  - [x] 1.3 Publish `instanceType` in task updates
    - In `ingest/src/publisher.ts`, add `instanceType?: string` to `TaskInput`, a `setIfDefined`
      in `toTaskInput`, and `instanceType` to the `TASK_MUTATION` response selection set so it fans
      out to `onTaskUpdated` subscribers
    - _Requirements: 1.5_

  - [ ]* 1.4 Write unit tests for `instanceType` capture
    - `mapTaskFields` captures `instanceType` when present and leaves it unset when absent/empty
      (`tasks.test.ts`); `buildTaskItem` includes it only when present (`repository.test.ts`);
      `toTaskInput` includes it only when present and `TASK_MUTATION` carries it (`publisher.test.ts`)
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

- [x] 2. Price List client and pure parser
  - [x] 2.1 Implement `parsePriceListItem` and `fetchRateMap`
    - Create `ingest/src/cost/priceList.ts` with the pure `parsePriceListItem(raw)` — an isolated
      "CONFIRM AGAINST AWS DOCS" parser: `JSON.parse(raw)`, keep only `product.productFamily === "Compute"`
      where `product.attributes.resourceType` is an omics instance type (unit `Instance-hrs`) OR exactly
      `"Dynamic Run Storage"` / `"Run Storage"` (unit `GB-Hours`); read the rate at
      `terms.OnDemand.<firstTermKey>.priceDimensions.<firstDimKey>.{ unit, pricePerUnit.USD }`; skip
      `"Ephemeral Storage"`, sequence/annotation/variant-store, and Ready2Run products; return `null`
      when any needed field is absent (never fabricate)
    - Implement `fetchRateMap(region)` paginating `GetProductsCommand({ ServiceCode: 'AmazonOmics',
      Filters: [{ TERM_MATCH regionCode = region }, { TERM_MATCH workflowType = 'Private' }] })` following
      `NextToken`, reducing parsed items into `{ rates, currency: 'USD' }`; a malformed item parses to
      `null` and is skipped, never zero-filled
    - _Requirements: 4.2_

  - [ ]* 2.2 Write unit tests for the Price List parser
    - Fixtures based on verified us-east-1 responses: a compute product (`omics.m.large`, `Instance-hrs`,
      `$0.1296`) and the two storage products (`"Dynamic Run Storage"` `$0.000411`,
      `"Run Storage"` `$0.0001918`, `GB-Hours`); assert the parsed `resourceType`→rate map; assert
      `"Ephemeral Storage"`, stores, and Ready2Run products are skipped; assert a malformed item parses
      to `null` (never fabricated)
    - In `ingest/src/cost/priceList.test.ts`
    - _Requirements: 4.2, 6.1_

- [x] 3. Rate-card cache in the repository
  - [x] 3.1 Add the region-keyed rate-card cache methods
    - In `ingest/src/repository.ts`, add the `RateCardItem` shape (`PK = SK = RATECARD#<region>`,
      `region`, `rates: Record<string, { pricePerUnit; unit }>`, `currency`, `effectiveDate`,
      `updatedAt`, `entityType: 'RATECARD'`, optional `failureReason`) and the `rateCardPk(region)` /
      `rateCardSk(region)` key helpers (both `RATECARD#${region}`), then `getRateCard(region)` (GetItem →
      item or `null`), `putRateCard(region, rates, currency, effectiveDate)` (unconditional `PutCommand`),
      and `recordRateCardFailure(region, reason)` (`UpdateCommand` that sets only `failureReason`/`updatedAt`
      without clobbering existing `rates`) — mirroring `getStaticGraph`/`putStaticGraph`/`recordGraphFailure`
    - _Requirements: 4.1, 4.6_

  - [ ]* 3.2 Write property test for region-partitioned rate-card keys
    - **Feature: run-cost-estimation, Property 10** — for all distinct regions `r1 != r2`,
      `rateCardPk(r1) != rateCardPk(r2)`, each key is exactly `RATECARD#<region>` with `PK === SK`, so
      distinct regions never share a cache entry
    - ≥100 iterations; in `ingest/src/repository.property.test.ts`
    - **Validates: Requirements 4.6**

  - [ ]* 3.3 Write unit tests for the rate-card cache methods
    - `getRateCard` returns the item or `null`; `putRateCard` writes the region-keyed item with its
      `effectiveDate`/`updatedAt`; `recordRateCardFailure` sets `failureReason`/`updatedAt` without
      clobbering existing `rates`
    - In `ingest/src/repository.test.ts`
    - _Requirements: 4.1, 4.6_

- [x] 4. Rate-card service (cache-first, lazy refresh, stale-serve)
  - [x] 4.1 Implement `isStale` and `loadRateCard`
    - Create `ingest/src/cost/rateCard.ts` exporting the named constant
      `RATE_CARD_STALENESS_MS = 7 * 24 * 60 * 60 * 1000`, the pure `isStale(updatedAt, now, thresholdMs)`,
      and the orchestrating `loadRateCard(repo, priceList, region, now)`: (1) `getRateCard(region)` present
      and not stale → reuse without calling the API (4.1); (2) absent or present-but-stale → `fetchRateMap`,
      on success `putRateCard` with `effectiveDate = today` and return it (4.2, 4.3, lazy refresh — no
      polling); (3) API failure with a cached card → `recordRateCardFailure` and return the stale card
      (4.4); (4) API failure with no cache → return a typed "unavailable" sentinel (4.5)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 4.2 Write property test for rate-card staleness threshold
    - **Feature: run-cost-estimation, Property 9** — for all `updatedAt`/`now` instants,
      `isStale(updatedAt, now, threshold)` is `true` iff `now - updatedAt > threshold`, so a card is
      eligible for lazy refresh exactly when older than `RATE_CARD_STALENESS_MS` (~7 days) and never before
    - ≥100 iterations; in `ingest/src/cost/rateCard.property.test.ts`
    - **Validates: Requirements 4.3**

  - [ ]* 4.3 Write unit tests for the rate-card service control flow
    - Fresh cache → `fetchRateMap` not called (4.1); miss → fetch with
      `{ ServiceCode: 'AmazonOmics', workflowType=Private, regionCode=<region> }` + `putRateCard` (4.2);
      API throws + cache present → returns stale card + `recordRateCardFailure` (4.4); API throws + no
      cache → unavailable sentinel (4.5)
    - In `ingest/src/cost/rateCard.test.ts`
    - _Requirements: 4.1, 4.2, 4.4, 4.5_

- [x] 5. Cost math pure helpers
  - [x] 5.1 Implement the estimate helpers
    - Create `ingest/src/cost/estimate.ts` with pure helpers: `instanceHours(startedAt, stoppedAt)`
      (wall-clock hours, `null` when either is missing/unparseable or `stop < start`);
      `aggregateComputeHours(tasks)` (group by `instanceType` summing hours, with `missingInstanceTypeCount`
      and `excludedNoRuntimeCount`); `bytesToGb(bytes)` (decimal GB, 1e9); `trapezoidalGbHours(points)`
      (Σ over consecutive pairs of `average(bytesToGb) × Δt-hours`, `0` for a single point, `null` for an
      empty series); `computeComputeLineItems(agg, rateMap)` (one line item per instance type, plus a single
      `available:false` unpriced-compute item for missing-instanceType tasks; `available:false` for types
      absent from the rate map); and `computeStorageLineItem(args)` (family from `storageType`, STATIC
      quantity = capacity × run hours, DYNAMIC quantity = `trapezoidalGbHours`, `estimatedCost` = quantity ×
      family rate, `available:false` on missing series or missing family rate)
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.5, 3.6_

  - [ ]* 5.2 Write property test for instance-hours
    - **Feature: run-cost-estimation, Property 1** — for all task start/stop ISO timestamp pairs,
      `instanceHours(start, stop)` returns `(Date.parse(stop) - Date.parse(start)) / 3_600_000` when both
      parse and `stop >= start`, and returns `null` (never fabricated) when either is missing/unparseable
      or `stop < start`
    - ≥100 iterations; in `ingest/src/cost/estimate.property.test.ts`
    - **Validates: Requirements 2.1**

  - [ ]* 5.3 Write property test for compute aggregation and pricing
    - **Feature: run-cost-estimation, Property 2** — for all task sets and rate maps,
      `computeComputeLineItems(aggregateComputeHours(tasks), rateMap)` produces exactly one available line
      item per instance type present (with a rate), whose `quantity` equals the sum of `instanceHours` over
      that type's tasks with valid runtime and whose `estimatedCost` equals `quantity × ratePerUnit`
    - ≥100 iterations; in `ingest/src/cost/estimate.property.test.ts`
    - **Validates: Requirements 2.2, 2.3**

  - [ ]* 5.4 Write property test for missing-instance-type non-fabrication
    - **Feature: run-cost-estimation, Property 3** — for all task sets, tasks lacking an `instanceType`
      contribute their hours to no priced (available) line item and are instead reflected in a single
      `available: false` unpriced-compute line item, whose presence never removes or alters the priced line
      items
    - ≥100 iterations; in `ingest/src/cost/estimate.property.test.ts`
    - **Validates: Requirements 2.4**

  - [ ]* 5.5 Write property test for no-runtime exclusion
    - **Feature: run-cost-estimation, Property 4** — for all task sets, the summed priced `Instance_Hours`
      equals the sum taken over only the tasks with a valid start→stop runtime, and the number of tasks with
      no runtime is reported as an excluded count rather than contributing a fabricated runtime
    - ≥100 iterations; in `ingest/src/cost/estimate.property.test.ts`
    - **Validates: Requirements 2.5**

  - [ ]* 5.6 Write property test for missing-rate unavailability (compute + storage)
    - **Feature: run-cost-estimation, Property 5** — for all aggregations, rate maps, and storage families,
      any instance type or storage family absent from the rate map produces an `available: false` line item
      with `null` `ratePerUnit`/`estimatedCost` (and, for storage, `null` `quantity` when it also cannot be
      computed), and that line item never contributes to the total
    - ≥100 iterations; in `ingest/src/cost/estimate.property.test.ts`
    - **Validates: Requirements 2.6, 3.6**

  - [ ]* 5.7 Write property test for static storage GB-hours
    - **Feature: run-cost-estimation, Property 6** — for all non-negative `storageCapacity` values and
      start≤stop windows, the STATIC storage line item's `quantity` equals `storageCapacity ×
      instanceHours(window)` and its `estimatedCost` equals `quantity × the "Run Storage" rate`
    - ≥100 iterations; in `ingest/src/cost/estimate.property.test.ts`
    - **Validates: Requirements 3.2, 3.5**

  - [ ]* 5.8 Write property test for dynamic trapezoidal GB-hours
    - **Feature: run-cost-estimation, Property 7** — for all sampled usage series (points of
      `{ timestamp ms, value bytes }`), `trapezoidalGbHours` equals the sum over consecutive point pairs of
      `average(bytesToGb(v_i), bytesToGb(v_{i+1})) × (Δt in hours)`; it is `0` for a single point and
      non-negative for a non-negative series; and the DYNAMIC storage line item's `estimatedCost` equals
      that quantity `× the "Dynamic Run Storage" rate`
    - ≥100 iterations; in `ingest/src/cost/estimate.property.test.ts`
    - **Validates: Requirements 3.3, 3.5**

  - [ ]* 5.9 Write property test for absent dynamic series → unavailable
    - **Feature: run-cost-estimation, Property 8** — for all runs using DYNAMIC storage whose
      `RUN_FILESYSTEM` usage series is empty or absent (a `null` from the integrator), the storage line item
      is `available: false` with `null` `quantity`/`estimatedCost` — never a fabricated or zero GB-hours
    - ≥100 iterations; in `ingest/src/cost/estimate.property.test.ts`
    - **Validates: Requirements 3.4**

  - [ ]* 5.10 Write property test for total and partiality
    - **Feature: run-cost-estimation, Property 13** — for all estimates, `total` equals the sum of the
      `estimatedCost` of the `available: true` line items (and is `null` when none are available), and
      `partial` is `true` iff at least one line item is `available: false`
    - ≥100 iterations; in `ingest/src/cost/estimate.property.test.ts`
    - **Validates: Requirements 6.3, 6.4**

- [x] 6. Filesystem usage source (DYNAMIC storage GB-hours)
  - [x] 6.1 Implement the RUN_FILESYSTEM usage fetch
    - Create `ingest/src/cost/filesystemUsage.ts` reusing the existing metrics query path:
      `buildSelector('aws.omics.run.filesystem.usage', runId)` (`promql.ts`) → `buildRangeBody` +
      `signAndPost('/api/v1/query_range', ...)` (`signedQuery.ts`) → `parseMatrix(..., 'RUN_FILESYSTEM',
      'usage')` (`parse.ts`), returning the run-level usage `points` (`{ timestamp, value }`, value in
      bytes) or `null` when the series is absent or the query failed
    - _Requirements: 3.3_

  - [ ]* 6.2 Write unit tests for the filesystem usage source
    - Builds the `RUN_FILESYSTEM` selector; parses a matrix fixture into usage `points`; empty result or
      `status:"error"` → `null`
    - In `ingest/src/cost/filesystemUsage.test.ts`
    - _Requirements: 3.3, 3.4_

- [x] 7. CostHandler Lambda
  - [x] 7.1 Implement `costHandler.ts` orchestration
    - Create `ingest/src/costHandler.ts` mirroring `metricsHandler.ts`: an AppSync Lambda-resolver whose
      event is `{ arguments: { runId } }` returning a typed `RunCostEstimate` (with the `CostCategory` /
      `CostLineItem` / `RunCostEstimate` types). Validate `runId` (non-empty) else `throw`; call
      `omics:GetRun` for `storageType`/`storageCapacity`/wall-clock window (typed `error` result on
      failure); load the run's task items from the repository (`PK = RUN#<runId>`, `SK begins_with TASK#`);
      `loadRateCard(region)`; compute compute line items via `computeComputeLineItems`; compute the storage
      line item via `computeStorageLineItem` (STATIC from capacity × hours, DYNAMIC from the integrated
      `filesystemUsage` series); assemble the `RunCostEstimate` (`total` = sum of available, `null` when
      none; `partial` = any unavailable; `currency`/`effectiveDate` from the card; `error: null` on success)
    - Read env vars `COST_REGION` (default `AWS_REGION`), `COST_TABLE_NAME`, `MONITORING_HOST`,
      `SIGNING_SERVICE`; 30s timeout behavior
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 5.7, 6.3, 6.4_

  - [ ]* 7.2 Write handler orchestration unit tests
    - `runId` empty → throws (5.7); GetRun failure → typed error (5.7); STATIC run → storage priced from
      `storageCapacity` × hours (3.2); DYNAMIC run → storage priced from the integrated series, absent
      series → unavailable (3.3, 3.4); mixed availability → `partial: true`, `total` = available only (6.3);
      none available → `total: null` (6.4)
    - In `ingest/src/costHandler.test.ts`
    - _Requirements: 3.2, 3.3, 3.4, 5.7, 6.3, 6.4_

- [x] 8. GraphQL schema surface
  - [x] 8.1 Add the `getRunCostEstimate` query and cost types
    - In `infra/graphql/schema.graphql`, add `enum CostCategory { COMPUTE STORAGE }`, the `CostLineItem`
      type (`category!`, `usageType!`, `resourceType`, `quantity`, `unit!`, `ratePerUnit`, `estimatedCost`,
      `available!`, `unavailableReason`) and the `RunCostEstimate` type (`runId!`, `lineItems!`, `total`,
      `currency`, `effectiveDate`, `partial!`, `error`) exactly as in design §6, add
      `getRunCostEstimate(runId: ID!): RunCostEstimate` to `type Query`, and add `instanceType: String` to
      both `type Task` and `input TaskInput`; annotate the query and cost types with `@aws_cognito_user_pools`
    - _Requirements: 1.3, 5.1_

- [x] 9. CDK wiring and least-privilege IAM (deploy path)
  - [x] 9.1 Implement `addCostResolver()` in the API stack
    - In `infra/lib/api-stack.ts`, add `addCostResolver()` mirroring `addMetricsResolver()`: a
      `NodejsFunction` `CostFunction` (`NODEJS_20_X`, entry `ingest/src/costHandler.ts`, handler `handler`,
      ingest `projectRoot`/`depsLockFilePath`, 30s timeout, env `COST_REGION`/`COST_TABLE_NAME`/
      `MONITORING_HOST`/`SIGNING_SERVICE`) with `format: OutputFormat.ESM`, `externalModules: ['@aws-sdk/*']`,
      and the `createRequire` banner shim; add the Lambda data source and a `getRunCostEstimate` resolver
      (`typeName: 'Query'`, `fieldName: 'getRunCostEstimate'`); call `addCostResolver()` where
      `addMetricsResolver()` is called
    - Add least-privilege IAM: `['pricing:GetProducts','pricing:DescribeServices']` on Resource `*`
      (documented exception — no resource-level scoping); `['cloudwatch:GetMetricData','cloudwatch:ListMetrics']`
      on Resource `*`; `['omics:GetRun']` scoped to `arn:aws:omics:<region>:<account>:run/*`; a DynamoDB
      grant scoped to the table ARN limited to `dynamodb:GetItem`/`PutItem`/`UpdateItem`; NO `Action: '*'`
    - _Requirements: 4.1, 4.6, 7.1, 7.2, 7.3_

  - [ ]* 9.2 Write infra tests for schema, resolver wiring, and IAM
    - Assert the schema exposes `getRunCostEstimate(runId): RunCostEstimate`, the `RunCostEstimate`/
      `CostLineItem` types + `CostCategory` enum (all `@aws_cognito_user_pools`), and `instanceType: String`
      on `Task` + `TaskInput` (1.3, 5.1); assert CDK synth registers a Lambda data source + a
      `getRunCostEstimate` resolver (mirror the `MetricsDataSource`/`getRunMetricsResolver` assertions);
      assert least-privilege IAM: a `pricing:GetProducts`/`pricing:DescribeServices` statement on `*`, the
      CloudWatch read pair on `*`, an `omics:GetRun` statement scoped to a run ARN, a DynamoDB grant scoped
      to the table ARN limited to `GetItem`/`PutItem`/`UpdateItem`, and no `Action: '*'` anywhere (reuse the
      `allPolicyActions` no-wildcard helper)
    - In the `infra/` test suite (`test/app.test.ts`)
    - _Requirements: 1.3, 5.1, 7.1, 7.2, 7.3_

- [x] 10. Frontend types and client query
  - [x] 10.1 Add frontend cost types and `instanceType` on `Task`
    - In `frontend/src/api/types.ts`, add `CostCategory`, `CostLineItem`, and `RunCostEstimate` mirrors of
      the GraphQL schema, and add `readonly instanceType?: string | null` to `Task`
    - _Requirements: 5.1, 8.1_

  - [x] 10.2 Add the `getRunCostEstimate` client query
    - In `frontend/src/api/client.ts`, add the `GET_RUN_COST_ESTIMATE` query document and
      `getRunCostEstimate(variables): Promise<RunCostEstimate>` mirroring `getRunMetrics`; in
      `isLocalMockMode()` return an honest unavailable estimate (`{ runId, lineItems: [], total: null,
      currency: null, effectiveDate: null, partial: false, error: null }`); add `instanceType` to the
      `GET_RUN`/`LIST_TASKS_FOR_RUN`/`ON_TASK_UPDATED` task selection sets
    - _Requirements: 5.1, 8.1_

  - [ ]* 10.3 Write client unit tests
    - `getRunCostEstimate` sends the documented query/variables; mock mode returns an unavailable estimate
      (`lineItems: []`, `total: null`)
    - In `frontend/src/api/client.mock.test.ts` (or the matching client test file)
    - _Requirements: 5.1_

- [x] 11. Frontend cost presentation pure helper
  - [x] 11.1 Implement `deriveCostPresentation`
    - Create `frontend/src/cost/costPresentation.ts` with the pure `deriveCostPresentation(result, isLoading)`
      returning exactly one of `loading | error | unavailable | ready`: `loading` whenever `isLoading` is
      true; a non-null `result.error` → `error` (never `unavailable`); a result with no computable line item
      → `unavailable` (never `error`/`ready`); otherwise `ready` (carrying partial-total detection from the
      `partial` flag)
    - _Requirements: 5.6, 5.7, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 11.2 Write property test for the four-state presentation
    - **Feature: run-cost-estimation, Property 11** — for all `(result, isLoading)` inputs,
      `deriveCostPresentation` returns exactly one of `loading | error | unavailable | ready`; `loading` is
      chosen whenever `isLoading` is true; a non-null `result.error` maps to `error` (never `unavailable`);
      and a result with no computable line item maps to `unavailable` (never `error` or `ready`)
    - ≥100 iterations; in `frontend/src/cost/costPresentation.property.test.ts`
    - **Validates: Requirements 5.6, 5.7, 6.5**

  - [ ]* 11.3 Write property test for honest, coexisting unavailable line items
    - **Feature: run-cost-estimation, Property 12** — for all estimates, every `available: false` line item
      carries `null` (never `0`/placeholder) `quantity`/`ratePerUnit`/`estimatedCost`, and its presence
      never removes any `available: true` line item from the breakdown
    - ≥100 iterations; in `frontend/src/cost/costPresentation.property.test.ts`
    - **Validates: Requirements 6.1, 6.2**

- [x] 12. RunCostPanel component
  - [x] 12.1 Implement `RunCostPanel.tsx`
    - Create `frontend/src/rundetail/RunCostPanel.tsx` rendering exactly one state via
      `deriveCostPresentation`: loading (`Spinner` + "Estimating cost…"); error (`Alert type="error"` +
      Retry that re-issues the query; a non-null `error` is treated as error); unavailable (explicit
      "Cost estimate unavailable" message, never a fabricated 0) — each visually distinct
    - Ready state: a Cloudscape `Table` styled after Cost Explorer with columns usage type / resource
      (instance) type / quantity / published rate / estimated cost; a total row with `currency` and
      `effectiveDate`; an "Estimate" `Badge` distinct from the metrics panel's "Measured" badge; the
      Estimate_Disclaimer text; a partial-total indicator when `partial` is true; unavailable line items
      render "—" in their numeric cells (never a zero) and coexist with the computable rows
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 12.2 Write RunCostPanel component tests
    - Four distinct states — loading, error+Retry, unavailable, ready — each visually distinct (5.6, 5.7,
      6.5); ready renders the five columns + total/currency/effectiveDate (5.2, 5.3); the Estimate_Disclaimer
      text (5.4); an "Estimate" badge distinct from "Measured" (5.5); unavailable line items show "—" not
      `0` and coexist with computable rows (6.1, 6.2); `partial` renders the partial-total indicator (6.3);
      no computable line item → whole-panel unavailable (6.4)
    - In `frontend/src/rundetail/RunCostPanel.test.tsx`
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 13. RunDetailView wiring (cost panel, task resource type, full family set)
  - [x] 13.1 Wire the cost panel, task resource type, and full metric family set into `RunDetailView`
    - In `frontend/src/rundetail/RunDetailView.tsx`, fetch `getRunCostEstimate(runId)` once on open
      (`costResult`/`costLoading` state, a `loadCost()` callback, an injectable `getRunCostEstimate` prop
      defaulting to the client, catching a thrown rejection into a typed-`error` result like `loadMetrics`);
      render `RunCostPanel` below the measured-usage section, always on, for any run with tasks
    - Show the selected task's `instanceType` in the per-task logs header/detail alongside cpus/memory when
      present, and an explicit unavailable affordance ("—" / "Resource type unavailable") when absent
    - Change the initial `loadMetrics` call to request the full family set via a fixed
      `ALL_METRIC_FAMILIES = ['CPU','MEMORY','FILESYSTEM','SCRATCH','RUN_FILESYSTEM','NETWORK']` constant
      (issued once per mount, not polled), widening the injectable `getRunMetrics` prop type to accept
      `families`; rely on the existing `RunMetricsPanel` + `formatMetricValue` to render storage/network in
      human-readable units, omitting absent series without error
    - _Requirements: 5.2, 8.1, 8.2, 9.1, 9.2, 9.3, 9.4_

  - [ ]* 13.2 Write RunDetailView component tests
    - Cost panel renders below measured usage and reflects loading/error/unavailable/ready states (5.2);
      a selected task with `instanceType` shows it near cpus/memory (8.1); a task without `instanceType`
      shows an explicit unavailable affordance (8.2); the initial `loadMetrics` call requests the full
      family set once per mount (9.1, 9.3); storage/network series render in human-readable units (9.2);
      absent series are omitted without error (9.4)
    - In `frontend/src/rundetail/RunDetailView.test.tsx`
    - _Requirements: 5.2, 8.1, 8.2, 9.1, 9.2, 9.3, 9.4_

- [x] 14. Final verification (no deploy)
  - Run the three suites and ensure all pass, fixing any breakage:
    - ingest: `cd ingest && npm run build && npm test`
    - frontend: `cd frontend && npm run build && npm run lint && npx vitest run`
    - infra: `cd infra && npm test`
  - Do NOT run `cdk deploy` (deploys are billable and a separate human decision); ensure the CDK IAM
    changes (task 9) are present so the pricing/cloudwatch wildcard-resource exceptions and the scoped
    omics/dynamodb grants are covered when the user deploys. Ensure all tests pass; ask the user if
    questions arise
  - _Requirements: 1–9 (Design Verification commands)_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core
  implementation sub-tasks are never optional.
- Each of the 13 correctness properties is implemented by exactly one property test at ≥100 iterations,
  tagged `// Feature: run-cost-estimation, Property {n}`: Property 1 (task 5.2), Property 2 (task 5.3),
  Property 3 (task 5.4), Property 4 (task 5.5), Property 5 (task 5.6), Property 6 (task 5.7), Property 7
  (task 5.8), Property 8 (task 5.9), Property 9 (task 4.2), Property 10 (task 3.2), Property 11 (task 11.2),
  Property 12 (task 11.3), Property 13 (task 5.10).
- `instanceType` is threaded through the pipeline first (record/repo/publisher), then backend pure helpers
  (Price List parser, rate-card cache/service, cost math, filesystem usage source), then the CostHandler
  that wires them, then the GraphQL surface, CDK+IAM, frontend types/client, the pure presentation helper,
  the RunCostPanel UI, and finally the RunDetailView wiring — so each task builds on prior ones with no
  orphaned code.
- The estimate is a list-price ESTIMATE (measured runtime × published price list), never the actual bill;
  the UI carries an "Estimate" badge distinct from "Measured" and the Estimate_Disclaimer. Every value is
  real/measured/priced or explicitly unavailable ("—"), never fabricated or zero-filled.
- No deployment tasks are included; deploys are billable and out of scope for implementation. Task 14 is a
  local, non-deploy verification only.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "5.1", "8.1", "10.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.2", "3.3", "4.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "5.9", "5.10", "6.1", "10.2", "11.1"] },
    { "id": 2, "tasks": ["1.3", "4.2", "4.3", "6.2", "7.1", "9.1", "10.3", "11.2", "11.3", "12.1"] },
    { "id": 3, "tasks": ["1.4", "7.2", "9.2", "12.2", "13.1"] },
    { "id": 4, "tasks": ["13.2"] },
    { "id": 5, "tasks": ["14"] }
  ]
}
```
