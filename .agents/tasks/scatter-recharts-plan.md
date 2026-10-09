# Implementation Plan — Real interactive Recharts scatter in Reports

Replace the current Cloudscape `LineChart` per-run "duration scatter" plus the top-5 "Jump to run" link list in the Reports view with a true interactive Recharts `ScatterChart` where each run is a clickable marker. Keep the two original Cloudscape `BarChart`s (Duration distribution histogram, Runs over time). Reuse the pure transform in `runScatter.ts`.

All paths below are relative to the worktree root
`/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-scatter-recharts`.
Frontend root: `frontend/`. Run all build/test/lint commands from `frontend/`.
Git: `git -C /Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-scatter-recharts`.

## Key facts established during exploration (ground truth for the implementer)

- `frontend/node_modules` is NOT installed in this worktree. A fresh `npm install` is required before anything builds or tests. That same install picks up the new `recharts` dependency.
- `frontend/package.json` pins EXACT versions (no caret) for every dependency. React is `19.2.8`, react-dom `19.2.8`. Vitest `3.2.7`, Vite `7.3.6`, jsdom `30.0.1`.
- Test runner config lives in `frontend/vite.config.ts` under the `test` key (`environment: 'jsdom'`, `globals: true`, `setupFiles: ['./vitest.setup.ts']`, `include: ['src/**/*.test.{ts,tsx}']`). `vitest.setup.ts` only imports `@testing-library/jest-dom/vitest` — there is NO global ResizeObserver/getBBox mock, so Recharts' `ResponsiveContainer` will NOT measure a size in jsdom. Component tests MUST avoid depending on `ResponsiveContainer` measuring width (mock it or render the inner chart with explicit width/height, or assert via the pure data/renderer path).
- `recharts@3.10.1` officially supports React 19 (peer `react ^19.0.0`). It is ESM and works with Vite. This is the ONE new dependency. Do NOT add any other dependency; do NOT add react-router.
- `runScatter.ts` exports `runPointsToScatterData` (pure RunPoint[] -> `ScatterDatum[]` with `{runId, x: epochMs, y: minutes, status?}`, filtering null/NaN/Inf/negative durations and unparseable `stoppedAt`), `formatDurationMs(ms) -> "H:MM:SS"`, and `topLongestRuns`. `topLongestRuns` is used ONLY by `ReportsView.tsx` (line ~351, for the jump list) and by `runScatter.test.ts`. After the jump list is removed, nothing in `src/` uses it — remove it and its tests.
- `RunPoint` (`frontend/src/api/types.ts` ~line 293): `runId: string`, `stoppedAt: string`, `status?: RunStatus|null`, `durationMs?: number|null`, plus other metric fields. The scatter uses `runId` (identity), `stoppedAt` (x), `durationMs` (y). `RunStatus` is a string union defined at line ~8.
- `App.tsx` passes `onOpenRun={openRun}` to `<ReportsView>`. `openRun(runId)` sets `selectedRunId` and `navigateHash({kind:'run',runId})` -> deep-link `#/run/<runId>`. KEEP this wiring unchanged; the scatter point click calls `onOpenRun(runId)`.
- `ReportsView.tsx` already pages `listWorkflowRunPoints` (limit 1000, follow nextToken, guard < 1000) into `scatterPoints` state via a `useEffect`, and derives `scatterData = runPointsToScatterData(scatterPoints)` via `useMemo`. This full paged fetch stays; the new scatter consumes `scatterData` (NOT `report.sample`). The old `scatterByX` map and `topRuns` memo exist only to support the LineChart popover and jump list and will be removed.
- The old block is wrapped in `<div data-testid="reports-run-scatter">` containing a `Box variant="awsui-key-label"` label, the empty affordance `data-testid="reports-run-scatter-empty"` ("No timed runs to plot."), the `LineChart`, and the jump list `data-testid="reports-run-scatter-jump"` with links `data-testid="reports-run-scatter-link"`. The histogram block is `data-testid="reports-duration-chart"`; the time-bins block is `data-testid="reports-timebins-chart"`. The new scatter goes between them (right after the histogram), as it is now.
- Existing tests to update:
  - `frontend/src/reports/runScatter.test.ts` — has a `describe('topLongestRuns', ...)` block to remove; keep the `runPointsToScatterData`, `formatDurationMs`, and fast-check property blocks.
  - `frontend/src/reports/ReportsView.test.tsx` — the `per-run duration scatter` describe asserts the jump list (`reports-run-scatter-jump`, `reports-run-scatter-link`, "longest first" order, clicking a jump link calls `onOpenRun`). These jump-list assertions must be replaced with scatter-marker assertions. Keep the empty-affordance test and the `reports-run-scatter` presence test.
  - `frontend/src/App.test.tsx` — stubs `ReportsView` entirely and drives `onOpenRun('run-2')` through a stub button (`stub-open-run`); it asserts the `#/run/run-2` hash. This test does NOT depend on the jump list and should keep passing unchanged. Verify it still passes; do not rewrite it unless it breaks.

