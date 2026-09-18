# Coding Agent Prompt: Serverless AWS HealthOmics Workflow Dashboard

## Role and Objective

You are building a production-quality, event-driven dashboard for monitoring AWS HealthOmics workflow runs. The dashboard shows a fleet view of all runs with their status, and lets a user drill into a single run to see that run's task graph (DAG) and per-task progress. Status must update in near real time as HealthOmics emits state changes, without the browser polling.

Optimize for the lowest possible cost and the least infrastructure to maintain. Every backend component must be fully managed and scale-to-zero. There must be no servers, containers, or provisioned capacity to operate.

## Target Architecture (build exactly this)

```
AWS HealthOmics (runs + tasks)
        │  emits state-change events
        ▼
Amazon EventBridge (default bus)
   rule: source = "aws.omics"
        │
        ▼
AWS Lambda (ingest handler, Node.js/TypeScript)
   - normalizes the event
   - upserts run/task state into DynamoDB
   - calls an AppSync mutation to publish the change
        │                         │
        ▼                         ▼
Amazon DynamoDB          AWS AppSync (GraphQL)
 (on-demand,               - Query resolvers read DynamoDB
  single table)            - Mutation triggers subscription publish
                           - Subscriptions push to clients
        │                         │
        └─────────┬───────────────┘
                  ▼
        React SPA (frontend)
         - GraphQL queries for initial load
         - GraphQL subscriptions for live updates
         - hosted on S3 + CloudFront

```

### Why these choices (do not deviate without flagging)

- **AppSync GraphQL subscriptions** for live updates instead of API Gateway WebSocket. AppSync manages WebSocket connections, subscription fan-out, and auth. Do NOT build a connections table or `$connect`/`$disconnect`/`PostToConnection` plumbing.
- **DynamoDB on-demand billing.** No provisioned capacity, scales to zero cost when idle.
- **EventBridge** on the default bus filtering `source: ["aws.omics"]`. No polling of the HealthOmics API for status.
- **S3 + CloudFront** static hosting for the SPA.
- **AWS CDK (TypeScript)** for all infrastructure as code.

## Tech Stack (required)

- IaC: AWS CDK v2, TypeScript.
- Lambda runtime: Node.js 20.x, TypeScript, bundled with esbuild via CDK `NodejsFunction`.
- API: AWS AppSync, GraphQL.
- Data store: Amazon DynamoDB, single-table design, on-demand (PAY_PER_REQUEST).
- Frontend: React + TypeScript (Vite), AWS Amplify GraphQL client (or `aws-appsync`/`graphql-ws`) for queries and subscriptions.
- Hosting: S3 (private bucket) + CloudFront (OAC).
- Auth: Amazon Cognito user pool guarding AppSync (default auth mode). Use IAM auth for the ingest Lambda's mutation calls.

## HealthOmics Event and Domain Model

HealthOmics emits EventBridge events. Handle at minimum these detail types from source `aws.omics`:

- Run status change: run enters/leaves states `PENDING`, `STARTING`, `RUNNING`, `STOPPING`, `COMPLETED`, `DELETED`, `CANCELLED`, `FAILED`.
- Task status change: task states `PENDING`, `STARTING`, `RUNNING`, `STOPPING`, `COMPLETED`, `CANCELLED`, `FAILED`.

Do not hardcode the exact event JSON shape from memory. Instead:

1. Write the ingest handler to defensively parse `detail`, logging the full event when a field is missing.
2. Provide a documented sample-event fixture directory and unit tests that can be updated once real event shapes are confirmed against the AWS docs.
3. For fields not present on the event (e.g. full task list), the ingest Lambda may call the HealthOmics API (`GetRun`, `ListRunTasks`, `GetRunTask`, `GetWorkflow`) to enrich state. Note that task dependency edges are NOT available from any of these run/task APIs (see Task DAG below) and must be derived from the workflow definition. Grant least-privilege IAM for those read calls. Keep these calls minimal and event-triggered, never on a timer.

### Task DAG

