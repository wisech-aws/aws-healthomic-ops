# Design Document

## Overview

This revision changes the Run Detail page (`frontend/src/rundetail/RunDetailView.tsx`) layout from the shipped two-column master-detail arrangement to a **full-width task DAG with a right-side fly-out detail panel**. The two-column layout shrank the DAG, left blank space beside it when nothing was selected, stacked tall utilization line charts above the logs in a narrow column, and produced sideways scrolling in the 2-up analysis grid. This revision:

- keeps the **DAG at full page width** as the primary element,
- shows a selected task's (or the run/engine logs') detail in a **right-side resizable fly-out** (the Cloudscape SplitPanel pattern) that opens on selection and closes to nothing,
- replaces the per-family time-series line charts with **compact peak-vs-limit bars** (`UtilizationBars`) so the log tail stays reachable,
- **relocates the run-level context** (resource summary + failed-tasks list) out of the (now-absent) side column into a full-width band, and
- stacks the **analysis sections in a single column** so nothing scrolls sideways.

This is a **presentation-only** revision. It recomposes existing components and pure helpers and changes no GraphQL API, client query surface, backend, or derived computation. The per-task metric join (`joinMetricsToTasks`) and chart shaping (`chartSeries`) are reused UNCHANGED; `UtilizationBars` derives peak/limit from `chartSeries` output. It builds on the shipped orientation strip, consolidated DAG toolbar, extracted `TaskDetailPanel`, honesty rules, and cross-zone deep-linking; only the layout and the metric visualization change.

## Architecture

The page keeps the shipped **orientation strip** (always visible) and **single-column analysis stack** (below), but replaces the two-column working area with a **full-width DAG + fly-out**.

### Zone 1 — Orientation strip (unchanged, always visible)

Run status badge, run name, progress (completed/total, elapsed HH:MM:SS), layer indicator, and — only when the run is FAILED — the failure banner (status detail + failure reason + Option-B engine error excerpt). Rendered regardless of selection or fly-out state, and above everything so run failure is never hidden. This is the shipped `RunOrientationStrip`, kept as-is.

### Zone 2 — Full-width DAG + run-level context band

- **DAG_Canvas (full width):** the task DAG (True_DAG / Inferred_DAG / Timeline_View via `selectLayer`) rendered at the full content width — no partial-width column. Its consolidated toolbar (node search, task-status legend, failed/cancelled quick-filter + count badge) stays attached (the shipped `DagToolbar`). A node click sets `selection = { kind: 'TASK', taskId, label }`.
- **Run-level context band (full width, below the DAG):** the derived `ResourceSummaryCard` and the failed-tasks list (with its per-task "view logs" deep link). In the shipped layout this was the detail column's default state; with no side column it moves to a full-width band so it is always reachable when nothing is selected — never blank space, never hidden behind a selection. (It remains rendered while the fly-out is open; the fly-out overlays/ docks beside it.)

### Zone 3 — Analysis stack (single column, collapsed)

The researcher's depth as collapsed-by-default `ExpandableSection`s, stacked in a **single column** (not a 2-up grid) so no section scrolls sideways:
- Estimated cost (`RunCostPanel`)
- Longest-running tasks
- Task queue-wait vs run-time timeline
- Inputs & outputs
- Run-level (non-task-scoped) measured utilization (`RunMetricsPanel`, e.g. `RUN_FILESYSTEM`, `taskId === null`) — stays here, not attributable to a node.

### The fly-out (Cloudscape AppLayout SplitPanel)

The fly-out uses the **real Cloudscape `SplitPanel`** hosted by the existing `AppLayout` in `App.tsx`, rather than a hand-rolled docked panel. This is the honest choice: a panel that presents as a native docked drawer must behave like one — keyboard focus management, the built-in side/bottom position toggle, the resize handle, persisted sizing, and screen-reader semantics — and Cloudscape's SplitPanel provides all of that (and its accessibility) natively. A re-implemented look-alike would inevitably diverge from those behaviors in ways users feel, which would be a subtle dishonesty (the UI promising "native drawer" and under-delivering) and would put accessibility compliance on us to hand-roll.

