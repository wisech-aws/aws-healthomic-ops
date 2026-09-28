/**
 * Status-to-color maps.
 *
 * Each `RunStatus` and each `TaskStatus` maps to a distinct color so that no
 * two status values share a color (Req 8.7, 9.5). The maps are plain lookup
 * objects so injectivity can be unit- and property-tested directly.
 */
import type { RunStatus, TaskStatus } from '../api/types';

/** Color used when a status is missing/unknown on a run or task. */
export const UNKNOWN_STATUS_COLOR = '#64748b';

/**
 * Accent color for the slowest (longest-running) task highlight on the DAG
 * (Req 3.6). Deliberately distinct from every status color (and from the amber
 * selection ring / blue search ring) so the "slowest" ring is unambiguous.
 * Shared by the DAG node and the legend so they always agree.
 */
export const SLOWEST_TASK_COLOR = '#db2777';

/**
 * Distinct color per `RunStatus`. Every RunStatus enum member is present and no
 * two members share a color (Req 8.7).
 */
export const RUN_STATUS_COLORS: Record<RunStatus, string> = {
  PENDING: '#94a3b8',
  STARTING: '#38bdf8',
  RUNNING: '#3b82f6',
  STOPPING: '#f59e0b',
  COMPLETED: '#047857',
  DELETED: '#1e293b',
  CANCELLED: '#8b5cf6',
  FAILED: '#ef4444',
};

/**
 * Distinct color per `TaskStatus`. Every TaskStatus enum member is present and
 * no two members share a color (Req 9.5). TaskStatus has no `DELETED` member,
 * so this map is defined separately from {@link RUN_STATUS_COLORS}.
 */
export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  PENDING: '#94a3b8',
  STARTING: '#38bdf8',
  RUNNING: '#3b82f6',
  STOPPING: '#f59e0b',
  COMPLETED: '#047857',
  CANCELLED: '#8b5cf6',
  FAILED: '#ef4444',
};

/** Returns the color for a run status, or the unknown color when absent. */
export function runStatusColor(status: RunStatus | null | undefined): string {
  return status == null ? UNKNOWN_STATUS_COLOR : RUN_STATUS_COLORS[status];
}

/** Returns the color for a task status, or the unknown color when absent. */
export function taskStatusColor(status: TaskStatus | null | undefined): string {
  return status == null ? UNKNOWN_STATUS_COLOR : TASK_STATUS_COLORS[status];
}
