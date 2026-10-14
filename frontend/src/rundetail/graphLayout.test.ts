import { describe, it, expect } from 'vitest';
import type { Node } from 'reactflow';
import {
  buildInferredDagFlow,
  buildTrueDagFlow,
  continuationCueId,
  CUE_COLUMN_INDEX,
  type BandContinuationNodeData,
  type TaskNodeData,
} from './graphLayout';
import { matchNodeIds } from './nodeSearch';
import { buildInferredDagOrdering } from '../taskview/inferredDag';
import { buildTrueDagOverlay } from '../taskview/trueDag';
import type { StaticGraph } from '../taskview/types';
import type { Task } from '../api/types';

function task(partial: Partial<Task> & { taskId: string }): Task {
  return { runId: 'r', updatedAt: 'x', ...partial };
}

/** Narrow a mixed Inferred_DAG node list to the TASK nodes (drop cue nodes). */
function taskNodes(
  nodes: Node<TaskNodeData | BandContinuationNodeData>[],
): Node<TaskNodeData>[] {
  return nodes.filter(
    (n): n is Node<TaskNodeData> => n.type !== 'bandContinuation',
  );
}

/** The CUE nodes in a mixed Inferred_DAG node list. */
function cueNodes(
  nodes: Node<TaskNodeData | BandContinuationNodeData>[],
): Node<BandContinuationNodeData>[] {
  return nodes.filter(
    (n): n is Node<BandContinuationNodeData> => n.type === 'bandContinuation',
  );
}

// Grid constants mirrored from graphLayout.ts (kept in sync via the exported
// CUE_COLUMN_INDEX). COL_GAP/ROW_GAP are internal to the layout; the expected
// cue/task geometry below is computed from these same values.
const COL_GAP = 192;
const ROW_GAP = 62;
const MAX_COLS = 8;

function graph(nodes: { id: string; name: string }[], edges: { from: string; to: string }[] = []): StaticGraph {
  return { workflowId: 'wf-1', nodes, edges };
}

describe('buildInferredDagFlow', () => {
  it('draws NO edges (inferred timing order is not a dependency)', () => {
    const tasks: Task[] = [
      task({ taskId: 'a', status: 'COMPLETED', startedAt: '2024-01-01T00:00:00Z', stoppedAt: '2024-01-01T00:01:00Z' }),
      task({ taskId: 'b', status: 'COMPLETED', startedAt: '2024-01-01T00:02:00Z', stoppedAt: '2024-01-01T00:03:00Z' }),
    ];
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks));
    expect(flow.edges).toHaveLength(0);
    expect(flow.nodes).toHaveLength(2);
  });

  it('wraps a very wide level into a grid instead of one huge row', () => {
    // 20 tasks that all overlap in time -> one inferred level. It must wrap so
    // the canvas isn't tens of thousands of pixels wide.
    const base = new Date('2024-01-01T00:00:00Z').getTime();
    const tasks: Task[] = Array.from({ length: 20 }, (_, i) =>
      task({
        taskId: `t${i}`,
        status: 'COMPLETED',
        // All start at the same instant so they group into a single level.
        startedAt: new Date(base).toISOString(),
        stoppedAt: new Date(base + 60_000).toISOString(),
      }),
    );
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks));
    const tnodes = taskNodes(flow.nodes);
    expect(tnodes).toHaveLength(20);
    expect(flow.edges).toHaveLength(0);
    // Grid capped at 8 columns * 168px spacing -> width well under a huge line.
    const xs = tnodes.map((n) => n.position.x);
    const width = Math.max(...xs) - Math.min(...xs);
    expect(width).toBeLessThanOrEqual(8 * 168);
    // More than one distinct row (y) is used.
    const ys = new Set(tnodes.map((n) => n.position.y));
    expect(ys.size).toBeGreaterThan(1);
  });

  it('includes still-untimed (STARTING) tasks so a live run shows all tasks', () => {
    const tasks: Task[] = [
      task({ taskId: 'done', status: 'COMPLETED', startedAt: '2024-01-01T00:00:00Z', stoppedAt: '2024-01-01T00:01:00Z' }),
      task({ taskId: 'starting1', status: 'STARTING', startedAt: null }),
      task({ taskId: 'starting2', status: 'STARTING', startedAt: null }),
    ];
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks));
    const ids = flow.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['done', 'starting1', 'starting2']);
    // Untimed tasks are positioned in a trailing row (higher y) than the timed one.
    const doneY = flow.nodes.find((n) => n.id === 'done')!.position.y;
    const startingY = flow.nodes.find((n) => n.id === 'starting1')!.position.y;
    expect(startingY).toBeGreaterThan(doneY);
  });
});

