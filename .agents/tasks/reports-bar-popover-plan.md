# Implementation Plan — Reports duration BAR histogram + clickable bucket Popover (new-tab run links)

All work happens in the worktree at
`/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover`.
The frontend root is `.../.worktrees/reports-bar-popover/frontend`. All paths below are absolute
under that worktree.

Build/test/lint commands (from `frontend/package.json`, run with cwd =
`/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend`):

- Build/typecheck: `npm run build` (= `tsc --noEmit && vite build`)
- Tests: `npm test` (= `vitest run`); scoped: `npx vitest run src/reports`
- Lint: `npm run lint`

## Design decisions (made during exploration, grounded in the pinned code)

1. **Popover mechanism — FALLBACK (parallel clickable bucket control), NOT the chart's built-in
   detail popover.** Verified against the installed `@cloudscape-design/components@3.0.1356`:
   `BarChart` extends `CommonMixedChartProps` (see
   `.../frontend/node_modules/@cloudscape-design/components/mixed-line-bar-chart/interfaces.d.ts`
   and `.../types/cartesian-chart.d.ts`). The pinned version exposes **no**
   `detailPopoverContent(datum, series) => ReactNode` render prop. It only offers
   `detailPopoverSeriesContent` (which must return a `{ key, value }` key/value pair, not arbitrary
   interactable content) and `detailPopoverFooter(xValue) => ReactNode`. The chart popover is
   hover-driven and pins on click (a `detailPopoverDismissAriaLabel` exists), but driving/pinning it
   and clicking a link inside it is not reliably reproducible under jsdom, and the user already
   rejected a fiddly chart-interaction approach. Therefore: KEEP the `BarChart` as the visual, and
   render a **parallel compact clickable bucket control** — one Cloudscape `Popover`
   (`triggerType="custom"`, `dismissButton`, click-triggered) per NON-EMPTY bucket, each triggered
   by a small Cloudscape `Button` labeled with the bucket's minute range + run count. This is
   deterministic and unit-testable. Document this choice in the component JSDoc.
2. **New-tab run links.** Verified `Link` in 3.0.1356
   (`.../node_modules/@cloudscape-design/components/link/interfaces.d.ts`): `external` + `href`
   opens in a new tab, and `target="_blank"` auto-adds `rel="noopener noreferrer"`. Use Cloudscape
   `<Link external href={...} target="_blank">`. href is built as
   `${window.location.origin}${window.location.pathname}#/run/${encodeURIComponent(runId)}`.
3. **Deep-link hash format — confirmed** from
   `.../frontend/src/navigation/viewHash.ts` `serializeViewHash`: a run is
   `#/run/${encodeURIComponent(runId)}` (fleet is `#/`). The new-tab links MUST use this exact
   shape. Reuse `serializeViewHash({ kind: 'run', runId })` to avoid drift, then prefix with
   `window.location.origin + window.location.pathname`.
4. **Bucket→runs assignment convention** (fold-in fact, matches `ingest/src/metrics/aggregate.ts`
   `buildHistogram`): equal-width buckets `{lo, hi}`; a finite `durationMs >= 0` lands in bucket
   `floor((v - min) / width)` clamped to `[0, lastIndex]`, where `min` = first bucket's `lo`,
   `max` = last bucket's `hi`, `width = (max - min) / bucketCount`. Net effect: every bucket is
   half-open `[lo, hi)` EXCEPT the LAST bucket which is CLOSED `[lo, hi]`. The frontend mapping MUST
   reproduce this so each bar's count equals the number of runs listed in its popover. Degenerate
   case `max === min` (single collapsed bucket): every finite run falls in index 0. Runs with
   `durationMs` null/undefined/NaN/Infinity/negative are placed in NO bucket (no fabrication).
5. **Full paged run fetch, not `report.sample`.** Reuse the existing `handleExportCsv` paging
   (limit 1000, follow `nextToken`, `guard < 1000`) — already duplicated in ReportsView's
   `scatterPoints` effect — to get ALL `RunPoint`s for the bucket→runs mapping. Rename the state
   from scatter-specific naming to bucket-oriented naming.
6. **Shared duration formatter module.** `formatDurationMs` currently lives in
   `src/reports/runScatter.ts` and is used by both `ReportsView.tsx` and (now-deleted)
   `RunDurationScatter.tsx`. The scatter transform (`runPointsToScatterData`, `ScatterDatum`) is no
   longer needed. Rename the module to a bucket-oriented name and keep only the pure pieces still in
   use: `formatDurationMs` (shared) + the NEW `runsInBuckets` mapping. Chosen module name:
   `src/reports/durationBuckets.ts` (replaces `runScatter.ts`).
7. **`onOpenRun` prop.** New-tab links are real anchors, NOT in-app navigation, so they do not use
   `onOpenRun`. After removing the scatter, `onOpenRun` becomes unused in `ReportsView`. Remove the
   `onOpenRun` prop from `ReportsViewProps` and its destructuring, and drop the now-dead
   `onOpenRun={openRun}` prop passed from `App.tsx` (App keeps `openRun` for fleet/other callers).
   This keeps the view clean per the task's "remove it only if cleanly unused" guidance.

