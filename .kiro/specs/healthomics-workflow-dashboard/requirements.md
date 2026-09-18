# Requirements Document

## Introduction

The HealthOmics Workflow Dashboard is a serverless, event-driven web application for monitoring AWS HealthOmics workflow runs in near real time. It presents a fleet view listing all workflow runs with their current status and lets a user drill into a single run to inspect that run's task graph (DAG) and per-task progress. State changes are pushed to the browser via GraphQL subscriptions rather than polled.

The system is optimized for lowest possible cost and least infrastructure to operate: every backend component is fully managed and scales to zero at idle, with no servers, containers, or provisioned capacity. HealthOmics emits state-change events to Amazon EventBridge, which triggers an ingest Lambda that normalizes the event, upserts state into a single DynamoDB table, and publishes the change through an AppSync GraphQL mutation. AppSync serves queries for the initial load and pushes live updates through subscriptions to a React single-page application hosted on Amazon S3 and Amazon CloudFront.

Because the HealthOmics run APIs do not expose task dependency edges, the task DAG is derived from the workflow definition (WDL, Nextflow, or CWL) with an inferred fallback and an always-available timeline view.

## Glossary

- **Dashboard**: The overall serverless application comprising ingest, storage, API, and frontend components that monitors HealthOmics workflow runs.
- **Ingest_Lambda**: The AWS Lambda function that receives HealthOmics EventBridge events, normalizes them, writes state to the data store, and publishes updates through the API.
- **Event_Source**: Amazon EventBridge configured on the default bus with a rule matching events where `source` equals `aws.omics`.
- **Data_Store**: The Amazon DynamoDB single-table, on-demand (PAY_PER_REQUEST) store holding run, task, and workflow-graph items.
- **API**: The AWS AppSync GraphQL endpoint exposing queries, mutations, and subscriptions.
- **Frontend**: The React single-page application served from Amazon S3 through Amazon CloudFront.
- **Auth_Provider**: The Amazon Cognito user pool and app client guarding the API for interactive users.
- **HealthOmics_API**: The AWS HealthOmics read APIs `GetRun`, `ListRunTasks`, `GetRunTask`, and `GetWorkflow`.
- **Run**: A single AWS HealthOmics workflow execution, identified by a `runId`.
- **Task**: A unit of work within a Run, identified by a `taskId`, belonging to exactly one Run.
- **Workflow_Definition**: The source document (WDL, Nextflow, or CWL) that defines a workflow's task graph, retrieved via `GetWorkflow`.
- **Definition_Parser**: The isolated module that parses a Workflow_Definition into a static task graph of nodes and edges, with one parser implementation per supported language behind a common interface.
- **Static_Graph**: The cached set of nodes and dependency edges derived from a Workflow_Definition, keyed by `workflowId`.
- **True_DAG**: The task dependency graph derived from the Workflow_Definition with edges resolved from step input/output connections.
- **Inferred_DAG**: A task graph whose ordering is estimated from task names and start/stop time overlap when the Workflow_Definition is unavailable or unparseable.
- **Timeline_View**: A Gantt-style view grouping tasks by status and ordering by start time, always available regardless of dependency information.
- **Dead_Letter_Queue**: The Amazon SQS queue that captures EventBridge deliveries that fail after retries.
- **Deployment_System**: The AWS CDK v2 TypeScript application that provisions all infrastructure.
- **Run_Status**: One of `PENDING`, `STARTING`, `RUNNING`, `STOPPING`, `COMPLETED`, `DELETED`, `CANCELLED`, `FAILED`.
- **Task_Status**: One of `PENDING`, `STARTING`, `RUNNING`, `STOPPING`, `COMPLETED`, `CANCELLED`, `FAILED`.

## Requirements

### Requirement 1: Ingest HealthOmics events

**User Story:** As an operator, I want HealthOmics state-change events to be captured automatically, so that the dashboard reflects run and task status without any polling.

#### Acceptance Criteria

