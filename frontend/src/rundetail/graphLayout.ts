/**
 * DAG layout for the run detail node-edge graph (Req 9.3).
 *
 * Turns a resolved task-DAG layer (True_DAG overlay or Inferred_DAG ordering)
 * into React Flow `Node`/`Edge` arrays with automatic layout computed by dagre.
 * Kept as pure functions, separate from the React component, so the mapping
 * from layer view models to positioned nodes is testable without rendering.
 *
 * Node data carries the task's `name`, `status`, and resolved status `color`
 * (via {@link taskStatusColor}) so the renderer colors each node by its
 * `TaskStatus` (Req 9.5) and a live `onTaskUpdated` event can recolor a single
 * node by id without a page reload (Req 9.7, 9.8).
 */
import dagre from 'dagre';
import { MarkerType, Position, type Edge, type Node } from 'reactflow';
import type { RunStatus, TaskStatus } from '../api/types';
import type { InferredDagOrdering, TrueDagOverlay } from '../taskview/types';
import { runStatusColor, taskStatusColor } from '../fleet/statusColors';

/** Data attached to each React Flow node in the run detail graph. */
export interface TaskNodeData {
  readonly label: string;
  readonly status: TaskStatus | null;
  readonly color: string;
  /** Whether a static-graph node matched a live task (True_DAG only). */
  readonly matched: boolean;
  /**
   * Whether this node is the run's slowest (longest-running) task, highlighted
   * on the DAG (Req 3.6). Only one node per graph is highlighted; false when no
   * slowest task is identified.
   */
  readonly highlighted: boolean;
  /**
   * Node search state (applied by the run detail view, not the builders):
   * `searchMatch` emphasizes a node that matches the active query; `dimmed`
   * fades a node that does not match while a search is active. Both default to
   * undefined/false (no active search) so the builders and their tests are
   * unaffected.
   */
  readonly searchMatch?: boolean;
  readonly dimmed?: boolean;
  /**
   * Whether this node's task is the one currently selected for log viewing
   * (its logs panel is open). The run detail view sets this from its logs
   * selection; the node renders a distinct selection ring. Defaults to
   * undefined/false (no selection).
   */
  readonly selected?: boolean;
}

/**
 * Compact node box size fed to dagre for layout spacing. Kept small so the DAG
 * reads as a diagram of many nodes rather than a few oversized cards, and so
 * `fitView` can show the whole graph on screen.
 */
const NODE_WIDTH = 168;
const NODE_HEIGHT = 42;

/**
 * Run dagre over the given nodes/edges and return the nodes with `position`
 * assigned from the computed layout (top-to-bottom DAG layout).
 */
function layout(nodes: Node<TaskNodeData>[], edges: Edge[]): Node<TaskNodeData>[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 44, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    // dagre ignores edges referencing unknown nodes; guard anyway so a stray
    // edge never throws during layout.
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    // dagre positions are box centers; React Flow positions are top-left.
    const x = pos ? pos.x - NODE_WIDTH / 2 : 0;
    const y = pos ? pos.y - NODE_HEIGHT / 2 : 0;
    return {
      ...node,
      position: { x, y },
      // Top-to-bottom flow: edges arrive at the top handle, leave the bottom.
      targetPosition: Position.Top,
      sourcePosition: Position.Bottom,
    };
  });
}

/** Build a colored, styled React Flow node for a task. */
function makeNode(
  id: string,
  data: TaskNodeData,
): Node<TaskNodeData> {
  // The visual box is rendered by the custom `TaskNode` component (registered as
  // the 'task' node type) so it can carry a hover tooltip (full name), search
  // emphasis/dimming, and status color. Fixed width/height are still declared
  // here so dagre and the inferred-grid layout reserve the right footprint.
  return {
    id,
    type: 'task',
    data,
    position: { x: 0, y: 0 },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  };
}

/** The rendered node box dimensions, exported for the custom node component. */
export const TASK_NODE_WIDTH = NODE_WIDTH;
export const TASK_NODE_HEIGHT = NODE_HEIGHT;

/**
 * The grid column index reserved exclusively for the Inferred_DAG
 * row-continuation cue. Task nodes occupy columns 0..7 (MAX_COLS = 8); the cue
 * sits alone in column 8 so it never collides with a task. Exported so the
 * layout code and its tests share a single source of truth for the lane.
 */
export const CUE_COLUMN_INDEX = 8;

/**
 * Data attached to a band-continuation cue node. Deliberately minimal and
 * DISJOINT from {@link TaskNodeData}: it carries NO `label` (so node search —
 * which matches on `data.label` — can never match it), NO `status`, and NO
 * `color`. The only field is the accessible description of what the glyph
 * conveys.
 */
