# Implementation Plan: Run Detail Full-Width DAG + Fly-out

## Overview

This plan revises the Run Detail page layout from the shipped two-column master-detail arrangement
(`run-detail-master-detail`) to a **full-width task DAG with a right-side Cloudscape SplitPanel
fly-out**, a **full-width run-level context band**, **compact peak/mean utilization bars**
(replacing the task-scoped line charts), and a **single-column analysis stack** (replacing the 2-up
grid that scrolled sideways). It is a presentation-only revision: it recomposes existing components
and pure helpers and changes no GraphQL API, client query surface, backend, or derived computation.
The per-task metric join (`joinMetricsToTasks`) and chart shaping (`chartSeries`) are reused
UNCHANGED; `UtilizationBars` derives its display from `chartSeries` output.

It builds on the shipped artifacts and keeps them: the `RunOrientationStrip`, the consolidated
`DagToolbar`, the extracted `TaskDetailPanel` (with its honesty/stale-selection handling), and the
collapsed analysis sections — re-laying them out and swapping the line charts for `UtilizationBars`.

Tasks are ordered so each builds on prior ones: add the shell split-panel slot first (so the fly-out
has a host), build `UtilizationBars` and swap it into `TaskDetailPanel`, restructure `RunDetailView`
to the full-width DAG + run-level band + single-column analysis and wire the SplitPanel, preserve
deep-linking / honesty / stale-selection, rework the test suites, and finish with a scope guard +
build/lint/test verification (no deploy). Every element on the current page remains reachable after
the revision; only arrangement, disclosure, and the task-metric visualization change.

## Tasks

- [x] 1. Add a view-agnostic split-panel slot to the `Dashboard` shell
  - In `frontend/src/App.tsx`, add optional `splitPanel?: React.ReactNode`, `splitPanelOpen?: boolean`,
    and `onSplitPanelToggle?: (open: boolean) => void` to `Dashboard` and forward them straight to
    `AppLayout`'s `splitPanel` / `splitPanelOpen` / `onSplitPanelToggle`
  - Provide the slot to the active content view without the shell knowing view internals (a
    render-prop or lightweight context passed into the run-detail branch); when a view supplies none
    (fleet, params), `AppLayout` renders with no split panel exactly as today
  - Keep the addition generic: no run-detail-specific types in `App.tsx`
  - _Requirements: 2.3, 9.1, 9.2, 9.3_

  - [x]* 1.1 Write shell slot tests
    - The fleet and params views render with no split panel (unchanged); when a view supplies a
      `splitPanel` node and `splitPanelOpen`, `AppLayout` receives them
    - In `frontend/src/App.test.tsx`
    - _Requirements: 9.1, 9.2, 9.3_

- [x] 2. Build the `UtilizationBars` component
  - Create `frontend/src/rundetail/UtilizationBars.tsx`: a presentational component taking
    `taskMetrics: TaskMetrics | null`, shaping it with `chartSeries(taskMetrics.series)` (UNCHANGED)
  - For each family, derive from the measured `actual` points BOTH a peak (max) and a mean, and the
    limit ceiling from `limit` points (max) when present; render one compact horizontal bar per
    family showing peak AND mean as explicitly-labeled values against the measured limit as the track
    (e.g. "CPU — peak 3.9 / mean 1.2 of 4 vCPU"); when no limit was measured, show peak+mean with no
    ceiling — never a fabricated limit
  - Surface the memory unconfirmed-units note (`MEMORY_UNITS_UNCONFIRMED_NOTE` from
    `metrics/resourceSummary.ts`) on the `MEMORY` family bar; format values via the existing
    `humanUnitLabel` / `prettifyMetricName` / `formatMetricValue` helpers (unchanged)
  - When `taskMetrics` is null or yields no pairs, render an explicit "utilization unavailable for
    this task" state (`data-testid="task-utilization-unavailable"`) — never a zero/placeholder bar;
    region testid `task-utilization`, per-bar testid `task-metric-bar-<taskId>-<metricName>`
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 8.4_

  - [x]* 2.1 Write `UtilizationBars` tests
    - actual+limit renders labeled peak AND mean plus the correct limit ceiling; actual-only renders
      peak+mean with no fabricated limit; a MEMORY bar surfaces the unconfirmed-units note; a
      null/empty slice renders the "utilization unavailable for this task" state; values use the
      shared formatting helpers
    - In `frontend/src/rundetail/UtilizationBars.test.tsx`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 8.4_

- [x] 3. Swap `UtilizationBars` into `TaskDetailPanel`
  - In `frontend/src/rundetail/TaskDetailPanel.tsx`, replace the Stage-2 task-scoped line-chart
    rendering with `UtilizationBars`, keeping the `taskMetrics: TaskMetrics | null` prop unchanged
  - Order the TASK-selection content as: resource detail (incl. "Resource type unavailable") →
    `UtilizationBars` (compact) → failure banner → `LogsPanel` stream=TASK, so the log tail stays
    reachable without extended scrolling
  - Preserve the RUN_ENGINE tabs, the `getErrorExcerpt`-rejection "no excerpt" handling, and `onClose`
  - _Requirements: 2.6, 2.7, 2.8, 3.1, 3.4, 4.3_

  - [x]* 3.1 Rework `TaskDetailPanel` metric tests
    - Task-scoped metric assertions target `UtilizationBars` (labeled peak/mean bars) instead of line
      charts; assert the log tail renders below the compact bars (not beneath tall charts); preserve
      the existing TASK / RUN_ENGINE / resource-detail / excerpt tests
    - In `frontend/src/rundetail/TaskDetailPanel.test.tsx`
    - _Requirements: 2.6, 2.8, 3.1, 3.4_