### Why this is a single plan (no FEAT decomposition)

The change is one tightly-coupled frontend edit across ~5 files: deleting the scatter, refactoring
the one shared pure module they both import, editing the single `ReportsView` consumer, dropping the
dependency, and updating the colocated tests. There is no separable, independently-shippable
sub-feature here, so this is written as a single ordered plan for the existing implement/review loop.

---

## Steps

- [ ] 1. Create the shared pure module `durationBuckets.ts` with `formatDurationMs` (moved verbatim
      from `runScatter.ts`) and a new exported `runsInBuckets(points, buckets) => RunPoint[][]`.
      `runsInBuckets` returns an array index-aligned to `buckets`; it derives `min = buckets[0].lo`,
      `max = buckets[last].hi`, `width = (max - min) / buckets.length`, and assigns each run with a
      finite `durationMs >= 0` to `idx = floor((durationMs - min)/width)` clamped to
      `[0, buckets.length-1]` (last bucket closed on the right). Handle the degenerate
      `max === min` / non-finite-or-<=0 `width` case by putting every finite run in index 0 (mirrors
      `buildHistogram`'s single-bucket collapse). Runs with null/undefined/NaN/Infinity/negative
      `durationMs` go in no bucket. Empty `buckets` => return `[]`. Reuse the existing
      `isUsableDurationMs` guard logic.
      Files: create `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/reports/durationBuckets.ts`
      Verify: `npx vitest run src/reports/durationBuckets.test.ts` passes after step 2 (this step
      compiles cleanly: `npx tsc --noEmit` from the frontend dir shows no new errors in this file).

- [ ] 2. Write `durationBuckets.test.ts`: unit tests for `formatDurationMs` (port the existing cases
      from `runScatter.test.ts`: `0:00:00`, `0:15:00`, `1:01:01`, rounding 1499→`0:00:01`,
      1500→`0:00:02`) and for `runsInBuckets`. Cover: a run exactly on an interior boundary lands in
      the UPPER bucket (`[lo,hi)`); the max value lands in the LAST bucket (closed); per-bucket
      counts equal the matching `durationHistogram` bucket counts for a hand-built fixture; null /
      negative / NaN / Infinity durations are excluded from every bucket; empty buckets => `[]`;
      degenerate single-bucket (`lo===hi`) holds all finite runs. Add a fast-check property: for
      random `RunPoint[]` and a random valid bucket array, every returned index-list entry's runs
      have `durationMs` within that bucket per the convention, and the total runs placed equals the
      count of finite-`durationMs>=0` runs whose value is within `[min, max]`.
      Files: create `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/reports/durationBuckets.test.ts`
      Verify: `npx vitest run src/reports/durationBuckets.test.ts` — all tests pass.

- [ ] 3. Delete the Recharts scatter component and its test, and the old scatter module and its test.
      Files: delete
      `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/reports/RunDurationScatter.tsx`,
      `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/reports/RunDurationScatter.test.tsx`,
      `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/reports/runScatter.ts`,
      `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/reports/runScatter.test.ts`
      Verify: the build will fail until step 4 removes the imports — this is expected; confirm the
      only remaining references are in `ReportsView.tsx` via
      `npx vitest run` error output or `grep` (fixed next). Do not run final verify yet.

- [ ] 4. Create the bucket-popover presentational component `DurationBucketPopovers.tsx`. It takes
      `buckets: readonly HistogramBucket[]` and `runsByBucket: readonly (readonly RunPoint[])[]`
      (index-aligned) and renders a compact horizontal `SpaceBetween` of one Cloudscape `Popover`
      per NON-EMPTY bucket. Each Popover: `triggerType="custom"`, `dismissButton`, `position="top"`,
      `size="large"`, `header={`Runs in ${loMin}–${hiMin} min — ${count} runs`}`; trigger is a small
      Cloudscape `Button` (variant `inline-link` or `normal`) labeled with the minute range + count,
      with `data-testid="reports-bucket-trigger"`. Content: a titled list (first 50 runs) where each
      entry is `<Link external href={runHref(runId)} target="_blank">` showing `runId` plus the
      exact duration via the shared `formatDurationMs(durationMs)` and status when present; if the
      bucket has >50 runs, append a `+ K more` `Box` note. `runHref` =
      `${window.location.origin}${window.location.pathname}${serializeViewHash({ kind: 'run', runId })}`
      (import `serializeViewHash` from `../navigation/viewHash`). Give each `Link`
      `data-testid="reports-bucket-run-link"`. Document in JSDoc that the pinned 3.0.1356 BarChart
      lacks an interactable `detailPopoverContent`, hence this parallel click-triggered control.
      Files: create `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/reports/DurationBucketPopovers.tsx`
      Verify: `npx tsc --noEmit` (from frontend dir) reports no errors in this file after step 5.

- [ ] 5. Edit `ReportsView.tsx`: (a) remove `import RunDurationScatter` and the
      `runPointsToScatterData, formatDurationMs` import from `./runScatter`; import `formatDurationMs`
      from `./durationBuckets`, import `runsInBuckets` from `./durationBuckets`, and import
      `DurationBucketPopovers` from `./DurationBucketPopovers`. (b) Remove the entire
      `<div data-testid="reports-run-scatter"> … <RunDurationScatter …/></div>` block. (c) Rename
      the `scatterPoints` state + its paging effect to bucket-oriented naming (e.g. `runPoints` /
      load effect), keeping the SAME paging logic (limit 1000, nextToken, guard<1000). Remove the
      now-unused `scatterData`/`runPointsToScatterData` `useMemo`. (d) In the existing
      `reports-duration-chart` block, keep the `BarChart` exactly as is, and directly BELOW it render
      `<DurationBucketPopovers buckets={report.durationHistogram.buckets}
      runsByBucket={runsInBuckets(runPoints, report.durationHistogram.buckets)} />` inside the same
      `reports-duration-chart` container. (e) Remove the `onOpenRun` prop from `ReportsViewProps`,
      its destructuring, and update the `scatterPoints` effect's comments.
      Files: modify `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/reports/ReportsView.tsx`
      Verify: `npx tsc --noEmit` from the frontend dir — no errors; `npx vitest run src/reports/ReportsView.test.tsx` after step 7.

- [ ] 6. Edit `App.tsx`: remove the now-dead `onOpenRun={openRun}` prop passed to `<ReportsView …>`
      (keep `onBack={goToFleet}` and keep the `openRun` function itself — still used by FleetView).
      Files: modify `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/App.tsx`
      Verify: `npx tsc --noEmit` from the frontend dir — no errors.

- [ ] 7. Rewrite the scatter section of `ReportsView.test.tsx`: delete the `vi.mock('recharts', …)`
      block and the entire `describe('per-run duration scatter', …)` suite. Add a
      `describe('duration bucket popovers', …)` that renders `ReportsView` with a mock
      `listWorkflowRunPoints` returning runs spanning the fixture `durationHistogram.buckets`
      (reuse `makeReport()`’s two buckets `[300000,600000)` and `[600000,900000]`), and asserts:
      (a) the scatter is GONE — `screen.queryByTestId('reports-run-scatter')` is null and no
      `recharts`/`RunDurationScatter`; (b) `reports-duration-chart` still renders (histogram stays);
      (c) one `reports-bucket-trigger` per non-empty bucket; (d) clicking a trigger
      (`fireEvent.click`) surfaces `reports-bucket-run-link` anchors whose `href` contains
      `#/run/<runId>` and whose `target` is `_blank`; (e) a null-duration run is in no bucket's list.
      If driving the Cloudscape Popover open in jsdom proves flaky, additionally/instead unit-test
      `DurationBucketPopovers` directly in a new `DurationBucketPopovers.test.tsx` (render with a
      fixed `buckets`+`runsByBucket`, open a popover, assert link `href`/`target`, assert the
      `+ K more` note for a >50-run bucket, assert zero-run buckets render no trigger).
      Files: modify `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/reports/ReportsView.test.tsx`;
      optionally create `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src/reports/DurationBucketPopovers.test.tsx`
      Verify: `npx vitest run src/reports` — all reports tests pass.

- [ ] 8. Remove `recharts` from dependencies and drop it from the lockfile.
      Edit `package.json` to delete the `"recharts": "3.10.1"` line, then run `npm install` so
      `package-lock.json` drops `recharts` and its nested deps.
      Files: modify `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/package.json`
      and `/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/package-lock.json` (via npm install)
      Verify: `npm ls recharts` (from frontend dir) reports it is not present (empty / not found).

- [ ] 9. Confirm zero remaining references to the removed code anywhere under `frontend/src`.
      Grep for `recharts`, `RunDurationScatter`, `runScatter`, `ScatterDatum`,
      `runPointsToScatterData` and confirm ZERO matches in `frontend/src` (matches may remain only in
      built `dist/` artifacts, which are regenerated).
      Files: none (verification only)
      Verify: `grep -rnE "recharts|RunDurationScatter|runScatter|ScatterDatum|runPointsToScatterData" /Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend/src`
      returns no matches.

- [ ] 10. Full verification gate. From the frontend dir run the full build, test, and lint.
      Files: none
      Verify: `npm run build` succeeds (tsc clean + vite build), `npm test` passes all suites,
      `npm run lint` reports no errors.

## Notes / assumptions

- The `durationHistogram` is OPTIONAL on `WorkflowReport`; the popover control renders only inside
  the existing `report.durationHistogram != null && buckets.length > 0` guard, so no popovers appear
  when there is no histogram (matches current chart gating). A zero-run bucket renders no trigger.
- Minute labels reuse the existing `toMin = (ms) => Math.round(ms/60000)` convention already used for
  the BarChart x labels, so bucket-trigger labels match the bars' x labels exactly.
- The bounded list (first 50 + `+ K more`) keeps a large bucket's popover from rendering thousands of
  anchors; 50 is a reasonable visible cap consistent with the task's guidance.