export interface BandContinuationNodeData {
  readonly aria: string;
}

/**
 * Namespaced id for a continuation-cue node. The `__cont__` prefix (mirroring
 * the existing `__initializing__` convention) plus the fact that task nodes are
 * keyed by `taskId` guarantees cue ids form a set disjoint from task ids — they
 * can never collide with a real taskId.
 */
export function continuationCueId(levelOrder: number, row: number): string {
  return `__cont__${levelOrder}__${row}`;
}

/**
 * Build positioned React Flow nodes/edges for a True_DAG overlay (Req 9.3).
 *
 * Node ids are the static-graph node ids; each node is colored by the matched
 * task's status (or the unknown color when unmatched, Req 6.11, 9.5). Edges are
 * carried through from the static graph.
 *
 * When `slowestTaskId` is provided (the run's longest-running task, Req 3.6),
 * the node whose matched task has that taskId is flagged `highlighted`. It is a
 * no-op when `slowestTaskId` is `null`/`undefined` (no node highlighted).
 */
export function buildTrueDagFlow(
  overlay: TrueDagOverlay,
  slowestTaskId?: string | null,
  selectedTaskId?: string | null,
): {
  nodes: Node<TaskNodeData>[];
  edges: Edge[];
} {
  const nodes = overlay.nodes.map((node) =>
    makeNode(node.id, {
      label: node.name,
      status: node.status,
      color: node.matched
        ? taskStatusColor(node.status)
        : taskStatusColor(null),
      matched: node.matched,
      // The slowest task is identified by its taskId; a True_DAG node's own
      // id is a definition-internal id, so match against the matched task's
      // taskId. No-op (nothing highlighted) when slowestTaskId is null/undefined.
      highlighted: slowestTaskId != null && node.task?.taskId === slowestTaskId,
      // Selection ring for the node whose logs are open (matched via taskId).
      selected: selectedTaskId != null && node.task?.taskId === selectedTaskId,
    }),
  );
  const edges: Edge[] = overlay.edges.map((edge, index) => ({
    id: `e-${edge.from}-${edge.to}-${index}`,
    source: edge.from,
    target: edge.to,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  }));
  return { nodes: layout(nodes, edges), edges };
}

/**
 * Build positioned React Flow nodes/edges for an Inferred_DAG ordering
 * (Req 9.3). Nodes are keyed by `taskId` and laid out in rows by inferred
 * concurrency level (earlier levels on top).
 *
 * IMPORTANT: the inferred ordering is derived from task START/STOP TIMING, not
 * from real data dependencies. Drawing dependency arrows between levels would
 * assert relationships that do not exist (and, for wide fan-out runs like
 * nf-core, produce an unreadable all-to-all mesh). So this layer intentionally
 * draws NO edges — it positions tasks in timing-ordered rows and lets the
 * vertical bands convey "these ran around the same time, before those below".
 * The `Inferred DAG` layer badge tells the user this is inferred. (The True_DAG
 * layer, which is edge-accurate, does draw dependency arrows.)
 *
 * Untimed tasks (still PENDING/STARTING) are grouped by the ordering builder
 * into a trailing level, so an in-flight run shows all its tasks positioned
 * after the timed ones rather than falling back to a flat list.
 *
 * When `slowestTaskId` is provided (the run's longest-running task, Req 3.6),
 * the node with that taskId is flagged `highlighted`. It is a no-op when
 * `slowestTaskId` is `null`/`undefined` (no node highlighted).
 */
