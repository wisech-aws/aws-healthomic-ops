# Implementation Plan: Workflow/Version Aggregate Performance Reports

## Overview

This plan implements the Reports feature: a persisted per-run rollup (Run_Summary) written at run
completion, a new GSI for group-over-window queries, two Cognito-authorized AppSync queries backed
by a Reports_Lambda that aggregates mean/median/p90 per metric, a Reports_View with a calendar
window and workflow/version selection, CSV and client-side print-to-PDF exports, and a one-time
idempotent backfill. Grouping/display use `(workflowName, workflowVersionName)` with `workflowId`
stored as a hidden collision guard; cost is out of scope; versionless runs form an "(unversioned)"
bucket. The load-bearing theme is availability honesty: unavailable metrics are never counted as
zero and always carry an "N of M runs" denominator.

Tasks are ordered by the design's dependency structure — data model → ingest rollup → repository
→ backend aggregation/query → CDK/IAM wiring → frontend types/client → view → exports → backfill →
docs — so each step builds on prior ones with no orphaned code. Each implementation task pairs
with the unit/property tests named in the design's Testing Strategy. The design defines exactly 14
correctness properties (properties 11–14 cover high-volume scale); each is implemented by exactly
one property test at ≥100 iterations, tagged
`Feature: workflow-performance-reports, Property {n}`. No deploy happens as part of these tasks
(deploys are billable and explicitly gated on user approval).

Tasks 1–12 deliver the base feature. **Section 13 is the high-volume (50k+) scalability addendum**
(Requirement 11): it replaces the per-run on-screen chart with server-computed fixed-size series,
bounds the report payload, replaces the group-list scan with a maintained Group_Registry, and adds
a paginated per-run export path for CSV. It is an amendment to tasks 3/4/7/8/9/10/11 above and is
listed separately so the scalability change set is explicit.

## Tasks

- [ ] 1. Run_Summary domain model
  - [ ] 1.1 Add `RunSummaryRecord` to `ingest/src/domain/records.ts`
    - Fields per design (labels incl. hidden `workflowId`, tracked metrics, availability flags);
      `workflowVersionName` normalized to `"(unversioned)"` when absent
    - _Requirements: 1.2, 1.3, 1.4_

- [ ] 2. Pure per-run rollup computation
  - [ ] 2.1 Implement `computeRunSummary(run, tasks, measuredSeries, now)` pure helper
    - Reuse `summarizeResources`/`intervals` for duration, CPU-hours, peak concurrency, task
      counts; derive mean/peak CPU and mean/peak memory (GiB) from measured series; set each
      Availability_Flag false when inputs absent (never zero)
    - _Requirements: 1.3, 1.4, 10.2, 10.4_
    - Property 2 (no zero fabrication), Property 10 (memory GiB)

- [ ] 3. Repository: Run_Summary persistence + keys
  - [ ] 3.1 Key derivations and item builder in `ingest/src/repository.ts`
    - `EntityType` += `"SUMMARY"`; `summarySk`, `groupGsi2Pk(name, version)` with delimiter-safe
      encoding, `groupGsi2Sk(stoppedAt)`; `buildSummaryItem` (metrics written only when defined,
      flags always written)
    - _Requirements: 2.1, 2.2_
    - Property 8 (key encoding safety)
  - [ ] 3.2 Idempotent `upsertSummary` with monotonic-`updatedAt` guard
    - _Requirements: 1.5_
    - Property 7 (idempotent summary upsert)

- [ ] 4. Ingest completion hook
  - [ ] 4.1 On Terminal_State, compute and persist exactly one Run_Summary, failure-isolated
    - Wire into existing terminal-state handling; one CloudWatch PromQL sweep for this run's
      utilization (reuse the signed read path); summary write must not fail/block the run/task
      upsert
    - _Requirements: 1.1, 1.5, 1.6_
    - Property 5 (version normalization)

- [ ] 5. CDK: GSI2 on the single table
  - [ ] 5.1 Add `GSI2` (`GSI2PK` hash, `GSI2SK` range) with projection covering summary attributes
    - `infra/lib/data-stack.ts`
    - _Requirements: 2.1, 2.2_

