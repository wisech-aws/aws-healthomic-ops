# Implementation Plan: Run Utilization Metrics

## Overview

This plan implements measured HealthOmics resource-utilization metrics on the Run Detail page, read on
demand from CloudWatch's Prometheus-compatible PromQL HTTP API through a new AppSync Lambda-backed query
(`getRunMetrics`), mirroring the existing `getRunLogs` read path. The metrics plane shares no storage or
events with the state plane and never writes to DynamoDB.

Tasks are ordered by the design's dependency structure so each step builds on the prior ones with no
orphaned code. Backend pure helpers come first (registry, PromQL builder, parser, result mapping), then
the signed-request builder, then the Lambda handler that wires them together, then the GraphQL surface,
then CDK wiring + IAM, then the frontend types/client, frontend pure helpers, and finally the
`RunMetricsPanel` UI. A separate operational script + docs task captures the externally-managed run-role
emission permission. Each task pairs implementation with the unit/property tests named in the design's
Testing Strategy. The design defines 8 correctness properties; each is implemented by exactly one
property test at ≥100 iterations, tagged `Feature: run-utilization-metrics, Property {n}`.

## Tasks

- [x] 1. Backend pure helpers: registry, PromQL selector builder, and parser
  - [x] 1.1 Implement the metric registry
    - Create `ingest/src/metrics/registry.ts` exporting the `MetricFamily` type
      (`CPU | MEMORY | NETWORK | FILESYSTEM | SCRATCH | GPU | RUN_FILESYSTEM`) and a pure table mapping
      each family to its `aws.omics.*` metric names and `role` (`usage`/`limit`), matching the design §5
      registry table (CPU/MEMORY usage+limit; NETWORK `network.io`; FILESYSTEM `filesystem.io`/`.operations`;
      SCRATCH scratch usage+limit; GPU utilization/memory usage+limit; RUN_FILESYSTEM usage+limit)
    - Export a `CORE` family default of `['CPU', 'MEMORY']` and a helper resolving a requested family list
      to the concrete `{ metricName, family, role }[]` selectors to query
    - _Requirements: 2.1, 3.1, 9.1, 9.2, 9.3, 9.5, 9.7 (Design §5)_

  - [x] 1.2 Implement the PromQL selector builder
    - Create `ingest/src/metrics/promql.ts` exporting `buildSelector(metricName, runId)` that references the
      dotted metric only via a `__name__` matcher and always includes the
      `@resource.aws.omics.run.id` matcher bound to the run id (design §2)
    - Add the internal `q(s)` quoting helper that double-quotes and escapes `"` and `\` so arbitrary run ids
      cannot break the expression; the function is pure and total
    - _Requirements: 1.3, 8.1 (Design §2)_

  - [ ]* 1.3 Write property test for PromQL selector construction
    - **Feature: run-utilization-metrics, Property 2** — for all metric names and run ids (including ids with
      quotes, spaces, backslashes), `buildSelector` references the metric only via `__name__`, always includes
      the `@resource.aws.omics.run.id` matcher bound to the id, and is balanced/parseable with quotes escaped;
      never a bare identifier
    - ≥100 iterations; in `ingest/src/metrics/promql.property.test.ts`
    - **Validates: Requirements 1.3, 8.1**

  - [ ]* 1.4 Write unit tests for the PromQL builder
    - Known metric + run id → exact `__name__` selector string; quote/backslash escaping examples (design
      Testing Strategy)
    - In `ingest/src/metrics/promql.test.ts`
    - _Requirements: 1.3, 8.1_

  - [x] 1.5 Implement the Prometheus parser (vector + matrix)
    - Create `ingest/src/metrics/parse.ts` with the `PrometheusEnvelope`/`PromResult` interfaces and
      `parseMatrix(env, family, role)` and `parseVector(env, family, role)` returning typed `MetricSeries[]`
    - Each `PromResult` becomes one `MetricSeries`; `timestamp = Math.round(tsSeconds * 1000)`;
      `value = Number(str)`, dropping points that do not parse to a finite number (never fabricated); extract
      labels `taskId=@resource.aws.omics.task.id`, `unit=__unit__`,
      `direction=network.io.direction ?? filesystem.io.direction`, `scratchMode=scratch.storage.mode`,
      `gpuId=gpu.id`
    - Define the shared `MetricSeries` type here (or a shared `types.ts` in `ingest/src/metrics/`) used by
      the registry/handler
    - _Requirements: 2.2, 3.2, 9.1, 9.2, 9.3, 9.5 (Design §4)_

  - [ ]* 1.6 Write property test for matrix parsing
    - **Feature: run-utilization-metrics, Property 1** — for all success matrix envelopes, `parseMatrix`
      returns exactly one `MetricSeries` per result, each point's `timestamp` equals source seconds → integer
      ms and each `value` equals the numeric parse of the source string, with non-finite values dropped and
      never replaced by a fabricated value
    - ≥100 iterations; in `ingest/src/metrics/parse.property.test.ts`
    - **Validates: Requirements 2.2, 3.2**

  - [ ]* 1.7 Write unit tests for the Prometheus parser
    - Fixtures based on the real PoC responses: a `cpu.usage` vector carrying `@resource.aws.omics.task.id`;
      `memory.usage` ~757760 bytes vs `memory.limit` 6442450944 bytes; a `query_range` matrix — parsed to
      typed series with correct taskId/unit/points; empty `result` → `[]`
    - In `ingest/src/metrics/parse.test.ts`
    - _Requirements: 2.2, 3.2_

- [x] 2. Backend result mapping and signed-request builder
  - [x] 2.1 Implement the empty-vs-error result mapping
    - Add a pure mapping (in `ingest/src/metrics/parse.ts` or a `resultMapping.ts`) that turns a Prometheus
      envelope + caller non-2xx signal into a `RunMetrics`-shaped result: `status:"success"` with empty
      `result` → `{ series: [], error: null }` (unavailable); `status:"error"` or a non-2xx signal →
      `{ series: [], error: <message> }` (typed error); the two outcomes are never conflated
    - Define the `RunMetrics` result type (`runId`, `window`, `series`, `error`) for reuse by the handler
    - _Requirements: 10.3, 10.4 (Design §4, Error Handling)_

  - [ ]* 2.2 Write property test for empty-vs-error mapping
    - **Feature: run-utilization-metrics, Property 3** — for all Prometheus envelopes, a success envelope with
      empty `result` maps to `series: []`, `error: null`; a `status:"error"` envelope (or non-2xx signal) maps
      to `error != null`; the two are never conflated
    - ≥100 iterations; in `ingest/src/metrics/resultMapping.property.test.ts`
    - **Validates: Requirements 10.3, 10.4**

  - [x] 2.3 Add `@aws-crypto/sha256-js` to ingest dependencies
    - Add `@aws-crypto/sha256-js` (pinned version) to `ingest/package.json` dependencies and refresh the
      lockfile so the SigV4 signer can be constructed and bundled (design §7 bundling note); `@smithy/signature-v4`
      5.7.3 and `@aws-sdk/credential-provider-node` are already present
    - _Requirements: 1.2 (Design §3, §7)_

  - [x] 2.4 Implement `buildRangeBody` and the SigV4 signed POST
    - Create `ingest/src/metrics/signedQuery.ts` exporting `RangeParams`, `buildRangeBody(p)` that
      form-encodes `query`, `start` (RFC3339), `end` (RFC3339), `step` (numeric-seconds string, e.g. `"30"`)
      via `URLSearchParams`, and a helper that clamps/produces a numeric-seconds step of at least 30
    - Implement `signAndPost(host, region, service, '/api/v1/query_range', body)` using
      `SignatureV4({ service: 'monitoring', region, sha256: Sha256, credentials: defaultProvider() })` from
      `@smithy/signature-v4` + `@aws-crypto/sha256-js` + `@aws-sdk/credential-provider-node`, signing an
      `HttpRequest` (POST, `host` header, `content-type: application/x-www-form-urlencoded`, form body) then
      issuing an HTTPS POST via global `fetch`, returning the parsed `PrometheusEnvelope`
    - Keep signer credentials injectable so tests can assert request shape with a fixed-credential signer
      (no live call)
    - _Requirements: 1.2, 1.4, 8.2 (Design §3)_

  - [ ]* 2.5 Write property test for range-parameter bounding
    - **Feature: run-utilization-metrics, Property 8** — for all run windows and requested step values, the
      `query_range` params carry RFC3339 `start`/`end` with `start <= end` and a numeric-seconds `step` of at
      least 30 for any requested step below 30 or missing
    - ≥100 iterations; in `ingest/src/metrics/rangeParams.property.test.ts`
    - **Validates: Requirements 1.4, 8.2**

  - [ ]* 2.6 Write unit tests for the signed-request builder
    - `buildRangeBody` form-encodes `query`/`start`/`end`/`step` with RFC3339 start/end and numeric-seconds
      step (1.4); the signed `HttpRequest` targets `monitoring.<region>.amazonaws.com`, method POST, path
      `/api/v1/query_range`, service `monitoring`, and carries an `Authorization` header (1.2) — assert shape
      with an injected fixed-credential signer, not a live call
    - In `ingest/src/metrics/signedQuery.test.ts`
    - _Requirements: 1.2, 1.4_

- [x] 3. MetricsLambda handler
  - [x] 3.1 Implement `metricsHandler.ts` orchestration
    - Create `ingest/src/metricsHandler.ts` mirroring `logsHandler.ts`: an AppSync Lambda resolver whose
      event is `{ arguments: { runId, startTime?, endTime?, stepSeconds?, families? } }` returning a typed
      `RunMetrics`
    - Validate `runId` (non-empty), else `throw`; resolve the range window (use supplied `startTime`/`endTime`
      when present, otherwise call `omics:GetRun` via `@aws-sdk/client-omics` for `startTime`..`stopTime ?? now`,
      with `end = now` for a live run); clamp `stepSeconds` to `>= 30` (default 30)
    - Select families (default CORE = CPU+MEMORY), build a `__name__`+`@run.id` selector per registry entry
      (scoped to the single run id), build + SigV4-sign + POST one `query_range` per selector concurrently
      (`Promise.all`), parse each matrix into `MetricSeries[]` tagging `family`/`role`/labels
    - Return the typed `RunMetrics`: empty series → unavailable (`error: null`); any non-2xx or Prometheus
      `status:"error"` (including a failed GetRun fallback) → typed error (`error != null`); read env vars
      `METRICS_REGION`/`MONITORING_HOST`/`SIGNING_SERVICE` with the documented defaults; 30s handling
    - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 3.1, 3.2, 8.1, 8.2, 9.1, 9.2, 9.3, 9.5, 9.7, 10.3, 10.4 (Design §1, Run window)_

  - [ ]* 3.2 Write handler orchestration unit tests
    - CORE default families → CPU+memory selectors (2.1, 3.1); window passed in args skips GetRun, absent
      window calls GetRun (8.2); non-2xx → typed error (10.3); success empty → unavailable (10.4); step
      clamped to ≥30 (8.2); query scoped to the single run id (8.1)
    - In `ingest/src/metricsHandler.test.ts`
    - _Requirements: 2.1, 3.1, 8.1, 8.2, 10.3, 10.4_

- [x] 4. GraphQL schema surface
  - [x] 4.1 Add the `getRunMetrics` query and metric types
    - In `infra/graphql/schema.graphql`, add `enum MetricFamily { CPU MEMORY NETWORK FILESYSTEM SCRATCH GPU RUN_FILESYSTEM }`,
      `enum MetricRole { usage limit }`, and the types `MetricPoint`, `MetricSeries`, `MetricWindow`,
      `RunMetrics` exactly as in design §6 (strongly typed points; optional label scalars)
    - Add `getRunMetrics(runId: ID!, startTime: String, endTime: String, stepSeconds: Int, families: [MetricFamily!]): RunMetrics`
      to `type Query`; annotate the query and every metric type with `@aws_cognito_user_pools`
    - _Requirements: 1.1, 1.5 (Design §6)_

- [x] 5. CDK wiring and least-privilege IAM (deploy path)
  - [x] 5.1 Implement `addMetricsResolver()` in the API stack
    - In `infra/lib/api-stack.ts`, add `addMetricsResolver()` mirroring `addLogsResolver()`: a `NodejsFunction`
      (`NODEJS_20_X`, entry `ingest/src/metricsHandler.ts`, handler `handler`, `projectRoot`/`depsLockFilePath`
      at the ingest package, 30s timeout, env `METRICS_REGION`/`MONITORING_HOST`/`SIGNING_SERVICE`)
    - Bundling: `format: OutputFormat.ESM`, `externalModules: ['@aws-sdk/*']` only, so esbuild bundles
      `@smithy/signature-v4` and `@aws-crypto/sha256-js` (NOT externalized); add the Lambda data source and a
      `getRunMetrics` resolver (`typeName: 'Query'`, `fieldName: 'getRunMetrics'`); call `addMetricsResolver()`
      from the constructor where `addLogsResolver()` is called
    - Add least-privilege IAM: one `PolicyStatement` with `['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics']`
      on Resource `*` (these actions do not support ARN scoping — VERIFIED-REQUIRED), and one with
      `['omics:GetRun']` scoped to `arn:aws:omics:<region>:<account>:run/*`; NO `Action: '*'`
    - _Requirements: 1.1, 1.2, 1.5, 8.1 (Design §7)_

  - [ ]* 5.2 Write infra tests for schema, resolver wiring, and IAM
    - Assert the schema exposes `getRunMetrics(runId, startTime, endTime, stepSeconds, families): RunMetrics`
      and the `RunMetrics`/`MetricSeries`/`MetricPoint`/`MetricWindow` types + `MetricFamily`/`MetricRole`
      enums, all carrying `@aws_cognito_user_pools` (1.1, 1.5)
    - Assert CDK synth registers a Lambda data source + `getRunMetrics` resolver (mirror the
      `LogsDataSource`/`getRunLogsResolver` assertions)
    - Assert least-privilege IAM: a statement with both `cloudwatch:GetMetricData` and `cloudwatch:ListMetrics`
      and one with `omics:GetRun` scoped to a run ARN, and no `Action: '*'` (reuse the `allPolicyActions`
      no-wildcard helper) (8.1)
    - In the `infra/` test suite (mirroring the logs/read-resolver assertions)
    - _Requirements: 1.1, 1.5, 8.1_

- [x] 6. Frontend types and client query
  - [x] 6.1 Add frontend metric types
    - In `frontend/src/api/types.ts`, add `MetricFamily`, `MetricRole`, `MetricPoint`, `MetricSeries`,
      `MetricWindow`, and `RunMetrics` mirrors of the GraphQL schema
    - _Requirements: 1.1, 10.3, 10.4 (Design §8)_

  - [x] 6.2 Add the `getRunMetrics` client query
    - In `frontend/src/api/client.ts`, add the `GET_RUN_METRICS` query and
      `getRunMetrics(variables): Promise<RunMetrics>` mirroring `getRunLogs`; in `isLocalMockMode()` return an
      empty-series success (`{ series: [], error: null }`) so the UI shows the unavailable state without a
      backend
    - _Requirements: 1.1, 10.4 (Design §8)_

  - [ ]* 6.3 Write client unit tests
    - `getRunMetrics` sends the documented query/variables; mock mode returns an empty-series success
      (unavailable)
    - In `frontend/src/api/client.mock.test.ts` (or the matching client test file)
    - _Requirements: 1.1, 10.4_

- [x] 7. Frontend pure helpers: task-id join, chart shaping, presentation
  - [x] 7.1 Implement `joinMetricsToTasks`
    - Create `frontend/src/metrics/joinMetricsToTasks.ts`: a pure join grouping `series` by `taskId` and
      matching each group to the `Task` whose `taskId` equals it; series whose `taskId` matches no task are
      omitted from the per-node result without discarding others; a task with no matching series is reported
      unavailable (no synthesized zero/placeholder series)
    - _Requirements: 6.1, 6.3, 6.4, 4.2 (Design §9)_

  - [ ]* 7.2 Write property test for matched grouping and unmatched-series omission
    - **Feature: run-utilization-metrics, Property 4** — for all series sets and task lists,
      `joinMetricsToTasks` associates every series whose `taskId` equals a task's id with exactly that task,
      omits every unmatched series without discarding others, and places no series under a task whose id it
      does not carry
    - ≥100 iterations; in `frontend/src/metrics/joinMetricsToTasks.property.test.ts`
    - **Validates: Requirements 6.1, 6.3**

  - [ ]* 7.3 Write property test for unmatched-node unavailability
    - **Feature: run-utilization-metrics, Property 5** — for all task lists and series sets, every task with
      no series carrying its `taskId` is reported unavailable (no synthesized zero/placeholder series),
      independently of how many other tasks have series
    - ≥100 iterations; in `frontend/src/metrics/joinMetricsToTasks.property.test.ts`
    - **Validates: Requirements 6.4, 4.2**

  - [x] 7.4 Implement `chartSeries`
    - Create `frontend/src/metrics/chartSeries.ts`: pure shaping of a per-task `MetricSeries` group into
      Cloudscape chart series — a usage (actual) series whenever a usage series exists, paired with a limit
      series iff a limit series exists for that task+metric, never emitting a fabricated limit; carry the
      metric unit (bytes for memory from `__unit__`, `{cpu}` for CPU)
    - _Requirements: 2.3, 2.4, 3.3, 3.4, 9.8 (Design §9)_

  - [ ]* 7.5 Write property test for actual-vs-limit chart shaping
    - **Feature: run-utilization-metrics, Property 6** — for all per-task series groups, `chartSeries`
      produces an actual (usage) series whenever a usage series exists, pairs it with a limit series iff a
      limit series exists for that task+metric, and never emits a limit series when none was measured
    - ≥100 iterations; in `frontend/src/metrics/chartSeries.property.test.ts`
    - **Validates: Requirements 2.4, 3.4, 9.8**

  - [x] 7.6 Implement measured-presentation derivation
    - Create the pure presentation-state helper (e.g. `frontend/src/metrics/runMetricsPresentation.ts`) that
      computes the `RunDetailView` presentation from a `RunMetrics` result while preserving the derived
      `ResourceSummary` inputs unchanged: the measured result is only ever added alongside; an absent/empty or
      failed measured result never blanks or degrades the derived summary
    - _Requirements: 5.1, 5.2 (Design §9)_

  - [ ]* 7.7 Write property test for measured-preserves-derived
    - **Feature: run-utilization-metrics, Property 7** — for all run metric results (including
      empty/unavailable and error), the computed presentation preserves the derived `ResourceSummary` inputs
      unchanged; the measured result is only added alongside and never blanks/degrades the derived summary
    - ≥100 iterations; in `frontend/src/metrics/runMetricsPresentation.property.test.ts`
    - **Validates: Requirements 5.1, 5.2**

- [x] 8. Frontend RunMetricsPanel and RunDetailView wiring
  - [x] 8.1 Implement `RunMetricsPanel.tsx`
    - Create `frontend/src/rundetail/RunMetricsPanel.tsx` rendering three distinct states — loading (Spinner),
      error (`Alert type="error"` + Retry that re-issues the query; a non-null `RunMetrics.error` is treated
      as error), and unavailable (explicit "Measured utilization unavailable" message, never a fabricated 0)
      — each visually distinct
    - Ready state: per-task CPU/memory actual-vs-limit charts via Cloudscape `LineChart`/`MixedLineBarChart`
      using `chartSeries` (usage line + limit reference; usage-only when no limit; unavailable when neither),
      badged "Measured"; join series to DAG nodes by task id via `joinMetricsToTasks`; run-level filesystem
      series (`taskId === null`) rendered run-scoped without a fabricated limit; GPU views only when GPU series
      exist (omitted, no error, otherwise); scratch usage-vs-limit split by `scratch.storage.mode` with
      delayed/absent SHARED → unavailable; secondary families degrade gracefully; on-demand Refresh for live
      runs (window `end = now`), no high-frequency poll
    - _Requirements: 2.3, 2.4, 2.5, 3.3, 3.4, 3.5, 4.1, 4.3, 4.4, 4.5, 5.3, 5.5, 6.2, 6.4, 7.1, 7.2, 7.3, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 10.1, 10.2, 10.3, 10.4 (Design §9)_

  - [x] 8.2 Wire `RunMetricsPanel` into `RunDetailView`
    - In `frontend/src/rundetail/RunDetailView.tsx`, fetch `getRunMetrics(runId, window, families?)` once on
      open (passing the run's `startedAt`/`stoppedAt` window, defaulting live-run `end` to now), keep the
      result in state, and render `RunMetricsPanel` below the unchanged `ResourceSummaryCard` (augment, never
      replace); label derived values "derived" and measured "measured" so they are distinguishable; surface
      per-task measured metrics in the context of the DAG node
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 7.1, 7.4 (Design §9)_

  - [ ]* 8.3 Write RunMetricsPanel and RunDetailView component tests
    - Three distinct states — loading, error+Retry, unavailable — each visually distinct (10.1, 10.2, 4.5); a
      non-null `error` renders the error state (10.3); empty series renders unavailable (10.4); measured values
      labeled "Measured" alongside the derived card (5.3–5.5); run started pre-permission (empty) → unavailable
      (4.3); GPU omitted without error when absent (9.6); DYNAMIC run filesystem usage shown without a limit
      (9.8); metrics fetched on open, derived summary still renders when measured is empty (5.2, 7.4)
    - In `frontend/src/rundetail/RunMetricsPanel.test.tsx` and `frontend/src/rundetail/RunDetailView.test.tsx`
    - _Requirements: 4.3, 4.5, 5.2, 5.3, 5.4, 5.5, 7.4, 9.6, 9.8, 10.1, 10.2, 10.3, 10.4_

- [x] 9. Run-role metric-emission permission script and docs (deploy path)
  - [x] 9.1 Add an idempotent run-role permission script
    - Create `scripts/ensure-run-metrics-permission.mjs` that idempotently ensures the HealthOmics run role
      has an inline policy granting `cloudwatch:PutMetricData` (Resource `*`) so HealthOmics can EMIT metrics;
      takes the role name as an arg/env defaulting to the known role `OmicsWorkflow-20260224075057`; is safe to
      re-run (checks/creates/updates the inline policy without duplicating); supports `--dry-run`; and prints
      what it did (or would do). This is a coding task that writes the script only — it MUST NOT execute AWS
      mutations as part of this plan
    - _Requirements: 4.3 (availability precondition; Design IAM/emission note)_

  - [x] 9.2 Document the run-role script in README and scripts/README
    - Update `README.md` (Deploy section §3 and/or Prerequisites) and `scripts/README.md` to document that
      `scripts/ensure-run-metrics-permission.mjs` must be run once against the HealthOmics run role so metrics
      are emitted, noting it introduces CloudWatch ingestion cost and that runs started before it have no
      metrics ever
    - _Requirements: 4.3 (Design IAM/emission note)_

- [x] 10. Final verification (no deploy)
  - Run the three suites and ensure all pass, fixing any breakage:
    - ingest: `cd ingest && npm run build && npm test`
    - frontend: `cd frontend && npm run build && npm run lint && npx vitest run`
    - infra: `cd infra && npm test`
  - Do NOT run `cdk deploy` (deploys are billable and a separate human decision); ensure the CDK IAM changes
    (task 5) and the run-role script + docs (task 9) are present so both IAM concerns are covered when the
    user deploys. Ensure all tests pass; ask the user if questions arise
  - _Requirements: 1–10 (Design Verification commands)_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core
  implementation sub-tasks are never optional.
- Each of the 8 correctness properties is implemented by exactly one property test at ≥100 iterations,
  tagged `// Feature: run-utilization-metrics, Property {n}`: Property 1 (task 1.6), Property 2 (task 1.3),
  Property 3 (task 2.2), Property 8 (task 2.5), Property 4 (task 7.2), Property 5 (task 7.3), Property 6
  (task 7.4/7.5), Property 7 (task 7.7).
- Backend pure helpers are implemented first (safest, most-tested core), then the signed-request builder,
  then the handler that wires them, then schema, CDK+IAM, frontend types/client, frontend pure helpers, and
  the UI panel — so each task builds on prior ones with no orphaned code.
- Task 9's script is externally-managed IaC captured as a coding task (writing a script + docs), NOT a task
  that runs AWS mutations. The run role `OmicsWorkflow-20260224075057` is a HealthOmics service role not
  created by this repo's CDK, so it cannot be added to a stack.
- No deployment tasks are included; deploys are billable and out of scope for implementation. Task 10 is a
  local, non-deploy verification only.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.5", "2.3", "4.1", "6.1"] },
    { "id": 1, "tasks": ["1.3", "1.4", "1.6", "1.7", "2.1", "2.4", "6.2", "7.1", "7.4", "7.6", "9.1"] },
    { "id": 2, "tasks": ["2.2", "2.5", "2.6", "3.1", "5.1", "6.3", "7.2", "7.5", "7.7", "9.2"] },
    { "id": 3, "tasks": ["3.2", "5.2", "7.3", "8.1"] },
    { "id": 4, "tasks": ["8.2"] },
    { "id": 5, "tasks": ["8.3"] },
    { "id": 6, "tasks": ["10"] }
  ]
}
```
