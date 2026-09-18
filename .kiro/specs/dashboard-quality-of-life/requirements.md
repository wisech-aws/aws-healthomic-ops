# Requirements Document

## Introduction

This feature adds nine quality-of-life enhancements to the AWS HealthOmics Workflow Dashboard. Every value surfaced is derived client-side from data already persisted in DynamoDB and already fetched by the existing GraphQL queries (`listRuns`, `getRun`, `listTasksForRun`). No new ingestion path, no new GraphQL field, and — per the project's strict standing rule — no fabricated or placeholder data is introduced. Where a value cannot be derived from present fields, the dashboard surfaces an explicit "unknown" / "unavailable" affordance rather than inventing one.

These requirements are derived from the approved design document (`design.md`) and are aligned with the design's fifteen correctness properties so that each property can cite a requirement number. Requirements 11 and 12 capture the two "CONFIRM AGAINST AWS DOCS" caveats (task memory units and task `createdAt` semantics) as explicit, testable requirements so those values are always surfaced under an unconfirmed caveat rather than presented as ground truth.

## Glossary

- **Dashboard**: The AWS HealthOmics Workflow Dashboard frontend (`frontend/src`), the system under specification for all requirements.
- **Run**: A workflow run record with fields `runId`, `status`, `createdAt`, `startedAt`, `stoppedAt`, `updatedAt`, `workflowId`, `workflowName`, `parameters`, `engineVersion`.
- **Task**: A per-run task record with fields `runId`, `taskId`, `status`, `name`, `createdAt`, `startedAt`, `stoppedAt`, `updatedAt`, `cpus`, `memory`.
- **Wall_Clock_Duration**: Elapsed time from `startedAt` to `stoppedAt`; for an item that has started but not stopped, elapsed time from `startedAt` to the current instant (`now`).
- **Now**: The current instant, injected as an epoch-millisecond parameter so all derivations are deterministic and testable.
- **Unknown_State**: An explicit user-visible affordance (for example the `—` placeholder or an "unavailable" label) shown when a value cannot be derived from present data.
- **Non_Terminal_Status**: A run or task status indicating work is still expected to progress (for example `PENDING`, `STARTING`, `RUNNING`), as opposed to a terminal status (for example `COMPLETED`, `FAILED`, `CANCELLED`).
- **Task_Interval**: A task's execution interval `[start, end)` in epoch milliseconds, derived from its `startedAt`/`stoppedAt`, with an `open` flag when the task is still running.
- **Peak_Concurrency**: The maximum, over all instants, of the number of Task_Intervals whose half-open range contains that instant.
- **CPU_Hours**: The summed area of task CPU usage over time, `Σ (task duration in hours × task cpus)`.
- **Queue_Wait**: A task's time from `createdAt` to `startedAt`.
- **Run_Time**: A task's time from `startedAt` to `stoppedAt` (or to `now` while running).
- **Params_Diff**: The set of per-key differences between the parsed `parameters` JSON of two runs.
- **Stale_Run**: A non-terminal Run whose `updatedAt` is older than a configured staleness threshold.

## Requirements

### Requirement 1: Run and task duration columns

**User Story:** As a bioinformatician, I want run and per-task wall-clock durations shown as columns, so that I can see how long work took without doing arithmetic on timestamps.

#### Acceptance Criteria

1. WHERE both `startedAt` and `stoppedAt` are present and parseable, THE Dashboard SHALL display the Wall_Clock_Duration as `stoppedAt` minus `startedAt`.
2. WHILE a run or task has a parseable `startedAt` but no `stoppedAt`, THE Dashboard SHALL display the elapsed-so-far Wall_Clock_Duration measured against Now.
3. IF `startedAt` is absent or unparseable, THEN THE Dashboard SHALL display the Unknown_State for that duration.
4. WHERE `stoppedAt` is earlier than `startedAt`, THE Dashboard SHALL display a Wall_Clock_Duration of zero rather than a negative value.
5. THE Dashboard SHALL compute every duration deterministically for a fixed Now.

### Requirement 2: Resource summary per run

**User Story:** As a bioinformatician, I want a per-run resource summary of peak concurrent CPUs, total CPU-hours, and peak memory, so that I can understand a run's compute footprint.

#### Acceptance Criteria