**Critical constraint (verified against the AWS API): the HealthOmics run APIs do NOT return task dependency edges.** `ListRunTasks` and `GetRunTask` return only a flat list of tasks with these fields: `taskId`, `name`, `status`, `cpus`, `gpus`, `memory`, `instanceType`, `creationTime`, `startTime`, `stopTime`, `statusMessage`, `failureReason`, `logStream`, `cacheHit`, `cacheS3Uri`, `imageDetails`, `uuid`. There is no `dependsOn`, `parentTask`, or edge field. The `aws.omics` EventBridge events carry the same run/task status information and likewise contain no dependency edges.

Therefore the dependency edges MUST come from the **workflow definition** (the graph lives in the workflow source, not the run API). Implement task-level DAG rendering in three layers, and build all three:

1. **True dependency DAG (primary goal).** Ingest the workflow definition and parse its task graph, then match definition steps to run tasks by task `name`:- WDL: parse `call` statements and wire edges from task `output` references consumed as another call's `input`.

- Nextflow: derive edges from process-to-process channel connections.
- CWL: parse `steps` and their `in`/`out`/`source` connections. Retrieve the definition automatically from the HealthOmics API: on first sighting of a run's `workflowId`, call `GetWorkflow` to obtain the workflow metadata and its definition (fetch from the returned definition URI / S3 location, or via workflow export where applicable). Do this lazily and cache it: parse the definition once per `workflowId`, store the resulting static graph (nodes + edges) in DynamoDB keyed by `workflowId`, and reuse it for every run of that workflow. Overlay live per-task status from the run onto the cached static graph at view time. Grant the ingest Lambda least-privilege read access for `GetWorkflow` and for the S3 location holding the definition. Build the definition parser as an isolated module with one parser per language behind a common interface, so languages can be added independently. If auto-fetch or parsing fails for a given workflow, fall back to the inferred/timeline layers below and record why in the workflow item.

1. **Inferred DAG (fallback when the definition is unavailable or unparseable).** Infer likely ordering from task names and start/stop time overlap. Clearly label this view as "inferred" in the UI so it is never mistaken for the true graph.
2. **Lane/timeline view (always-available floor).** Group tasks by status and order by start time (Gantt-style) so a meaningful "task flow" renders even with zero dependency information.

The frontend must render an actual node-edge graph for layers 1 and 2 (use a graph layout library such as React Flow / dagre / elkjs, with automatic DAG layout), with each node color-coded by live task status and updating via subscriptions. The dashboard must clearly indicate which of the three layers is currently being shown for a given run.

## Data Model (DynamoDB single table)

Design a single table with these access patterns:

- Get all runs (fleet view), sorted by most recently updated.
- Get one run's metadata.
- Get all tasks for one run.

Suggested keys (adjust as needed, document your final choice):

- Run item: `PK = RUN#<runId>`, `SK = RUN#<runId>`, plus a GSI (`GSI1PK = RUNS`, `GSI1SK = <updatedAt ISO8601>`) for the fleet list ordered by recency.
- Task item: `PK = RUN#<runId>`, `SK = TASK#<taskId>`.
- Common attributes: `status`, `name`, `createdAt`, `startedAt`, `stoppedAt`, `updatedAt`, `workflowId`, `workflowName`, and for tasks `cpus`, `memory`, `dependsOn?`.

## GraphQL API (AppSync)

Schema requirements:

- `type Run` and `type Task` matching the data model above.
- Queries: `listRuns(limit, nextToken)` (fleet, recency-ordered via GSI), `getRun(runId)`, `listTasksForRun(runId)`.
- Mutation: `publishRunUpdate(input)` and `publishTaskUpdate(input)` used only by the ingest Lambda (IAM-authed) to fan out changes. These write-through to DynamoDB or are called after the write, your choice, but document it.
- Subscriptions: `onRunUpdated` (fleet-level), `onTaskUpdated(runId)` (scoped to a run) using `@aws_subscribe` tied to the publish mutations.
- Resolvers: prefer AppSync JS resolvers (`APPSYNC_JS`) directly on DynamoDB for queries to avoid extra Lambda cost. Use a Lambda data source only where JS resolvers are insufficient.