- [x] 4. Restructure `RunDetailView` to a full-width DAG and single-column analysis
  - Render the DAG_Canvas (via `selectLayer`, with the consolidated `DagToolbar`) at full content
    width — remove the two-column `Grid` so no partial-width column or blank detail region remains
  - Move the run-level context (derived `ResourceSummaryCard` + failed-tasks list, with its per-task
    "view logs" deep link) into a full-width band below the DAG so it is always reachable when nothing
    is selected
  - Change the analysis sections from the 2-up grid to a single-column stack of collapsed-by-default
    `ExpandableSection`s (estimated cost, longest-running tasks, queue-wait vs run-time timeline,
    inputs & outputs, run-level measured utilization); remove no content
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 4.2, 6.1, 6.2, 6.3, 6.4_

- [x] 5. Wire the SplitPanel fly-out into `RunDetailView`
  - Build a Cloudscape `SplitPanel` (header naming the selection, e.g. "Logs — task <name>" /
    "Logs — run & engine") wrapping `TaskDetailPanel`, and supply it plus `splitPanelOpen`
    (driven by `selection != null`) and an `onSplitPanelToggle` that clears the selection through the
    `Dashboard` shell slot from task 1
  - Selecting a DAG node (or a deep link) opens the panel; closing it (native close or toggle) sets
    the selection to `null`; the full-width DAG stays rendered and interactive while the panel is open
  - Pass the selected task's `TaskMetrics` slice (`joinMetricsToTasks(series, tasks).matched` matched
    by `taskId`, else `null`) into `TaskDetailPanel` for `UtilizationBars`
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.1_

- [x] 6. Preserve cross-zone deep-linking and stale-selection handling through the new structure
  - The failed-tasks "view logs" sets `selection = { kind: 'TASK', taskId }` and opens the SplitPanel;
    the failure-banner "view engine logs" sets `selection = { kind: 'RUN_ENGINE' }` and opens it; the
    opened panel is brought into view (retain the `scrollIntoView` guard, no-op when unsupported)
  - A selection referencing a `taskId` no longer present in the task list clears the selection and
    closes the panel rather than erroring or showing an empty task detail
  - Keep the orientation strip and its selection-independent failure banner exactly as shipped
  - _Requirements: 2.9, 4.1, 5.1, 5.2, 5.3, 7.1, 7.2, 7.3, 7.4_

- [x] 7. Preserve honesty / non-fabrication across the revision
  - The derived `ResourceSummaryCard` renders unconditionally and is never blanked by a
    measured-metrics outcome; failure detail and error excerpts render only when real
  - `RunMetricsPanel`, `RunCostPanel`, and `LogsPanel` retain their own loading / error / unavailable
    / ready states through the layout change
  - `UtilizationBars` shows only measured peak/mean/limit values with the memory units caveat, never a
    fabricated value, and the explicit "unavailable" state when no series match
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 8. Rework the `RunDetailView` test suite for the full-width + fly-out structure
  - Assert: the DAG renders full-width (no detail column and no reserved blank region when the
    selection is null); selecting a node opens the SplitPanel fly-out (not a side column or appended
    bottom block) and closing it clears the selection; the run-level context band (resource summary +
    failed-tasks list) renders regardless of fly-out state; the failed-tasks "view logs" and
    failure-banner "view engine logs" deep links open the fly-out; the analysis sections are a
    single-column collapsed stack
  - Preserve behavioral assertions (what a selection shows, deep-link targets, honest-unavailable
    states, selection-independent failure banner); change only structural/position assertions
  - In `frontend/src/rundetail/RunDetailView.test.tsx`
  - _Requirements: 1.1, 1.5, 2.1, 2.2, 2.4, 4.2, 5.1, 5.2, 6.2_

- [x] 9. Scope guard and verification (no deploy)
  - Confirm the change is presentation-only: no edits to the GraphQL API, the client query surface,
    any backend (ingest/infra), or the derived resource summary / cost / metrics computations
    (`joinMetricsToTasks`, `chartSeries`, `deriveMeasuredPresentation`, `deriveCostPresentation`,
    `selectLayer`, `resourceSummary`)
  - Run the frontend suite and ensure it is green, fixing any breakage:
    `cd frontend && npm run build && npm run lint && npx vitest run`
  - Ask the user if questions arise
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core
  implementation tasks are never optional.
- This is a presentation-only revision: no GraphQL API, client query surface, backend, or derived
  computation changes (Requirement 9). `joinMetricsToTasks`, `chartSeries`, `formatMetricValue`,
  `resourceSummary` (incl. `MEMORY_UNITS_UNCONFIRMED_NOTE`), `deriveMeasuredPresentation`,
  `deriveCostPresentation`, and `selectLayer` are reused unchanged.
- The design's "Correctness Properties" (UtilizationBars never fabricates; the fly-out is a total
  function of the selection) are enforced through the `UtilizationBars`, `TaskDetailPanel`, and
  `RunDetailView` component tests rather than stand-alone property-based tests — this is a
  presentation refactor with no new pure helper carrying a large-input-space invariant.
- No deployment tasks are included; deploys are a separate human decision. Task 9 is a local,
  non-deploy verification only.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2"] },
    { "id": 1, "tasks": ["1.1", "2.1", "3"] },
    { "id": 2, "tasks": ["3.1", "4"] },
    { "id": 3, "tasks": ["5"] },
    { "id": 4, "tasks": ["6", "7"] },
    { "id": 5, "tasks": ["8"] },
    { "id": 6, "tasks": ["9"] }
  ]
}
```