To avoid pushing run-detail internals into the shared shell, `AppLayout`'s split-panel props are exposed to the active content view through a small, view-agnostic **slot** on the `Dashboard` shell: the shell renders `AppLayout` and accepts an optional `splitPanel` node plus `splitPanelOpen` / `onSplitPanelToggle` from whichever view is active. `RunDetailView` fills that slot with a `SplitPanel` whose content is the `TaskDetailPanel`; the shell stays ignorant of the selection, the selected task, and the metrics join. `App.tsx` only forwards a node and open/toggle callbacks — a clean seam, not deep coupling. The fleet and params views pass no split panel, so their behavior is unchanged.

Wiring:
- `Dashboard` (App.tsx) gains optional props/slot: `splitPanel?: React.ReactNode`, `splitPanelOpen?: boolean`, `onSplitPanelToggle?: (open: boolean) => void`, forwarded straight to `AppLayout`'s `splitPanel` / `splitPanelOpen` / `onSplitPanelToggle`. When the active view supplies none, `AppLayout` renders without a split panel exactly as today.
- `RunDetailView` builds a `SplitPanel` (header names the selection, e.g. "Logs — task align" / "Logs — run & engine") wrapping `TaskDetailPanel`, and drives `splitPanelOpen` from `selection != null`. Because `RunDetailView` sits inside `AppLayout.content`, it surfaces this node/state up via the same slot mechanism the shell exposes (a render-prop or context provided by `Dashboard`), keeping selection ownership in `RunDetailView`.

Behavior:
- `selection === null` → SplitPanel closed (or unmounted); the run-level context band is the only "detail" on the page.
- selection becomes TASK or RUN_ENGINE → SplitPanel opens; the DAG stays full-width and interactive.
- user closes the SplitPanel (its native close, or `onSplitPanelToggle(false)`) → `selection = null`.
- a stale TASK selection (taskId no longer in the task list) → clear the selection and close the SplitPanel (no error, no empty task detail).

### Responsive behavior

Cloudscape's `SplitPanel` handles this natively: on wide viewports it docks to the side (or bottom, per the user's position toggle) and is resizable; on narrow viewports it collapses to a bottom drawer so its content is never squeezed into an unreadable sliver. The full-width DAG remains the primary element and stays rendered and interactive while the panel is open. Opening the panel from a deep link brings it into view via the panel's own open behavior. No content is hidden; only arrangement changes — and it is Cloudscape's tested responsive behavior, not a re-implementation.

## Components and Interfaces

### `TaskDetailPanel` (reused, extended)

The shipped presentational panel already renders, for a TASK selection: resource detail (incl. "Resource type unavailable") → task-scoped utilization → failure banner → `LogsPanel` stream=TASK; and for RUN_ENGINE: the run/engine logs tabs. Its `onClose` already clears the selection.

Change: swap the STAGE-2 task-scoped **line charts** for `UtilizationBars` (below). The `taskMetrics: TaskMetrics | null` prop is unchanged; only the child rendering the metrics changes. The ordering becomes: resource detail → **`UtilizationBars`** (compact) → failure banner → log tail — so the log tail sits close to the top of the scroll rather than beneath tall charts.

### `UtilizationBars` (new)

A compact, presentational peak-vs-limit view of a task's measured utilization, replacing the per-family `LineChart`s.

Props:
- `taskMetrics: TaskMetrics | null`

Behavior:
- Shapes the slice with `chartSeries(taskMetrics.series)` (UNCHANGED helper), yielding one `ChartSeriesPair` per family: `{ metricName, unit, actual: MetricPoint[] | null, limit: MetricPoint[] | null }`.
- For each family, derives from the measured `actual` points BOTH a **peak** (max of the point values) and a **mean** (arithmetic mean of the point values), and derives the **limit ceiling** from the `limit` points (max) when a limit series exists. Renders one compact horizontal bar per family showing peak and mean as EXPLICITLY LABELED values against the measured limit as the track — e.g. "CPU — peak 3.9 / mean 1.2 of 4 vCPU". This is a deliberate honesty choice: peak alone can look alarming for a brief spike, and mean alone hides the spike that may have caused an OOM/throttle; showing both, each labeled, tells the truth about the utilization shape without collapsing it into one misleading number. When no limit series was measured, the bar shows peak and mean with no track/ceiling (never a fabricated limit).
- **Memory units caveat carried forward.** The `MEMORY` family's displayed values carry the same units caveat the rest of the app applies to memory (`MEMORY_UNITS_UNCONFIRMED_NOTE` from `resourceSummary.ts` — "Memory unit is unconfirmed pending AWS documentation confirmation"). `UtilizationBars` MUST surface that note for the memory bar rather than presenting a converted memory value as authoritative, so the compact view is no less honest than the line charts it replaces.
- When `taskMetrics` is null OR yields no pairs, renders an explicit "utilization unavailable for this task" state (`data-testid="task-utilization-unavailable"`) — never a zero/placeholder bar.
- Values are formatted with the existing metric formatting helpers (`humanUnitLabel` / `prettifyMetricName` / `formatMetricValue`) reused from the metrics presentation layer, unchanged. Region testid `task-utilization`; per-bar testid `task-metric-bar-<taskId>-<metricName>`.

