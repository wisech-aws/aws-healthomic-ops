# Requirements Document

## Introduction

This feature revises the Run Detail page (`frontend/src/rundetail/RunDetailView.tsx`) layout, replacing the two-column master-detail arrangement with a **full-width task DAG** and a **fly-out detail panel**. The two-column layout shrank the DAG (the primary element), left a blank region beside it when nothing was selected, pushed a selected task's logs far down the column beneath tall utilization charts, and forced sideways scrolling in the 2-up analysis grid. This revision keeps the DAG full-width, presents a selected task's detail in a right-side resizable fly-out panel over the DAG, replaces the tall time-series utilization charts with a compact peak-vs-limit representation, and stacks the analysis sections in a single column so nothing scrolls sideways.

It is a presentation-only revision: it recomposes existing components and pure helpers and changes no GraphQL API, client query surface, backend, or derived computation. It builds on the shipped orientation strip, consolidated DAG toolbar, extracted `TaskDetailPanel`, honesty/non-fabrication rules, and cross-zone deep-linking; only the layout and the metric visualization change.

## Glossary

- **Run_Detail_Page**: The revised Run Detail view rendered by `RunDetailView`.
- **Orientation_Strip**: The always-visible header zone showing run status, name, progress, layer indicator, and — when the run is FAILED — the failure banner. (Unchanged from the shipped layout.)
- **DAG_Canvas**: The task DAG (True_DAG / Inferred_DAG / Timeline_View via the existing `selectLayer`) rendered at full page width, including its consolidated toolbar (node search, task-status legend, failed/cancelled quick-filter + count badge).
- **Detail_Flyout**: The right-side resizable panel that flies out over the page to show the selection's detail. Implemented with the Cloudscape SplitPanel pattern docked to the right.
- **Analysis_Stack**: The progressive-disclosure analysis sections, collapsed by default, stacked in a single column below the DAG_Canvas.
- **Selection**: The current selection value, one of `null` (no selection), `{ kind: 'TASK', taskId }`, or `{ kind: 'RUN_ENGINE' }`.
- **Resource_Summary_Card**: The derived `ResourceSummaryCard` computed from task data, independent of measured metrics.
- **Task_Metrics**: The per-task metric slice produced by `joinMetricsToTasks(series, tasks).matched` for a given `taskId`.
- **Utilization_Bars**: A compact peak-vs-limit representation of a task's measured utilization — one horizontal bar per metric family showing the measured peak against the allocated limit — replacing the tall time-series line charts.

## Requirements

### Requirement 1: Full-width DAG as the primary element

**User Story:** As an operator, I want the task DAG to occupy the full page width, so that I can read topology and pick nodes without the graph being shrunk into a column.

#### Acceptance Criteria

1. THE DAG_Canvas SHALL render at the full width of the page content area, not constrained to a partial-width column.
2. THE DAG_Canvas SHALL render the True_DAG, Inferred_DAG, or Timeline_View selected by the existing `selectLayer` function.
3. THE DAG_Canvas SHALL present its node search, task-status legend, and failed/cancelled quick-filter with its count badge as a toolbar on the DAG.
4. WHEN a user clicks a task node in the DAG_Canvas, THE Run_Detail_Page SHALL set the Selection to `{ kind: 'TASK', taskId }` for that node's task.
5. WHILE the Selection is `null`, THE Run_Detail_Page SHALL NOT reserve blank space beside the DAG_Canvas for a detail region.

### Requirement 2: Fly-out detail panel

**User Story:** As an operator, I want a task's detail to fly out over the DAG when I select it, so that I get detail on demand without permanently shrinking the DAG or seeing empty space when nothing is selected.

#### Acceptance Criteria

1. WHILE the Selection is `null`, THE Detail_Flyout SHALL be closed.
2. WHEN the Selection becomes `{ kind: 'TASK', taskId }` or `{ kind: 'RUN_ENGINE' }`, THE Detail_Flyout SHALL open.
3. THE Detail_Flyout SHALL be dockable to the right side of the page and SHALL be resizable by the user.
4. WHEN a user closes the Detail_Flyout, THE Run_Detail_Page SHALL clear the Selection to `null`.
5. WHILE the Detail_Flyout is open, THE DAG_Canvas SHALL remain rendered and interactive.
6. WHILE the Selection is `{ kind: 'TASK', taskId }`, THE Detail_Flyout SHALL render that task's resource detail (cpus, memory, and instance type), the task's Utilization_Bars, the task's failure excerpt when present, and that task's logs.
7. IF a selected task has no instance type, THEN THE Detail_Flyout SHALL render an explicit "Resource type unavailable" affordance.
8. WHILE the Selection is `{ kind: 'RUN_ENGINE' }`, THE Detail_Flyout SHALL render the run logs and engine logs tabs.
9. IF the Selection references a `taskId` no longer present in the task list, THEN THE Run_Detail_Page SHALL close the Detail_Flyout and clear the Selection rather than erroring.

### Requirement 3: Compact task utilization representation

**User Story:** As an operator, I want a selected task's measured utilization shown compactly, so that I can read resource behavior without the visualization consuming the panel and pushing the logs far down.

#### Acceptance Criteria