describe('buildInferredDagFlow row-continuation cue', () => {
  // Build N tasks that ALL overlap in time so they collapse into a single
  // inferred level (one concurrency band), as in the "wraps a very wide level"
  // test. This is the setup that forces wrapping within one level.
  function singleLevel(n: number): Task[] {
    const base = new Date('2024-01-01T00:00:00Z').getTime();
    return Array.from({ length: n }, (_, i) =>
      task({
        taskId: `t${i}`,
        name: `task_${i}`,
        status: 'COMPLETED',
        startedAt: new Date(base).toISOString(),
        stoppedAt: new Date(base + 60_000).toISOString(),
      }),
    );
  }

  it('adds NO cue for a single-row level (N <= 8)', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(singleLevel(5)));
    expect(cueNodes(flow.nodes)).toHaveLength(0);
    // Task set is intact.
    expect(taskNodes(flow.nodes)).toHaveLength(5);
  });

  it('adds exactly ONE cue (row 0, not the last row) for 9 tasks (8,1)', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(singleLevel(9)));
    const cues = cueNodes(flow.nodes);
    expect(cues).toHaveLength(1);
    // The single inferred level has order 0.
    expect(cues[0].id).toBe(continuationCueId(0, 0));
    // No cue on the final row (row 1).
    expect(cues.some((c) => c.id === continuationCueId(0, 1))).toBe(false);
  });

  it('adds exactly TWO cues (rows 0,1; none on row 2) for 20 tasks (8,8,4)', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(singleLevel(20)));
    const cues = cueNodes(flow.nodes);
    expect(cues.map((c) => c.id).sort()).toEqual([
      continuationCueId(0, 0),
      continuationCueId(0, 1),
    ]);
    // None on the last row (row 2).
    expect(cues.some((c) => c.id === continuationCueId(0, 2))).toBe(false);
  });

  it('cue count across levels = sum of max(0, ceil(count/8) - 1)', () => {
    // Two disjoint time windows -> two distinct levels: 9 tasks early, 20 later.
    const early = new Date('2024-01-01T00:00:00Z').getTime();
    const late = new Date('2024-01-01T01:00:00Z').getTime();
    const tasks: Task[] = [
      ...Array.from({ length: 9 }, (_, i) =>
        task({
          taskId: `e${i}`,
          name: `early_${i}`,
          status: 'COMPLETED',
          startedAt: new Date(early).toISOString(),
          stoppedAt: new Date(early + 60_000).toISOString(),
        }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        task({
          taskId: `l${i}`,
          name: `late_${i}`,
          status: 'COMPLETED',
          startedAt: new Date(late).toISOString(),
          stoppedAt: new Date(late + 60_000).toISOString(),
        }),
      ),
    ];
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks));
    // ceil(9/8)-1 = 1, ceil(20/8)-1 = 2 -> 3 cues total.
    expect(cueNodes(flow.nodes)).toHaveLength(3);
    expect(taskNodes(flow.nodes)).toHaveLength(29);
  });

  it('task node set is unchanged and cue ids are a disjoint, namespaced set', () => {
    const input = singleLevel(20);
    const flow = buildInferredDagFlow(buildInferredDagOrdering(input));
    const taskIds = taskNodes(flow.nodes)
      .map((n) => n.id)
      .sort();
    const expectedIds = input.map((t) => t.taskId).sort();
    expect(taskIds).toEqual(expectedIds);

    const cueIds = cueNodes(flow.nodes).map((n) => n.id);
    // Every cue id is namespaced and shares nothing with the task ids.
    expect(cueIds.every((id) => id.startsWith('__cont__'))).toBe(true);
    expect(cueIds.some((id) => taskIds.includes(id))).toBe(false);
  });

  it('cue nodes are non-selectable and invisible to node search', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(singleLevel(20)));
    const cues = cueNodes(flow.nodes);
    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) {
      expect(cue.selectable).toBe(false);
      // No `label` field at all -> search can never match it.
      expect('label' in cue.data).toBe(false);
    }
    // A search over ONLY the cue nodes finds nothing, regardless of the query.
    expect(matchNodeIds(cues, 'task').size).toBe(0);
    expect(matchNodeIds(cues, '__cont__').size).toBe(0);
  });

  it('places each cue in the column-8 lane with y matching its row', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(singleLevel(20)));
    const tnodes = taskNodes(flow.nodes);
    const cues = cueNodes(flow.nodes);
    const expectedX =
      CUE_COLUMN_INDEX * COL_GAP - ((MAX_COLS - 1) * COL_GAP) / 2;
    for (const cue of cues) {
      expect(cue.position.x).toBe(expectedX);
    }
    // Row 0 cue y matches a row-0 task; row 1 cue y matches a row-1 task.
    const cue0 = cues.find((c) => c.id === continuationCueId(0, 0))!;
    const cue1 = cues.find((c) => c.id === continuationCueId(0, 1))!;
    const row0TaskY = tnodes.find((n) => n.id === 't0')!.position.y; // row 0
    const row1TaskY = tnodes.find((n) => n.id === 't8')!.position.y; // row 1
    expect(cue0.position.y).toBe(row0TaskY);
    expect(cue1.position.y).toBe(row1TaskY);
    // The lane is constant across wrapped rows (same x), reading as a vertical
    // lane; only y differs.
    expect(cue0.position.x).toBe(cue1.position.x);
    expect(cue1.position.y).toBeGreaterThan(cue0.position.y);
  });

  it('does NOT shift task positions horizontally (guard vs. the cue existing)', () => {
    // Expected task geometry from the UNCHANGED task formula:
    //   col = i % 8, row = floor(i / 8)
    //   full rows (0,1) have 8 items -> rowWidth = 7 * COL_GAP, centered on 0
    //   last row (row 2) has 4 items -> rowWidth = 3 * COL_GAP
    //   x = col * COL_GAP - rowWidth / 2 ; y = row * ROW_GAP (level starts at y=0)
    const flow = buildInferredDagFlow(buildInferredDagOrdering(singleLevel(20)));
    const tnodes = taskNodes(flow.nodes);

    function expectedTaskPos(i: number): { x: number; y: number } {
      const cols = MAX_COLS; // 20 > 8 -> cols capped at 8
      const row = Math.floor(i / cols);
      const col = i % cols;
      const isLastRow = row === Math.floor((20 - 1) / cols);
      const itemsInRow = isLastRow ? 20 - row * cols : cols;
      const rowWidth = (itemsInRow - 1) * COL_GAP;
      return { x: col * COL_GAP - rowWidth / 2, y: row * ROW_GAP };
    }

    for (let i = 0; i < 20; i += 1) {
      const node = tnodes.find((n) => n.id === `t${i}`)!;
      expect(node.position).toEqual(expectedTaskPos(i));
    }
  });
});

