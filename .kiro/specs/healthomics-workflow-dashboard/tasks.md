# Implementation Plan: HealthOmics Workflow Dashboard

## Overview

This plan implements the serverless HealthOmics Workflow Dashboard incrementally, one independently testable layer at a time, in the order fixed by the design: project scaffolding → data model → ingest → parser → API → frontend, with tests wired in throughout. Each task builds on prior tasks and ends by integrating its output into the running system so no orphaned code remains.

The stack is TypeScript end-to-end: AWS CDK v2 for infrastructure, Node.js 20.x for the ingest Lambda, and React + Vite for the SPA. Property-based tests use `fast-check`; CDK template assertions verify infrastructure shape. Each of the 26 correctness properties from the design maps to exactly one property-based test running a minimum of 100 iterations, tagged `Feature: healthomics-workflow-dashboard, Property {number}: {property_text}`.

## Tasks

- [x] 1. Scaffold the monorepo, CDK app shell, and shared tooling
  - Create the repo layout: `infra/` (CDK v2 TS app), `ingest/` (Lambda TS), `frontend/` (Vite React TS), `fixtures/`, `scripts/`.
  - Pin all dependencies to exact versions in each `package.json` (CDK v2, `aws-cdk-lib`, `constructs`, `esbuild`, `fast-check`, `vitest`/`jest`, TypeScript, React, Vite, React Flow, `dagre`/`elkjs`, AppSync/Amplify client, `graphql-ws`).
  - Configure `tsconfig.json`, linting, and the test runner in each package so `test` and `build` scripts run.
  - Create the CDK app entry point instantiating four empty stacks (`DataStack`, `ApiStack`, `IngestStack`, `FrontendStack`) in dependency order, applying a project identifier tag at the app level.
  - _Requirements: 11.1, 11.8, 12.1_

- [x] 2. Implement the DynamoDB data model in DataStack
  - [x] 2.1 Define the single table with GSI1 in DataStack
    - Create the DynamoDB table with `PK`/`SK` keys, on-demand (PAY_PER_REQUEST) capacity, point-in-time recovery enabled, and a `RemovalPolicy` chosen for clean teardown.
    - Add global secondary index `GSI1` on `GSI1PK`/`GSI1SK`.
    - Export table name and ARNs (table + GSI) as stack properties and stack outputs.
    - _Requirements: 3.6, 3.7, 12.3, 11.7_

  - [ ]* 2.2 Write CDK template assertions for the table
    - Assert PAY_PER_REQUEST billing, PITR enabled, and GSI1 key schema present.
    - _Requirements: 3.6, 3.7, 12.3_

- [x] 3. Implement ingest domain types, status enums, and the isolated EventMapper
  - [x] 3.1 Define domain records and status enums
    - Create `ingest/src/domain/status.ts` with `RunStatus` and `TaskStatus` enums (clearly commented as a confirm-against-AWS-docs point) and `ingest/src/domain/records.ts` with `RunRecord`/`TaskRecord`.
    - _Requirements: 1.3, 1.4_

  - [x] 3.2 Implement the EventMapper with confirm-against-docs mapping functions
    - Create `ingest/src/eventMapper.ts` implementing `detectKind`, `mapRunEvent`, `mapTaskEvent`, with all real-event-shape assumptions isolated behind clearly-commented field-extraction constants.
    - Defensively extract present fields only; log the full event and continue when a field is missing; skip status values outside the enum without failing the event.
    - _Requirements: 1.3, 1.4, 1.5, 1.6_

  - [ ]* 3.3 Write property test for event mapping robustness and extraction
    - **Property 1: Event mapping robustness and extraction**
    - **Validates: Requirements 1.3, 1.4, 1.5, 1.6**