## Design decisions (made here; implementer follows them)

1. **Keep `runScatter.ts` as the single source of plottable data and duration formatting.** The new component receives `ScatterDatum[]` (already filtered, x=epoch ms, y=minutes) and `onOpenRun`. Rationale: preserves the no-fabrication guarantees and the shared formatter; keeps the component thin and the logic unit-tested.
2. **Tooltip content is a standalone exported pure function** (`renderScatterTooltip` or a named component), so a test can call it directly with a Recharts payload and assert `runId` is visible without needing a hovered DOM. Rationale: Recharts tooltips don't render in jsdom without pointer+layout; testing the renderer directly is the reliable path and the task explicitly allows it.
3. **Keyboard/accessibility fallback:** render a visually-hidden (sr-only) ordered list of the plottable runs as focusable `<button>`s (or links) that call `onOpenRun(runId)`, labelled e.g. "Open run <id> (<duration>)", inside the scatter container but off-screen. This is NOT the big visible top-5 jump list — it is a complete, screen-reader/keyboard-accessible path to every run, hidden from sighted users who use the pointer-driven markers. Rationale: Recharts scatter click is pointer-oriented; the task requires a keyboard-accessible path and forbids bringing back the visible jump list as primary UI. Document this choice in a code comment and in the component test.
4. **Outlier emphasis (optional, data-derived only):** compute a threshold purely from the plotted y-values (e.g. y > median + 1.5*IQR, or simply the max). Markers at/above it get a larger radius or distinct fill. If implemented, derive it only from actual data — never fabricate. Keep it simple; it is optional and must not change which points are plotted.
5. **x-axis** = `type="number"`, `dataKey="x"` (epoch ms), `domain={['dataMin','dataMax']}`, `tickFormatter` -> short date/time via `new Date(ms)`. Title "Run stop time". **y-axis** = `dataKey="y"` (minutes), title "Duration (minutes)" to match the sibling histogram's minutes labeling.
6. **No connecting line:** a single `<Scatter>` renders discrete markers only (ScatterChart does not draw a connecting polyline). `line={false}` is the default for Scatter; do not set `line`.

## Ordered steps

- [ ] 1. Add the `recharts` dependency and install.
      Add `"recharts": "3.10.1"` to the `dependencies` block of `frontend/package.json` (exact pin, no caret, alphabetical position near `reactflow`). Then run `npm install` from `frontend/` to resolve it and write `frontend/package-lock.json`. This also installs the previously-missing `node_modules`.
      Files: `frontend/package.json`, `frontend/package-lock.json` (generated).
      Verify: `cd frontend && npm install` completes without peer-dependency ERESOLVE errors; `node -e "require('./node_modules/recharts/package.json').version"` prints `3.10.1`; `git -C <worktree> diff --stat frontend/package.json frontend/package-lock.json` shows only the recharts addition and its lockfile resolution.