describe('buildInferredDagFlow slowest-node highlight (Req 3.6)', () => {
  const tasks: Task[] = [
    task({ taskId: 'a', status: 'COMPLETED', startedAt: '2024-01-01T00:00:00Z', stoppedAt: '2024-01-01T00:01:00Z' }),
    task({ taskId: 'b', status: 'COMPLETED', startedAt: '2024-01-01T00:02:00Z', stoppedAt: '2024-01-01T00:05:00Z' }),
  ];

  it('highlights exactly the node whose taskId is passed as slowestTaskId', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks), 'b');
    const highlighted = taskNodes(flow.nodes).filter((n) => n.data.highlighted);
    expect(highlighted.map((n) => n.id)).toEqual(['b']);
    // Every other node is not highlighted.
    expect(taskNodes(flow.nodes).find((n) => n.id === 'a')!.data.highlighted).toBe(false);
  });

  it('highlights no node when slowestTaskId is null', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks), null);
    expect(taskNodes(flow.nodes).some((n) => n.data.highlighted)).toBe(false);
  });

  it('highlights no node when slowestTaskId is undefined (omitted)', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks));
    expect(taskNodes(flow.nodes).some((n) => n.data.highlighted)).toBe(false);
  });

  it('highlights no node when slowestTaskId matches no task', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks), 'does-not-exist');
    expect(taskNodes(flow.nodes).some((n) => n.data.highlighted)).toBe(false);
  });
});

describe('buildTrueDagFlow slowest-node highlight (Req 3.6)', () => {
  // A True_DAG node's own id is a definition-internal id, so the slowest task is
  // matched via the matched task's taskId, not the node id.
  const g = graph(
    [
      { id: 'n0', name: 'align' },
      { id: 'n1', name: 'call_variants' },
    ],
    [{ from: 'n0', to: 'n1' }],
  );
  const alignTask = task({ taskId: 'task-align', name: 'align', status: 'COMPLETED' });
  const callTask = task({ taskId: 'task-call', name: 'call_variants', status: 'COMPLETED' });
  const overlay = buildTrueDagOverlay(g, [alignTask, callTask]);

  it('highlights the node whose matched task has the slowest taskId', () => {
    const flow = buildTrueDagFlow(overlay, 'task-call');
    const highlighted = flow.nodes.filter((n) => n.data.highlighted);
    // Node id is the definition-internal id (n1), matched via task taskId.
    expect(highlighted.map((n) => n.id)).toEqual(['n1']);
    expect(flow.nodes.find((n) => n.id === 'n0')!.data.highlighted).toBe(false);
  });

  it('highlights no node when slowestTaskId is null', () => {
    const flow = buildTrueDagFlow(overlay, null);
    expect(flow.nodes.some((n) => n.data.highlighted)).toBe(false);
  });

  it('highlights no node when slowestTaskId is undefined (omitted)', () => {
    const flow = buildTrueDagFlow(overlay);
    expect(flow.nodes.some((n) => n.data.highlighted)).toBe(false);
  });

  it('highlights no node when the slowest taskId does not match any matched task', () => {
    const flow = buildTrueDagFlow(overlay, 'task-missing');
    expect(flow.nodes.some((n) => n.data.highlighted)).toBe(false);
  });

  it('does not highlight an unmatched node (no matched task to carry a taskId)', () => {
    // 'call_variants' has no live task, so it is unmatched (task === null) and
    // can never be flagged the slowest even if its would-be id were passed.
    const partialOverlay = buildTrueDagOverlay(g, [alignTask]);
    const flow = buildTrueDagFlow(partialOverlay, 'task-call');
    expect(flow.nodes.some((n) => n.data.highlighted)).toBe(false);
  });
});
