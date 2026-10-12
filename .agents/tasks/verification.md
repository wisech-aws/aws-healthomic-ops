# Verification — Reports duration BAR histogram + clickable bucket Popover

All commands run with cwd =
`/Users/wisech/Documents/aws-healthomics-visualizer/.worktrees/reports-bar-popover/frontend`.

## Popover mechanism used

FALLBACK: a parallel, click-triggered Cloudscape `Popover` control (one per
non-empty bucket), NOT the chart's built-in detail popover. The pinned
`@cloudscape-design/components@3.0.1356` `BarChart` exposes no interactable
`detailPopoverContent(datum, series) => ReactNode` render prop (only
`detailPopoverSeriesContent`, which must return a `{ key, value }` pair, and
`detailPopoverFooter`), so hosting clickable run links inside the chart popover
is not reliable. The `BarChart` stays as the visual; `DurationBucketPopovers`
renders the clickable per-bucket run lists directly below it. Documented in the
`DurationBucketPopovers.tsx` JSDoc.

## Commands + results

1. `npm --prefix .../frontend install`
   - Result: PASS. `removed 23 packages` (recharts + transitive deps). No new
     dependency added.

2. `npm --prefix .../frontend run build` (`tsc --noEmit && vite build`)
   - Result: PASS, exit 0. Zero TypeScript errors. No recharts reference.
     (Pre-existing non-blocking vite warnings only: aws-amplify dynamic-import
     notice and chunk-size notice.)

3. `npm --prefix .../frontend test` (`vitest run`)
   - Result: PASS, exit 0. `Test Files 43 passed (43)`, `Tests 431 passed (431)`.
   - New/updated suites: `durationBuckets.test.ts` (formatter + `runsInBuckets`
     unit + fast-check property), `DurationBucketPopovers.test.tsx` (href/target,
     `+ K more`, zero-run buckets, runsInBuckets integration),
     `ReportsView.test.tsx` (scatter GONE, histogram stays, bar-trigger ->
     popover run links with `#/run/<id>` href + `target=_blank`),
     `App.test.tsx` (removed the scatter->openRun test; top-nav still opens
     Reports).

4. `npm --prefix .../frontend run lint` (`eslint .`)
   - Result: PASS, exit 0. 0 errors, 3 warnings
     (`react-refresh/only-export-components` — matches the existing accepted
     pattern in `ReportsView.tsx` and `RunCostPanel.tsx`; one is on the new
     `DurationBucketPopovers.tsx` `runHref` export used by its test).

5. Dependency diff + reference grep
   - `git diff frontend/package.json`: only `recharts` removed.
   - `git diff frontend/package-lock.json`: 23 `node_modules/*` entries removed,
     0 added. Net change is a pure removal.
   - `npm ls recharts`: `(empty)` — not present.
   - `grep -rnE "recharts|RunDurationScatter|runScatter|ScatterDatum|runPointsToScatterData" frontend/src`:
     NO MATCHES.

## Files

- Added: `frontend/src/reports/durationBuckets.ts`,
  `frontend/src/reports/durationBuckets.test.ts`,
  `frontend/src/reports/DurationBucketPopovers.tsx`,
  `frontend/src/reports/DurationBucketPopovers.test.tsx`.
- Deleted: `frontend/src/reports/RunDurationScatter.tsx`,
  `frontend/src/reports/RunDurationScatter.test.tsx`,
  `frontend/src/reports/runScatter.ts`,
  `frontend/src/reports/runScatter.test.ts`.
- Modified: `frontend/src/reports/ReportsView.tsx` (removed scatter block,
  renamed state to `runPoints`, added `<DurationBucketPopovers>`, removed
  `onOpenRun` prop), `frontend/src/reports/ReportsView.test.tsx`,
  `frontend/src/App.tsx` (dropped `onOpenRun` prop), `frontend/src/App.test.tsx`,
  `frontend/package.json`, `frontend/package-lock.json`.

## Bucket->runs convention

`runsInBuckets` mirrors `ingest/src/metrics/aggregate.ts` `buildHistogram`:
`min = buckets[0].lo`, `max = buckets[last].hi`,
`width = (max - min) / buckets.length`; a usable run lands in
`floor((v - min) / width)` clamped to `[0, lastIndex]` — every bucket half-open
`[lo, hi)` except the LAST which is CLOSED `[lo, hi]`. Degenerate `max === min`
collapses all usable runs to index 0. Runs with null/undefined/NaN/Infinity/
negative `durationMs` are in no bucket.
