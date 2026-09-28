/**
 * Run and task status enums.
 *
 * ============================================================================
 * CONFIRM AGAINST AWS DOCS
 * ----------------------------------------------------------------------------
 * The exact member spellings below (PENDING, STARTING, RUNNING, ...) are the
 * values the HealthOmics dashboard treats as valid statuses. They MUST be
 * confirmed against the real HealthOmics event/API status vocabulary before
 * relying on them in production:
 *
 *   - Run status values: confirm against the AWS HealthOmics `GetRun` response
 *     `status` field and the EventBridge run status-change `detail` payload.
 *   - Task status values: confirm against the AWS HealthOmics `GetRunTask` /
 *     `ListRunTasks` response `status` field and the EventBridge task
 *     status-change `detail` payload.
 *
 * If the real HealthOmics spellings differ (casing, extra states, etc.), update
 * these enums here. This file is the single source of truth for status
 * vocabulary (see the "Confirm against AWS docs" table in design.md), so any
 * event whose status is not a member of these enums is treated as unrecognized
 * (Requirements 1.6).
 * ============================================================================
 */

/**
 * Valid HealthOmics run statuses (Requirement 1.3).
 *
 * CONFIRM AGAINST AWS DOCS: member spellings must match the values emitted by
 * HealthOmics for run status-change events and returned by `GetRun`.
 */
export enum RunStatus {
  PENDING = 'PENDING',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
  COMPLETED = 'COMPLETED',
  DELETED = 'DELETED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

/**
 * Valid HealthOmics task statuses (Requirement 1.4).
 *
 * CONFIRM AGAINST AWS DOCS: member spellings must match the values emitted by
 * HealthOmics for task status-change events and returned by `GetRunTask` /
 * `ListRunTasks`. Note: unlike RunStatus, tasks have no DELETED state.
 */
export enum TaskStatus {
  PENDING = 'PENDING',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

/**
 * Type guard: is the given value a recognized RunStatus enum member?
 * Used to reject unrecognized status values during ingest (Requirement 1.6).
 */
export function isRunStatus(value: unknown): value is RunStatus {
  return (
    typeof value === 'string' &&
    (Object.values(RunStatus) as string[]).includes(value)
  );
}

/**
 * Type guard: is the given value a recognized TaskStatus enum member?
 * Used to reject unrecognized status values during ingest (Requirement 1.6).
 */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' &&
    (Object.values(TaskStatus) as string[]).includes(value)
  );
}

/**
 * Terminal (end-of-life) statuses shared by runs and tasks.
 *
 * A run or task in one of these states will never transition to any other
 * state. This set is the source of truth for the repository's status-monotonic
 * upsert guard: once an item is persisted in a terminal state it must never be
 * reverted to a non-terminal state by a later-processed but semantically
 * earlier event (out-of-order EventBridge delivery, at-least-once redelivery,
 * or same-second `event.time` collisions). `DELETED` applies only to runs.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>([
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
  RunStatus.DELETED,
]);

/**
 * Is the given status a terminal (end-of-life) status? Non-string or
 * unrecognized values are treated as non-terminal (`false`) so an unknown
 * status never blocks a legitimate write.
 */
export function isTerminalStatus(value: unknown): boolean {
  return typeof value === 'string' && TERMINAL_STATUSES.has(value);
}
