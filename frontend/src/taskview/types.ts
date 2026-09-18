/**
 * Frontend-side mirrors of the backend static-graph shapes plus the derived
 * view models the three task-DAG layers (True_DAG, Inferred_DAG, Timeline_View)
 * are built from.
 *
 * The static-graph shapes mirror `ingest/src/parser/types.ts`
 * ({@link GraphNode}, {@link GraphEdge}, {@link StaticGraph}). They are kept
 * hand-written and minimal — matching the frontend's approach in
 * `src/api/types.ts` — rather than shared across the package boundary.
 *
 * See design.md "Task DAG Rendering (Three Layers)" and requirements 6.10,
 * 6.11, 7.2, 7.4, 7.6.
 */

import type { Task, TaskStatus } from '../api/types';

/**
 * A node in a parsed static task graph.
 *
 * `id` is the stable, definition-internal identifier used to reference the node
 * within {@link GraphEdge}s. `name` is the task name matched against live run
 * tasks by exact, case-sensitive equality (Req 6.10).
 */
export interface GraphNode {
  readonly id: string;
  readonly name: string;
}

/**
 * A directed dependency edge (producer → consumer) between two
 * {@link GraphNode}s.
 */
export interface GraphEdge {
  /** Node id of the producer. */
  readonly from: string;
  /** Node id of the consumer. */
  readonly to: string;
}

/**
 * The parsed static task graph derived from a workflow definition, keyed by
 * `workflowId`. Mirrors the backend {@link StaticGraph} (Req 6.3, 6.8).
 */
export interface StaticGraph {
  readonly workflowId: string;
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  /**
   * Confidence of the derived graph, mirrored from the backend
   * {@link import('../api/types').GraphFidelity} (Req 8.1). `exact` for
   * authoritative WDL/CWL graphs, `approximate` for best-effort Nextflow
   * graphs. Optional so pre-existing callers that predate the field still
   * construct a graph; the view treats a missing value as `approximate`.
   */
  readonly fidelity?: 'exact' | 'approximate';
}

/**
 * Which of the three task-DAG layers is being shown. The frontend always
 * displays this indication (Req 7.5).
 */
export type LayerKind = 'True_DAG' | 'Inferred_DAG' | 'Timeline_View';

/**
 * A single static-graph node overlaid with the matched run task's status.
 *
 * When `matched` is `true`, `status` carries the matched task's
 * {@link TaskStatus} (possibly `null` when the task itself has no status yet)
 * and `task` is the matched task. When `matched` is `false`, the node had no
 * exactly-matching run task: it carries an unmatched-status indication and no
 * status overlay (Req 6.11).
 */
export interface TrueDagNode {
  readonly id: string;
  readonly name: string;
  readonly matched: boolean;
  readonly status: TaskStatus | null;
  readonly task: Task | null;
}

/**
 * The True_DAG overlay result: the original edges, plus per-node status
 * overlays keyed by exact, case-sensitive name match (Req 6.10, 6.11).
 */
export interface TrueDagOverlay {
  readonly kind: 'True_DAG';
  readonly nodes: TrueDagNode[];
  readonly edges: GraphEdge[];
}

/**
 * A group of tasks the Inferred_DAG places at the same ordinal position because
 * their [startedAt, stoppedAt] intervals overlap (concurrent tasks, Req 7.2).
 */
export interface InferredDagLevel {
  /** Zero-based ordinal position; lower comes first. */
  readonly order: number;
  /** Tasks in this level, all mutually concurrent, ordered by start time. */
  readonly tasks: Task[];
}

/**
 * The Inferred_DAG ordering result: tasks bucketed into ordered levels where a
 * task with an earlier start is placed no later than one with a later start,
 * and overlapping tasks share a level (Req 7.2).
 */
export interface InferredDagOrdering {
  readonly kind: 'Inferred_DAG';
  readonly levels: InferredDagLevel[];
}

/**
 * A group of tasks that share a {@link TaskStatus}, ordered by ascending start
 * time (Req 7.4).
 */
export interface TimelineGroup {
  readonly status: TaskStatus | 'UNKNOWN';
  readonly tasks: Task[];
}

/**
 * The Timeline_View grouping result: tasks partitioned by status. When no task
 * carries timing data, `orderingUnavailable` is `true` so the view can surface
 * an "ordering data unavailable" indication (Req 7.6).
 */
export interface TimelineView {
  readonly kind: 'Timeline_View';
  readonly groups: TimelineGroup[];
  readonly orderingUnavailable: boolean;
}