- [ ] 6. Backend aggregation helpers (pure)
  - [ ] 6.1 `aggregate(runs, metricKey)` → { mean, median, p90, availableCount, totalCount }
    - Compute only over available runs; p90 = fixed nearest-rank on sorted available values;
      unavailable-for-all → Metric_Unavailable_State
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
    - Property 1 (availability gating), Property 3 (percentile correctness), Property 4 (denominators)
  - [ ] 6.2 `detectCollision(runs)` → distinct `workflowId` count > 1
    - _Requirements: 6.1, 6.2_
    - Property 6 (collision detection)

- [ ] 7. Reports_Lambda + GraphQL surface
  - [ ] 7.1 Schema: `WorkflowGroup`, `AggregateMetric`, `RunPoint`, `WorkflowReport`,
        `listWorkflowGroups`, `getWorkflowReport` (Cognito-authorized)
    - `infra/graphql/schema.graphql`
    - _Requirements: 2.3, 2.4, 2.5_
  - [ ] 7.2 Reports_Lambda: `listWorkflowGroups` (group + counts + distinct workflowIds over window)
    - _Requirements: 2.3, 4.5_
  - [ ] 7.3 Reports_Lambda: `getWorkflowReport` (GSI2 range read → aggregate via task 6 helpers,
        outcomes, collision, timeline)
    - _Requirements: 2.4, 3.1, 3.5, 6.2_
  - [ ] 7.4 CDK ApiStack: Lambda data source, resolvers, least-privilege IAM (GSI2 read; CloudWatch
        only if the Lambda itself sweeps — else none)
    - _Requirements: 2.5_

- [ ] 8. Frontend API types + client
  - [ ] 8.1 Add `WorkflowGroup`/`AggregateMetric`/`RunPoint`/`WorkflowReport` types and
        `listWorkflowGroups`/`getWorkflowReport` client calls (+ local-mock entries)
    - `frontend/src/api/types.ts`, `frontend/src/api/client.ts`
    - _Requirements: 2.3, 2.4_

- [ ] 9. Reports_View
  - [ ] 9.1 New top-level route/nav item, distinct from fleet/run-detail
    - _Requirements: 4.1_
  - [ ] 9.2 Calendar range picker (default last 30 days) + workflow/version selectors from
        `listWorkflowGroups`; "(unversioned)" selectable
    - _Requirements: 4.2, 4.3, 4.5_
  - [ ] 9.3 Summary cards + time-series charts (mean/median/p90 distinguished); measured labels + GiB
    - _Requirements: 5.1, 5.2, 5.3, 5.5_
  - [ ] 9.4 Honesty affordances: Metric_Unavailable_State (no zeros/blanks) with N-of-M denominator;
        Collision_State badge; utilization-permission explanation; empty state
    - _Requirements: 4.4, 5.4, 6.2, 6.3, 10.3_

- [ ] 10. Exports
  - [ ] 10.1 CSV serializer (pure `toReportCsv`) — per-run rows + aggregate block; unavailable →
        empty/explicit (never zero); GiB memory columns; group labeled by name+version
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
    - Property 9 (CSV honesty)
  - [ ] 10.2 Client-side print-to-PDF: print stylesheet + trigger; renders cards+charts with group
        label, window, and collision/unavailable affordances
    - _Requirements: 8.1, 8.2, 8.3_

- [ ] 11. One-time backfill script
  - [ ] 11.1 `scripts/backfill-run-summaries.mjs` with `--dry-run`
    - Enumerate terminal runs; run-level facts from stored data; bounded CloudWatch sweep within
      retention else utilization unavailable; idempotent writes; rate-limited
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [ ] 12. Documentation
  - [ ] 12.1 Update `README.md` (new Reports feature + backfill script) and `scripts/README.md`
    - _Requirements: (docs for 9.x, 4.x)_

