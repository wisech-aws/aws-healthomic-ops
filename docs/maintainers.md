# Maintainer notes: HealthOmics shapes to re-check

The ingest code isolates each assumption about HealthOmics event and API
shapes behind a `CONFIRM AGAINST AWS DOCS` comment, so a change in the
service can be fixed in one place. This table lists those places. The event
fields marked as observed in [architecture.md](architecture.md#event-metadata-reference)
were checked against live events; the rest should be re-checked against the
[AWS HealthOmics documentation](https://docs.aws.amazon.com/omics/latest/dev/what-is-healthomics.html)
when the service changes.

| # | What to check | Source file | Code element |
|---|---------------|-------------|--------------|
| 1 | Run and task status spellings (casing, extra states, `DELETED` on runs only) | `ingest/src/domain/status.ts` | `RunStatus` and `TaskStatus` enums, used by `isRunStatus` and `isTaskStatus` |
| 2 | Event `detail-type` strings that classify run and task events | `ingest/src/eventMapper.ts` | `detectKind()`, constants `RUN_DETAIL_TYPE` and `TASK_DETAIL_TYPE` |
| 3 | Run event `detail` fields: `runId`, `status`, `runName`, `workflowId`, `workflowName`, and the optional `workflowVersionName` and `runOutputUri` | `ingest/src/eventMapper.ts` | `mapRunEvent()`, constants `RUN_FIELDS` and `RUN_OPTIONAL_FIELDS` |
| 4 | Task event `detail` fields: the task ID carried only in `arn` (`.../task/<id>`), the required `runId` and `status`, and the optional `taskName` (legacy `name`), `cpus`, `memory`, `instanceType`, `creationTime`, `startTime`, `stopTime` | `ingest/src/eventMapper.ts` | `mapTaskEvent()`, constants `TASK_FIELDS`, `TASK_OPTIONAL_FIELDS`, `TASK_ARN_FIELD`, `TASK_ARN_RESOURCE_PREFIX`, and `parseTaskIdFromArn()` |
| 5 | `GetRun` response mapping: timestamps, status, `workflowId`, `outputUri`, parameters, engine version, and the run configuration exposed through GraphQL (`storageType`, `storageCapacity`, `cacheId`, `cacheBehavior`, `networkingMode`, `configuration.name`, `logLevel`, `batchId`). The full response is also stored as `rawGetRun` (with `$metadata` removed). `rawGetRun` and the run role ARN inside it are never exposed through GraphQL. | `ingest/src/enrichment/tasks.ts` | `mapRunResponse()` |
| 6 | `ListRunTasks` item and `GetRunTask` response mapping (status, cpus, memory units, timestamps) | `ingest/src/enrichment/tasks.ts` | `mapTaskFields()`, used by `enrichRun`, `enrichTask`, and `enrichTasks` |
| 7 | `GetWorkflow` export mode and definition fields. `GetWorkflow` with `export=[DEFINITION]` returns `definition` as a presigned S3 URL to a `definition.zip` bundle and `main` as the entry file (for example `main.nf`). The bundle is downloaded, unzipped, and parsed within a 30-second budget. | `ingest/src/enrichment/workflow.ts`, `ingest/src/enrichment/unzip.ts` | `resolveDefinitionUrl()`, `resolveMainPath()`, `getWorkflowDefinition()`, constants `WORKFLOW_EXPORT_DEFINITION`, `DEFINITION_URL_FIELD`, `WORKFLOW_MAIN_FIELD` |
| 8 | `GetWorkflow` engine spellings mapped to the parser `Language` union (`WDL_LENIENT` is folded into WDL) | `ingest/src/enrichment/workflow.ts` | `mapEngineToLanguage()`, `resolveLanguage()`, constant `WORKFLOW_LANGUAGE_FIELD` |

When a shape changes, also update the event fixtures under `fixtures/events/`
and the workflow-definition fixtures used by the parser tests.

## Deploy-time checks

- `npx cdk diff` from `infra/` before every deploy. `scripts/deploy.sh` deploys
  with `--require-approval never`.
- After changing ingest, deploy once with `-c eventEnrichmentMode=shadow`, run a
  workflow, and check the `HealthOmicsIngest/EnrichmentShadowMismatch` metric
  before going back to `event`.
- The Lambdas use `nodejs20.x`; see
  [Known limitations](../README.md#known-limitations) for the deprecation dates.
