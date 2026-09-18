/**
 * Maps run/task statuses to Cloudscape `StatusIndicator` types so statuses are
 * rendered with the design system's standard iconography and semantic colors.
 *
 * This is a presentational mapping for Cloudscape and is intentionally separate
 * from the injective `statusColors.ts` maps (which the React Flow task-graph
 * nodes and the color-injectivity property tests depend on). Several statuses
 * legitimately share a Cloudscape indicator type (e.g. both PENDING and
 * STARTING are "pending"), which is expected — Cloudscape has a fixed, small set
 * of indicator types.
 */
import type { RunStatus, TaskStatus } from '../api/types';

/** The Cloudscape StatusIndicator `type` values we use. */
export type StatusIndicatorType =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'pending'
  | 'in-progress'
  | 'stopped';

const STATUS_INDICATOR: Record<RunStatus | TaskStatus, StatusIndicatorType> = {
  PENDING: 'pending',
  STARTING: 'pending',
  RUNNING: 'in-progress',
  STOPPING: 'in-progress',
  COMPLETED: 'success',
  DELETED: 'stopped',
  CANCELLED: 'stopped',
  FAILED: 'error',
};

/**
 * Returns the Cloudscape StatusIndicator type for a run/task status, defaulting
 * to `info` when the status is absent/unknown.
 */
export function statusIndicatorType(
  status: RunStatus | TaskStatus | null | undefined,
): StatusIndicatorType {
  return status == null ? 'info' : STATUS_INDICATOR[status];
}
