# Reports duration histogram: Recharts scatter → clickable per-bucket run popovers

The branch removes the Recharts per-run duration scatter and replaces it with a parallel, click-triggered Cloudscape `Popover` control sitting directly below the existing Cloudscape duration-distribution `BarChart`. Each non-empty histogram bucket gets a small trigger button; opening it lists that bucket's runs as hyperlinks that open the in-app deep link `#/run/<runId>` in a new browser tab. The bucket→runs mapping is a pure exported function (`runsInBuckets`) that mirrors the server's `buildHistogram` convention so per-bar counts reconcile with per-popover lists. The `recharts` dependency is dropped from both `package.json` and `package-lock.json`; no new dependency is added.

**Watch for:** nothing blocking. One behavioral note (non-blocking): a usable run whose `durationMs` falls outside `[min, max]` gets clamped into the edge bucket — this matches the server's own clamping, so counts still reconcile, but it means the frontend-fetched run population and the server-aggregated population are assumed to be the same window (they are, both query the same range). (confirmed)

**Verdict**: APPROVED

## High-level view

The scatter and its supporting module are fully gone from the branch: `RunDurationScatter.tsx`/`.test.tsx` and `runScatter.ts`/`.test.ts` are deleted, and a scoped grep over `.worktrees/reports-bar-popover/frontend/src` returns zero references to `recharts`, `RunDurationScatter`, `runScatter`, `ScatterDatum`, or `runPointsToScatterData`. (The whole-workspace grep tool also surfaces the main-branch copies, which still exist on `main` and are out of scope.)

The popover mechanism is the documented FALLBACK: the pinned `@cloudscape-design/components@3.0.1356` `BarChart` has no interactable `detailPopoverContent` render prop, so the chart stays as the pure visual and a separate row of click-triggered `Popover`s hosts the run links. This is stated in the `DurationBucketPopovers.tsx` JSDoc and the verification note, and it is deterministic/unit-testable rather than relying on driving the chart's hover popover under jsdom.

Both Cloudscape `BarChart`s are retained: `reports-duration-chart` (the histogram) and `reports-timebins-chart` ("Runs over time"). The "N of M runs" availability note on the histogram is kept.

Run links are real anchors built via `serializeViewHash({ kind: 'run', runId })` prefixed with `window.location.origin + pathname`, carrying `target="_blank"` (Cloudscape adds `rel="noopener noreferrer"`). This is in-app deep-link format, exactly matching `viewHash.ts`.

The bucket mapping is pure, exported, and tested with unit cases plus a fast-check property; the shared `formatDurationMs` moved into the sensibly-named `durationBuckets.ts` and its tests were ported. No test on the branch imports recharts or the scatter.

<details>
<summary>Issues (0 blocking)</summary>

No blocking findings. One informational note: `runsInBuckets` clamps out-of-range usable durations into the edge bucket, matching the server's `buildHistogram`; reconciliation holds because both query the same window.

</details>

<details>
<summary>Details</summary>

### Constraint 1 — recharts and RunDurationScatter fully removed

`frontend/package.json` diff shows the sole change is removal of `"recharts": "3.10.1"` (the `reactflow` line is untouched; the trailing comma shift is cosmetic). `grep -n recharts frontend/package-lock.json` returns nothing. `git diff --diff-filter=D` confirms `RunDurationScatter.tsx`, `RunDurationScatter.test.tsx`, `runScatter.ts`, `runScatter.test.ts` are all deleted on the branch. Scoped grep over `.worktrees/reports-bar-popover/frontend/src` for `recharts|RunDurationScatter|runScatter|ScatterDatum|runPointsToScatterData` → NO MATCHES. The only `reports-run-scatter` token left in-tree is the negative assertion in `ReportsView.test.tsx:179`. (confirmed)

### Constraint 2 — no new dependency, no react-router

`package.json` net change is a pure removal; `grep react-router frontend/package.json` → none. Lockfile diff is 274 lines of `node_modules/*` removals, zero additions (per verification note `removed 23 packages`). (confirmed)

### Constraint 3 — both BarCharts kept, scatter gone

`ReportsView.tsx` keeps `reports-duration-chart` (the `BarChart` histogram, with the "N of M runs" key-label note at the `Duration distribution` block) and `reports-timebins-chart` ("Runs over time (per bin)" `BarChart`). No `reports-run-scatter` element is rendered. (confirmed)

### Constraint 4 — click → popover → new-tab deep-link hyperlinks