1. WHEN building Task_Intervals for a run, THE Dashboard SHALL include exactly the tasks with a parseable `startedAt`, SHALL set each interval's end to `stoppedAt` when present and to Now when absent, SHALL flag intervals derived from still-running tasks as open, and SHALL clamp any interval whose end precedes its start so that start equals end.
2. THE Dashboard SHALL compute Peak_Concurrency as the maximum over all instants of the number of Task_Intervals whose half-open range contains that instant, treating a task that ends exactly when another starts as not concurrent, and SHALL report zero for an empty task set.
3. THE Dashboard SHALL compute peak concurrent CPUs as the maximum summed `cpus` over any set of mutually overlapping Task_Intervals.
4. THE Dashboard SHALL compute CPU_Hours as the sum over intervals with non-null `cpus` of the interval duration in hours multiplied by the interval `cpus`, against a fixed Now.
5. IF no task with a parseable start carries a non-null `cpus`, THEN THE Dashboard SHALL report the peak concurrent CPUs and CPU_Hours metrics as unavailable with a null value rather than zero-as-data.
6. IF no task with a parseable start carries a non-null `memory`, THEN THE Dashboard SHALL report the peak memory metric as unavailable with a null value rather than zero-as-data.
7. WHILE any Task_Interval for a run is open, THE Dashboard SHALL mark the resource summary as partial to indicate the values are provisional lower bounds.

### Requirement 3: Longest-running tasks and slowest-step highlight

**User Story:** As a bioinformatician, I want the longest-running tasks ranked and the slowest task highlighted on the DAG, so that I can find the steps that dominate a run's wall-clock time.

#### Acceptance Criteria

1. THE Dashboard SHALL rank a run's tasks by descending Wall_Clock_Duration, producing one ranked entry per task with a 1-based non-decreasing rank.
2. THE Dashboard SHALL order every task with a known duration before every task with an unknown duration, and SHALL order known-duration tasks so the sequence is non-increasing in duration.
3. THE Dashboard SHALL surface the top N longest-running tasks, where N defaults to five, excluding tasks with unknown duration.
4. WHEN at least one task has a known duration, THE Dashboard SHALL identify the single slowest task as the one whose duration is greater than or equal to every other task's duration, resolving ties to the earliest `startedAt`, and the identified task SHALL be present in the input.
5. IF no task has a known duration, THEN THE Dashboard SHALL report no slowest task.
6. WHERE a task DAG is displayed and a slowest task is identified, THE Dashboard SHALL highlight that task's node.
7. THE Dashboard SHALL label this feature as "longest-running tasks" (a wall-clock approximation) and SHALL NOT present it as a dependency-graph critical path.

### Requirement 4: Failed-task quick filter and count badge

**User Story:** As a bioinformatician, I want to filter to failed or cancelled tasks and see a count badge, so that I can jump straight to what went wrong.

#### Acceptance Criteria

1. THE Dashboard SHALL select exactly the tasks whose `status` is `FAILED` or `CANCELLED` when the failed-task filter is applied.
2. THE Dashboard SHALL display a count badge equal to the number of tasks whose `status` is `FAILED` or `CANCELLED`.

### Requirement 5: Run-list filtering and sorting

**User Story:** As a bioinformatician, I want to filter the run list by status and workflow and sort by recency or duration, so that I can focus on the runs that matter.

#### Acceptance Criteria

1. WHEN a status filter is active, THE Dashboard SHALL return exactly the runs whose `status` is in the selected status set.
2. WHEN a workflow filter is active, THE Dashboard SHALL return exactly the runs whose `workflowId` equals the selected workflow.
3. THE Dashboard SHALL leave the source run collection unmutated when applying filters and sorting.
4. WHERE no status filter and no workflow filter are active and the sort key is recency, THE Dashboard SHALL produce the same ordering as the existing recency ordering.
5. WHEN sorting by duration, THE Dashboard SHALL place every known-duration run before every unknown-duration run, order known-duration runs by Wall_Clock_Duration in the requested direction, and break ties by the existing recency comparator.
6. THE Dashboard SHALL produce a deterministic total ordering that is a permutation of the filtered runs, adding or dropping no run.

### Requirement 6: Parameters diff between two runs

**User Story:** As a bioinformatician, I want to compare the parameters of two runs of the same workflow, so that I can see what changed between executions.

#### Acceptance Criteria

1. THE Dashboard SHALL parse each run's `parameters` JSON string into an object and SHALL flatten nested objects to dotted-path keys.
2. THE Dashboard SHALL produce one Params_Diff entry per key in the union of the two runs' flattened parameter keys, sorted by key.
3. THE Dashboard SHALL classify an entry as added when the key exists only on the right run, removed when only on the left run, unchanged when present on both with deep-equal values, and changed otherwise.
4. WHEN the two runs are swapped, THE Dashboard SHALL swap each entry's added and removed classification and its left and right values while preserving the changed and unchanged classifications.
5. IF a run's `parameters` is a non-empty non-JSON string, THEN THE Dashboard SHALL treat that side as a parse error and SHALL surface a parse-error notice for that side.
6. WHERE a run's `parameters` is null or empty, THE Dashboard SHALL treat it as an empty parameter object without raising a parse error.
7. IF the two runs do not share a non-null `workflowId`, THEN THE Dashboard SHALL still compute the diff and SHALL warn that the comparison may be meaningless.

