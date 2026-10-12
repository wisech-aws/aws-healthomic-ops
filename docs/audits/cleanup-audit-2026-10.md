# Cleanup Audit — AWS HealthOmics Workflow Dashboard

READ-ONLY investigation. Nothing was changed, deleted, or moved. Every claim below cites the search that proves it.

- Repo root: `/Users/wisech/Documents/aws-healthomics-visualizer`
- Commit audited: `f6bf53d` (main), working tree clean (`git status --short` empty)
- Packages: `frontend/` (React 19 + Vite + Cloudscape), `ingest/` (Node 20 Lambda), `infra/` (CDK v2), standalone `dist-cost-estimator/`, plus `scripts/`. No root `package.json`.

## Summary (counts)

| Category | Count | Notes |
|---|---|---|
| Orphaned source files (`.ts`/`.tsx`) | **0** | Every non-entry module has a non-test importer. The three abandoned scatter attempts + relative-time revert left **no** orphaned source behind — reverts were clean. |
| Genuine dead exports | **0** | All flagged exports are used in their own file (JSX/type position) or are idiomatic component `Props` types. |
| Unused dependencies | **1 SAFE, 2 RISKY** | SAFE: `elkjs` (frontend). RISKY: `@aws-sdk/client-appsync` (ingest), `graphql-ws` + `graphql` (frontend). |
| Stale committed build output | **9 files** | `infra/lib/*.js` + `*.d.ts` and `infra/bin/infra.{js,d.ts}` — compiled output, CDK runs via ts-node. RISKY (verify no external consumer). |
| Tracked agent/workflow artifacts | **10 files** | All of `.agents/tasks/**` is git-tracked (NOT gitignored). Describe reverted/shipped features. SAFE-ish, user decision. |
| Obsolete specs/docs | note only | `.kiro/` is gitignored (untracked) — not a repo-cleanup concern. |
| Untracked root cruft | note only | `*.zip`, `*.html`, `.DS_Store`, `cdk-outputs.json` are all gitignored — not tracked, not a cleanup target. |

Headline: the recent churn (3 scatter attempts, relative-time revert, recharts add/remove) was reverted **cleanly in source** — no orphaned `.ts/.tsx`, no `recharts` anywhere, no dead helpers. The real cleanup opportunities are (1) one unused frontend dep `elkjs`, (2) committed compiled JS in `infra/`, and (3) the git-tracked `.agents/tasks/` planning artifacts.

---

## 1. Orphaned source files — NONE

Importer scan over every non-test, non-entry module in all three packages (allowing ESM `.js` import extensions) returned zero orphans.

- frontend: scanned `frontend/src/**/*.{ts,tsx}` excluding `.test.*`, `main.tsx`, `vite-env.d.ts`, `testFactories.ts` — every module has ≥1 non-test importer.
- ingest: scanned `ingest/src/**/*.ts` with regex `/${mod}(\.js)?['"]` — zero orphans. Handler entry points (`handler`, `costHandler`, `kinesisHandler`, `logsHandler`, `metricsHandler`, `reconcilerHandler`, `reportsHandler`) are referenced by `infra/lib/api-stack.ts` (e.g. `COST_HANDLER_ENTRY = path.join(INGEST_PROJECT_ROOT, 'src', 'costHandler.ts')`, api-stack.ts:27-30).
- infra: scanned `infra/{lib,bin}/**/*.ts` (excluding `.d.ts`) — zero orphans.

Specific revert suspects verified absent:

- `RunDurationScatter` — `grep -rn "RunDurationScatter"` over all `.ts/.tsx`: **zero hits**.
- `runScatter` — `grep -rni "runScatter"`: **zero hits** (only mentioned historically inside `.agents/tasks/scatter-recharts-plan.md`, a tracked artifact, not source).
- `RelativeTime` component / `relativeTime.ts` — `grep -rni "relativeTime"` in `frontend/src`: **zero hits**.
- `git ls-files | grep -iE "scatter|relative"` → only `.agents/tasks/scatter-plan.md` and `.agents/tasks/scatter-recharts-plan.md` (artifacts, see §5). No source files.

Verdict: **KEEP everything** (nothing to remove here).

