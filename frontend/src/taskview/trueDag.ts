/**
 * True_DAG overlay (Req 6.10, 6.11).
 *
 * Given a {@link StaticGraph} derived from the workflow definition and the run's
 * live tasks, overlay each static node with the status of the task whose `name`
 * matches by EXACT, CASE-SENSITIVE equality. A node with no matching task is
 * flagged unmatched and carries no status overlay.
 *
 * See design.md "Task DAG Rendering (Three Layers)".
 */

import type { Task } from '../api/types';
import type { StaticGraph, TrueDagNode, TrueDagOverlay } from './types';

/**
 * Build the True_DAG overlay for a run.
 *
 * Matching is by exact, case-sensitive task `name` equality (Req 6.10). Each
 * matched node is overlaid with the matched task's `status` (which may itself be
 * `null` when the task has no status yet). Each node with no exact match carries
 * `matched: false`, a `null` status, and no task (Req 6.11).
 *
 * When multiple tasks share the same `name`, the first task in `tasks` order is
 * used for the overlay; matching remains deterministic for a given input order.
 *
 * @param graph The static graph for the run's workflow.
 * @param tasks The run's live tasks.
 * @returns The overlay: nodes with status overlays plus the original edges.
 */
export function buildTrueDagOverlay(
  graph: StaticGraph,
  tasks: readonly Task[],
): TrueDagOverlay {
  // Index tasks by exact name. `Map` preserves case-sensitive keys and lets us
  // keep the first task seen for a given name (deterministic on input order).
  const byName = new Map<string, Task>();
  for (const task of tasks) {
    if (task.name != null && !byName.has(task.name)) {
      byName.set(task.name, task);
    }
  }

  const nodes: TrueDagNode[] = graph.nodes.map((node) => {
    const match = byName.get(node.name);
    if (match === undefined) {
      // No exact, case-sensitive match: unmatched indication, no overlay.
      return {
        id: node.id,
        name: node.name,
        matched: false,
        status: null,
        task: null,
      };
    }
    return {
      id: node.id,
      name: node.name,
      matched: true,
      status: match.status ?? null,
      task: match,
    };
  });

  return {
    kind: 'True_DAG',
    nodes,
    // Edges are carried through unchanged; the overlay only affects nodes.
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  };
}