- [ ] 13. High-volume scalability (50k+ runs) — Requirement 11
  - [ ] 13.1 Group_Registry data model + repository
    - `EntityType` += `"GROUP"`; keys `GROUPS_PK = "GROUPS"`, `groupRegistrySk(name, version)`;
      `upsertGroupRegistry(name, version, workflowId)` — idempotent id-set-add + `lastSeen`
    - `ingest/src/repository.ts`
    - _Requirements: 11.4_
    - Property 14 (group registry equivalence)
  - [ ] 13.2 Maintain the Group_Registry from the completion hook + backfill
    - After the summary upsert (failure-isolated), upsert the registry for the run's
      `(name, version, workflowId)`; add the same call to `scripts/backfill-run-summaries.mjs`
    - `ingest/src/handler.ts`, `scripts/backfill-run-summaries.mjs`
    - _Requirements: 11.4_
  - [ ] 13.3 Pure fixed-size chart-series helpers
    - `buildDurationHistogram(values, maxBuckets)` (every available value in exactly one bucket,
      Σ bucket counts == availableCount, bucket count ≤ cap); `buildTimeBins(rows, window, maxBins)`
      (bounded bins, per-bin mean/p90 + run count); a streaming/bucketed median/p90 estimator for
      High_Volume with a documented error bound + `approximate` flag
    - `ingest/src/metrics/aggregate.ts` (extend)
    - _Requirements: 11.2, 11.6, 11.7_
    - Property 12 (histogram completeness), Property 13 (aggregate exactness at scale)
  - [ ] 13.4 Reports_Lambda: single-pass, size-bounded `getWorkflowReport`
    - Stream the GSI2 range once; compute exact stats + outcome counts + collision + fixed-size
      `durationHistogram` + `timeBins` + capped `sample` (Sample_Limit) + `sampleCapped`; never
      return one row per run
    - `ingest/src/reportsHandler.ts`
    - _Requirements: 11.1, 11.2, 11.3, 11.6_
    - Property 11 (bounded report payload)
  - [ ] 13.5 Reports_Lambda: `listWorkflowGroups` reads the Group_Registry (no scan)
    - Read the `GROUPS` partition instead of the `entityType = SUMMARY` scan
    - _Requirements: 11.4_
  - [ ] 13.6 Reports_Lambda + schema: paginated `listWorkflowRunPoints` for CSV
    - Add `RunPoint`/`RunPointConnection`, the `listWorkflowRunPoints(... limit, nextToken)` query,
      the resolver (GSI2 range with `nextToken`), and the ApiStack resolver wiring
    - `infra/graphql/schema.graphql`, `ingest/src/reportsHandler.ts`, `infra/lib/api-stack.ts`
    - _Requirements: 7.2, 11.3_
  - [ ] 13.7 Schema: extend `WorkflowReport` with `durationHistogram`, `timeBins`, `sample`,
        `sampleCapped`; add `HistogramBucket`/`MetricHistogram`/`TimeBin`
    - `infra/graphql/schema.graphql`
    - _Requirements: 11.1, 11.2_
  - [ ] 13.8 Frontend types + client for the scale surface
    - Add the new types; update `getWorkflowReport` selection to fetch histogram/timeBins/sample;
      add the paginated `listWorkflowRunPoints` client call; update local mock
    - `frontend/src/api/types.ts`, `frontend/src/api/client.ts`, `frontend/src/api/mockData.ts`
    - _Requirements: 11.1, 11.2, 11.3_
  - [ ] 13.9 Reports_View: replace per-run bar chart with fixed-size charts
    - Render the duration **Histogram** (bounded buckets) and/or **Time_Bins** trend from the
      server series (bounded element count); drop the one-bar-per-run chart; show an "approximate"
      label when a percentile is flagged approximate
    - `frontend/src/reports/ReportsView.tsx`
    - _Requirements: 5.2, 11.2, 11.5, 11.7_
    - Property 11 (bounded on-screen element count, view-level assertion)
  - [ ] 13.10 CSV export via the paginated per-run path
    - Fetch per-run rows through `listWorkflowRunPoints` (paged), append per page in `toReportCsv`;
      aggregate block still from the report
    - `frontend/src/reports/ReportsView.tsx`, `frontend/src/reports/reportCsv.ts`
    - _Requirements: 7.2, 11.3_

## Notes

- Every property test tagged `Feature: workflow-performance-reports, Property {n}`, ≥100 iterations,
  one test per property, matching the design's 14 properties (11–14 are the scale properties).
- No `cdk deploy` in these tasks; deployment is billable and requires explicit user approval.
- Memory is GiB everywhere; unavailable metrics are never zero-filled in any surface.
- Grouping/display by `(workflowName, workflowVersionName)`; `workflowId` stored hidden for
  collision detection only.
- High-volume rule (Req 11): the report payload and on-screen chart element count are bounded
  independent of run count; group enumeration is a Group_Registry read, not a table scan; the
  complete per-run dataset is reached only via the paginated CSV export path.