1. THE Event_Source SHALL match events on the default EventBridge bus where the `source` field equals `aws.omics`.
2. WHEN the Event_Source matches an event, THE Event_Source SHALL invoke the Ingest_Lambda with the event within 5 seconds of the event being published to the bus.
3. WHEN the Ingest_Lambda receives a run status-change event, THE Ingest_Lambda SHALL extract the run identifier and Run_Status from the `detail` payload, where Run_Status is one of the defined Run_Status enum values.
4. WHEN the Ingest_Lambda receives a task status-change event, THE Ingest_Lambda SHALL extract the run identifier, task identifier, and Task_Status from the `detail` payload, where Task_Status is one of the defined Task_Status enum values.
5. IF an expected field is missing from the event `detail`, THEN THE Ingest_Lambda SHALL log the complete event, continue processing the remaining available fields, and complete without raising a processing failure.
6. IF the extracted Run_Status or Task_Status value is not a member of its defined enum, THEN THE Ingest_Lambda SHALL log the complete event and skip persistence of the unrecognized status value while continuing to process remaining fields.
7. IF the Ingest_Lambda fails to process an event after 3 EventBridge retry attempts, THEN THE Event_Source SHALL deliver the event to the Dead_Letter_Queue SQS queue.

### Requirement 2: Enrich run and task state on demand

**User Story:** As an operator, I want the dashboard to fill in details that are not present on the event, so that I see complete run and task information.

#### Acceptance Criteria

1. WHEN the Ingest_Lambda processes an event that lacks one or more fields required to render a Run or Task, THE Ingest_Lambda SHALL call the HealthOmics_API using only the read operations GetRun, ListRunTasks, GetRunTask, and GetWorkflow to retrieve the missing fields.
2. THE Ingest_Lambda SHALL initiate calls to the HealthOmics_API only in response to a received event and SHALL NOT initiate such calls on a timer, schedule, or other non-event trigger.
3. THE Deployment_System SHALL grant the Ingest_Lambda read-only permission limited to the GetRun, ListRunTasks, GetRunTask, and GetWorkflow operations and SHALL NOT grant any create, update, or delete permission on the HealthOmics_API.
4. WHEN a HealthOmics_API call completes successfully, THE Ingest_Lambda SHALL persist the Run or Task state combining the event fields and the retrieved fields.
5. IF a HealthOmics_API call returns an error or does not return a response within 10 seconds, THEN THE Ingest_Lambda SHALL log an entry indicating the failed operation and the affected Run or Task identifier, SHALL persist the state derived solely from the available event fields, and SHALL leave the fields that could not be retrieved unset.
6. IF a HealthOmics_API call returns an error, THEN THE Ingest_Lambda SHALL retry the failed operation up to 3 times before applying the fallback behavior defined in criterion 5.

### Requirement 3: Persist run and task state

**User Story:** As an operator, I want run and task state stored durably, so that the dashboard can load current state and order runs by recency.

#### Acceptance Criteria

