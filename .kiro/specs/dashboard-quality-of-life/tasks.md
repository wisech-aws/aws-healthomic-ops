# Implementation Plan: Dashboard Quality-of-Life Enhancements

## Overview

This plan implements nine frontend-only quality-of-life enhancements as a thin layer of pure, testable helper modules that the existing React views consume. Every value is derived client-side from data already fetched by `listRuns`, `getRun`, and `listTasksForRun` — no ingestion, GraphQL, or CDK changes, and no fabricated data.

The plan is ordered so that shared timing primitives come first, then the pure analytics/filter helpers that depend on them (each with unit tests and fast-check property tests matching the existing `*.test.ts` convention), then the React view integrations that consume those helpers. Language: TypeScript throughout (the design and codebase are React + TypeScript). Property tests use `fast-check` 4.9.0, already a frontend dev dependency, and test factories follow `frontend/src/taskview/testFactories.ts`.

Verification uses the frontend toolchain from `frontend/`: `npm run lint`, `npm run build`, and `npm test`.

## Tasks

- [x] 1. Extend shared duration primitives in `frontend/src/fleet/duration.ts`
  - [x] 1.1 Add numeric and task-aware duration primitives
    - Add `durationMs(startedAt, stoppedAt, now?)` returning `null` when `startedAt` is absent/unparseable, else `max(0, resolvedEnd − start)` where `resolvedEnd` is `stoppedAt` when parseable else `now`
    - Add `isRunning(startedAt, stoppedAt)` (started but not stopped)
    - Add `taskDuration(task, now?)` formatted `HH:MM:SS` wrapper reusing `runDuration`
    - Leave existing `formatDuration`, `runDuration`, `formatStartTime` unchanged
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 10.1, 10.3_

  - [x]* 1.2 Write property test for duration primitives in `frontend/src/fleet/duration.test.ts`
    - **Property 1: Duration is non-negative, monotone, and honest about the unknown**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 10.1, 10.3**

  - [x]* 1.3 Write unit tests for duration edge cases in `frontend/src/fleet/duration.test.ts`
    - Cover equal start/stop, stop-before-start (clamp to 0), running item vs fixed `now`, absent/unparseable `startedAt`
    - _Requirements: 1.2, 1.3, 1.4_

- [x] 2. Implement interval model and overlap sweep in `frontend/src/metrics/intervals.ts`
  - [x] 2.1 Implement `toIntervals` and `peakConcurrent`
    - `toIntervals(tasks, now?)`: include exactly tasks with a parseable `startedAt`; end = `stoppedAt` when present else `now` with `open = true`; clamp inverted intervals to `end = start`; carry `cpus`/`memory` (null when absent)
    - `peakConcurrent(intervals, weight)`: boundary sweep, ends processed before starts at equal timestamp (half-open `[start, end)`); return `{peakCount, peakWeight}`, `0` for empty input
    - _Requirements: 2.1, 2.2, 2.3, 10.1, 10.3, 10.4_

  - [x]* 2.2 Write property test for interval construction in `frontend/src/metrics/intervals.test.ts`
    - **Property 2: Intervals never fabricate execution**
    - **Validates: Requirements 2.1, 10.1, 10.3, 10.4**

  - [x]* 2.3 Write property test for peak concurrency in `frontend/src/metrics/intervals.test.ts`
    - **Property 3: Peak concurrency equals the true overlap maximum**
    - **Validates: Requirements 2.2, 2.3, 11.3**