Honesty: peak, mean, and limit are computed ONLY from measured points; a family with no `actual` series shows no fabricated peak/mean, a family with no `limit` series shows no fabricated ceiling, memory carries its unconfirmed-units note, and an absent/empty slice shows the explicit "unavailable" state (Req 3.2, 3.3, 3.5, 8.4).

### Split-panel slot on the `Dashboard` shell (App.tsx)

A small, view-agnostic addition so the active content view can supply an `AppLayout` split panel without the shell knowing view internals. `Dashboard` accepts `splitPanel?: React.ReactNode`, `splitPanelOpen?: boolean`, and `onSplitPanelToggle?: (open: boolean) => void` (via a render-prop or a lightweight context) and forwards them to `AppLayout`. Views that supply nothing (fleet, params) render exactly as today. This is the only change to `App.tsx`, and it is generic — it carries no run-detail-specific types.

### `RunDetailView` (restructured)

- Owns selection state (`logsSelection`) and all fetches exactly as today.
- Renders zone 1 (orientation strip, unchanged), zone 2 (full-width DAG + full-width run-level context band), and zone 3 (single-column analysis stack).
- Supplies the `AppLayout` split panel through the shell slot: a `SplitPanel` wrapping `TaskDetailPanel`, with `splitPanelOpen` driven by `selection != null` and the panel's close/toggle clearing the selection.
- Computes the per-task metric join once (`joinMetricsToTasks(series, tasks)`) and passes the selected task's `TaskMetrics` slice to `TaskDetailPanel` (unchanged from the shipped Stage 2), which renders it via `UtilizationBars`.
- Stale-selection guard: when the selection is TASK and no matching task exists, clear the selection so the split panel closes.

### Cross-zone deep-linking (reused)

The failed-tasks "view logs" sets `selection = { kind: 'TASK', taskId }`; the failure-banner "view engine logs" sets `selection = { kind: 'RUN_ENGINE' }`. Both now OPEN the fly-out and bring it into view (the shipped `scrollIntoView` guard is retained; on a docked panel this focuses/opens rather than scrolling a bottom block).

## Data Models

No new persisted or wire data models. Consumes existing frontend types unchanged: `Task`, `MetricSeries` / `MetricPoint` / `MetricFamily` / `MetricRole` / `RunMetrics`, `TaskMetrics` (`{ taskId; series: MetricSeries[] }`), `ChartSeriesPair` (from `chartSeries`), the selection model (`{ kind: 'TASK'; taskId; label } | { kind: 'RUN_ENGINE' } | null`), and `RunCostEstimate`. No GraphQL schema, client query, or backend type changes.

## Correctness Properties

This is a presentation-only refactor; the pure helpers that carry quantifiable invariants (`joinMetricsToTasks`, `chartSeries`, `selectLayer`, `deriveMeasuredPresentation`, `deriveCostPresentation`) are unchanged and keep their existing tests. Two design-level invariants are stated formally below and enforced through `UtilizationBars` and `RunDetailView` component tests (see Testing strategy); the remaining design invariants follow.

### Property 1: UtilizationBars never fabricates a value

For any `TaskMetrics` slice, every peak, every mean, and every limit rendered by `UtilizationBars` is derived solely from measured `MetricPoint` values in that slice: a family with no `actual` series renders no peak/mean, a family with no `limit` series renders no ceiling, memory carries its unconfirmed-units note, and an empty/absent slice renders the explicit "utilization unavailable for this task" state. No zero or placeholder bar is ever produced.

**Validates: Requirements 3.3, 3.5, 8.4**

### Property 2: The fly-out is a total function of the selection

For every selection value the fly-out state is determined: `null` closes it; `{ kind: 'TASK', taskId }` with a matching task opens it on that task detail; `{ kind: 'RUN_ENGINE' }` opens it on the run/engine logs; a `{ kind: 'TASK' }` whose `taskId` is absent from the task list resolves to closed + `null`. No selection yields an error or a blank/stale panel.