1. WHEN the Ingest_Lambda extracts a Run, THE Ingest_Lambda SHALL upsert a run item into the Data_Store with partition key `RUN#<runId>` and sort key `RUN#<runId>`.
2. WHEN the Ingest_Lambda extracts a Task, THE Ingest_Lambda SHALL upsert a task item into the Data_Store with partition key `RUN#<runId>` and sort key `TASK#<taskId>`.
3. WHEN the Ingest_Lambda upserts a run item whose `updatedAt` value is a valid ISO 8601 timestamp, THE Ingest_Lambda SHALL set `GSI1PK` to `RUNS` and `GSI1SK` to that `updatedAt` value formatted as an ISO 8601 timestamp in UTC with millisecond precision.
4. WHEN the Ingest_Lambda upserts a run item, THE Ingest_Lambda SHALL store the attributes `status`, `name`, `createdAt`, `startedAt`, `stoppedAt`, `updatedAt`, `workflowId`, and `workflowName`.
5. WHEN the Ingest_Lambda upserts a task item, THE Ingest_Lambda SHALL store the attributes `status`, `name`, `createdAt`, `startedAt`, `stoppedAt`, `updatedAt`, `cpus`, and `memory`.
6. THE Data_Store SHALL use on-demand (PAY_PER_REQUEST) capacity and SHALL have point-in-time recovery enabled.
7. THE Data_Store SHALL provide a global secondary index keyed by `GSI1PK` and `GSI1SK` supporting retrieval of all runs ordered by `updatedAt`.
8. IF the Ingest_Lambda upserts an item whose `updatedAt` value is less than or equal to the `updatedAt` value already stored for that item, THEN THE Ingest_Lambda SHALL preserve the existing stored item unchanged and SHALL NOT overwrite any attribute.
9. IF a required attribute (`runId` for a run item, or `runId` and `taskId` for a task item) is absent or is an empty string, THEN THE Ingest_Lambda SHALL reject the upsert, SHALL leave the Data_Store unchanged, and SHALL emit an error indication identifying the missing attribute.
10. IF a write to the Data_Store fails after 3 attempts, THEN THE Ingest_Lambda SHALL leave the affected item unchanged and SHALL emit an error indication identifying the failed runId or taskId.

### Requirement 4: Publish live updates

**User Story:** As a user viewing the dashboard, I want run and task changes to appear within a few seconds, so that I can monitor progress in near real time.

#### Acceptance Criteria

1. WHEN the Ingest_Lambda persists a run change, THE Ingest_Lambda SHALL call the API `publishRunUpdate` mutation with the updated run data.
2. WHEN the Ingest_Lambda persists a task change, THE Ingest_Lambda SHALL call the API `publishTaskUpdate` mutation with the updated task data.
3. THE Ingest_Lambda SHALL authenticate to the API using IAM authorization.
4. THE Deployment_System SHALL grant the Ingest_Lambda `appsync:GraphQL` permission limited to the `publishRunUpdate` and `publishTaskUpdate` mutations.
5. WHEN the API processes a `publishRunUpdate` mutation, THE API SHALL deliver the run data to all clients subscribed to `onRunUpdated`.
6. WHEN the API processes a `publishTaskUpdate` mutation for a given run, THE API SHALL deliver the task data to all clients subscribed to `onTaskUpdated` for that run identifier.
7. WHEN the Ingest_Lambda persists a run or task change, THE Ingest_Lambda SHALL complete the corresponding publish mutation call within 2 seconds of persisting the change.
8. IF a `publishRunUpdate` or `publishTaskUpdate` mutation call fails, THEN THE Ingest_Lambda SHALL retry the failed mutation call up to 3 attempts, and IF all 3 attempts fail, THEN THE Ingest_Lambda SHALL record an error indicating the publish failure while retaining the persisted run or task data unchanged.
9. IF a run or task change to be published has a missing or empty run or task identifier, THEN THE Ingest_Lambda SHALL reject the publish request without calling the mutation and record an error indicating the invalid identifier.

### Requirement 5: Serve run and task data through GraphQL

**User Story:** As a frontend developer, I want GraphQL queries and subscriptions for runs and tasks, so that the SPA can load initial state and receive live updates.

#### Acceptance Criteria

