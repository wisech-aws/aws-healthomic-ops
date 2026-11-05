# HealthOmics event metadata

This page lists what AWS HealthOmics sends to Amazon EventBridge, which
fields the ingest mapper reads, and which dashboard fields still come from
HealthOmics read APIs. The mapping lives in `ingest/src/eventMapper.ts`. For
how the enrichment types use these fields, see
[Event enrichment](../README.md#event-enrichment-eventenrichmentmode) and
[architecture.md](architecture.md#event-driven-enrichment-eventenrichmentmode).

- [Event envelope](#event-envelope)
- [Statuses](#statuses)
- [Run Status Change](#run-status-change)
- [Task Status Change](#task-status-change)
- [Fields that still come from the API](#fields-that-still-come-from-the-api)

## Event envelope

HealthOmics publishes two event types to the default event bus of the account
and region where the run executes. Both use the standard EventBridge
envelope.

| Envelope field | Value | Used for |
|----------------|-------|----------|
| `source` | `aws.omics` | The ingest rule matches `{"source": ["aws.omics"]}` |
| `detail-type` | `Run Status Change` or `Task Status Change` | Classifies the event as a run or task event (`RUN_DETAIL_TYPE`, `TASK_DETAIL_TYPE`); any other value is ignored |
| `time` | ISO 8601, 1-second precision | The stored `updatedAt` (monotonic write guard), and the run's `createdAt` at `PENDING` and `startedAt` at `RUNNING` until `GetRun` supplies exact values |
| `detail.omicsVersion` | `1.0.0` | Not mapped. The field reference below was checked against this version |

The mapper is defensive. A missing field is left unset rather than defaulted.
A missing identity or status field logs the full event. An unknown status is
logged and left unset, and the event is still processed.

## Statuses

Both event types carry `status` at every transition. The mapper accepts the
values in `ingest/src/domain/status.ts`:

| Status | Runs | Tasks |
|--------|------|-------|
| `PENDING` | Yes | Yes |
| `STARTING` | Yes | Yes |
| `RUNNING` | Yes | Yes |
| `STOPPING` | Yes | Yes |
| `COMPLETED` | Yes (terminal) | Yes (terminal) |
| `FAILED` | Yes (terminal) | Yes (terminal) |
| `CANCELLED` | Yes (terminal) | Yes (terminal) |
| `DELETED` | Yes (terminal) | No |

The field reference was checked against captured live events: run events
from `PENDING` through `COMPLETED`, and task events at `PENDING`, `STARTING`,
`RUNNING`, and `COMPLETED`. The `FAILED` and `CANCELLED` event shapes have not
been checked against live data, which is one reason `event` mode still calls
`GetRunTask` for those tasks.

## Run Status Change

Run events carry only identity fields, the status, `workflowVersionName`, and
`runOutputUri`. All fields are present at every status.

| Detail field | Type / format | Dashboard field |
|--------------|---------------|-----------------|
| `runId` | String (numeric ID) | `runId` |
| `status` | String, run status | `status` |
| `runName` | String | `name` |
| `workflowId` | String (numeric ID) | `workflowId` |
| `workflowName` | String | `workflowName` |
| `workflowVersionName` | String, optional (absent for a run without a version) | `workflowVersionName` |
| `runOutputUri` | String, S3 URI, optional | `outputUri` |
| `arn` | String, run ARN | Not mapped |
| `uuid` | String, UUID | Not mapped |
| `workflowUuid` | String, UUID | Not mapped |

Example (sanitized):

```json
{
  "version": "0",
  "id": "11111111-2222-3333-4444-555555555555",
  "detail-type": "Run Status Change",
  "source": "aws.omics",
  "account": "123456789012",
  "time": "2025-01-15T10:00:00Z",
  "region": "us-east-1",
  "resources": ["arn:aws:omics:us-east-1:123456789012:run/1234567"],
  "detail": {
    "omicsVersion": "1.0.0",
    "arn": "arn:aws:omics:us-east-1:123456789012:run/1234567",
    "runId": "1234567",
    "status": "RUNNING",
    "uuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "runOutputUri": "s3://amzn-s3-demo-bucket/run-outputs/1234567",
    "runName": "example-run",
    "workflowName": "example-workflow",
    "workflowId": "7654321",
    "workflowVersionName": "v1",
    "workflowUuid": "ffffffff-0000-1111-2222-333333333333"
  }
}
```

## Task Status Change

Task events have no `taskId` field. The task ID is the segment after `task/`
in the task `arn`. Numeric values arrive as strings and are converted to
numbers. Timestamps are ISO 8601 with milliseconds, match `GetRunTask`, and
are stored as UTC.

| Detail field | Type / format | Carried on | Dashboard field |
|--------------|---------------|------------|-----------------|
| `arn` | String, task ARN (`.../task/<task-id>`) | All statuses | `taskId` (parsed from the ARN) |
| `runId` | String (numeric ID) | All statuses | `runId` |
| `status` | String, task status | All statuses | `status` |
| `taskName` | String | All statuses | `name` |
| `cpus` | String, integer (for example `"2"`) | All statuses | `cpus` (number) |
| `memory` | String, GiB (for example `"12"`) | All statuses | `memory` (number, GiB) |
| `gpus` | String, integer (for example `"0"`) | All statuses | Not mapped (no `gpus` field in the record or GraphQL schema) |
| `creationTime` | ISO 8601 timestamp | All statuses | `createdAt` |
| `instanceType` | String (for example `omics.m.large`) | Added at `RUNNING` | `instanceType` |
| `startTime` | ISO 8601 timestamp | Added at `RUNNING` | `startedAt` |
| `stopTime` | ISO 8601 timestamp | Added at `COMPLETED` | `stoppedAt` |
| `runArn`, `runName`, `runUuid`, `workflowId`, `workflowName`, `workflowVersionName`, `workflowUuid` | Strings | All statuses | Not mapped on the task (the run event supplies them) |

Task events never carry `statusMessage` or `failureReason`. The mapper also
reads a legacy `name` field when `taskName` is absent, which is what the
sample `fixtures/events/task-status-change.json` uses.

Example (sanitized, `COMPLETED`):

```json
{
  "version": "0",
  "id": "66666666-7777-8888-9999-000000000000",
  "detail-type": "Task Status Change",
  "source": "aws.omics",
  "account": "123456789012",
  "time": "2025-01-15T10:05:30Z",
  "region": "us-east-1",
  "resources": ["arn:aws:omics:us-east-1:123456789012:task/2345678"],
  "detail": {
    "omicsVersion": "1.0.0",
    "arn": "arn:aws:omics:us-east-1:123456789012:task/2345678",
    "status": "COMPLETED",
    "runArn": "arn:aws:omics:us-east-1:123456789012:run/1234567",
    "runId": "1234567",
    "runName": "example-run",
    "runUuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "workflowName": "example-workflow",
    "workflowId": "7654321",
    "workflowVersionName": "v1",
    "workflowUuid": "ffffffff-0000-1111-2222-333333333333",
    "taskName": "EXAMPLE:ALIGN (sample1)",
    "cpus": "2",
    "gpus": "0",
    "memory": "12",
    "instanceType": "omics.m.large",
    "creationTime": "2025-01-15T10:01:00.123Z",
    "startTime": "2025-01-15T10:03:10.456Z",
    "stopTime": "2025-01-15T10:05:29.789Z"
  }
}
```

At `PENDING` and `STARTING` the same event has no `instanceType`,
`startTime`, or `stopTime`. At `RUNNING` it has no `stopTime`.

## Fields that still come from the API

Events don't carry everything the dashboard shows, so `event` mode still
calls HealthOmics read APIs for these fields:

| Dashboard fields | API | When (`event` mode) |
|------------------|-----|---------------------|
| Run `statusMessage`, `failureReason`, exact `stoppedAt` | `GetRun` | Terminal run status |
| Run `parameters`, `engineVersion`, `roleArn`, `tags`, storage (`storageType`, `storageCapacity`), cache (`cacheId`, `cacheBehavior`), `networkingMode`, `configurationName`, `logLevel`, `batchId`, exact `createdAt` and `startedAt`, and the raw `GetRun` capture (`rawGetRun`) | `GetRun` | `PENDING`, terminal, and as a fallback when the stored run has no `GetRun` data or the event has no status |
| Task `statusMessage`, `failureReason` | `GetRunTask` | `FAILED` or `CANCELLED` tasks, and as a fallback when a terminal task event lacks `taskName`, `startTime`, or `stopTime` |
| Workflow definition (static graph) | `GetWorkflow` | First time a workflow version's graph is needed (cache miss) |

In `api` mode the same fields come from the same calls, but `GetRun` runs on
every run event and `GetRunTask` on every terminal task event.