## Frontend Requirements

- Fleet view: table/cards of all runs with status badge, workflow name, start time, duration, and a live-updating status. Color-code by status. Filter by status; sort by recency.
- Run detail view: the task DAG/lane view with per-task status, plus a progress indicator (completed tasks / total tasks, and elapsed time). Subscribe to `onTaskUpdated(runId)` so it updates live while viewing.
- Initial load via GraphQL queries; thereafter update purely from subscriptions (no polling).
- Clean, responsive UI. Use a lightweight component library or Tailwind. Keep dependencies minimal.
- Handle empty, loading, and error states. Reconnect subscriptions on network drop.

## Infrastructure as Code (CDK) Requirements

- One CDK app, well-structured stacks (e.g. `DataStack`, `ApiStack`, `IngestStack`, `FrontendStack`) or a single well-organized stack, your choice, documented.
- Least-privilege IAM everywhere. The ingest Lambda gets only: DynamoDB write on the table, `appsync:GraphQL` on the specific mutations, and minimal HealthOmics read APIs.
- EventBridge rule on the default bus with pattern `{"source": ["aws.omics"]}` targeting the ingest Lambda, with a dead-letter queue (SQS) and retry policy.
- DynamoDB table: on-demand, point-in-time recovery on, the GSI above.
- CloudFront + S3 with Origin Access Control, SPA routing (403/404 to `index.html`).
- Cognito user pool + app client; wire AppSync default auth to Cognito user pools.
- All resource names, ARNs, and endpoints surfaced as CloudFormation/CDK outputs and injected into the frontend build config.
- Tag all resources with a project tag.

## Cost and Operations Constraints (must hold)

- No always-on compute. No NAT gateways. No provisioned DynamoDB capacity. No EC2/ECS/Fargate.
- Everything pay-per-use and scale-to-zero at idle.
- Document the expected cost drivers (AppSync request/subscription minutes, Lambda invocations, DynamoDB on-demand R/W, CloudFront) in the README.

## Deliverables

1. A working CDK project that deploys with `npm install && npx cdk deploy`.
2. Ingest Lambda with unit tests and a `fixtures/` folder of sample HealthOmics EventBridge events.
3. AppSync schema, resolvers, and data sources.
4. A workflow-definition parser module (WDL/Nextflow/CWL) that produces the static task graph used for the true dependency DAG, with unit tests and sample definition fixtures.
5. React SPA with fleet view and run-detail DAG, wired to AppSync queries and subscriptions.
6. A README covering: architecture diagram, prerequisites, deploy/teardown steps, how to point it at a HealthOmics account, how to verify events flow end to end, expected costs, and known limitations (especially around task dependency/DAG inference).
7. A short section documenting every place where the real HealthOmics event shape must be confirmed against AWS docs, with the exact code locations to update.

## Working Method and Constraints

- Confirm assumptions in the README rather than inventing undocumented API fields. Where you are unsure of an exact event field name or API response shape, isolate it behind a clearly commented mapping function and note it in the "confirm against AWS docs" section.
- Build incrementally and keep each layer independently testable: data model, then ingest, then API, then frontend.
- Provide a local mock path: a script that publishes a synthetic `aws.omics` event to EventBridge (or invokes the ingest Lambda directly with a fixture) so the full pipeline can be tested without waiting for a real run.
- Include a teardown (`cdk destroy`) that leaves no orphaned resources.
- Keep the dependency footprint small and pin versions.

## Acceptance Criteria

- Deploying the CDK app stands up EventBridge, Lambda, DynamoDB, AppSync, Cognito, S3, and CloudFront with least-privilege IAM.
- Publishing a synthetic `aws.omics` run/task event results in the run/task appearing/updating in the dashboard within a few seconds, with no browser polling.
- The fleet view lists runs ordered by recency; selecting a run shows a node-edge task DAG (true dependency graph when the workflow definition is available, clearly-labeled inferred/timeline view otherwise) with per-node live status and progress.
- No provisioned/always-on infrastructure exists in the stack.
- `cdk destroy` removes everything cleanly.