- [ ] 2. Trim `runScatter.ts`: remove the now-unused `topLongestRuns` helper; keep `runPointsToScatterData`, `formatDurationMs`, and the `ScatterDatum` type exactly as they are.
      Files: `frontend/src/reports/runScatter.ts`.
      Verify: `cd frontend && npx tsc --noEmit` (will still error on `ReportsView.tsx`/tests until steps 3-6 land — that is expected; the point is that `runScatter.ts` itself has no dangling references). Final verification is step 7's full build.

- [ ] 3. Update `runScatter.test.ts`: delete the `describe('topLongestRuns', ...)` block and remove `topLongestRuns` from the import. Keep the `runPointsToScatterData`, `formatDurationMs`, and fast-check property blocks unchanged.
      Files: `frontend/src/reports/runScatter.test.ts`.
      Verify: `cd frontend && npx vitest run src/reports/runScatter.test.ts` — all remaining tests pass.

- [ ] 4. Create the Recharts component `frontend/src/reports/RunDurationScatter.tsx`.
      Props: `{ points: readonly ScatterDatum[]; onOpenRun?: (runId: string) => void }`.
      Build with `ResponsiveContainer` (fixed height ~280px) wrapping `ScatterChart` containing `CartesianGrid`, `XAxis` (type="number", dataKey="x", domain=['dataMin','dataMax'], tickFormatter -> short date/time, name/label "Run stop time"), `YAxis` (dataKey="y", label "Duration (minutes)"), `Tooltip` (content = the exported tooltip renderer from decision 2), and one `<Scatter data={points as ScatterDatum[]} ...>` with `onClick={(datum) => datum?.runId && onOpenRun?.(datum.runId)}` and `cursor: pointer` styling on markers.
      Export a pure `renderScatterTooltip` (Recharts `TooltipProps`-style `{ active, payload }`) that, when active and payload[0].payload is a `ScatterDatum`, renders `runId`, `Duration` via `formatDurationMs(y * 60000)`, and `Status` when present. `runId` MUST be visible.
      Empty state: if `points.length === 0`, render an explicit message element (text "No timed runs to plot.", `data-testid="run-scatter-empty"`) instead of an empty chart/axes.
      Accessibility: give the chart container `role="img"` and an `aria-label` (e.g. "Per-run duration scatter"); render an sr-only (visually hidden via inline style or an existing utility) list of focusable buttons — one per point — labelled "Open run <runId> (<formatted duration>)" that call `onOpenRun(runId)` (decision 3). Add `data-testid="run-scatter-sr-open"` to those buttons. Optionally emphasize data-derived outliers (decision 4).
      Add a top-of-file comment documenting: the jsdom/ResponsiveContainer caveat, the sr-only keyboard path, and why there is no connecting line.
      Files: `frontend/src/reports/RunDurationScatter.tsx` (new).
      Verify: covered by step 5's component test and step 7's full build.

- [ ] 5. Create the component test `frontend/src/reports/RunDurationScatter.test.tsx`.
      Mock Recharts' `ResponsiveContainer` to a fixed-size `<div style={{width:600,height:280}}>` child (jsdom has no layout), e.g. `vi.mock('recharts', async (orig) => ({ ...(await orig()), ResponsiveContainer: ({children}) => <div style={{width:600,height:280}}>{children}</div> }))`, OR render the inner `ScatterChart` with explicit `width`/`height`. REQUIRED assertions:
      (i) given N plottable `ScatterDatum`, N `<Scatter>` markers are present (query the rendered SVG for marker nodes, or assert the sr-only buttons count === N as the data-path proxy);
      (ii) the exported tooltip renderer, called directly with a payload `[{ payload: { runId:'run-x', y:30, status:'FAILED' } }]` and `active: true`, outputs the `runId` text (and the shared-formatter duration);
      (iii) clicking a marker — or invoking the wired `onClick` handler with a datum, or clicking the corresponding sr-only button — calls `onOpenRun` with that datum's EXACT `runId`;
      (iv) `points={[]}` renders `run-scatter-empty` with "No timed runs to plot." and no markers.
      Files: `frontend/src/reports/RunDurationScatter.test.tsx` (new).
      Verify: `cd frontend && npx vitest run src/reports/RunDurationScatter.test.tsx` — all assertions pass.

