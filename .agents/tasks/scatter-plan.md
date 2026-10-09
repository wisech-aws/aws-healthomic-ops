# Implementation Plan — Interactive per-run duration scatter in Reports

Worktree root: `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter`
Frontend root: `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/frontend`
Branch: `reports-run-scatter`. Pure frontend. No backend/GraphQL/schema/IAM change, no new npm dependency.
Scripts (run from the frontend root): `npm run build` (`tsc --noEmit && vite build`), `npm test` (`vitest run`), `npm run lint` (`eslint .`).

Node modules are NOT installed in the worktree. The worktree shares the pinned versions of the sibling `frontend/` checkout; the loop must `npm ci`/`npm install` in the worktree frontend before building if `node_modules` is absent. Verification commands below assume dependencies are installed.

## Key design decisions (verified against code, not assumed)

### D1 — Chart component: Cloudscape `LineChart`, NOT `ScatterPlot`
Verified in `/Users/wisech/Documents/aws-healthomics-visualizer/frontend/node_modules/@cloudscape-design/components` (pinned 3.0.1356, same version the worktree resolves): the only cartesian chart components are `area-chart`, `bar-chart`, `line-chart`, `mixed-line-bar-chart`. There is **no `scatter-plot`** directory and **no `scatter`** string anywhere in the shipped `*.d.ts`. So the task's preferred `@cloudscape-design/components/scatter-plot` import is unavailable in this version.
Decision: use **`LineChart`** (`@cloudscape-design/components/line-chart`) with a single `type: 'line'` series — one datum per run. Caveat documented honestly: `LineChart` in 3.0.1356 always draws a connecting polyline between the series points and offers no "markers only / no line" option (its series type union is only `'line' | 'threshold'` per `line-chart/interfaces.d.ts`). The visual is therefore a time-ordered line through the per-run points rather than a pure disconnected scatter; each run is still an individually highlightable point with its own hover popover. This is the closest the pinned Cloudscape version supports without adding a charting library (which is forbidden). This caveat is acceptable per the task's explicit "whichever the pinned version supports" clause.
X axis uses `xScaleType="time"` with `Date` x values (epoch-ms parsed from `stoppedAt`, wrapped in `Date`); y is duration in MINUTES.