Note on `frontend/src/reports/resolveRange.test.ts`: it has no sibling `resolveRange.ts` (looks suspicious) but it is NOT orphaned — it imports `resolveRange` from `./ReportsView` (`resolveRange.test.ts:4`), and `ReportsView.tsx:112` `export function resolveRange(...)` is used at `ReportsView.tsx:199`. KEEP.

The current reports feature (`durationBuckets.ts`, `DurationBucketPopovers.tsx` with `runHref`, bar histogram) is live and imported by `ReportsView.tsx` — KEEP (confirmed by brief, verified by importer scan).

---

## 2. Dead exports / unused helpers — NONE genuine

A symbol-level scan (`export (function|const|class|interface|type|enum) NAME`, then look for references outside the defining file) surfaced candidates; **every one is used inside its own file** (my scan deliberately excludes the defining file, which makes same-file JSX/type uses look "dead"). Re-verified individually:

| Symbol | File | Reality |
|---|---|---|
| `runHref` | `frontend/src/reports/DurationBucketPopovers.tsx:38` | used same file at line 65 (`href={runHref(run.runId)}`). KEEP |
| `explainUnavailable` | `frontend/src/rundetail/RunCostPanel.tsx:150` | used same file at lines 337/350/371. KEEP |
| `MEASURED_MEMORY_NOTE` | `frontend/src/rundetail/UtilizationBars.tsx:58` | used same file at line 196. KEEP |
| `SubscribeRuns` (type) | `frontend/src/fleet/FleetView.tsx:121` | used same file at 123/149. KEEP |
| `DetailSelection` (type) | `frontend/src/rundetail/TaskDetailPanel.tsx:58` | used same file at 313. KEEP |
| `*Props` interfaces (CopyIdProps, ErrorBoundaryProps, LogsPanelProps, RunDetailViewProps, RunMetricsPanelProps, ParamsDiffViewProps, FleetViewProps, ...) | various `.tsx` | idiomatic exported component prop types; low value, risky to strip. KEEP |
| `FilesystemUsageWindow`, `FilesystemUsageSigningParams` | `ingest/src/cost/filesystemUsage.ts` | exported types consumed within the module's own API surface. KEEP |
| `DefinitionFetchOptions` | `ingest/src/enrichment/workflow.ts` | exported options type for the module's own function. KEEP |

Specific revert-leftover helpers the brief called out:

- `formatStartTime` — **still used**, not leftover: `frontend/src/fleet/duration.ts:57` defines it; used by `TaskDetailPanel.tsx:266,273` and `FleetView.tsx:711`. KEEP.
- `formatAbsoluteTime` — `grep` returns **zero hits**: fully removed with the relative-time revert. Nothing to clean.
- `topLongestRuns` — `grep` returns **zero hits**: does not exist. Nothing to clean.

Verdict: **nothing to remove**. The reverts did not leave dead helpers.

---

## 3. Unused dependencies

Checked every `dependencies`/`devDependencies` entry in each `package.json` against actual `import`/`require` usage in that package's source and config. CLI/config-only tools (`eslint`, `typescript`, `vite`, `vitest`, `jest`, `ts-jest`, `ts-node`, `aws-cdk`, `@vitejs/plugin-react`, eslint plugins, `@types/*`, `jsdom`, `@testing-library/*`, `fast-check`) are NOT flagged — they are used via config files or test runs, not imports.

### 3a. `elkjs` (frontend) — **SAFE to remove**

- Declared: `frontend/package.json:22` `"elkjs": "0.12.0"`.
- Evidence of non-use: `git grep -nI "elkjs|'elk'|elkLayout|ELK" -- frontend/**` (excluding lockfile) returns **only** `frontend/package.json:22`. No static import, no dynamic `import()`, no string reference in any `.ts/.tsx` or config.
- The run-detail graph layout is done entirely with `dagre` + `reactflow` (`frontend/src/rundetail/graphLayout.ts:14-15`). `elkjs` is an alternative layout engine that is never wired in — a leftover from an abandoned layout approach.
- Severity: medium. Verdict: **SAFE to remove** `elkjs` from `frontend/package.json` (and regenerate `frontend/package-lock.json`). It has no peer/plugin/type indirection — it is a standalone runtime lib with zero references.

### 3b. `@aws-sdk/client-appsync` (ingest) — **RISKY (lean remove)**