- [x] 4. Implement the Repository with monotonic upserts and identifier validation
  - [x] 4.1 Implement run/task key derivation and attribute persistence
    - Create `ingest/src/repository.ts` deriving `PK`/`SK` (and `GSI1PK`/`GSI1SK` for runs) and storing the required run and task attributes.
    - Normalize `GSI1SK` to ISO 8601 UTC millisecond precision only when `updatedAt` is a valid ISO 8601 timestamp.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 4.2 Implement the monotonic conditional upsert and identifier validation
    - Use a DynamoDB conditional expression to write only when the item is absent or the incoming `updatedAt` is strictly greater than the stored value; otherwise preserve the item unchanged.
    - Reject upserts before writing when `runId` (run) or `runId`/`taskId` (task) is absent or empty, emitting an error naming the missing attribute.
    - Retry writes up to 3 attempts; on persistent failure leave the item unchanged and emit an error identifying the `runId`/`taskId`.
    - _Requirements: 3.8, 3.9, 3.10_

  - [x] 4.3 Implement static graph persistence and failure recording
    - Add `putStaticGraph`, `getStaticGraph`, and `recordGraphFailure` keyed by `WF#<workflowId>`, preserving existing data on failure.
    - _Requirements: 6.8, 6.9, 7.1_

  - [ ]* 4.4 Write property test for key derivation
    - **Property 4: Key derivation**
    - **Validates: Requirements 3.1, 3.2**

  - [ ]* 4.5 Write property test for GSI recency key normalization
    - **Property 5: GSI recency key normalization**
    - **Validates: Requirements 3.3**

  - [ ]* 4.6 Write property test for stored attribute completeness
    - **Property 6: Stored attribute completeness**
    - **Validates: Requirements 3.4, 3.5**

  - [ ]* 4.7 Write property test for monotonic (idempotent) upsert
    - **Property 7: Monotonic (idempotent) upsert**
    - Apply randomly ordered upserts against an in-memory DynamoDB double and assert the max-`updatedAt` invariant.
    - **Validates: Requirements 3.8**

  - [ ]* 4.8 Write property test for invalid identifier rejects the write
    - **Property 8: Invalid identifier rejects the write**
    - **Validates: Requirements 3.9**

- [x] 5. Implement the Enricher over HealthOmics read APIs
  - [x] 5.1 Implement enrichment calls with retries and timeouts
    - Create `ingest/src/enrichment/tasks.ts` and `ingest/src/enrichment/workflow.ts` calling only `GetRun`, `ListRunTasks`, `GetRunTask`, `GetWorkflow`, with field mappings commented as confirm-against-docs points.
    - Apply a 10s per-call timeout and up to 3 retries; on persistent failure log the operation and identifier, persist from event fields only, and leave unretrieved fields unset.
    - Merge event-derived and enrichment-derived fields before persistence.
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.6_

  - [ ]* 5.2 Write property test for enrichment merge preserves both sources
    - **Property 2: Enrichment merge preserves both sources**
    - **Validates: Requirements 2.4, 2.5**

  - [ ]* 5.3 Write property test for enrichment uses only allowed read operations
    - **Property 3: Enrichment uses only allowed read operations**
    - **Validates: Requirements 2.1**

- [x] 6. Implement the Workflow Definition Parser module
  - [x] 6.1 Define the DefinitionParser interface and dispatcher
    - Create `ingest/src/parser/types.ts` (`GraphNode`, `GraphEdge`, `StaticGraph`, `DefinitionParser`) and a dispatcher selecting a parser by language, exposing exactly one parser per language behind the common interface.
    - Enforce acyclicity and node-count invariants; reject unparseable/unsupported/cyclic definitions with an error identifying `workflowId` and reason.
    - _Requirements: 6.3, 6.4, 6.12_

  - [x] 6.2 Implement the WDL parser
    - Parse `call` statements as nodes; create a directed edge from each call producing an output reference to every call consuming that reference as input.
    - _Requirements: 6.5_

  - [x] 6.3 Implement the Nextflow parser
    - Parse `process` declarations as nodes; create a directed edge for each process-to-process channel connection, producer → consumer.
    - _Requirements: 6.6_

  - [x] 6.4 Implement the CWL parser
    - Parse `steps` as nodes; create a directed edge for each connection derived from `in`/`out`/`source` references, producing step → consuming step.
    - _Requirements: 6.7_

  - [ ]* 6.5 Write property test for parser produces an acyclic graph with correct node/edge counts
    - **Property 14: Parser produces an acyclic graph with correct node/edge counts**
    - **Validates: Requirements 6.3, 6.4**

  - [ ]* 6.6 Write property test for definition-to-graph round trip per language
    - **Property 15: Definition-to-graph round trip per language**
    - Generate a random DAG, render it into each language's source form, parse it back, and assert graph equivalence.
    - **Validates: Requirements 6.5, 6.6, 6.7**

  - [ ]* 6.7 Write unit tests and fixtures for each parser language
    - Add at least one WDL, Nextflow, and CWL definition fixture under `fixtures/` and unit tests parsing each, all passing.
    - _Requirements: 6.5, 6.6, 6.7, 13.3_