- [x] 3. Implement resource summary in `frontend/src/metrics/resourceSummary.ts`
  - [x] 3.1 Implement `summarizeResources`
    - Compute `peakConcurrentTasks`, `peakConcurrentCpus`, `cpuHours`, `peakConcurrentMemory` from `toIntervals` + `peakConcurrent`
    - Each `ResourceMetric` reports `available: false`, `value: null` when its input field is absent on all started tasks (never 0-as-data)
    - `cpuHours = Σ (durationMs(i)/3_600_000 × i.cpus)` over intervals with non-null `cpus`
    - Set `partial: true` when any interval is `open`
    - Attach the unconfirmed-units note to `peakConcurrentMemory`; compute memory as a unit-agnostic sum over concurrent intervals with no unit conversion
    - _Requirements: 2.4, 2.5, 2.6, 2.7, 10.1, 10.4, 11.1, 11.2, 11.3_

  - [x]* 3.2 Write property test for metric availability in `frontend/src/metrics/resourceSummary.test.ts`
    - **Property 4: Resource metrics are available exactly when their inputs exist**
    - **Validates: Requirements 2.5, 2.6, 2.7, 10.1, 10.4**

  - [x]* 3.3 Write property test for CPU-hours area in `frontend/src/metrics/resourceSummary.test.ts`
    - **Property 5: CPU-hours equals the summed area**
    - **Validates: Requirements 2.4**

  - [x]* 3.4 Write unit test for the peak-memory unconfirmed-units caveat in `frontend/src/metrics/resourceSummary.test.ts`
    - Assert `peakConcurrentMemory.note` always states the unit is unconfirmed and the raw value is never unit-converted (CONFIRM AGAINST AWS DOCS caveat)
    - _Requirements: 11.1, 11.2, 11.3_

- [x] 4. Implement task ranking / slowest-step in `frontend/src/metrics/taskRanking.ts`
  - [x] 4.1 Implement `rankByDuration`, `topLongest`, `slowestTaskId`
    - `rankByDuration`: one entry per task; known-duration entries precede unknown; known sorted non-increasing by `durationMs`; 1-based non-decreasing ranks; running tasks ranked by elapsed-so-far and flagged
    - `topLongest(tasks, n=5, now?)`: top-N known-duration tasks, never unknown-duration
    - `slowestTaskId(tasks, now?)`: rank-1 known-duration `taskId` (ties → earliest `startedAt`), or `null` when none
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7_

  - [x]* 4.2 Write property test for ranking order in `frontend/src/metrics/taskRanking.test.ts`
    - **Property 6: Ranking is a stable total order with unknowns last**
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [x]* 4.3 Write property test for slowest-task argmax in `frontend/src/metrics/taskRanking.test.ts`
    - **Property 7: Slowest id is the argmax of duration**
    - **Validates: Requirements 3.4, 3.5**

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement task state-transition segments in `frontend/src/metrics/taskSegments.ts`
  - [x] 6.1 Implement `segmentsFor` and `segmentsForAll`
    - `runTimeMs = durationMs(startedAt, stoppedAt, now)`; `queueWaitMs = durationMs(createdAt, startedAt)` with no `now` fallback; each `null` when bounding timestamps absent/unparseable
    - `running = isRunning(startedAt, stoppedAt)`
    - `confidence = 'unconfirmed'` whenever `queueWaitMs` is non-null, else `'confirmed'`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 12.1, 12.2, 12.4_

  - [x]* 6.2 Write property test for segment partitioning in `frontend/src/metrics/taskSegments.test.ts`
    - **Property 14: Segments partition a task's timeline without fabrication**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 12.1, 12.2**

- [x] 7. Implement parameters diff in `frontend/src/params/paramsDiff.ts`
  - [x] 7.1 Implement `parseParameters` and `diffRunParameters`
    - `parseParameters`: parse JSON string to object, `null` on failure; null/empty treated as empty object (no error)
    - Flatten nested objects to dotted-path keys; one entry per key in the union, sorted by key
    - Classify `added`/`removed`/`unchanged` (deep-equal)/`changed`; set `leftParseError`/`rightParseError` for non-empty non-JSON strings; set `sameWorkflow`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 10.1, 10.3_

  - [x]* 7.2 Write property test for diff completeness and symmetry in `frontend/src/params/paramsDiff.test.ts`
    - **Property 12: Parameters diff is complete, sound, and symmetric in structure**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

  - [x]* 7.3 Write property test for parse-error surfacing in `frontend/src/params/paramsDiff.test.ts`
    - **Property 13: Parse errors are surfaced, not swallowed**
    - **Validates: Requirements 6.5, 6.6, 10.1, 10.3**