- Declared: `ingest/package.json:17`.
- Evidence: `git grep -nI "client-appsync"` (excluding lockfiles) returns **only** `ingest/package.json:17`. In source, `grep -rn "client-appsync|AppSyncClient"` in `ingest/src` → zero. The only `appsync` mentions are a comment and the SigV4 service-name string in `ingest/src/publisher.ts:25,49`.
- The publisher signs AppSync HTTP requests manually with `@smithy/signature-v4` + `@aws-sdk/credential-provider-node` (`publisher.ts:35-37`) — it does **not** use the AppSync SDK client.
- Not referenced in `scripts/` either (`grep -rn "client-appsync" scripts` → zero).
- Severity: medium. Verdict: **RISKY** — appears genuinely unused, but AWS SDK v3 clients are occasionally pulled in indirectly or added in anticipation of use. Safe to remove on a careful pass with a build+test run afterward; marked RISKY (not SAFE) because the user will act on this list and SDK removals warrant a verification build.

### 3c. `graphql-ws` + `graphql` (frontend) — **RISKY, lean KEEP**

- Declared: `frontend/package.json:17-18` (`graphql: 17.0.2`, `graphql-ws: 6.2.1`).
- Evidence: no direct source import of either (`grep -rnE "from 'graphql'"` → zero; `grep -rni "graphql-ws"` in `frontend/src` → only a **comment** at `subscriptionManager.ts:169` "AppSync/graphql-ws deliver a value only when data arrives").
- But these are the runtime/peer companions of AppSync GraphQL subscriptions via `aws-amplify` (used heavily: `src/api/client.ts`, `subscriptionManager.ts`). `graphql` is also a declared peer of `graphql-ws` (`frontend/package-lock.json:5884` peerDependencies `"graphql": "^15.10.1 || ^16 || ^17"`).
- Severity: low. Verdict: **RISKY — KEEP** unless deliberately testing a build/subscription path without them. Removing a pinned GraphQL version that Amplify's websocket transport relies on can break subscriptions at runtime (not caught by `tsc`). Do not strip without an end-to-end subscription test.

### Dependencies confirmed USED (KEEP) — spot evidence

- frontend: `dagre` (graphLayout.ts:14), `reactflow` (9 files), `aws-amplify` (5 files, incl. dynamic `import('aws-amplify')` config.ts:190), `@aws-amplify/ui-react` (App.tsx:24 Authenticator), `@cloudscape-design/components` (many), `@cloudscape-design/global-styles` (main.tsx:6). `@types/dagre` backs `dagre`.
- ingest: all `@aws-sdk/client-*` except appsync are imported (dynamodb 5, omics 6, pricing 1, scheduler 2, cloudwatch-logs 1, lib-dynamodb 5, credential-provider-node 2, @aws-sdk/types 1), plus `@aws-crypto/sha256-js`, `@smithy/node-http-handler`, `@smithy/signature-v4`, `fflate`, `js-yaml` — all have ≥1 source import.
- infra: `aws-cdk-lib` + `constructs` (8 refs) used across stacks; `esbuild` used by NodejsFunction bundling (referenced in `lib/ingest-stack.ts`); `ts-node` is the CDK app runner (`cdk.json` app = `npx ts-node ... bin/infra.ts`).
- dist-cost-estimator: all 5 deps used in `estimate-run-cost.mjs` (2 refs each).

---

## 4. Stale build artifacts / committed generated output

### 4a. Compiled TS output committed in `infra/` — **RISKY (likely stale, verify then remove)**

Tracked (via `git ls-files`), NOT gitignored (`git check-ignore` returns nonzero):

```
infra/bin/infra.js        infra/bin/infra.d.ts
infra/lib/api-stack.js     infra/lib/api-stack.d.ts
infra/lib/data-stack.js    infra/lib/data-stack.d.ts
infra/lib/frontend-stack.js infra/lib/frontend-stack.d.ts
infra/lib/ingest-stack.js   infra/lib/ingest-stack.d.ts
```

Evidence these are compiled output, not needed at runtime:

- `infra/tsconfig.json` compiles `bin/**/*.ts` + `lib/**/*.ts` with `"declaration": true` and **no `outDir`** → `tsc` emits `.js` + `.d.ts` next to each `.ts`.
- The CDK app executes the **TypeScript** directly: `infra/cdk.json` `"app": "npx ts-node --prefer-ts-exts bin/infra.ts"`. It does not run the committed `.js`.
- `cdk.json` `watch.exclude` explicitly lists `**/*.d.ts` and `**/*.js` — the compiled files are treated as noise.
- `infra/eslint.config.mjs` ignores `**/*.js` and `**/*.d.ts` — not linted as source.
- `infra/package.json` `"bin": { "infra": "bin/infra.js" }` is the only reference to a compiled file, but that `bin` field is irrelevant for a `private` package that is never `npm install`ed as a dependency; CDK uses the `cdk.json` app command, not the `bin`.
- `infra/lib/api-stack.js` and `api-stack.ts` were last committed in the same commit `17cdf8b` — i.e. the `.js` is a one-time committed snapshot, easy to drift out of sync on the next `tsc`.

Severity: medium. Verdict: **RISKY → remove from tracking + gitignore**. Recommend `git rm --cached infra/{bin,lib}/*.js infra/{bin,lib}/*.d.ts` and add `infra/lib/*.js`, `infra/lib/*.d.ts`, `infra/bin/*.js`, `infra/bin/*.d.ts` (or `infra/**/*.js`/`*.d.ts` carefully — see caveat) to `.gitignore`. Marked RISKY not SAFE because of the `infra/resolvers/*.js` caveat below — a blanket `infra/**/*.js` ignore would wrongly untrack source resolvers.

### 4b. `infra/resolvers/*.js` — **KEEP (genuine source, NOT build output)**

```
infra/resolvers/{getRun,getStaticGraph,listRuns,listTasksForRun,publishPassthrough}.js
```

- There are **no** `.ts` versions of these (`git ls-files 'infra/resolvers/*'` shows only `.js`).
- They are hand-written **AppSync JS resolvers** loaded as assets by file name: `infra/lib/api-stack.ts:45` `RESOLVERS_DIR = path.join(__dirname, '..', 'resolvers')` and `api-stack.ts:612-614` reference `'listRuns.js'`, `'getRun.js'`, `'listTasksForRun.js'`, etc.
- Verdict: **KEEP**. Any `.gitignore` rule for infra compiled output must NOT match `infra/resolvers/*.js` (scope the ignore to `infra/lib/` and `infra/bin/`).

### 4c. Untracked root cruft — note only, NOT cleanup targets

All gitignored (confirmed via `.gitignore` + they do not appear in `git ls-files`):
- `healthomics-cost-estimator.zip`, `omics-2026-09-03.zip` → `.gitignore` `*.zip`
- `User Guide – AWS HealthOmics S3 Run Storage (beta).html` → `.gitignore` `User Guide*AWS HealthOmics*.html`
- `.DS_Store` → `.gitignore` `.DS_Store`
- `cdk-outputs.json` → `.gitignore` `cdk-outputs.json`
- `HealthOmics Dashboard - Coding Agent Prompt.md` → `.gitignore` `*Coding Agent Prompt*.md`
- `.kiro/` → `.gitignore` `.kiro/`

These are local-only files; they are not in version control, so they are not a repo-cleanup concern. (The user may still delete local copies if desired, but nothing to do in git.)

---

## 5. Leftover agent/workflow artifacts — `.agents/tasks/**` (TRACKED)

`.agents/` is **NOT gitignored** (`git check-ignore .agents/tasks/scatter-plan.md` → exit 1). All of the following are git-tracked:

```
.agents/tasks/scatter-plan.md            (107 lines) — abandoned Cloudscape LineChart scatter attempt
.agents/tasks/scatter-recharts-plan.md   (100 lines) — abandoned Recharts scatter attempt; references deleted runScatter.ts
.agents/tasks/reports-bar-popover-plan.md(198 lines) — the CURRENT bar-histogram-with-popover feature plan
.agents/tasks/reports-bar-popover-review.md (79 lines)
.agents/tasks/verification.md            (77 lines)
.agents/tasks/review.json                (12 lines)
.agents/tasks/features/FEAT-001.json     — reverted QoL #5 "relative timestamps" (describes RelativeTime.tsx, relativeTime.ts, formatAbsoluteTime — all since removed)
.agents/tasks/features/FEAT-002.json     — shipped QoL #4 log search/download
.agents/tasks/features/FEAT-003.json     — shipped QoL #2 copy-to-clipboard
.agents/tasks/features/FEAT-004.json     — shipped QoL #3 deep-linkable URLs
```