- [ ] 6. Rewire `ReportsView.tsx`: remove the old LineChart block, the jump list, the `scatterByX` memo, the `topRuns` memo, and the now-unused imports (`LineChart`, `Link`, `topLongestRuns`; keep `formatDurationMs` and `runPointsToScatterData`). In place of the removed block (right after the `reports-duration-chart` histogram, before `reports-timebins-chart`), render a section wrapped in `<div data-testid="reports-run-scatter">` with a `Box variant="awsui-key-label"` section label (e.g. "Per-run duration (click a point to open the run)") followed by `<RunDurationScatter points={scatterData} onOpenRun={onOpenRun} />`. Keep the paged `listWorkflowRunPoints` fetch, `scatterPoints` state, and `scatterData` memo exactly as they are. Preserve no-fabrication throughout.
      Files: `frontend/src/reports/ReportsView.tsx`.
      Verify: covered by steps 7 and 8.

- [ ] 7. Update `ReportsView.test.tsx` scatter tests to match the new UI. In the `per-run duration scatter` describe: replace the jump-list assertions (`reports-run-scatter-jump`, `reports-run-scatter-link`, longest-first ordering) with assertions that `reports-run-scatter` renders when run points have durations, that the scatter shows one marker/sr-button per timed run (null-duration run `run-nodur` omitted), and that activating a run (click the marker handler or the sr-only `run-scatter-sr-open` button for `run-slow`) calls `onOpenRun('run-slow')`. Keep the empty-affordance test but update its expected testid/text to the component's empty affordance (`reports-run-scatter` present; the empty message rendered by `RunDurationScatter`). If `ResponsiveContainer` prevents markers from rendering in jsdom here, mock it the same way as in step 5 (module-level `vi.mock('recharts', ...)`).
      Files: `frontend/src/reports/ReportsView.test.tsx`.
      Verify: `cd frontend && npx vitest run src/reports/ReportsView.test.tsx` — all tests pass.

- [ ] 8. Confirm `App.test.tsx` still passes unchanged (it stubs `ReportsView` and only exercises `onOpenRun` -> `#/run/<id>` routing, which is unchanged). Only touch it if it breaks.
      Files: `frontend/src/App.test.tsx` (only if needed).
      Verify: `cd frontend && npx vitest run src/App.test.tsx` — the "routes a Reports scatter click through openRun" test and all others pass.

- [ ] 9. Full verification: build, test suite, lint. If the production build surfaces a Recharts-specific Vite transform / `optimizeDeps` issue, resolve it minimally in `frontend/vite.config.ts` (e.g. add `recharts` to `optimizeDeps.include`) and document the change in a comment. Confirm the production bundle includes recharts without error.
      Files: `frontend/vite.config.ts` (only if the build requires it).
      Verify, all from `frontend/`:
      - `npm run build` (`tsc --noEmit && vite build`) completes with no type errors and bundles recharts.
      - `npm test` (`vitest run`) — entire suite green.
      - `npm run lint` (`eslint .`) — no new errors.

## No-fabrication / constraint checklist (must hold at completion)

- `recharts@3.10.1` is the ONLY new dependency, exact-pinned (no caret). No other new deps. No router.
- The two original Cloudscape `BarChart`s (`reports-duration-chart`, `reports-timebins-chart`) are untouched.
- Runs with missing/invalid `durationMs` or unparseable `stoppedAt` are omitted by `runPointsToScatterData`, never plotted as 0 or a guess.
- The scatter consumes the full paged `scatterData` (every run in the window), never `report.sample`.
- A clicked/activated marker calls `onOpenRun` with that marker's exact `runId`; `App.tsx`'s `openRun` wiring is unchanged.
- Zero plottable runs renders the explicit empty affordance, never empty axes.
- Conventions matched: `awsui-key-label` section label, `data-testid="reports-run-scatter"`, shared `formatDurationMs`, minutes labeling on the y-axis.

## Loop stop contract (unchanged)

The implement/review loop gates on `.agents/tasks/scatter-review.json` with jsonPath `verdict` == `APPROVED`. This plan does not alter that contract.