- [x] 8. Implement fleet filtering/sorting/grouping in `frontend/src/fleet/runFilters.ts`
  - [x] 8.1 Implement `applyFleetControls`, `workflowOptions`, `groupByEngineVersion`
    - `applyFleetControls`: filter by status set and `workflowId` (null => all) without mutating input; `recency` delegates to existing `compareRuns`; `duration` sorts by `durationMs` with unknowns last, ties by `compareRuns`, honoring `direction`
    - `workflowOptions`: distinct, sorted workflow options present in the runs
    - `groupByEngineVersion`: partition runs by `engineVersion` (absent => single `null` group), preserving input order within each group
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 7.3, 7.4_

  - [x]* 8.2 Write property test for filtering and input preservation in `frontend/src/fleet/runFilters.test.ts`
    - **Property 9: Fleet filtering selects exactly the matching runs and preserves the input**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

  - [x]* 8.3 Write property test for sort total order in `frontend/src/fleet/runFilters.test.ts`
    - **Property 10: Fleet sorting is a deterministic total order**
    - **Validates: Requirements 5.5, 5.6**

  - [x]* 8.4 Write property test for engine-version grouping in `frontend/src/fleet/runFilters.test.ts`
    - **Property 11: Engine grouping partitions the runs**
    - **Validates: Requirements 7.3, 7.4**

- [x] 9. Implement stale-run detection in `frontend/src/fleet/staleness.ts`
  - [x] 9.1 Implement `NON_TERMINAL_STATUSES` and `evaluateStaleness`
    - `stale = true` iff status is non-terminal, `updatedAt` parseable, and `now − updatedAt > thresholdMs` (default 1 hour, must be > 0)
    - Terminal status => `stale: false, reason: 'terminal'`; unparseable `updatedAt` => `stale: false, reason: 'unknown'`; else `reason: 'active-no-progress'`; report `ageMs`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.1, 10.3_

  - [x]* 9.2 Write property test for staleness in `frontend/src/fleet/staleness.test.ts`
    - **Property 15: Staleness flags only quiet non-terminal runs**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 10.1, 10.3**

- [x] 10. Checkpoint - Ensure all helper tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement failed-task filter predicate and wire it into `frontend/src/rundetail/RunDetailView.tsx`
  - [x] 11.1 Add the failed/cancelled task predicate and count in RunDetailView
    - Add a pure predicate selecting exactly tasks whose `status` is `FAILED` or `CANCELLED`
    - Wire a quick filter toggle and a count badge equal to the selection size
    - _Requirements: 4.1, 4.2_

  - [x]* 11.2 Write property test for the failed-task predicate in `frontend/src/rundetail/RunDetailView.test.tsx` (or colocated helper test)
    - **Property 8: Failed filter selects exactly the failed/cancelled tasks**
    - **Validates: Requirements 4.1, 4.2**

- [x] 12. Extend DAG layout to highlight the slowest node in `frontend/src/rundetail/graphLayout.ts`
  - [x] 12.1 Add slowest-node highlight support
    - Accept an optional slowest `taskId` and mark that node as highlighted in the layout output; no-op when `null`
    - _Requirements: 3.6, 3.7_

  - [x]* 12.2 Write unit tests for slowest-node highlight in `frontend/src/rundetail/graphLayout.test.ts`
    - Assert the identified node is highlighted and no node is highlighted when id is `null`
    - _Requirements: 3.6_