1. WHEN a task is selected and its Task_Metrics contains matching metric series, THE Detail_Flyout SHALL render the task's Utilization_Bars, one bar per metric family present, above the task's log tail.
2. THE Utilization_Bars SHALL, for each metric family, show the measured peak value and — WHERE a limit series was measured for that same family — the allocated limit for comparison.
3. WHERE a metric family has no measured limit series, THE Utilization_Bars SHALL show the peak without fabricating a limit.
4. THE Utilization_Bars SHALL occupy substantially less vertical space than a per-family time-series line chart, keeping the task's log tail reachable without extended scrolling.
5. WHEN a task is selected and its Task_Metrics contains no matching metric series, THE Detail_Flyout SHALL render an explicit "utilization unavailable for this task" state rather than a zero or placeholder bar.

### Requirement 4: Selection-driven detail, totally

**User Story:** As an operator, I want the fly-out to always reflect my current selection, so that I never see stale or blank detail.

#### Acceptance Criteria

1. FOR ALL Selection values, THE Detail_Flyout SHALL render exactly one of: task detail (TASK) or run/engine logs (RUN_ENGINE); AND SHALL be closed when the Selection is `null`.
2. THE Run_Detail_Page SHALL surface the run-level context — the Resource_Summary_Card and the failed-tasks list — outside the Detail_Flyout so it is reachable when no task is selected.
3. IF the failure error-excerpt lookup rejects, THEN THE Detail_Flyout SHALL treat the result as "no excerpt available" without failing the panel.

### Requirement 5: Cross-zone deep-linking

**User Story:** As an operator, I want failure and failed-task links to open the relevant detail in the fly-out, so that I move from "why did it fail" to the evidence in one click.

#### Acceptance Criteria

1. WHEN a user activates a failed task's "view logs" action, THE Run_Detail_Page SHALL set the Selection to `{ kind: 'TASK', taskId }` for that task and open the Detail_Flyout.
2. WHEN a user activates the failure banner's "view engine logs" action, THE Run_Detail_Page SHALL set the Selection to `{ kind: 'RUN_ENGINE' }` and open the Detail_Flyout.
3. WHEN the Detail_Flyout opens from a deep-link action, THE Run_Detail_Page SHALL bring the opened detail into view.

### Requirement 6: Single-column analysis sections

**User Story:** As a researcher, I want the analysis sections stacked in one column, so that I can read each without scrolling sideways.

#### Acceptance Criteria

1. THE Analysis_Stack SHALL render below the DAG_Canvas as a single-column stack and SHALL include the estimated cost section, the longest-running tasks section, the task queue-wait versus run-time timeline section, the inputs and outputs section, and the run-level (non-task-scoped) measured utilization section.
2. THE Analysis_Stack sections SHALL be collapsed by default.
3. THE Analysis_Stack SHALL NOT require horizontal scrolling to view any section's content at supported viewport widths.
4. THE Run_Detail_Page SHALL keep every element present on the current page reachable after the revision, removing no content.

### Requirement 7: Always-visible orientation strip and selection-independent failure banner

**User Story:** As an operator, I want run status, progress, and failure detail to stay visible regardless of what I have selected, so that I keep orientation and never have run failure hidden.

#### Acceptance Criteria

1. THE Orientation_Strip SHALL render the run status badge, the run name, the progress indicator (completed/total task counts and elapsed time formatted as HH:MM:SS), and the current layer indicator badge.
2. WHILE any Selection value is active and the Detail_Flyout is open or closed, THE Orientation_Strip SHALL remain rendered.
3. WHILE the run status is FAILED, THE Orientation_Strip SHALL render the failure banner (status message + failure reason + Option-B engine error excerpt when found) for every Selection value.
4. WHERE the run status is not FAILED, THE Orientation_Strip SHALL NOT render the failure banner.

### Requirement 8: Honesty and non-fabrication preserved

**User Story:** As a user relying on this page for incident response, I want the page to show only real derived and measured data, so that I never mistake a placeholder for an actual result.

#### Acceptance Criteria

1. THE Resource_Summary_Card SHALL render unconditionally and SHALL NOT be blanked by any measured-metrics outcome.
2. THE Run_Detail_Page SHALL render failure detail and error excerpts only when real failure data is present.
3. THE estimated cost, run-level measured utilization, and logs panels SHALL each retain their own loading, error, unavailable, and ready states.
4. THE Utilization_Bars SHALL show only measured values, never a fabricated peak or limit.

### Requirement 9: Presentation-only scope constraint

**User Story:** As a maintainer, I want this revision confined to presentation, so that data plumbing, contracts, and infrastructure remain untouched and low-risk.

#### Acceptance Criteria

1. THE Run_Detail_Page change SHALL NOT modify the GraphQL API.
2. THE Run_Detail_Page change SHALL NOT modify the client query surface.
3. THE Run_Detail_Page change SHALL NOT modify any backend, including ingest and infrastructure.
4. THE Run_Detail_Page change SHALL NOT modify the derived resource summary, cost, or metrics computations (`joinMetricsToTasks`, `chartSeries`, `deriveMeasuredPresentation`, `deriveCostPresentation`, `selectLayer`).