- [x] 7. Checkpoint - Ensure all ingest logic and parser tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement the Publisher and wire the ingest handler
  - [x] 8.1 Implement the AppSync Publisher
    - Create `ingest/src/publisher.ts` calling `publishRunUpdate`/`publishTaskUpdate` via IAM auth; reject before the call when the run/task identifier is missing/empty; retry up to 3 attempts and record an error if all fail while retaining persisted data.
    - _Requirements: 4.1, 4.2, 4.3, 4.8, 4.9_

  - [x] 8.2 Wire the ingest handler pipeline
    - Create `ingest/src/handler.ts` orchestrating classify/map → enrich on demand → resolve/cache static graph on first `workflowId` sighting (30s budget, reuse cache, record failure) → persist → publish.
    - Ensure downstream failures never discard already-persisted state.
    - _Requirements: 1.3, 1.4, 2.4, 4.1, 4.2, 6.1, 6.2, 6.9, 6.13, 7.1_

  - [ ]* 8.3 Write property test for publish dispatch correctness
    - **Property 9: Publish dispatch correctness**
    - **Validates: Requirements 4.1, 4.2, 4.9**

  - [ ]* 8.4 Write property test for static graph cache reuse
    - **Property 17: Static graph cache reuse**
    - **Validates: Requirements 6.9, 6.13**

  - [ ]* 8.5 Write unit tests for the handler
    - Cover valid run event, valid task event, malformed event; enrichment/write/publish 3x retry behavior; GetWorkflow failure recording.
    - _Requirements: 1.1, 2.6, 3.10, 4.8, 6.1, 7.1, 13.1_

- [x] 9. Implement the AppSync API in ApiStack
  - [x] 9.1 Define the GraphQL schema and Cognito auth
    - Add the schema (`Run`/`Task` types with non-nullable stored attributes non-nullable, `RunConnection`, queries, IAM-only publish mutations, subscriptions via `@aws_subscribe`).
    - Provision the Cognito user pool + app client before configuring API authorization; set default authorization to the user pool and IAM auth for the publish mutations.
    - _Requirements: 5.1, 5.9, 5.10, 5.12, 5.13, 11.6, 11.10_

  - [x] 9.2 Implement APPSYNC_JS resolvers on the DynamoDB data source
    - `listRuns` queries GSI1 descending with server-side `limit` validation (1–100, default 25) and `nextToken` pagination, rejecting out-of-range limits and malformed/expired tokens.
    - `getRun` returns null (no error) when no run matches; `listTasksForRun` returns tasks or an empty list.
    - Add pass-through resolvers for the publish mutations to trigger subscription fan-out.
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.11, 4.5, 4.6_

  - [x] 9.3 Export API outputs and scope data source grants
    - Emit AppSync endpoint, user pool ID, app client ID, and region as stack outputs; scope the AppSync data source role to read the table/GSI.
    - _Requirements: 11.2, 11.7_

  - [ ]* 9.4 Write property test for task subscription scoping
    - **Property 10: Task subscription scoping**
    - **Validates: Requirements 4.6, 5.10**

  - [ ]* 9.5 Write property test for listRuns ordering and limit bounds
    - **Property 11: listRuns ordering and limit bounds**
    - **Validates: Requirements 5.2, 5.3**

  - [ ]* 9.6 Write property test for pagination completeness
    - **Property 12: Pagination completeness**
    - **Validates: Requirements 5.4, 5.5**

  - [ ]* 9.7 Write property test for run and task lookup completeness
    - **Property 13: Run and task lookup completeness**
    - **Validates: Requirements 5.6, 5.8**

  - [ ]* 9.8 Write CDK assertions for API auth and least privilege
    - Assert default Cognito authz, IAM-only publish mutations, user-pool-before-authz ordering, and no wildcard grants.
    - _Requirements: 5.12, 11.2, 11.6, 11.10_

- [x] 10. Wire IngestStack: Lambda, EventBridge, DLQ, and least-privilege IAM
  - [x] 10.1 Provision the ingest Lambda and event source
    - Define the ingest `NodejsFunction` (esbuild bundling) targeting the handler; create the EventBridge rule on the default bus with pattern `{"source": ["aws.omics"]}` targeting the Lambda; add the SQS DLQ and a retry policy of max 3 attempts routing failures to the DLQ.
    - _Requirements: 1.1, 1.2, 1.7, 11.3_

  - [x] 10.2 Grant least-privilege IAM to the ingest role
    - Grant DynamoDB write scoped to the table/GSI ARNs, `appsync:GraphQL` scoped to the `publishRunUpdate`/`publishTaskUpdate` field ARNs only, and HealthOmics read limited to `GetRun`/`ListRunTasks`/`GetRunTask`/`GetWorkflow` with no create/update/delete and no wildcards.
    - _Requirements: 2.3, 4.4, 11.2_

  - [ ]* 10.3 Write CDK assertions for the event source and IAM
    - Assert the rule pattern, retry=3 with DLQ destination, and the scoped ingest role statements.
    - _Requirements: 1.7, 2.3, 4.4, 11.2, 11.3_