- [x] 13. Integrate analytics panels into `frontend/src/rundetail/RunDetailView.tsx`
  - [x] 13.1 Wire duration, resource summary, longest-tasks, timeline, and engine badge into RunDetailView
    - Add per-task duration column via `taskDuration` (#1)
    - Add resource summary card via `summarizeResources`, showing "unavailable" states and the memory units caveat, and a partial indicator when provisional (#2, #11)
    - Add longest-running tasks list via `topLongest` and slowest-node DAG highlight via `slowestTaskId` + extended `graphLayout`, labeled "longest-running tasks" not "critical path" (#3)
    - Add per-task queue-wait vs run-time timeline via `segmentsForAll`, rendering queue-wait under the unconfirmed `createdAt` caveat and run-time without it (#8, #12)
    - Add engine version badge on the run header via `engineVersion`, with Unknown_State when absent (#7)
    - Use the existing injectable-data-function prop pattern
    - _Requirements: 1.1, 1.2, 1.3, 2.7, 3.6, 3.7, 7.1, 7.2, 8.4, 10.4, 11.1, 12.3, 12.4_

  - [x]* 13.2 Write view integration tests for RunDetailView panels in `frontend/src/rundetail/RunDetailView.test.tsx`
    - Assert resource card shows "unavailable" when tasks lack `cpus`; slowest node highlighted on DAG; queue-wait rendered under the unconfirmed caveat; engine badge shows Unknown_State when absent
    - _Requirements: 2.5, 3.6, 7.2, 12.3_

- [x] 14. Implement the parameters diff view in `frontend/src/params/ParamsDiffView.tsx`
  - [x] 14.1 Build the two-run parameters diff view
    - Render `diffRunParameters` entries with added/removed/changed/unchanged styling
    - Show a parse-error notice per side when flagged and a cross-workflow warning when `sameWorkflow` is false
    - Use the existing injectable-data-function prop pattern
    - _Requirements: 6.5, 6.7_

  - [x]* 14.2 Write view integration tests for ParamsDiffView in `frontend/src/params/ParamsDiffView.test.tsx`
    - Assert cross-workflow warning renders and a per-side parse-error notice renders on unparseable parameters
    - _Requirements: 6.5, 6.7_

- [x] 15. Integrate fleet controls, engine grouping, and stale badge into `frontend/src/fleet/FleetView.tsx`
  - [x] 15.1 Wire duration column, filter/sort controls, engine grouping, and stale badge into FleetView
    - Add a run duration column via `durationMs`/`runDuration` (#1)
    - Add status + workflow filters (options from `workflowOptions`) and recency/duration sort via `applyFleetControls` (#5)
    - Add an engine-version grouped render via `groupByEngineVersion` (#7)
    - Add a stale-run warning badge per row via `evaluateStaleness` (#9)
    - Use the existing injectable-data-function prop pattern
    - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 5.5, 7.3, 7.4, 9.1_

  - [x]* 15.2 Write view integration tests for FleetView controls in `frontend/src/fleet/FleetView.test.tsx`
    - Assert the duration column and stale badge render for representative runs and that filtering/sorting/grouping reflect the injected data
    - _Requirements: 1.1, 5.1, 7.3, 9.1_

- [x] 16. Wire the ParamsDiffView entry point into navigation (`frontend/src/App.tsx`)
  - [x] 16.1 Add routing/navigation to reach ParamsDiffView with two selected runs
    - Add the route/link so two runs can be compared; pass runs via the existing data-function/prop pattern
    - _Requirements: 6.7_

- [x] 17. Final checkpoint - Ensure lint, build, and tests pass
  - Run `npm run lint`, `npm run build`, and `npm test` in `frontend/`; fix any failures. Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- Each task references specific requirement sub-clauses and, where applicable, a numbered correctness property from the design for traceability.
- Property tests use `fast-check` 4.9.0 (already a frontend dev dependency) and follow the `testFactories.ts` pattern; unit and property tests are complementary.
- Requirements 11 (memory units) and 12 (`createdAt` queue-wait) are the two CONFIRM-AGAINST-AWS-DOCS caveats and are surfaced explicitly in tasks 3.4 (units note) and 13.1/13.2 (queue-wait caveat rendering).
- Checkpoints ensure incremental validation with the frontend build/lint/test commands.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "4.1", "6.1", "7.1", "8.1", "9.1", "12.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.1", "4.2", "4.3", "6.2", "7.2", "7.3", "8.2", "8.3", "8.4", "9.2", "12.2"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "11.1", "14.1"] },
    { "id": 4, "tasks": ["13.1", "14.2", "15.1"] },
    { "id": 5, "tasks": ["11.2", "13.2", "15.2", "16.1"] }
  ]
}
```