1. THE API SHALL define a `Run` type and a `Task` type whose fields correspond one-to-one to the run and task attributes stored in the Data_Store, with every non-nullable Data_Store attribute exposed as a non-nullable field.
2. WHEN a client invokes `listRuns(limit, nextToken)`, THE API SHALL return a page of runs ordered by descending `updatedAt` using the global secondary index, where `limit` accepts an integer from 1 to 100 and defaults to 25 when omitted.
3. IF `listRuns` is invoked with `limit` less than 1 or greater than 100, THEN THE API SHALL reject the query without returning run data and return an error indicating the limit is out of the allowed range.
4. WHEN a client invokes `listRuns` with a `nextToken`, THE API SHALL return the next page of runs continuing from that token and include a `nextToken` in the response that is null when no further pages exist.
5. IF `listRuns` is invoked with a `nextToken` that is malformed or expired, THEN THE API SHALL reject the query without returning run data and return an error indicating the pagination token is invalid.
6. WHEN a client invokes `getRun(runId)` with a `runId` that matches an existing run, THE API SHALL return the corresponding run item.
7. IF `getRun(runId)` is invoked with a `runId` that matches no existing run, THEN THE API SHALL return a null run result without an error.
8. WHEN a client invokes `listTasksForRun(runId)` with a `runId` that matches an existing run, THE API SHALL return all task items associated with that run identifier, or an empty list when the run has no tasks.
9. THE API SHALL provide an `onRunUpdated` subscription bound to the `publishRunUpdate` mutation that delivers the updated run item to subscribed clients.
10. THE API SHALL provide an `onTaskUpdated(runId)` subscription bound to the `publishTaskUpdate` mutation that delivers only task updates whose run identifier equals the subscribed `runId`.
11. WHERE a query reads directly from the Data_Store and an AppSync JavaScript resolver is sufficient to express it, THE API SHALL resolve the query with an AppSync JavaScript resolver, and WHERE a JavaScript resolver is insufficient, THE API MAY resolve the query with a Lambda data source.
12. THE API SHALL authorize interactive queries and subscriptions through the Auth_Provider (Cognito user pool).
13. IF a query or subscription request presents no valid Auth_Provider credentials, THEN THE API SHALL reject the request without returning run or task data and return an error indicating the request is unauthorized.

### Requirement 6: Derive the true dependency DAG from the workflow definition

**User Story:** As a user inspecting a run, I want to see the actual task dependency graph, so that I understand how tasks relate rather than only their order.

#### Acceptance Criteria

1. WHEN the Ingest_Lambda first encounters a run with a `workflowId` for which no Static_Graph exists in the Data_Store, THE Ingest_Lambda SHALL call `GetWorkflow` and retrieve the Workflow_Definition.
2. IF the `GetWorkflow` call fails or does not return a Workflow_Definition within 30 seconds, THEN THE Ingest_Lambda SHALL abort Static_Graph creation for that `workflowId`, retain any previously cached state unchanged, and record an error indication identifying the failed `workflowId`.
3. WHEN a Workflow_Definition is retrieved, THE Definition_Parser SHALL parse the Workflow_Definition into a Static_Graph consisting of one node per workflow task and one directed dependency edge per producer-to-consumer relationship between tasks.
4. IF the Workflow_Definition cannot be parsed, has an unsupported language, or produces a graph containing a cycle, THEN THE Definition_Parser SHALL reject the Workflow_Definition, produce no Static_Graph, and return an error indication identifying the `workflowId` and the failure reason.
5. WHERE the Workflow_Definition language is WDL, THE Definition_Parser SHALL create a directed edge from each call that produces an output reference to every call that consumes that reference as input.
6. WHERE the Workflow_Definition language is Nextflow, THE Definition_Parser SHALL create a directed edge for each process-to-process channel connection, from the producing process to the consuming process.
7. WHERE the Workflow_Definition language is CWL, THE Definition_Parser SHALL create a directed edge for each step connection derived from its `in`, `out`, and `source` references, from the producing step to the consuming step.
8. WHEN the Definition_Parser produces a Static_Graph, THE Ingest_Lambda SHALL store the Static_Graph in the Data_Store keyed by `workflowId`.
9. WHEN a Static_Graph already exists in the Data_Store for a `workflowId`, THE Ingest_Lambda SHALL reuse the cached Static_Graph and SHALL NOT re-fetch the Workflow_Definition.
10. WHEN the Frontend renders a True_DAG, THE Frontend SHALL match each Static_Graph node to a run task by exact, case-sensitive task `name` equality and overlay that task's live Task_Status onto the matched node.
11. IF a Static_Graph node has no run task whose `name` matches, THEN THE Frontend SHALL render the node with an unmatched-status indication and SHALL NOT overlay any Task_Status onto it.
12. THE Definition_Parser SHALL expose exactly one parser implementation per supported language (WDL, Nextflow, CWL) behind a common interface.
13. WHILE the workflow service is unreachable, IF a Static_Graph already exists in the Data_Store for a `workflowId`, THEN THE Ingest_Lambda SHALL continue to reuse the cached Static_Graph without attempting to re-fetch or invalidate it.