**Validates: Requirements 2.1, 2.2, 2.9, 4.1**

## Design Invariants

- **DAG is full-width and never blank-padded.** The DAG renders at full content width; when the selection is null there is no reserved empty detail region beside it.
- **Fly-out is a total function of selection.** `selection === null` ⇒ fly-out closed; TASK/RUN_ENGINE ⇒ fly-out open rendering exactly that detail; close ⇒ selection null. A stale TASK selection resolves to closed + null, never an error or empty task detail.
- **Run-level context is always reachable.** The `ResourceSummaryCard` + failed-tasks list render in a full-width band regardless of fly-out state, so nothing selected never means nothing to see.
- **Compact, honest utilization.** `UtilizationBars` shows explicitly-labeled measured peak AND mean (and the measured limit when present), never a fabricated value, carries memory's unconfirmed-units note, and shows an explicit "unavailable" state when no series match — taking far less vertical space than line charts so the log tail stays reachable.
- **Failure visibility is selection-independent.** The orientation-strip failure banner renders for every selection and analysis state when the run is FAILED.
- **No content removed.** DAG, logs, resource summary, failed-tasks list, cost, longest-running, queue-wait timeline, inputs/outputs, run-level metrics all remain reachable; only arrangement, disclosure, and the task-metric visualization change.
- **Single-column analysis never scrolls sideways.** The analysis sections stack vertically; no 2-up grid.

## Error Handling

- Panels retain their own loading/error/unavailable/ready states: `RunMetricsPanel` (`deriveMeasuredPresentation`), `RunCostPanel` (`deriveCostPresentation`), `LogsPanel`. The layout change does not alter these.
- A `getErrorExcerpt` rejection inside `TaskDetailPanel` is caught and treated as "no excerpt available" — never fatal (preserved).
- A stale `taskId` selection closes the fly-out and clears the selection rather than erroring.
- `UtilizationBars` with an empty/absent slice renders the explicit unavailable state, never throwing.
- The fly-out's resize/close chrome is a no-op-safe presentation concern; it never blocks the DAG or the analysis stack.

## Testing strategy

- `UtilizationBars` unit tests: a slice with an actual+limit series renders a bar with the correct labeled peak AND mean and the correct limit ceiling; a slice with actual-only renders peak+mean with no fabricated limit; a MEMORY family bar surfaces the unconfirmed-units note; a null/empty slice renders the "utilization unavailable for this task" state; values use the shared formatting helpers.
- `TaskDetailPanel` tests: reworked so the task-scoped metric assertions target `UtilizationBars` (labeled peak/mean bars) instead of line charts, and assert the log tail renders close to the top (bars above logs, compact). Existing TASK/RUN_ENGINE/resource-detail/excerpt tests preserved.
- `RunDetailView` tests: reworked for the new structure — the DAG renders full-width (no detail column); selecting a node opens the fly-out (not a side column or bottom block); closing it clears the selection; the run-level context band renders regardless of fly-out state; deep links open the fly-out; the analysis sections are a single-column collapsed stack. Behavioral assertions (what a selection shows, deep-link targets, honest-unavailable states, selection-independent failure banner) preserved; only structural/position assertions change.
- Existing pure helpers (`joinMetricsToTasks`, `chartSeries`, `deriveMeasuredPresentation`, `deriveCostPresentation`, `selectLayer`) are unchanged and keep their current tests.

## Out of scope / non-goals

- No change to the GraphQL API, the client, or any backend (ingest/infra).
- No change to the derived resource summary, cost, or metrics computations; `UtilizationBars` derives its display from `chartSeries` output without modifying it.
- No change to the orientation strip's content or the failure-banner logic.
- Keeping the two-column master-detail layout (explicitly replaced by this revision).

## Relationship to the prior spec

This spec supersedes the layout decisions in `run-detail-master-detail` (the two-column master-detail arrangement and the task-scoped line charts). It retains and reuses that spec's shipped artifacts: the `RunOrientationStrip`, the consolidated `DagToolbar`, the extracted `TaskDetailPanel` (with its honesty/stale-selection handling), and the collapsed analysis sections — re-laying them out as full-width DAG + fly-out + single-column analysis, and swapping the line charts for `UtilizationBars`.