Evidence they describe reverted/completed work:
- `scatter-recharts-plan.md` opens by proposing to "Replace the current Cloudscape LineChart ... with a true interactive Recharts ScatterChart ... Reuse the pure transform in runScatter.ts" — both the Recharts chart and `runScatter.ts` are gone from source (§1).
- `FEAT-001.json` describes creating `frontend/src/fleet/relativeTime.ts`, `frontend/src/components/RelativeTime.tsx`, and `formatAbsoluteTime` — none exist in source (§2).

Severity: low. Verdict: **SAFE-ish, user decision**. These are development scaffolding, not part of the shipped product, and `README.md` does not reference `.agents/`. They can be removed from tracking (`git rm -r --cached .agents/tasks` or delete) and `.agents/` added to `.gitignore` to match how `.kiro/` is already handled. Flagged as **user decision** rather than hard-SAFE because a team may intentionally keep workflow artifacts in history. NOTE: this very report is being written to `.agents/tasks/cleanup-audit.md`; if the user cleans up `.agents/`, preserve or relocate this file first.

---

## 6. Obsolete specs/docs — note only (do not delete)

- `.kiro/specs/dashboard-quality-of-life/` (and sibling specs) describe QoL features including the reverted relative-timestamp (QoL #5). `.kiro/` is **gitignored** (untracked), so it is outside repo-cleanup scope. If the user keeps `.kiro/` locally, the QoL design/requirements/tasks for the reverted relative-time feature are **possibly obsolete** — user decision, do not auto-remove.
- `docs/design-sqs-fifo-batch-ingest.md`, `docs/healthomics-eventbridge-feedback.md` — tracked design docs; nothing indicates they are obsolete. KEEP.
- `scripts/estimate-run-cost.mjs` is **byte-identical** to `dist-cost-estimator/estimate-run-cost.mjs` (`diff -q` → identical); the `.sh`/`.cmd` differ slightly. This is intentional duplication (`dist-cost-estimator/` is the packaged standalone copy of the `scripts/` tool), not dead code. KEEP both; noted for awareness.

---

## Recommended cleanup order (SAFE items only)

Do these in order; run the listed verification after each. These are the only items rated SAFE; everything else is RISKY/KEEP/user-decision above.

1. **Remove `elkjs` from the frontend.**
   - Edit `frontend/package.json` (drop line 22 `"elkjs": "0.12.0"`), then `cd frontend && npm install` to update `package-lock.json`.
   - Verify: `cd frontend && npm run build && npm test` — build + Vitest pass (proves nothing imported it). Evidence it is safe: `git grep "elkjs"` matched only `package.json`.

2. **Untrack the committed agent/workflow artifacts (user-confirmed).**
   - `git rm -r --cached .agents/tasks` (preserve/relocate this `cleanup-audit.md` first), add `.agents/` to `.gitignore`.
   - Verify: `git status` shows them staged for deletion from the index only; working-tree builds unaffected (`.agents/` is never imported by any package).

RISKY items deliberately excluded from the SAFE to-do (require a verification build/test or user judgment before acting): `@aws-sdk/client-appsync` removal (§3b), the `infra/lib|bin` compiled `.js`/`.d.ts` untracking (§4a, careful not to catch `infra/resolvers/*.js`), and `graphql-ws`/`graphql` (§3c, lean KEEP).

---

## Could-not-determine / ambiguous

- **`@aws-sdk/client-appsync` (ingest):** source shows zero usage, but I cannot rule out a planned/indirect use. Confirm with a build+test after removal before committing. (RISKY, not SAFE.)
- **`graphql` / `graphql-ws` (frontend):** no direct import, but they are the runtime/peer backing for Amplify AppSync subscriptions; `tsc`/Vitest would not catch breakage from removing them. A live subscription smoke test is required to call them removable. Default: KEEP.
- **`infra/lib|bin` compiled `.js`/`.d.ts`:** strongly evidenced as unused build output (CDK runs ts-node), but confirm no external script/import consumes `infra/lib/*.js` before untracking. The `bin` field in `infra/package.json` points at `bin/infra.js` — harmless for a private, never-installed package, but worth a glance.
- **`scripts/` vs `dist-cost-estimator/` duplication:** identical `.mjs`; intentional packaging, not confirmed dead. KEEP both unless the user says the standalone package is retired.
