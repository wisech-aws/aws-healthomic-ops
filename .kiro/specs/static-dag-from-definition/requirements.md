# Requirements Document

## Introduction

This feature builds a **static DAG** — a true dependency graph — for an AWS HealthOmics workflow by downloading and parsing the workflow's **definition bundle** (a `definition.zip`), caching the parsed result, and surfacing it in the dashboard's run detail view as a "True DAG" layer. When a parsed graph is available for a run's workflow version, the True DAG replaces the current timing-only "Inferred DAG"; when no parsed graph is available (unsupported language, parse failure, or not-yet-built), the run detail view continues to fall back to the Inferred DAG.

The approach is **source-derived**: the graph is derived from the workflow definition source, not from observed run events. (An event-derived alternative was considered and deferred.) The design must build on machinery that already exists rather than recreate it:

- `ingest/src/enrichment/workflow.ts` (`getWorkflowDefinition`, and the `resolveDefinitionSource`/`resolveLanguage`/`mapEngineToLanguage` helpers behind "CONFIRM AGAINST AWS DOCS" markers, which were explicitly designed to be extended for the bundle/URL case), wrapped by `callWithRetry`.
- `ingest/src/parser/types.ts` (`WorkflowDefinition`, `DefinitionParser`, `parseDefinition`, `StaticGraph`/`GraphNode`/`GraphEdge`, `ParseError`, `assertValidGraph`, `registerParser`/`getParser`) plus the language parsers `wdl.ts`, `nextflow.ts`, `cwl.ts`.
- `ingest/src/repository.ts` (`GRAPH` entity type; `buildGraphItem`, `putStaticGraph`, `getStaticGraph`, `recordGraphFailure`; keys via `graphPk`/`graphSk`).
- Frontend `frontend/src/rundetail/RunDetailView.tsx`, `graphLayout.ts` (`buildTrueDagFlow`, Inferred DAG layout), `TaskNode.tsx`, `taskGraph.css`, and layer selection via `selectLayer`.
- GraphQL `infra/graphql/schema.graphql` and resolvers in `infra/resolvers/`.

A central open question this feature must address explicitly is **fidelity tiering**: a reliable node inventory is achievable, top-level dataflow edges are best-effort, and full channel semantics are out of scope. The user interface must honestly label an approximate graph and never present it as authoritative.

### Grounding facts (verified; treated as constraints)

- `GetWorkflow(export=[DEFINITION])` returns `definition` as a **presigned S3 URL** to a `definition.zip` (not inline text), plus `engine` (e.g. `NEXTFLOW` / `WDL` / `WDL_LENIENT` / `CWL`), `main` (entry filename such as `main.nf`), and `parameterTemplate`.
- The presigned URL is short-lived (~600 second TTL), so the download must happen within the same Lambda invocation as the `GetWorkflow` call.
- Trivial workflows (e.g. GreetingsNF) are a single self-contained `main.nf`. Real nf-core workflows are deeply modular (e.g. nf-core-fetchngs = 149 files, 17 `.nf` files across `main.nf` → `workflows/<name>/main.nf` → `subworkflows/**` → `modules/**`) wired by `include` statements, with true dependencies expressed as channel dataflow (`X.out.y` fed into `Z(...)`), often via `.branch{}` / `.map{}` / `.set{}` operators and `if` conditionals.

### Implementation context for later phases (not requirements)

- Language/stack is TypeScript. The ingest Lambda bundles the AWS SDK.
- Verification commands: ingest `cd ingest && npm run build && npm test`; frontend `cd frontend && npm run build && npm run lint && npx vitest run`; infra `cd infra && npm test`.
- Live TEST environment is account `123456789012` / `us-east-1`; deploys are billable. The requirements phase involves no deploys and no code.
- This spec must not collide with existing specs `healthomics-workflow-dashboard` or `dashboard-quality-of-life`.

## Glossary