### Requirement 7: Provide fallback task views

**User Story:** As a user inspecting a run, I want a meaningful task view even when the true dependency graph is unavailable, so that I can still track progress.

#### Acceptance Criteria

1. IF the Workflow_Definition cannot be retrieved or parsed for a `workflowId` within 5 seconds, THEN THE Ingest_Lambda SHALL record the failure reason on the workflow item in the Data_Store and SHALL preserve any previously stored workflow data without modification.
2. WHERE no Static_Graph is available for a run, THE Frontend SHALL render an Inferred_DAG whose ordering is estimated from task names and start/stop times, such that a task with an earlier start time is placed before a task with a later start time, and tasks whose start/stop time intervals overlap are shown as concurrent.
3. WHEN the Frontend renders an Inferred_DAG, THE Frontend SHALL display a visible text label identifying the view as inferred.
4. THE Frontend SHALL provide a Timeline_View that groups tasks by Task_Status and orders tasks by start time.
5. WHEN the Frontend displays a run's task view, THE Frontend SHALL display a visible indication of which of True_DAG, Inferred_DAG, or Timeline_View is currently shown.
6. IF neither a Static_Graph nor task timing data is available for a run, THEN THE Frontend SHALL display the Timeline_View grouped by Task_Status with an indication that ordering data is unavailable.

### Requirement 8: Present the fleet view

**User Story:** As an operator, I want to see all runs at a glance, so that I can monitor the whole fleet and spot problems quickly.

#### Acceptance Criteria

1. WHEN the Frontend loads the fleet view, THE Frontend SHALL query `listRuns` and SHALL display each returned run with its status badge, workflow name, start time, and duration within 3 seconds of receiving the response.
2. IF the `listRuns` query fails or does not return a response within 3 seconds, THEN THE Frontend SHALL display an error message indicating that runs could not be loaded and SHALL provide a retry action.
3. WHERE the `listRuns` query returns no runs, THE Frontend SHALL display an empty-state message indicating that no runs are available.
4. THE Frontend SHALL order runs in the fleet view by most recent `updatedAt` in descending order, and SHALL break ties between equal `updatedAt` values by start time in descending order.
5. WHEN the Frontend receives an `onRunUpdated` event for a run currently displayed in the fleet view, THE Frontend SHALL update that run in place within 2 seconds without a page reload.
6. WHEN the Frontend receives an `onRunUpdated` event for a run not currently displayed in the fleet view, THE Frontend SHALL insert that run into the fleet view in its ordered position within 2 seconds without a page reload.
7. THE Frontend SHALL display each Run_Status using a distinct color, such that no two different Run_Status values share the same color.
8. WHERE the user selects a status filter, THE Frontend SHALL display only runs whose Run_Status matches the selected filter.
9. WHEN the user clears the status filter, THE Frontend SHALL display all runs subject to the ordering defined in criterion 4.
10. WHEN the Frontend obtains updated run data from any source, including a subscription event, a query result, or a direct API call, THE Frontend SHALL apply that update to the fleet view subject to the ordering defined in criterion 4.
11. IF an `onRunUpdated` update cannot be applied within 2 seconds, THEN THE Frontend SHALL display a loading indicator for the affected run until the update is applied, and SHALL NOT trigger a full page reload.

### Requirement 9: Present the run detail view

**User Story:** As a user, I want to drill into a single run, so that I can see its task graph and progress in detail.

#### Acceptance Criteria

