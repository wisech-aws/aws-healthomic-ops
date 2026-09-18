# Implementation Plan: Static DAG from Definition

## Overview

This plan implements a source-derived static DAG for AWS HealthOmics workflows: fetch and unzip the
definition bundle inside one Lambda invocation, parse it (WDL/CWL exact, Nextflow multi-file approximate),
cache the graph under a version-qualified DynamoDB key, expose it through a `getStaticGraph` GraphQL query,
and render it as a labeled "True DAG" layer in the run detail view with a fallback to the Inferred DAG.

Tasks are ordered by the design's dependency structure. The foundational, high-blast-radius parser type
change comes first so the build stays green through every later step. Each task pairs implementation with
the unit/property tests named in the design's Testing Strategy. The design defines 11 correctness
properties; each is implemented by exactly one property test at ≥100 iterations, tagged
`Feature: static-dag-from-definition, Property {n}`.

## Tasks

- [x] 1. Foundational parser type change and blast-radius migration
  - [x] 1.1 Change `WorkflowDefinition` and `StaticGraph` types
    - In `ingest/src/parser/types.ts`, replace `WorkflowDefinition.source: string` with `files: Record<string, string>` and `mainPath: string` (keep `workflowId`, `language`)
    - Add `export type Fidelity = 'exact' | 'approximate'` and add `fidelity: Fidelity` to the `StaticGraph` interface
    - Add a shared `readMain(def): string` helper that returns `def.files[def.mainPath]` and throws `ParseError(def.workflowId, ...)` when the main file is absent
    - Ensure `assertValidGraph` carries `fidelity` through unchanged (still guarantees unique/non-empty node ids, valid edge endpoints, acyclic) and `parseDefinition` returns the validated graph including `fidelity`
    - _Requirements: 2.1, 2.2, 4.4, 4.5, 4.6, 4.7 (Design §3, §4b)_

  - [x] 1.2 Migrate all existing `WorkflowDefinition` construction sites and parser fixtures to keep the build green
    - Update `ingest/src/parser/wdl.ts`, `cwl.ts`, and `nextflow.ts` construction/consumption points to compile against the new `files`+`mainPath` shape (edge/inventory logic refined in later tasks)
    - Migrate every parser unit test and fixture that builds a `WorkflowDefinition` (WDL/CWL/Nextflow tests) from `{ source: '<text>' }` to `{ files: { [mainPath]: '<text>' }, mainPath }`
    - Ensure existing graph-shape assertions still pass and that every `StaticGraph` construction sets a `fidelity` value
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.6 (Design §3 blast radius)_

  - [ ]* 1.3 Verify ingest build and existing tests are green after the type migration
    - Run `cd ingest && npm run build && npm test` and fix any compilation/test breakage from the type change
    - _Requirements: 2.1, 2.2 (Design Verification commands)_