- **Ingest_Lambda**: The ingest Lambda function that reacts to run/task events, calls HealthOmics read APIs, parses workflow definitions, and persists results.
- **Definition_Fetcher**: The enrichment component (in `ingest/src/enrichment/workflow.ts`) that calls `GetWorkflow`, downloads the definition bundle, and normalizes it into a `WorkflowDefinition`.
- **Definition_Bundle**: The `definition.zip` archive returned via a presigned S3 URL by `GetWorkflow(export=[DEFINITION])`.
- **Presigned_URL**: The short-lived (~600 second TTL) S3 URL on the `definition` field of the `GetWorkflow` response that points at the Definition_Bundle.
- **File_Map**: A map of archive-relative file path to file contents (`Record<string, string>`) produced by unzipping the Definition_Bundle in memory.
- **Main_Path**: The archive-relative path of the workflow entry file (from the `GetWorkflow` `main` field, e.g. `main.nf`).
- **Definition_Parser**: A per-language component implementing the `DefinitionParser` interface (WDL, Nextflow, CWL) that consumes a `WorkflowDefinition` and produces a `Static_Graph`.
- **Parser_Dispatcher**: The `parseDefinition` function that selects the registered Definition_Parser for a definition's language and validates the produced graph.
- **Static_Graph**: The parsed dependency graph (`StaticGraph`: `workflowId`, `nodes`, `edges`) derived from the workflow definition source.
- **Node_Inventory**: The set of `Static_Graph` nodes (one per workflow module/process/task), independent of edges.
- **Dataflow_Edge**: A directed producer→consumer edge in the `Static_Graph`.
- **Fidelity**: A classification of how complete a produced `Static_Graph` is — `exact` (authoritative structure) or `approximate` (node inventory reliable, edges best-effort).
- **Graph_Item**: The single-table DynamoDB item (`entityType = "GRAPH"`) storing a workflow version's `Static_Graph` and metadata.
- **Graph_Cache_Key**: The version-qualified DynamoDB key `WF#<workflowId>#<workflowVersionName>` identifying a Graph_Item.
- **Workflow_Version_Name**: The HealthOmics workflow version name that, together with the workflow id, identifies a specific definition of a workflow.
- **Repository**: The DynamoDB persistence component (`DynamoRepository` in `ingest/src/repository.ts`).
- **Graph_Query**: The new `getStaticGraph(workflowId, workflowVersionName)` GraphQL query and its resolver.
- **Run_Detail_View**: The frontend run detail component (`RunDetailView.tsx`) that renders the task graph.
- **True_DAG**: The run detail layer rendered from a `Static_Graph`.
- **Inferred_DAG**: The existing timing-only run detail layer derived from observed task timing, used as the fallback layer.

## Requirements

### Requirement 1: Fetch and unzip the definition bundle within a single invocation

**User Story:** As a dashboard operator, I want the Ingest_Lambda to download and unzip a workflow's Definition_Bundle during the same invocation that requests it, so that the short-lived Presigned_URL is never allowed to expire before use.

#### Acceptance Criteria

1. WHEN the Ingest_Lambda requests a workflow definition, THE Definition_Fetcher SHALL call `GetWorkflow` with `export=[DEFINITION]` and read the Presigned_URL from the response `definition` field.
2. WHEN a Presigned_URL is obtained from `GetWorkflow`, THE Definition_Fetcher SHALL download the Definition_Bundle within the same Ingest_Lambda invocation that received the Presigned_URL.
3. THE Definition_Fetcher SHALL NOT persist the Presigned_URL for use by a later invocation.
4. WHEN the Definition_Bundle is downloaded, THE Definition_Fetcher SHALL unzip the archive in memory into a File_Map of archive-relative path to file contents.
5. WHEN unzipping the Definition_Bundle, THE Definition_Fetcher SHALL record the Main_Path from the `GetWorkflow` `main` field and the declared language from the `GetWorkflow` `engine` field.
6. IF the `GetWorkflow` call fails after the configured retry attempts, THEN THE Definition_Fetcher SHALL return a null definition result and log the operation and the workflow identifier.
7. IF downloading the Definition_Bundle from the Presigned_URL fails, THEN THE Definition_Fetcher SHALL return a null definition result and log the failure reason and the workflow identifier.
8. IF the Definition_Bundle cannot be unzipped, THEN THE Definition_Fetcher SHALL return a null definition result and log the failure reason and the workflow identifier.
9. IF the Definition_Fetcher returns a null definition result, THEN THE Ingest_Lambda SHALL abort static-graph creation for the workflow version and leave any previously cached Graph_Item unchanged.

### Requirement 2: File-map parser interface

**User Story:** As a maintainer of the parser module, I want the `WorkflowDefinition` type to carry a File_Map and a Main_Path instead of a single source string, so that parsers can resolve multi-file workflows.