- [x] 11. Checkpoint - Ensure ingest, API, and infrastructure tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement frontend GraphQL client and subscription manager
  - [x] 12.1 Implement the client and build-time config injection
    - Create `frontend/src/api/client.ts` configured from injected CDK outputs (AppSync endpoint, user pool ID, app client ID, region) with no hardcoded environment values; add a build step consuming the outputs.
    - Fetch initial data through queries exactly once per view mount, applying subsequent changes only through subscriptions.
    - _Requirements: 10.4, 11.7_

  - [x] 12.2 Implement the reconnecting subscription manager
    - On subscription drop, reconnect with exponential backoff starting at 1s capped at 30s; show a disconnected indicator and suppress refetch while down; on reconnect remove the indicator and refetch current data.
    - _Requirements: 10.5, 10.6_

  - [ ]* 12.3 Write property test for reconnect backoff schedule
    - **Property 26: Reconnect backoff schedule**
    - **Validates: Requirements 10.5**

  - [ ]* 12.4 Write property test for query view state machine
    - **Property 25: Query view state machine**
    - **Validates: Requirements 10.1, 10.2, 10.3**

- [x] 13. Implement the fleet view
  - [x] 13.1 Implement fleet list rendering, ordering, and status colors
    - Query `listRuns` on mount and render each run's status badge, workflow name, start time, and duration; order by descending `updatedAt` with ties broken by descending start time; assign each `Run_Status` a distinct color.
    - Handle loading, error-with-retry, and empty states.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.7, 10.1, 10.2, 10.3_

  - [x] 13.2 Implement live fleet updates and status filtering
    - Apply `onRunUpdated` events (update in place or insert in ordered position) and any update source subject to the fleet ordering; show a per-run loading indicator when an update cannot be applied promptly without full reload; implement status filter and clear.
    - _Requirements: 8.5, 8.6, 8.8, 8.9, 8.10, 8.11_

  - [ ]* 13.3 Write property test for fleet ordering with tie-break
    - **Property 20: Fleet ordering with tie-break**
    - **Validates: Requirements 8.4**

  - [ ]* 13.4 Write property test for fleet update merge is idempotent and order-preserving
    - **Property 21: Fleet update merge is idempotent and order-preserving**
    - **Validates: Requirements 8.5, 8.6, 8.10**

  - [ ]* 13.5 Write property test for status color injectivity
    - **Property 22: Status color injectivity**
    - **Validates: Requirements 8.7, 9.5**

  - [ ]* 13.6 Write property test for status filtering
    - **Property 23: Status filtering**
    - **Validates: Requirements 8.8, 8.9**

- [x] 14. Implement the three-layer task view logic
  - [x] 14.1 Implement layer selection, status overlay, inferred ordering, and timeline grouping
    - Build the True_DAG overlay (exact case-sensitive `name` match with unmatched-status indication), Inferred_DAG ordering (earlier start placed no later; overlapping intervals concurrent), and Timeline_View grouping by status ordered by start time, including the ordering-unavailable case.
    - Select the highest-fidelity available layer: True → Inferred → Timeline.
    - _Requirements: 6.10, 6.11, 7.2, 7.4, 7.6_

  - [ ]* 14.2 Write property test for name-based status overlay
    - **Property 16: Name-based status overlay**
    - **Validates: Requirements 6.10, 6.11**

  - [ ]* 14.3 Write property test for inferred DAG ordering
    - **Property 18: Inferred DAG ordering**
    - **Validates: Requirements 7.2**

  - [ ]* 14.4 Write property test for timeline grouping
    - **Property 19: Timeline grouping**
    - **Validates: Requirements 7.4**

