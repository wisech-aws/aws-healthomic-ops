/**
 * Task-DAG layer selection (Req 7.5, 7.6, and design.md "Task DAG Rendering").
 *
 * Choose the highest-fidelity available layer:
 *   True_DAG    — when a static graph exists for the run's workflow.
 *   Inferred_DAG — else, when any task carries usable start-time data.
 *   Timeline_View — otherwise (the always-available floor).
 *
 * This module decides only WHICH layer to show; the individual layer builders
 * (`trueDag.ts`, `inferredDag.ts`, `timeline.ts`) produce the view models.
 */

import type { Task } from '../api/types';
import type { LayerKind, StaticGraph } from './types';

/** Whether a static graph is usable for a True_DAG (has at least one node). */
function hasStaticGraph(graph: StaticGraph | null | undefined): boolean {
  return graph != null && graph.nodes.length > 0;
}

/**
 * Select the highest-fidelity task-DAG layer for a run.
 *
 * @param graph The static graph for the run's workflow, or `null`/`undefined`
 *   when none is available.
 * @param tasks The run's live tasks.
 * @returns The layer to render:
 *   - `True_DAG` when a static graph is available (highest fidelity), else
 *   - `Inferred_DAG` whenever there are any tasks. The inferred builder orders
 *     timed tasks by start/overlap and groups still-untimed (PENDING/STARTING)
 *     tasks into a trailing level, so a live run that is only partially timed
 *     still renders as a structured DAG rather than degrading to the flat
 *     Timeline with an "ordering unavailable" message. Previously this required
 *     at least one *timed* task, which made an early run (all tasks STARTING
 *     with no start time yet) fall back to Timeline — confusing while a run is
 *     clearly progressing.
 *   - `Timeline_View` only as the floor when there are no tasks at all.
 */
export function selectLayer(
  graph: StaticGraph | null | undefined,
  tasks: readonly Task[],
): LayerKind {
  if (hasStaticGraph(graph)) {
    return 'True_DAG';
  }
  if (tasks.length > 0) {
    return 'Inferred_DAG';
  }
  return 'Timeline_View';
}