1. WHEN the user opens a run detail view, THE Frontend SHALL query `getRun` and `listTasksForRun` for the selected run identifier.
2. IF the `getRun` or `listTasksForRun` query fails or does not return a response within 10 seconds, THEN THE Frontend SHALL display an error message indicating the run details could not be loaded and SHALL provide a retry action.
3. WHEN the run detail view is open, THE Frontend SHALL render the run's tasks as a node-edge graph for the True_DAG and Inferred_DAG views with automatic DAG layout.
4. IF the selected run contains zero tasks, THEN THE Frontend SHALL display an empty-state message indicating no tasks exist for the run instead of an empty graph.
5. THE Frontend SHALL assign each task node a distinct color for each defined Task_Status value, such that no two Task_Status values share the same color.
6. WHEN the run detail view is open, THE Frontend SHALL display a progress indicator showing the count of completed tasks out of total tasks and the elapsed time in HH:MM:SS format.
7. WHEN the run detail view is open, THE Frontend SHALL subscribe to `onTaskUpdated` for the selected run identifier.
8. WHEN the Frontend receives an `onTaskUpdated` event, THE Frontend SHALL update the affected task node's color and status within 2 seconds without a page reload.

### Requirement 10: Frontend loading, error, and reconnect behavior

**User Story:** As a user, I want the dashboard to behave predictably under empty, loading, and network-loss conditions, so that I can trust what I see.

#### Acceptance Criteria

1. WHILE a GraphQL query is in progress and has not yet returned a result or error, THE Frontend SHALL display a loading indicator in place of the queried content.
2. IF a GraphQL query returns an error, THEN THE Frontend SHALL replace the loading indicator with an error state that includes a human-readable message describing the failure and SHALL retain any previously loaded content unchanged.
3. WHERE a GraphQL query completes successfully and returns an empty result set of runs or tasks, THE Frontend SHALL display an empty state indicating that no runs or no tasks exist.
4. WHEN the Frontend mounts a view, THE Frontend SHALL fetch initial data through GraphQL queries exactly once and thereafter SHALL apply all subsequent data changes only through active subscriptions.
5. IF a subscription connection drops, THEN THE Frontend SHALL attempt to re-establish the subscription automatically, retrying with exponential backoff beginning at 1 second and capped at 30 seconds between attempts, continuing until the connection is re-established.
6. IF a subscription connection drops, THEN THE Frontend SHALL display a disconnected indicator and SHALL NOT attempt to refetch data while the connection is down, and WHEN the subscription is re-established, THE Frontend SHALL remove the indicator and refetch current data through GraphQL queries.

### Requirement 11: Provision infrastructure with least privilege

**User Story:** As an operator, I want all infrastructure defined as code with least-privilege access, so that the system is reproducible and secure.

#### Acceptance Criteria

1. WHEN the Deployment_System is deployed, THE Deployment_System SHALL provision the Event_Source, Ingest_Lambda, Data_Store, API, Auth_Provider, the S3 bucket, and the CloudFront distribution.
2. WHEN the Deployment_System is deployed, THE Deployment_System SHALL grant each provisioned resource only the access permissions required for its own operation and SHALL NOT grant wildcard access to all actions or all resources.
3. WHEN the Deployment_System is deployed, THE Deployment_System SHALL configure the Event_Source rule with the Dead_Letter_Queue as its failure destination and SHALL configure a retry policy with a maximum of 3 retry attempts before routing the event to the Dead_Letter_Queue.
4. WHEN the Deployment_System is deployed, THE Deployment_System SHALL configure the S3 bucket to block all public access and SHALL serve its objects only through CloudFront using Origin Access Control.
5. WHEN CloudFront receives a 403 or 404 response for a requested route, THE Deployment_System SHALL configure CloudFront to return the `index.html` object with an HTTP 200 response so that single-page-application routing resolves.
6. WHEN the Deployment_System is deployed, THE Deployment_System SHALL provision the Auth_Provider user pool and app client and SHALL configure the API default authorization to require a valid token issued by the Auth_Provider.
7. WHEN the Deployment_System is deployed, THE Deployment_System SHALL expose all resource names, ARNs, and endpoints as stack outputs and SHALL inject them into the Frontend build configuration.
8. WHEN the Deployment_System is deployed, THE Deployment_System SHALL apply a project identifier tag to every provisioned resource that supports tagging.
9. IF the Deployment_System teardown is invoked, THEN THE Deployment_System SHALL remove all provisioned resources and SHALL report any resource that could not be removed.
10. WHEN the Deployment_System provisions the Auth_Provider, THE Deployment_System SHALL provision the Auth_Provider user pool before configuring the API authorization, and SHALL NOT configure API authorization until the user pool exists.
11. IF any single component fails to provision during deployment, THEN THE Deployment_System SHALL fail the entire deployment and SHALL NOT leave a partially provisioned stack in service.