- [x] 15. Implement the run detail view
  - [x] 15.1 Render the run detail view with graph, progress, and live task updates
    - Query `getRun` and `listTasksForRun` on open with error-with-retry handling; render the node-edge graph via React Flow with dagre/elkjs auto layout for True/Inferred layers; show a visible layer indicator and the inferred label; assign each `Task_Status` a distinct color; show progress (completed/total tasks and elapsed time in HH:MM:SS); handle the zero-task empty state.
    - Subscribe to `onTaskUpdated(runId)` and update the affected node's color/status without page reload.
    - _Requirements: 7.3, 7.5, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

  - [ ]* 15.2 Write property test for progress counting and elapsed formatting
    - **Property 24: Progress counting and elapsed formatting**
    - **Validates: Requirements 9.6**

  - [ ]* 15.3 Write unit tests for run detail and fleet view states
    - Cover fleet error/empty, run-detail error/empty/zero-task, inferred and layer-indicator labels, fetch-once-on-mount, disconnect/reconnect indicator toggling, and node-edge rendering.
    - _Requirements: 7.3, 7.5, 7.6, 8.2, 8.3, 9.2, 9.3, 9.4, 10.4, 10.6_

- [x] 16. Implement FrontendStack hosting
  - [x] 16.1 Provision the private S3 bucket and CloudFront distribution
    - Create the S3 bucket with all public access blocked, served only through CloudFront using Origin Access Control; map 403/404 responses to `index.html` with HTTP 200 for SPA routing; emit outputs; inherit the project tag.
    - _Requirements: 11.4, 11.5, 11.7, 11.8_

  - [ ]* 16.2 Write CDK assertions for hosting and cost constraints
    - Assert S3 public-access block, CloudFront OAC and 403/404→index.html, presence of outputs and project tag, and absence of EC2/ECS/Fargate/NAT.
    - _Requirements: 11.4, 11.5, 11.7, 11.8, 12.1, 12.2_

- [x] 17. Implement fixtures and the local verification script
  - [x] 17.1 Add event fixtures and the synthetic-event/invoke script
    - Add at least one sample `aws.omics` run status-change event and one task status-change event under `fixtures/`; create an executable script that either publishes a synthetic `aws.omics` event to EventBridge or invokes the ingest Lambda directly with a fixture, selectable by the operator, rejecting events that fail schema validation and leaving data unchanged.
    - _Requirements: 13.2, 13.4, 13.6_

- [x] 18. Author documentation
  - [x] 18.1 Write the README and cost documentation
    - Include distinct sections for architecture diagram, prerequisites, deploy steps, teardown steps, pointing at a HealthOmics account, and end-to-end verification; document DAG/inference known limitations as discrete entries; itemize each cost driver (AppSync requests and subscription minutes, Lambda invocations, DynamoDB on-demand read/write units, CloudFront) with billing unit and metering service, flagging any fixed recurring charge; enumerate every confirm-against-AWS-docs location with the exact file and code element to update.
    - _Requirements: 12.4, 12.5, 14.1, 14.2, 14.3_

- [x] 19. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests and assertions) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirements for traceability.
- Checkpoints ensure incremental validation at layer boundaries.
- Property-based tests use `fast-check`, run a minimum of 100 iterations, and are tagged `Feature: healthomics-workflow-dashboard, Property {number}: {property_text}`. Properties 1–26 map one-to-one to the design's Correctness Properties.
- Unit tests, CDK template assertions, and integration/timing tests cover fixed-count behaviors, infrastructure shape, and timing bounds that are not universal properties.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "4.1", "6.1"] },
    { "id": 3, "tasks": ["3.3", "4.2", "4.3", "5.1", "6.2", "6.3", "6.4"] },
    { "id": 4, "tasks": ["4.4", "4.5", "4.6", "4.7", "4.8", "5.2", "5.3", "6.5", "6.6", "6.7", "8.1"] },
    { "id": 5, "tasks": ["8.2", "9.1"] },
    { "id": 6, "tasks": ["8.3", "8.4", "8.5", "9.2", "9.3", "10.1"] },
    { "id": 7, "tasks": ["9.4", "9.5", "9.6", "9.7", "9.8", "10.2"] },
    { "id": 8, "tasks": ["10.3", "12.1", "16.1"] },
    { "id": 9, "tasks": ["12.2", "13.1", "14.1", "16.2", "17.1"] },
    { "id": 10, "tasks": ["12.3", "12.4", "13.2", "14.2", "14.3", "14.4", "15.1"] },
    { "id": 11, "tasks": ["13.3", "13.4", "13.5", "13.6", "15.2", "15.3", "18.1"] }
  ]
}
```