#### Acceptance Criteria

1. THE `WorkflowDefinition` type SHALL carry a File_Map field `files` of type `Record<string, string>` mapping archive-relative path to file contents.
2. THE `WorkflowDefinition` type SHALL carry a Main_Path field `mainPath` identifying the workflow entry file within the File_Map.
3. WHEN the Definition_Fetcher normalizes a `GetWorkflow` result, THE Definition_Fetcher SHALL populate the `WorkflowDefinition` with the File_Map, the Main_Path, the workflow identifier, and the declared language.
4. THE WDL Definition_Parser SHALL read its definition content from the File_Map rather than from a single source string.
5. THE CWL Definition_Parser SHALL read its definition content from the File_Map rather than from a single source string.
6. THE Nextflow Definition_Parser SHALL read its definition content from the File_Map rather than from a single source string.
7. WHERE the workflow language is unsupported, THE Parser_Dispatcher SHALL reject the definition with a `ParseError` identifying the workflow identifier and the unsupported language.

### Requirement 3: Cross-file include resolution for Nextflow

**User Story:** As a user viewing a modular nf-core workflow, I want the Nextflow Definition_Parser to follow `include` statements across files in the File_Map, so that processes and subworkflows defined in separate files appear in the graph.

#### Acceptance Criteria

1. WHEN the Nextflow Definition_Parser parses the Main_Path entry, THE Nextflow Definition_Parser SHALL resolve `include { NAME } from './path'` statements by locating the referenced file within the File_Map.
2. WHEN an `include` statement references a file present in the File_Map, THE Nextflow Definition_Parser SHALL parse the referenced file and incorporate its declared processes and subworkflows into the Node_Inventory.
3. WHEN `include` statements chain across multiple files (entry → workflow → subworkflow → module), THE Nextflow Definition_Parser SHALL follow the chain transitively across entries in the File_Map.
4. IF an `include` statement references a path that is absent from the File_Map, THEN THE Nextflow Definition_Parser SHALL skip the missing reference and continue producing a graph from the resolvable files.
5. IF `include` resolution encounters a cyclic include chain, THEN THE Nextflow Definition_Parser SHALL resolve each file at most once so that resolution terminates.

### Requirement 4: Fidelity tiers and graph guarantees

**User Story:** As a user relying on the True_DAG, I want the graph to guarantee an accurate node inventory and clearly distinguish reliable structure from best-effort structure, so that I can trust what the graph asserts.

#### Acceptance Criteria

1. WHEN a Definition_Parser successfully parses a workflow definition, THE Definition_Parser SHALL produce a Node_Inventory containing one node per declared workflow module, process, or task.
2. THE Definition_Parser SHALL attempt, on a best-effort basis, to produce top-level Dataflow_Edges by matching producer outputs consumed as inputs within workflow blocks.
3. THE Definition_Parser SHALL NOT be required to produce edges for dependencies expressed only through branch, map, set, or conditional channel operators.
4. WHEN a Definition_Parser produces a Static_Graph, THE Parser_Dispatcher SHALL validate that node ids are unique and non-empty, that every edge endpoint references an existing node, and that the graph is acyclic.
5. IF a produced Static_Graph contains a cycle, THEN THE Parser_Dispatcher SHALL reject it with a `ParseError` identifying the workflow identifier.
6. WHEN a Definition_Parser produces a Static_Graph whose edges are complete and authoritative for the definition, THE Definition_Parser SHALL mark the graph Fidelity as `exact`.
7. WHERE a Definition_Parser produces a Static_Graph with a reliable Node_Inventory but best-effort edges, THE Definition_Parser SHALL mark the graph Fidelity as `approximate`.
8. WHEN a Static_Graph is persisted, THE Repository SHALL store the graph Fidelity on the Graph_Item.

### Requirement 5: Version-qualified graph caching

**User Story:** As a dashboard operator, I want each workflow version's graph cached under a version-qualified key in the existing Graph_Item, so that a version change never serves a stale graph and graphs are reused across runs of the same version.

#### Acceptance Criteria