export function buildInferredDagFlow(
  ordering: InferredDagOrdering,
  slowestTaskId?: string | null,
  selectedTaskId?: string | null,
): {
  nodes: Node<TaskNodeData | BandContinuationNodeData>[];
  edges: Edge[];
} {
  // Lay out timing levels top-to-bottom. A single inferred level can contain a
  // very large number of concurrent (or still-untimed) tasks — a real nf-core
  // run can have 150+ tasks in one band. Rendering those in one horizontal line
  // produces a canvas tens of thousands of pixels wide, which is unreadable, so
  // each level WRAPS into a grid capped at MAX_COLS columns. Consecutive levels
  // are separated by a gap. No edges are drawn: inferred timing order is not a
  // dependency relationship (drawing arrows would assert false dependencies and
  // create an all-to-all hairball).
  // Gaps are node-size + a gutter so the wider (168px) / taller (42px) nodes
  // keep a comfortable margin and never touch edge-to-edge in the grid.
  const COL_GAP = 192; // 168px node width + 24px horizontal gutter
  const ROW_GAP = 62; //  42px node height + 20px vertical gutter
  const LEVEL_GAP = 28; // extra vertical space between distinct timing levels
  const MAX_COLS = 8;

  const nodes: Node<TaskNodeData | BandContinuationNodeData>[] = [];
  let y = 0;

  for (const level of ordering.levels) {
    const count = level.tasks.length;
    if (count === 0) {
      continue;
    }
    const cols = Math.min(count, MAX_COLS);

    level.tasks.forEach((task, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      // Last row of the level may be partially filled; center it too.
      const isLastRow = row === Math.floor((count - 1) / cols);
      const itemsInRow = isLastRow ? count - row * cols : cols;
      const rowWidth = (itemsInRow - 1) * COL_GAP;
      const node = makeNode(task.taskId, {
        label: task.name ?? task.taskId,
        status: task.status ?? null,
        color: taskStatusColor(task.status ?? null),
        matched: true,
        // Highlight the slowest task's node (Req 3.6). No-op when null/undefined.
        highlighted: slowestTaskId != null && task.taskId === slowestTaskId,
        // Selection ring for the node whose logs are open.
        selected: selectedTaskId != null && task.taskId === selectedTaskId,
      });
      node.position = {
        x: col * COL_GAP - rowWidth / 2,
        // vertical offset within the level's own wrapped rows
        y: y + row * ROW_GAP,
      };
      nodes.push(node);
    });

    const rowsUsed = Math.ceil(count / cols);

    // Row-continuation cue (strict no-fabrication: conveys ONLY "this
    // concurrency band continues onto the next row"). A level that wraps into
    // more than one row gets a single faint `↩` in the reserved column-8 lane
    // at the right edge of every row EXCEPT the last, so the user can tell the
    // same inferred timing level continues below. Never on a single-row level
    // (rowsUsed <= 1) and never between distinct levels.
    //
    // Centering decision (documented per spec): the cue uses the centering
    // basis of the row it sits on. Every NON-FINAL wrapped row is, by
    // definition, a FULL row of MAX_COLS (8) tasks, so that row's width is
    // (MAX_COLS - 1) * COL_GAP and its tasks are centered on x = 0. Placing the
    // cue at column index CUE_COLUMN_INDEX (8) therefore means:
    //   x = CUE_COLUMN_INDEX * COL_GAP - (MAX_COLS - 1) * COL_GAP / 2
    // which is CONSTANT across all non-final rows of the level, so the cues
    // line up as a straight vertical lane just past the right-most task column.
    // Task x for columns 0..7 is unchanged (cols stays Math.min(count, 8)), so
    // tasks never shift horizontally because a cue exists.
    if (rowsUsed > 1) {
      const cueX =
        CUE_COLUMN_INDEX * COL_GAP - (MAX_COLS - 1) * COL_GAP / 2;
      for (let row = 0; row <= rowsUsed - 2; row += 1) {
        nodes.push({
          id: continuationCueId(level.order, row),
          type: 'bandContinuation',
          data: { aria: 'band continues on next row' },
          position: { x: cueX, y: y + row * ROW_GAP },
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          // Presentational decoration, not a task: React Flow must never
          // select, focus, drag, or connect it, and it carries no handles.
          selectable: false,
          focusable: false,
          draggable: false,
          connectable: false,
        });
      }
    }

    y += rowsUsed * ROW_GAP + LEVEL_GAP;
  }

  return { nodes, edges: [] };
}


/**
 * Build a single-node "Initializing" DAG for a run that has started but has not
 * yet reported any tasks (e.g. PENDING / STARTING, or RUNNING while the engine
 * stages inputs and pulls containers before the first process launches).
 *
 * This gives the run detail view a meaningful graph during the pre-task window
 * instead of an empty canvas, and it is colored by the run's own status so it
 * reads as "the run is initializing". As soon as real tasks arrive, the view
 * switches to the True/Inferred/Timeline layers built from those tasks.
 *
 * @param runStatus the run's current status, used to color the node.
 */
export function buildInitializingFlow(runStatus: RunStatus | null | undefined): {
  nodes: Node<TaskNodeData>[];
  edges: Edge[];
} {
  const node = makeNode('__initializing__', {
    label: 'Initializing…',
    // Reuse the task status slot as null so the node renders as a neutral,
    // in-progress marker; color comes from the run status below.
    status: null,
    color: runStatusColor(runStatus ?? null),
    matched: true,
    highlighted: false,
    selected: false,
  });
  return { nodes: layout([node], []), edges: [] };
}