### Requirement 7: Engine version badge and grouping

**User Story:** As a bioinformatician, I want a run's engine version shown on its header and the fleet groupable by engine version, so that I can reason about behavior differences across engine versions.

#### Acceptance Criteria

1. WHERE a run has an `engineVersion`, THE Dashboard SHALL display that engine version on the run header.
2. IF a run has no `engineVersion`, THEN THE Dashboard SHALL display the Unknown_State for the engine version.
3. WHEN grouping runs by engine version, THE Dashboard SHALL place every run in exactly one group such that the concatenation of groups is a permutation of the input.
4. THE Dashboard SHALL group runs so that all runs in a group share the same `engineVersion`, collecting runs with an absent `engineVersion` under a single unknown group, and SHALL preserve input order within each group.

### Requirement 8: Task state-transition timeline

**User Story:** As a bioinformatician, I want each task's time broken into queue-wait and run-time, so that I can see where a task spent its time.

#### Acceptance Criteria

1. THE Dashboard SHALL compute Run_Time for a task as the Wall_Clock_Duration from `startedAt` to `stoppedAt`, or to Now while the task is running.
2. THE Dashboard SHALL compute Queue_Wait for a task as the duration from `createdAt` to `startedAt`, with no Now fallback.
3. IF the bounding timestamps of a segment are absent or unparseable, THEN THE Dashboard SHALL report that segment as unknown.
4. WHILE a task is running, THE Dashboard SHALL flag its Run_Time segment as provisional.

### Requirement 9: Stale-run indicator

**User Story:** As a bioinformatician, I want non-terminal runs that have gone quiet flagged as possibly stuck, so that I can investigate runs that may have stalled.

#### Acceptance Criteria

1. WHEN a run's `status` is a Non_Terminal_Status and its `updatedAt` is parseable and Now minus `updatedAt` exceeds the staleness threshold, THE Dashboard SHALL flag the run as a Stale_Run.
2. THE Dashboard SHALL use a configurable staleness threshold greater than zero, defaulting to one hour.
3. IF a run's `status` is terminal, THEN THE Dashboard SHALL NOT flag the run as stale and SHALL record the reason as terminal.
4. IF a run's `updatedAt` is unparseable, THEN THE Dashboard SHALL NOT flag the run as stale and SHALL record the reason as unknown.

### Requirement 10: No fabricated data (standing rule)

**User Story:** As a maintainer, I want every derived value to degrade to an explicit unknown state when its inputs are missing, so that the dashboard never presents fabricated data.

#### Acceptance Criteria

1. IF a value cannot be derived from present Run or Task fields, THEN THE Dashboard SHALL display an Unknown_State rather than a fabricated or placeholder value.
2. THE Dashboard SHALL derive every enhancement value solely from data already fetched by the existing `listRuns`, `getRun`, and `listTasksForRun` queries, adding no new stored attribute and no new data source.
3. WHEN a derivation receives missing or malformed input, THE Dashboard SHALL return an Unknown_State without raising an exception.
4. WHERE a derived value depends on a still-running item, THE Dashboard SHALL flag that value as provisional rather than final.

### Requirement 11: Task memory units are surfaced as unconfirmed (CONFIRM AGAINST AWS DOCS)

**User Story:** As a bioinformatician, I want the peak memory value labeled as having unconfirmed units, so that I do not misread the number as a confirmed unit.

#### Acceptance Criteria

1. THE Dashboard SHALL attach an unconfirmed-units note to the peak memory metric stating that the memory unit is unconfirmed pending AWS documentation confirmation.
2. THE Dashboard SHALL display the peak memory value with its unit marked as unconfirmed and SHALL NOT convert the value into any other unit.
3. THE Dashboard SHALL compute the peak memory aggregation as a unit-agnostic sum over concurrent Task_Intervals so that only the display label changes if the confirmed unit differs.

### Requirement 12: Task createdAt semantics are surfaced as unconfirmed (CONFIRM AGAINST AWS DOCS)

**User Story:** As a bioinformatician, I want queue-wait labeled as derived from unconfirmed `createdAt` semantics, so that I do not treat queue-wait as ground truth.

#### Acceptance Criteria

1. WHEN Queue_Wait is derived for a task, THE Dashboard SHALL mark that task's segment confidence as unconfirmed.
2. WHERE a task's Queue_Wait is unknown, THE Dashboard SHALL mark that task's segment confidence as confirmed, because no unconfirmed `createdAt`-derived value is presented.
3. WHERE Queue_Wait confidence is unconfirmed, THE Dashboard SHALL render the queue-wait segment under an explicit caveat that the `createdAt` semantics are unconfirmed.
4. THE Dashboard SHALL present Run_Time without the unconfirmed caveat, as Run_Time does not depend on `createdAt`.