### D2 — Click to open a run: accessible "Jump to run" top-N list is the PRIMARY click path (point-click is impossible in this version)
Verified in `types/cartesian-chart.d.ts` and `mixed-line-bar-chart/interfaces.d.ts`: the cartesian chart API (shared by LineChart) exposes only `onFilterChange` and `onHighlightChange` (series-level: `HighlightChangeDetail` carries `highlightedSeries`, not a datum). There is **no `onDatumClick` / `onPointClick` / per-point click** handler — confirmed by grepping the components package for `onDatumClick|onPointClick|datumClick` (no matches). A reliable per-point click therefore genuinely cannot be delivered by LineChart in 3.0.1356.
Decision (per the task's explicit fallback clause): render an accessible **"Jump to run" affordance directly beneath the scatter** — a compact list of the top N (N = 5) longest-duration runs in the window, each a Cloudscape `Link` whose `onFollow` calls `onOpenRun(runId)`. This is keyboard-accessible and is the real click path. The chart itself supplies the runId **on hover** via `detailPopoverSeriesContent` (satisfies "runId MUST be visible on hover"). We do NOT fabricate a point click.

### D3 — Hover content
Use `detailPopoverSeriesContent` on the LineChart. It receives `{ series, x, y }` where `x` is the `Date` and `y` is duration-in-minutes for the highlighted point. We cannot carry `runId` through the Cloudscape datum (its `Datum<T>` is strictly `{ x, y }`), so build a lookup `Map<xMs, ScatterDatum>` (and, to disambiguate ties on identical stop times, keep the matched datum by nearest y) to resolve the highlighted `{x,y}` back to its `runId`/`status`. Popover shows: runId, duration (formatted via the shared duration helper, see D4), and status when present.

### D4 — Duration formatting: extract and reuse the existing helper
`ReportsView.tsx` has a private `fmtStat(m, value)` that formats `durationMs` as `H:MM:SS`. It is not exported and is coupled to an `AggregateMetric`. Decision: add a small exported helper `formatDurationMs(ms: number): string` in `runScatter.ts` that produces the same `H:MM:SS` string, and refactor `fmtStat`'s duration branch in `ReportsView.tsx` to call it — one source of truth, no behavior change (keeps existing tests green). The scatter popover and the top-N list both use `formatDurationMs`.

### D5 — Data source: page through `listWorkflowRunPoints`, not `report.sample`
`report.sample` is a bounded subset. Mirror `handleExportCsv` exactly: loop `listWorkflowRunPoints({ workflowName, versionName, start, end, limit: 1000, nextToken })`, accumulate `items`, follow `nextToken`, same `guard < 1000` cap. Store the accumulated `RunPoint[]` in state, recomputed whenever the selected group or window changes (same deps as the report effect). Reuse the injected `listWorkflowRunPoints` prop (already a `ReportsViewProps` field) so tests can mock it.

### D6 — Scope: single cohesive feature, no FEAT decomposition
`runScatter.ts` (pure transform), its wiring into `ReportsView`, the `App.tsx` prop pass-through, and the tests are one tightly-coupled unit touching 4 files. It does not decompose into independently-shippable features. The existing implement-and-review loop will implement this plan; the restructuring path is intentionally not taken. The loop's stop gate remains `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/.agents/tasks/scatter-review.json` (`verdict == "APPROVED"`).

## Implementation outcome (verified in worktree, Cloudscape 3.0.1356)

Confirmed empirically in the installed worktree `node_modules`:
- NO `@cloudscape-design/components/scatter-plot` directory exists; `line-chart` does. So the feature uses **`LineChart`** (single `type: 'line'` series, one datum per run), exactly as D1 predicted.
- `line-chart/interfaces.d.ts` series union is only `'line' | 'threshold'` (no markers-only), and the cartesian API exposes `detailPopoverSeriesContent` but **no per-point click** handler. So:
  - Hover run id comes from `detailPopoverSeriesContent` resolving the highlighted `{x,y}` back to the run via an x-epoch-ms `Map` (nearest-y tiebreak).
  - The **primary, keyboard-accessible click path is the "Jump to run" top-5 list** of longest-duration runs beneath the chart (`reports-run-scatter-link` Cloudscape `Link`s calling `onOpenRun`). Point-click was NOT fabricated.
- Zero plottable runs renders an explicit empty affordance (`reports-run-scatter-empty`, text "No timed runs to plot.") instead of handing LineChart an empty series (which draws bare axes in jsdom) — strictly no fabricated points.

## Items

- [x] 1. Create the pure transform module `runScatter.ts` with the data transform and shared duration formatter.
      Export `interface ScatterDatum { runId: string; x: number; y: number; status?: RunStatus | null }` where `x` = `stoppedAt` epoch ms, `y` = duration in MINUTES (`durationMs / 60000`).
      Export `runPointsToScatterData(points: readonly RunPoint[]): ScatterDatum[]`: keep ONLY runs where `durationMs` is a finite number `>= 0` (reject `null`/`undefined`/`NaN`/`Infinity`/negative) AND `Date.parse(stoppedAt)` is not `NaN`; map each kept run to `{ runId, x: Date.parse(stoppedAt), y: durationMs/60000, status }`. Omit all others (strict no-fabrication; never emit a 0 for a missing value). Preserve input order.
      Export `formatDurationMs(ms: number): string` producing the same `H:MM:SS` string as the existing `fmtStat` duration branch (`totalSec = round(ms/1000)`, `H:MM:SS` with zero-padded mm/ss).
      Export a helper `topLongestRuns(data: readonly ScatterDatum[], n: number): ScatterDatum[]` returning the N highest-`y` datums (stable, descending by y) for the "Jump to run" list.
      Import `RunPoint`/`RunStatus` as types from `../api/types`.
      Files: `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/frontend/src/reports/runScatter.ts`
      Verify: `cd frontend && npx vitest run src/reports/runScatter.test.ts` passes (after item 2 adds the test), and `npx tsc --noEmit` is clean.

- [ ] 2. Create `runScatter.test.ts` colocated with the module.
      Cover: `null`/`undefined` `durationMs` omitted; negative duration omitted; `NaN`/`Infinity` duration omitted; unparseable `stoppedAt` (e.g. `"not-a-date"`) omitted; a valid run maps to exactly `x = Date.parse(stoppedAt)` and `y = durationMs/60000` with `runId`/`status` carried through; empty input -> empty output; `formatDurationMs` formats a known ms value to the expected `H:MM:SS`; `topLongestRuns` returns the correct N ordered descending by y and never more than input length.
      fast-check property: for any array of arbitrary `RunPoint`-shaped objects, `output.length <= input.length` AND every output `runId` corresponds to an input run whose `durationMs` is a finite `>= 0` number and whose `stoppedAt` parses. (fast-check is already a dev dependency — used elsewhere in the repo.)
      Files: `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/frontend/src/reports/runScatter.test.ts`
      Verify: `cd frontend && npx vitest run src/reports/runScatter.test.ts` — all cases pass.

- [ ] 3. Refactor `ReportsView.tsx` duration formatting to reuse `formatDurationMs` from `runScatter.ts` (no behavior change).
      In the `fmtStat` helper, replace the inline `durationMs` `H:MM:SS` computation with a call to `formatDurationMs(value)`; leave the non-duration branch untouched.
      Files: `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/frontend/src/reports/ReportsView.tsx`
      Verify: `cd frontend && npx vitest run src/reports/ReportsView.test.ts` — existing tests still pass (the N-of-M, collision, empty, and real-shape tests are unaffected).

- [ ] 4. Add `onOpenRun?: (runId: string) => void` to `ReportsViewProps` and page the full run-point window into state.
      Add the optional prop to the interface and destructure it in the component. Add state `scatterPoints: RunPoint[]` and an effect keyed on `[selectedGroup, listWorkflowRunPoints, windowRange.start, windowRange.end]` that pages through `listWorkflowRunPoints` exactly like `handleExportCsv` (limit 1000, follow `nextToken`, `guard < 1000`), accumulating into local state; cancel-guard the async like the report effect. When no group is selected, reset to `[]`.
      Files: `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/frontend/src/reports/ReportsView.tsx`
      Verify: `cd frontend && npx tsc --noEmit` clean; `npx vitest run src/reports/ReportsView.test.ts` still passes (existing tests pass no `onOpenRun` and a `listWorkflowRunPoints` mock is not required by them because the paging effect tolerates the default; if the default client call is undesirable in tests, the effect must no-op when `selectedGroup == null`).

- [ ] 5. Render the per-run scatter block in `ReportsView.tsx` immediately AFTER the "Duration distribution" histogram block (`data-testid="reports-duration-chart"`), before the "Runs over time" block.
      Wrap in `<div data-testid="reports-run-scatter">`. Section label via `<Box variant="awsui-key-label">Per-run duration (click a point to open the run)</Box>` to match sibling labels. Compute `const scatterData = useMemo(() => runPointsToScatterData(scatterPoints), [scatterPoints])`.
      Render `LineChart` imported from `@cloudscape-design/components/line-chart`:
      - `series={[{ title: 'Runs', type: 'line', data: scatterData.map(d => ({ x: new Date(d.x), y: d.y })) }]}`
      - `xScaleType="time"`, `height={260}`, `hideFilter`, `hideLegend`
      - `yTitle="Duration (minutes)"`, `xTitle="Run stop time"`
      - `ariaLabel="Per-run duration scatter"`
      - `empty={<Box textAlign="center">No timed runs to plot.</Box>}` (shown when `scatterData.length === 0` — do NOT plot fabricated points)
      - `detailPopoverSeriesContent={({ x, y }) => { resolve the datum via a Map keyed on x epoch-ms (new Date(d.x).getTime()); return { key: 'Run', value: <runId + status>, subItems: [{ key: 'Duration', value: formatDurationMs(resolved.y*60000) }, status ? {key:'Status', value: status} : …] } }}` so the **runId is visible on hover**.
      Document in a code comment that LineChart was chosen because 3.0.1356 ships no ScatterPlot and that point-click is unavailable (hence the Jump-to-run list below).
      Files: `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/frontend/src/reports/ReportsView.tsx`
      Verify: `cd frontend && npx tsc --noEmit` clean; build item covered in item 8.

- [ ] 6. Render the accessible "Jump to run" top-N affordance directly beneath the scatter (primary click path).
      Inside the same `reports-run-scatter` div, below the chart: when `scatterData.length > 0`, render a labeled list (`data-testid="reports-run-scatter-jump"`) of `topLongestRuns(scatterData, 5)`; each entry is a Cloudscape `Link` (`data-testid="reports-run-scatter-link"`) showing `runId` + its formatted duration, with `onFollow={e => { e.preventDefault(); onOpenRun?.(datum.runId); }}`. Guard all click wiring on `onOpenRun` being defined. Keyboard-accessible by construction (links). When `onOpenRun` is undefined, render the runIds as plain text (no click).
      Files: `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/frontend/src/reports/ReportsView.tsx`
      Verify: covered by item 7 tests and item 8 build.

- [ ] 7. Add scatter + navigation tests to `ReportsView.test.tsx` (and an App-level routing assertion).
      In `ReportsView.test.tsx`: (a) with a `listWorkflowRunPoints` mock returning two timed runs and one null-duration run, assert `reports-run-scatter` renders and the Jump-to-run list shows exactly the timed runs (null-duration omitted); (b) clicking a `reports-run-scatter-link` calls the injected `onOpenRun` with that run's `runId`; (c) with all runs null-duration, assert the empty affordance text "No timed runs to plot" appears and no jump links render. Follow the existing `render(<ReportsView now={NOW} listWorkflowGroups=… getWorkflowReport=… listWorkflowRunPoints=vi.fn()… onOpenRun=vi.fn() />)` style and `waitFor`/`findByTestId` usage already in the file.
      For the deep-link requirement, add a test in `App.test.tsx` (create if absent, else append) that renders `Dashboard`, navigates to Reports, and asserts that invoking the Reports `onOpenRun` path lands on the run detail view with `window.location.hash === '#/run/<runId>'`. If driving the real chart click in jsdom is impractical, assert the wiring at the `openRun` boundary: that `ReportsView` is rendered with `onOpenRun={openRun}` and that calling `openRun(id)` sets the hash via `navigateHash` to `#/run/<id>` (serializeViewHash contract). Prefer a user-facing test (click a jump link, assert the hash) if feasible.
      Files: `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/frontend/src/reports/ReportsView.test.tsx`, `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/frontend/src/App.test.tsx`
      Verify: `cd frontend && npx vitest run src/reports src/App.test.tsx` — all new and existing tests pass.

- [ ] 8. Wire `App.tsx` to pass `onOpenRun={openRun}` into `<ReportsView>`.
      Change `<ReportsView onBack={goToFleet} />` (in the `showReports` branch, ~line 294) to `<ReportsView onBack={goToFleet} onOpenRun={openRun} />`. `openRun` already sets `selectedRunId` and calls `navigateHash({ kind: 'run', runId })`, so a Reports click routes through the SAME path as a fleet click and produces `#/run/<runId>`.
      Files: `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-run-scatter/frontend/src/App.tsx`
      Verify: `cd frontend && npm run build` (tsc + vite) succeeds; `npm test` (full `vitest run`) is green; `npm run lint` has no new errors.

## Files summary
- ADD: `frontend/src/reports/runScatter.ts`
- ADD: `frontend/src/reports/runScatter.test.ts`
- MODIFY: `frontend/src/reports/ReportsView.tsx` (prop, paging effect, scatter block, jump list, fmtStat refactor)
- MODIFY: `frontend/src/reports/ReportsView.test.tsx` (scatter/click/empty tests)
- MODIFY: `frontend/src/App.tsx` (pass `onOpenRun={openRun}`)
- ADD or MODIFY: `frontend/src/App.test.tsx` (deep-link routing assertion)

## No-dismissal check
Every WHAT-TO-BUILD item is backed by code read during exploration; none is declared "already satisfied". The ScatterPlot-vs-LineChart choice (D1) and the per-point-click impossibility (D2) are both confirmed from the pinned package's `.d.ts` and directory listing, not assumed.