1. THE Repository SHALL key each Graph_Item by the Graph_Cache_Key `WF#<workflowId>#<workflowVersionName>`.
2. THE Repository SHALL store Graph_Items in the existing single-table `GRAPH` entity type without introducing a new table.
3. WHEN the Ingest_Lambda needs a workflow version's Static_Graph, THE Repository SHALL look up the Graph_Item by the Graph_Cache_Key.
4. WHEN a Graph_Item with usable graph data exists for the Graph_Cache_Key, THE Ingest_Lambda SHALL reuse the cached Static_Graph and SHALL NOT re-fetch or re-parse the definition.
5. WHEN no Graph_Item with usable graph data exists for the Graph_Cache_Key, THE Ingest_Lambda SHALL fetch and parse the definition and persist the resulting Static_Graph under the Graph_Cache_Key.
6. WHEN a workflow definition is parsed successfully, THE Repository SHALL persist the Static_Graph, the language, the Fidelity, and an updated timestamp on the Graph_Item for the Graph_Cache_Key.
7. IF fetching or parsing a definition fails, THEN THE Repository SHALL record the failure reason on the Graph_Item for the Graph_Cache_Key WITHOUT overwriting existing node and edge data.
8. WHEN two workflow versions of the same workflow are cached, THE Repository SHALL store each version's Static_Graph under its own Graph_Cache_Key so that one version's graph never replaces another version's graph.

### Requirement 6: Surfacing the stored graph via GraphQL

**User Story:** As a frontend developer, I want a GraphQL query that returns a stored Static_Graph for a workflow version, so that the Run_Detail_View can fetch and render the True_DAG.

#### Acceptance Criteria

1. THE GraphQL schema SHALL expose a Graph_Query `getStaticGraph(workflowId: ID!, workflowVersionName: String!)` returning a Static_Graph type.
2. THE Static_Graph GraphQL type SHALL expose the workflow identifier, the nodes, the edges, and the Fidelity.
3. WHEN the Graph_Query is invoked, THE Graph_Query resolver SHALL perform a DynamoDB GetItem on the Graph_Cache_Key `WF#<workflowId>#<workflowVersionName>`.
4. WHEN a Graph_Item with usable graph data exists for the requested Graph_Cache_Key, THE Graph_Query SHALL return the stored Static_Graph including its Fidelity.
5. IF no Graph_Item with usable graph data exists for the requested Graph_Cache_Key, THEN THE Graph_Query SHALL return a null Static_Graph.
6. THE Graph_Query SHALL be authorized for the Cognito user pool consistent with the other interactive queries.

### Requirement 7: Rendering the True DAG in the run detail view

**User Story:** As a user viewing a run, I want the Run_Detail_View to fetch and render the True_DAG when one is available for the run's workflow version, so that I see the real dependency structure instead of only timing-inferred ordering.

#### Acceptance Criteria

1. WHEN the Run_Detail_View opens for a run, THE Run_Detail_View SHALL invoke the Graph_Query using the run's workflow identifier and Workflow_Version_Name.
2. WHEN the Graph_Query returns a Static_Graph with at least one node, THE Run_Detail_View SHALL render the True_DAG layer.
3. WHEN the Graph_Query returns a null Static_Graph, THE Run_Detail_View SHALL render the Inferred_DAG layer as the fallback.
4. WHEN the Graph_Query returns a Static_Graph with no nodes, THE Run_Detail_View SHALL render the Inferred_DAG layer as the fallback.
5. WHEN the True_DAG is rendered, THE Run_Detail_View SHALL overlay each Static_Graph node with the live status of the task whose name matches the node name by exact, case-sensitive equality.

### Requirement 8: Honest fidelity labeling and non-fabrication

**User Story:** As a user, I want approximate graphs to be clearly labeled and unsupported workflows to degrade gracefully, so that I never mistake a best-effort graph for an authoritative one.

#### Acceptance Criteria

1. WHILE the rendered True_DAG has Fidelity `approximate`, THE Run_Detail_View SHALL display a label identifying the graph as approximate.
2. WHILE the rendered True_DAG has Fidelity `exact`, THE Run_Detail_View SHALL display a label identifying the graph as the true dependency graph without an approximate qualifier.
3. WHEN the True_DAG is rendered, THE Run_Detail_View SHALL provide a control to switch to the Inferred_DAG layer.
4. IF the run's workflow language is unsupported or the definition is unparseable, THEN THE Run_Detail_View SHALL render the Inferred_DAG layer.
5. THE Run_Detail_View SHALL NOT present an approximate Static_Graph as an authoritative dependency graph.