`DurationBucketPopovers.tsx` renders one Cloudscape `Popover` (`triggerType="custom"`, `dismissButton`) per non-empty bucket, each triggered by a `Button` with `data-testid="reports-bucket-trigger"`. Content lists each run as `<Link external href={runHref(run.runId)} target="_blank" data-testid="reports-bucket-run-link">`. `runHref` = `${origin}${pathname}${serializeViewHash({ kind:'run', runId })}`, i.e. `#/run/<encoded runId>`, matching `viewHash.ts serializeViewHash` exactly. The chosen mechanism (parallel click-triggered control, not the chart's built-in popover) and the reason (3.0.1356 BarChart lacks interactable `detailPopoverContent`) are documented in the component JSDoc and verification note. (confirmed)

### Constraint 5 — pure bucket→runs mapping, strict no-fabrication, reconciliation

`runsInBuckets` in `durationBuckets.ts` is pure and exported. It derives `min = buckets[0].lo`, `max = buckets[last].hi`, `width = (max-min)/buckets.length`, assigns `idx = floor((v-min)/width)` clamped to `[0, lastIndex]` — half-open `[lo,hi)` with the last bucket closed. This matches `ingest/src/metrics/aggregate.ts buildHistogram` (which builds `lo = min + i*width`, `hi = min + (i+1)*width`, and clamps `idx` the same way), so `buckets[0].lo === server min` and `buckets[last].hi === server max`; the floor+clamp is identical. Degenerate `max===min` (non-positive width) collapses to index 0, matching the server's single-bucket collapse. Runs with null/undefined/NaN/Infinity/negative `durationMs` are excluded via `isUsableDurationMs`. The popover list is capped at `MAX_VISIBLE_RUNS = 50` with a `+ K more` note. The histogram's "N of M runs" availability note is preserved in `ReportsView.tsx`. (confirmed)

Note (non-blocking): a usable run outside `[min,max]` is clamped into the edge bucket. The server does the same, and both read the same window, so per-bar/per-popover counts still reconcile. (confirmed)

### Constraint 6 — tests + property, shared formatter, no scatter imports

`durationBuckets.test.ts` covers `formatDurationMs` (0:00:00, 0:15:00, 1:01:01, rounding 1499→01 / 1500→02), interior-boundary → upper bucket, max → last bucket, min → first, clamping, exclusion of unusable durations, degenerate single bucket, order preservation, reconciliation with a hand-built histogram fixture, and a fast-check property (every assigned run is finite ≥0, total assigned equals the usable count). `DurationBucketPopovers.test.tsx` covers `runHref` format + URL-encoding, zero-run buckets → no trigger, click → new-tab links with `#/run/<id>`/`target=_blank`/`rel=noopener`, the 50-cap + `+ 23 more`, and `runsInBuckets` integration. `formatDurationMs` now lives in the sensibly-named `durationBuckets.ts` and is reused by `ReportsView.tsx fmtStat`. No branch test imports recharts/RunDurationScatter (the grep hits are main-branch copies, out of scope). (confirmed)

### Constraint 7 — verification evidence

`verification.md` records exact commands and results: `npm install` (removed 23 packages, no new dep), `npm run build` (exit 0, zero TS errors), `npm test` (43 files, 431 tests passed), `npm run lint` (0 errors, 3 pre-existing `react-refresh/only-export-components` warnings consistent with the existing accepted pattern), plus the dependency diff and reference grep. Evidence is complete; per instructions the suites were not re-run. (confirmed)

</details>

<details>
<summary>File map</summary>

- `frontend/src/reports/durationBuckets.ts` — new shared pure module: `formatDurationMs` + `runsInBuckets`.
- `frontend/src/reports/durationBuckets.test.ts` — unit + fast-check property tests for the above.
- `frontend/src/reports/DurationBucketPopovers.tsx` — new click-triggered per-bucket popover control with new-tab run links; `runHref` export.
- `frontend/src/reports/DurationBucketPopovers.test.tsx` — component tests (links, cap, zero-run buckets, integration).
- `frontend/src/reports/ReportsView.tsx` — removed scatter block, renamed state to `runPoints`, renders `DurationBucketPopovers` below the histogram, dropped `onOpenRun` prop.
- `frontend/src/reports/ReportsView.test.tsx` — removed recharts mock + scatter suite, added bucket-popover suite.
- `frontend/src/App.tsx` — dropped the dead `onOpenRun` prop to ReportsView (kept `openRun` for fleet).
- `frontend/src/App.test.tsx` — removed scatter→openRun test; retains top-nav→Reports routing test.
- `frontend/package.json` / `frontend/package-lock.json` — recharts removed (pure removal).
- Deleted: `RunDurationScatter.tsx`, `RunDurationScatter.test.tsx`, `runScatter.ts`, `runScatter.test.ts`.

Full diff: `git -C .worktrees/reports-bar-popover diff main...reports-bar-popover`

</details>