### Requirement 12: Cost and operations constraints

**User Story:** As a budget owner, I want the system to cost nothing when idle and require no server operations, so that monitoring is cheap and low maintenance.

#### Acceptance Criteria

1. THE Deployment_System SHALL provision only compute that scales to zero instances when idle and SHALL NOT provision EC2, ECS, or Fargate resources.
2. THE Deployment_System SHALL NOT provision NAT gateways, and SHALL incur zero recurring hourly infrastructure charges when no requests or events are being processed.
3. THE Deployment_System SHALL provision the Data_Store with on-demand capacity mode and SHALL NOT provision reserved or provisioned throughput capacity.
4. THE Deployment_System SHALL produce documentation that itemizes each expected cost driver, including AppSync requests and subscription minutes, Lambda invocations, DynamoDB on-demand read and write units, and CloudFront usage, with each driver listing its billing unit and the AWS service that meters it.
5. IF any provisioned resource incurs a fixed recurring charge that is billed independent of usage, THEN THE Deployment_System SHALL flag that resource in the cost documentation with an indication that it violates the idle-cost constraint.

### Requirement 13: Testing, fixtures, and local verification

**User Story:** As a developer, I want tests, sample fixtures, and a local mock path, so that I can verify the pipeline without waiting for a real HealthOmics run.

#### Acceptance Criteria

1. THE Dashboard SHALL include unit tests for the Ingest_Lambda that cover valid run status events, valid task status events, and malformed events, with all tests passing on execution.
2. THE Dashboard SHALL include a fixtures directory containing at least one sample HealthOmics EventBridge event for a run status change and at least one for a task status change.
3. THE Dashboard SHALL include unit tests for the Definition_Parser covering WDL, Nextflow, and CWL, with at least one sample definition fixture per format, and all tests passing on execution.
4. THE Dashboard SHALL include an executable script that either publishes a synthetic `aws.omics` event to EventBridge or invokes the Ingest_Lambda directly with a fixture, selectable by the operator.
5. WHEN a synthetic `aws.omics` run or task event is published, THE Dashboard SHALL update the corresponding run or task in the Frontend within 5 seconds without browser polling.
6. IF a synthetic event fails schema validation, THEN THE Dashboard SHALL reject the event, leave existing run and task data unchanged, and return an error indication identifying the validation failure.

### Requirement 14: Documentation

**User Story:** As a new operator, I want documentation covering setup and known limitations, so that I can deploy and operate the dashboard confidently.

#### Acceptance Criteria

1. THE Dashboard SHALL include a README that contains an architecture diagram, a prerequisites list, deploy steps, teardown steps, instructions for pointing the dashboard at a HealthOmics account, and instructions for verifying end-to-end event flow, with each of these seven items present as a distinct section.
2. THE Dashboard SHALL document in the README the known limitations of task dependency inference and DAG inference, listing each limitation as a discrete entry.
3. THE Dashboard SHALL document every location where the real HealthOmics event shape must be confirmed against AWS documentation, and for each location SHALL identify the exact source code file and the code element to update.