- [x] 2. In-memory zip decoder
  - [x] 2.1 Implement `unzipToFileMap` with `fflate`
    - Add `fflate` as an ingest dependency (pinned version) and create `ingest/src/enrichment/unzip.ts` exporting `unzipToFileMap(bytes: Uint8Array): Record<string, string>`
    - Decode every archive entry with `fflate.unzipSync`, skip directory entries, decode file bytes as UTF-8, key by archive-relative POSIX path exactly as stored
    - Throw on corrupt/undecodable archives and when the uncompressed total exceeds a fixed size cap (e.g. 64 MiB), so the caller treats it as an unzip failure
    - _Requirements: 1.4, 1.8 (Design §2)_

  - [ ]* 2.2 Write property test for zip round-trip
    - **Property 1: Zip round-trip preserves the File_Map** — for all file maps, zipping then `unzipToFileMap` yields an equivalent File_Map
    - Use `fflate.zipSync` to build the bundle; run ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 1`
    - Include corrupt-bytes edge cases as generator inputs to confirm the failure path throws
    - In `ingest/src/enrichment/unzip.property.test.ts`
    - **Validates: Requirements 1.4**

- [x] 3. Definition_Fetcher rewrite (download + in-invocation unzip)
  - [x] 3.1 Rewrite `getWorkflowDefinition` to fetch, download, and unzip within the invocation
    - In `ingest/src/enrichment/workflow.ts`, add CONFIRM-AGAINST-DOCS constants `DEFINITION_URL_FIELD='definition'`, `WORKFLOW_MAIN_FIELD='main'`, `WORKFLOW_LANGUAGE_FIELD='engine'` and resolver helpers `resolveDefinitionUrl`, `resolveMainPath` (keep `resolveLanguage`/`mapEngineToLanguage`)
    - Call `GetWorkflow` with `export=[DEFINITION]` via `callWithRetry`; add a `DefinitionFetchOptions` interface with an injectable `download?: (url) => Promise<Uint8Array>` seam defaulting to global `fetch`
    - Control flow: read presigned URL from `definition`; download bytes in the same invocation; never persist the URL; `unzipToFileMap(bytes)`; resolve `mainPath` and `language`; return `{ workflowId, language, files, mainPath }`
    - On each failure (GetWorkflow after retries, missing/invalid URL, download throw/non-2xx, unzip failure) log operation + workflowId + reason and return `null`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.3 (Design §1)_

  - [ ]* 3.2 Write unit tests for the Definition_Fetcher
    - Assert `GetWorkflow` called with `export=[DEFINITION]` and URL read from `definition` (1.1); download seam invoked within the call (1.2); URL never persisted (1.3)
    - Assert `mainPath`/`language` populated including `WDL_LENIENT`→`WDL` (1.5); all four normalized fields present (2.3)
    - Assert `null` + log on GetWorkflow failure (1.6), download throw (1.7), and corrupt bytes (1.8)
    - In `ingest/src/enrichment/workflow.test.ts`
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 1.8, 2.3_

- [x] 4. WDL and CWL parsers read from the File_Map with exact fidelity
  - [x] 4.1 Update WDL and CWL parsers to read `files[mainPath]` and set fidelity `exact`
    - In `ingest/src/parser/wdl.ts` and `ingest/src/parser/cwl.ts`, replace `def.source` usage with `readMain(def)`, keeping existing call/step extraction and edge logic
    - Set `fidelity: 'exact'` on a successfully parsed WDL/CWL graph
    - _Requirements: 2.4, 2.5, 4.6 (Design §4a)_

  - [ ]* 4.2 Write unit tests for WDL/CWL File_Map reading and fidelity
    - Assert WDL/CWL parse from `files[mainPath]` and reproduce their prior node/edge graphs (2.4, 2.5)
    - Assert `fidelity === 'exact'` for a trivial single-file WDL and CWL definition (4.6)
    - Assert `readMain` missing-file case raises `ParseError` naming the workflowId
    - In `ingest/src/parser/wdl.test.ts` and `ingest/src/parser/cwl.test.ts`
    - _Requirements: 2.4, 2.5, 4.6_

- [x] 5. Nextflow cross-file include resolution and best-effort edges
  - [x] 5.1 Implement transitive include resolution over the File_Map
    - Rewrite `ingest/src/parser/nextflow.ts` to traverse the File_Map from `mainPath`, following `include { NAME [as ALIAS] } from '...'` statements transitively, visiting each file at most once (cycle-safe)
    - Implement `extractIncludeTargets` (regex `/\binclude\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g`) and `resolvePath` trying resolved path as-is, `+.nf`, then `+/main.nf` (nf-core module-directory convention); return `null` and skip when absent
    - Build the Node_Inventory as the deduped (first-seen-wins) union of `process <Name>` and named `workflow <Name>` declarations across all reachable files; the unnamed entry `workflow {` is the composition root, not a node
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1 (Design §5)_

  - [x] 5.2 Implement best-effort dataflow edges and Nextflow fidelity decision
    - Within each `workflow { ... }` body, seed an alias map with known process/subworkflow names, alias LHS of `ch = CALL.out[.x]` to the producer, and emit `P -> CALL` edges when a call argument resolves to a producer; reuse existing `readBlock`/`collectWorkflowBodies`/`readParenArgs`/`referencedProducers` helpers
    - Do not model `.branch{}`/`.map{}`/`.set{}`/`if` channel semantics; set `fidelity: 'approximate'` when the workflow spans >1 resolved file, any include was followed, or any heuristic edge was inferred; set `fidelity: 'exact'` only for a trivial single-file, single-process workflow with no includes and no channel wiring
    - Update the module header comment documenting the heuristic limits
    - _Requirements: 2.6, 4.2, 4.3, 4.7 (Design §5)_

  - [x] 5.3 Add nf-core-style Nextflow edge fixtures
    - Create a fixture File_Map under `ingest/` fixtures: entry `main.nf` → `workflows/<name>/main.nf` → `subworkflows/**/main.nf` → `modules/**/main.nf` with known `X.out → Z(...)` wiring
    - _Requirements: 3.1, 3.2, 3.3, 4.2 (Design Testing Strategy)_

  - [ ]* 5.4 Write property test for Nextflow node inventory
    - **Property 2: Nextflow node inventory is the deduped union of declared processes and subworkflows across all reachable files** — for all File_Maps with uniquely-named processes/subworkflows wired by includes forming an arbitrary (deep/cyclic) reference graph, the node set equals the distinct reachable declared names, each appearing exactly once
    - ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 2`; in `ingest/src/parser/nextflow.inventory.property.test.ts`
    - **Validates: Requirements 3.1, 3.2, 3.3, 4.1**

  - [ ]* 5.5 Write property test for include-resolution termination and safety
    - **Property 3: Include resolution always terminates and never fails on missing or cyclic includes** — for all File_Maps including missing-target and cyclic includes, resolution terminates (visit-once) and produces a graph without throwing; every process in a resolvable file is present
    - ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 3`; in `ingest/src/parser/nextflow.resolution.property.test.ts`
    - **Validates: Requirements 3.4, 3.5**

  - [ ]* 5.6 Write unit tests for best-effort edges and approximate fidelity
    - Using the fixture from 5.3, assert the expected producer→consumer edges appear; assert branch/map/set dependencies may be absent (documented, not asserted present) (4.2, 4.3)
    - Assert `fidelity === 'approximate'` for the multi-file nf-core-style definition and `exact` for a trivial single-process def (4.7)
    - Assert unsupported language yields a `ParseError` naming workflowId + language (2.7)
    - In `ingest/src/parser/nextflow.test.ts`
    - _Requirements: 2.6, 2.7, 4.2, 4.3, 4.7_

- [x] 6. Dispatcher fidelity passthrough and graph validation
  - [x] 6.1 Ensure `parseDefinition`/`assertValidGraph` validate and carry fidelity
    - Confirm `parseDefinition` selects the registered parser, rejects unsupported languages with a `ParseError` naming workflowId + language (2.7), and returns the validated graph including `fidelity`
    - Confirm `assertValidGraph` rejects empty/duplicate node ids and dangling edge endpoints, rejects cycles (including self-loops) with a `ParseError` naming workflowId, and returns well-formed graphs unchanged with `fidelity` preserved
    - In `ingest/src/parser/types.ts`
    - _Requirements: 2.7, 4.4, 4.5, 4.6, 4.7 (Design §4b)_

  - [ ]* 6.2 Write property test for malformed-graph rejection and acceptance
    - **Property 4: The dispatcher rejects malformed graphs** — for all graphs with an empty node id, duplicate node id, or dangling edge endpoint, `assertValidGraph` throws a `ParseError` naming the workflowId; for all well-formed acyclic graphs it returns the graph unchanged preserving `fidelity`
    - ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 4`; in `ingest/src/parser/assertValidGraph.wellformed.property.test.ts`
    - **Validates: Requirements 4.4**

  - [ ]* 6.3 Write property test for cyclic-graph rejection
    - **Property 5: The dispatcher rejects cyclic graphs** — for all node sets with an edge set introducing at least one cycle (including a self-loop), `assertValidGraph` throws a `ParseError` naming the workflowId
    - ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 5`; in `ingest/src/parser/assertValidGraph.cycle.property.test.ts`
    - **Validates: Requirements 4.5**

- [x] 7. Repository version-qualified keys and fidelity/language storage
  - [x] 7.1 Version-qualify keys and extend the Graph_Item
    - In `ingest/src/repository.ts`, change `graphPk`/`graphSk` to `WF#${workflowId}#${workflowVersionName}` and add `workflowVersionName` to all four graph methods
    - Extend `GraphItem` with `workflowVersionName`, `fidelity?`, `language?` (keep `updatedAt`, `entityType='GRAPH'`, `failureReason?`)
    - `buildGraphItem`/`putStaticGraph`: write `nodes`, `edges`, `fidelity` (from `graph.fidelity`), `language`, ISO-8601 `updatedAt` under the version key via unconditional `PutItem`
    - `getStaticGraph`: GetItem the version key; return `null` when the item is absent or lacks `nodes`/`edges` arrays; reconstruct `{ workflowId, nodes, edges, fidelity }` defaulting `fidelity` to `approximate` for legacy items
    - `recordGraphFailure`: `UpdateItem` only `failureReason` + `updatedAt` + `workflowId` + `workflowVersionName` + `entityType`, leaving prior `nodes`/`edges`/`fidelity` intact; no new table
    - _Requirements: 5.1, 5.2, 5.6, 5.7, 5.8, 4.8 (Design §6)_

  - [ ]* 7.2 Write property test for repository put/get round-trip
    - **Property 6: Repository put/get round-trip preserves the graph and its fidelity** — for all workflow ids, version names, graphs, and languages, `putStaticGraph` then `getStaticGraph` under the same version key yields an equivalent graph (nodes, edges, fidelity) and the stored item carries the language and an ISO-8601 `updatedAt`
    - Use an in-memory document-client stub; ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 6`; in `ingest/src/repository.roundtrip.property.test.ts`
    - **Validates: Requirements 5.6, 4.8**

  - [ ]* 7.3 Write property test for version key isolation
    - **Property 7: Version-qualified keys isolate graphs across versions** — for all pairs of distinct version names of the same workflow and any two graphs, persisting one under each leaves each version's stored graph readable and unchanged by the other write
    - ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 7`; in `ingest/src/repository.isolation.property.test.ts`
    - **Validates: Requirements 5.1, 5.8**

  - [ ]* 7.4 Write property test for failure preservation
    - **Property 8: Recording a failure preserves existing graph data** — for all previously-persisted graph items and any failure reason, `recordGraphFailure` under the version key leaves stored nodes, edges, and fidelity unchanged and sets only the failure reason and updated timestamp
    - ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 8`; in `ingest/src/repository.failure.property.test.ts`
    - **Validates: Requirements 5.7, 1.9**

  - [ ]* 7.5 Write unit tests for key template and entity type
    - Assert `buildGraphItem` sets `entityType='GRAPH'` and the version-qualified key `WF#<id>#<ver>` across arbitrary ids (5.1, 5.2)
    - In `ingest/src/repository.test.ts`
    - _Requirements: 5.1, 5.2_

- [x] 8. Handler orchestration with version name sourcing and cache gating
  - [x] 8.1 Source `workflowVersionName` from `GetRun`
    - In `ingest/src/enrichment/tasks.ts`, add `workflowVersionName?: string` to `RunRecord` and map it in `mapRunResponse` alongside `workflowId` within the CONFIRM-AGAINST-DOCS block
    - _Requirements: 1.9, 5.1 (Design §7)_

  - [x] 8.2 Wire `resolveStaticGraph` to cache-gate by version key with DEFAULT fallback
    - In `ingest/src/handler.ts`, give `resolveStaticGraph` a `workflowVersionName` parameter and read `run.workflowVersionName`, applying the `DEFAULT` sentinel when absent
    - Cache lookup gates work: `getStaticGraph(workflowId, versionName)` usable hit → return without fetch/parse (5.3, 5.4)
    - On miss: `getWorkflowDefinition` → `parseDefinition` → `putStaticGraph(workflowId, versionName, graph, definition.language)` (5.5, 5.6)
    - Every failure path (definition `null`, `ParseError`) calls `recordGraphFailure(workflowId, versionName, reason)` without clobbering prior data; graph resolution stays after `upsertRun`
    - _Requirements: 1.9, 5.1, 5.3, 5.4, 5.5, 5.6, 5.7 (Design §7)_

  - [ ]* 8.3 Write handler orchestration unit tests
    - Cache hit → no fetch/parse (5.4); cache miss → fetch+parse+`putStaticGraph` under version key (5.3, 5.5); definition `null` → `recordGraphFailure` under version key, no put (1.9)
    - `workflowVersionName` sourced from the run; `DEFAULT` fallback when absent
    - In `ingest/src/handler.test.ts`
    - _Requirements: 1.9, 5.3, 5.4, 5.5_

- [x] 9. GraphQL schema, resolver, and infra registration
  - [x] 9.1 Add the `StaticGraph` schema types and `getStaticGraph` query
    - In `infra/graphql/schema.graphql`, add `StaticGraphNode`, `StaticGraphEdge`, `enum GraphFidelity { exact approximate }`, and `type StaticGraph { workflowId: ID!, nodes: [StaticGraphNode!]!, edges: [StaticGraphEdge!]!, fidelity: GraphFidelity! }`, all `@aws_cognito_user_pools`
    - Add `getStaticGraph(workflowId: ID!, workflowVersionName: String!): StaticGraph @aws_cognito_user_pools` to `type Query`
    - _Requirements: 6.1, 6.2, 6.6 (Design §8)_

  - [x] 9.2 Implement the `getStaticGraph` JS resolver
    - Create `infra/resolvers/getStaticGraph.js` (APPSYNC_JS, `getRun.js` style): `request()` builds a GetItem on `PK=SK=WF#<workflowId>#<workflowVersionName>`; `response()` returns `null` on error/missing item/failure-only marker (no `nodes`), else `{ workflowId, nodes, edges, fidelity: item.fidelity || 'approximate' }`
    - _Requirements: 6.3, 6.4, 6.5 (Design §8)_

  - [x] 9.3 Register the resolver on the read-only DynamoDB data source
    - In `infra/lib/api-stack.ts`, add `{ field: 'getStaticGraph', file: 'getStaticGraph.js' }` to the `addReadResolvers` list on the existing read-only DynamoDB data source; add no new table and no new IAM
    - _Requirements: 6.6, 5.2 (Design §8)_

  - [ ]* 9.4 Write infra tests for schema, resolver, and synth
    - Assert the schema exposes `getStaticGraph(workflowId, workflowVersionName): StaticGraph` and the `StaticGraph` type with `workflowId`/`nodes`/`edges`/`fidelity`, both carrying `@aws_cognito_user_pools` (6.1, 6.2, 6.6)
    - Assert resolver `request()` builds the `PK=SK=WF#<id>#<ver>` GetItem (6.3) and `response()` returns the graph incl fidelity for a usable item (6.4) and `null` for a missing/failure-only marker (6.5)
    - Assert CDK synth registers the resolver on the read-only Dynamo data source and adds no new table and no new IAM (5.2, 6.6)
    - In `infra/` vitest test files
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 5.2_

- [x] 10. Frontend types, client query, and run detail rendering
  - [x] 10.1 Add frontend types for version name and fidelity
    - In `frontend/src/api/types.ts` add `Run.workflowVersionName?: string | null` and `StaticGraph.fidelity: 'exact' | 'approximate'`; mirror `fidelity` in `frontend/src/taskview/types.ts` view types
    - _Requirements: 7.1, 8.1 (Design §9)_

  - [x] 10.2 Add the `getStaticGraph` client query and version selection
    - In `frontend/src/api/client.ts` add the `GET_STATIC_GRAPH` query and `getStaticGraph(workflowId, workflowVersionName): Promise<StaticGraph | null>`; add `workflowVersionName` to `GET_RUN`/`LIST_RUNS` selection sets
    - In local mock mode return `MOCK_GRAPHS_BY_RUN` mapped by workflow with a `fidelity` field
    - _Requirements: 6.1, 7.1 (Design §9)_

  - [x] 10.3 Fetch, select layer, label fidelity, and toggle in `RunDetailView`
    - In `frontend/src/rundetail/RunDetailView.tsx`, on open fetch `getStaticGraph(run.workflowId, run.workflowVersionName ?? 'DEFAULT')` once alongside `getRun`/`listTasksForRun`; keep the graph in state; a fetch failure degrades to `null` (no error banner)
    - Use existing `selectLayer(graph, tasks)` (True_DAG when ≥1 node, else Inferred_DAG) and existing `buildTrueDagOverlay`/`buildTrueDagFlow` for the True DAG (exact case-sensitive name→status overlay)
    - Extend the layer badge: `approximate` → "Static DAG (approximate)"; `exact` → "True dependency graph"; add a Cloudscape toggle "Show inferred (timing) DAG" shown only while a True DAG is available, overriding the layer client-side without refetch
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5 (Design §9)_

  - [x] 10.4 Remove the `App.tsx` staticGraph shim
    - In `frontend/src/App.tsx`, remove the `staticGraphForRun` shim and its "KNOWN LIMITATION" comment now that `RunDetailView` owns the graph fetch
    - _Requirements: 7.1 (Design §9)_

  - [ ]* 10.5 Write property test for True DAG layer selection
    - **Property 9: A non-empty static graph selects the True DAG layer** — for all graphs with ≥1 node and any task list, `selectLayer` returns `True_DAG`
    - ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 9`; in `frontend/src/taskview/selectLayer.property.test.ts`
    - **Validates: Requirements 7.2**

  - [ ]* 10.6 Write property test for Inferred DAG fallback
    - **Property 10: An unusable static graph falls back to the Inferred DAG layer** — for all task lists with ≥1 task, `selectLayer` returns `Inferred_DAG` when the graph is `null` or has zero nodes
    - ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 10`; in `frontend/src/taskview/selectLayer.property.test.ts`
    - **Validates: Requirements 7.3, 7.4, 8.4**

  - [ ]* 10.7 Write property test for True DAG overlay name matching
    - **Property 11: True DAG overlay matches node to task by exact, case-sensitive name** — for all graphs and task lists, `buildTrueDagOverlay` marks a node matched with a task's status iff a task's `name` equals the node `name` by exact case-sensitive equality; case-only differences are unmatched
    - ≥100 iterations; tag `// Feature: static-dag-from-definition, Property 11`; in `frontend/src/taskview/trueDag.property.test.ts`
    - **Validates: Requirements 7.5**

  - [ ]* 10.8 Write RunDetailView and client component/example tests
    - `getStaticGraph` invoked with `workflowId` + version (`DEFAULT` fallback) on open (7.1); approximate → "approximate" label (8.1, 8.5); exact → authoritative label without "approximate" (8.2); toggle present and switches to Inferred DAG (8.3); `null` query → Inferred DAG (8.4)
    - Client: `getStaticGraph` sends the documented query/vars; mock mode returns a graph with `fidelity`
    - In `frontend/src/rundetail/RunDetailView.test.tsx` and `frontend/src/api/client.mock.test.ts`
    - _Requirements: 7.1, 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 11. Final verification (no deploy)
  - Run the three suites and ensure all pass, fixing any breakage:
    - ingest: `cd ingest && npm run build && npm test`
    - frontend: `cd frontend && npm run build && npm run lint && npx vitest run`
    - infra: `cd infra && npm test`
  - Ensure all tests pass; ask the user if questions arise
  - _Requirements: 1–8 (Design Verification commands)_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core
  implementation sub-tasks are never optional.
- Each correctness property is implemented by exactly one property test at ≥100 iterations, tagged
  `// Feature: static-dag-from-definition, Property {n}`.
- Task 1 is intentionally first: the `WorkflowDefinition`/`StaticGraph` type change is the highest
  blast-radius change, and migrating all construction sites/fixtures up front keeps the build green.
- No deployment tasks are included; deploys are billable and out of scope for implementation. Task 11 is a
  local, non-deploy verification only.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["1.3", "2.2", "3.1", "4.1", "9.1", "10.1"] },
    { "id": 3, "tasks": ["3.2", "4.2", "5.1", "6.1", "9.2", "10.2"] },
    { "id": 4, "tasks": ["5.2", "6.2", "6.3", "7.1", "9.3", "10.3"] },
    { "id": 5, "tasks": ["5.3", "7.2", "7.3", "7.4", "7.5", "8.1", "9.4", "10.4", "10.5", "10.6", "10.7"] },
    { "id": 6, "tasks": ["5.4", "5.5", "5.6", "8.2", "10.8"] },
    { "id": 7, "tasks": ["8.3"] },
    { "id": 8, "tasks": ["11"] }
  ]
}
```
