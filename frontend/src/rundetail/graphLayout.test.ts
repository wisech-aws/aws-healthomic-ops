import { describe, it, expect } from 'vitest';
import { buildInferredDagFlow, buildTrueDagFlow } from './graphLayout';
import { buildInferredDagOrdering } from '../taskview/inferredDag';
import { buildTrueDagOverlay } from '../taskview/trueDag';
import type { StaticGraph } from '../taskview/types';
import type { Task } from '../api/types';

function task(partial: Partial<Task> & { taskId: string }): Task {
  return { runId: 'r', updatedAt: 'x', ...partial };
}

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
    expect(flow.nodes).toHaveLength(20);
    expect(flow.edges).toHaveLength(0);
    // Grid capped at 8 columns * 168px spacing -> width well under a huge line.
    const xs = flow.nodes.map((n) => n.position.x);
    const width = Math.max(...xs) - Math.min(...xs);
    expect(width).toBeLessThanOrEqual(8 * 168);
    // More than one distinct row (y) is used.
    const ys = new Set(flow.nodes.map((n) => n.position.y));
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

describe('buildInferredDagFlow slowest-node highlight (Req 3.6)', () => {
  const tasks: Task[] = [
    task({ taskId: 'a', status: 'COMPLETED', startedAt: '2024-01-01T00:00:00Z', stoppedAt: '2024-01-01T00:01:00Z' }),
    task({ taskId: 'b', status: 'COMPLETED', startedAt: '2024-01-01T00:02:00Z', stoppedAt: '2024-01-01T00:05:00Z' }),
  ];

  it('highlights exactly the node whose taskId is passed as slowestTaskId', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks), 'b');
    const highlighted = flow.nodes.filter((n) => n.data.highlighted);
    expect(highlighted.map((n) => n.id)).toEqual(['b']);
    // Every other node is not highlighted.
    expect(flow.nodes.find((n) => n.id === 'a')!.data.highlighted).toBe(false);
  });

  it('highlights no node when slowestTaskId is null', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks), null);
    expect(flow.nodes.some((n) => n.data.highlighted)).toBe(false);
  });

  it('highlights no node when slowestTaskId is undefined (omitted)', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks));
    expect(flow.nodes.some((n) => n.data.highlighted)).toBe(false);
  });

  it('highlights no node when slowestTaskId matches no task', () => {
    const flow = buildInferredDagFlow(buildInferredDagOrdering(tasks), 'does-not-exist');
    expect(flow.nodes.some((n) => n.data.highlighted)).toBe(false);
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
