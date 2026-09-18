import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildTrueDagOverlay } from './trueDag';
import { makeTask, TASK_STATUSES } from './testFactories';
import type { StaticGraph } from './types';
import type { TaskStatus } from '../api/types';

function graph(names: string[]): StaticGraph {
  return {
    workflowId: 'wf-1',
    nodes: names.map((name, i) => ({ id: `n${i}`, name })),
    edges: [],
  };
}

describe('buildTrueDagOverlay (Req 6.10, 6.11)', () => {
  it('overlays the matched task status onto an exactly-named node', () => {
    const g = graph(['align']);
    const task = makeTask({ name: 'align', status: 'RUNNING' });
    const overlay = buildTrueDagOverlay(g, [task]);
    expect(overlay.kind).toBe('True_DAG');
    expect(overlay.nodes).toHaveLength(1);
    expect(overlay.nodes[0]).toMatchObject({
      name: 'align',
      matched: true,
      status: 'RUNNING',
    });
    expect(overlay.nodes[0].task).toBe(task);
  });

  it('flags an unmatched node with no status overlay (Req 6.11)', () => {
    const g = graph(['align', 'call_variants']);
    const overlay = buildTrueDagOverlay(g, [makeTask({ name: 'align' })]);
    const unmatched = overlay.nodes.find((n) => n.name === 'call_variants')!;
    expect(unmatched.matched).toBe(false);
    expect(unmatched.status).toBeNull();
    expect(unmatched.task).toBeNull();
  });

  it('matching is case-sensitive (Req 6.10)', () => {
    const g = graph(['Align']);
    const overlay = buildTrueDagOverlay(g, [makeTask({ name: 'align' })]);
    expect(overlay.nodes[0].matched).toBe(false);
  });

  it('carries edges through unchanged', () => {
    const g: StaticGraph = {
      workflowId: 'wf-1',
      nodes: [
        { id: 'n0', name: 'a' },
        { id: 'n1', name: 'b' },
      ],
      edges: [{ from: 'n0', to: 'n1' }],
    };
    const overlay = buildTrueDagOverlay(g, []);
    expect(overlay.edges).toEqual([{ from: 'n0', to: 'n1' }]);
  });

  it('treats a matched task with null status as matched with null overlay', () => {
    const g = graph(['a']);
    const overlay = buildTrueDagOverlay(g, [makeTask({ name: 'a', status: null })]);
    expect(overlay.nodes[0].matched).toBe(true);
    expect(overlay.nodes[0].status).toBeNull();
  });

  // Property 16: Name-based status overlay (Validates: Requirements 6.10, 6.11)
  it('Property 16: each node exactly matching a task name is overlaid with that status; unmatched nodes carry no overlay', () => {
    const statusArb = fc.constantFrom<TaskStatus>(...TASK_STATUSES);
    const nameArb = fc.string({ minLength: 1, maxLength: 6 });

    fc.assert(
      fc.property(
        fc.uniqueArray(nameArb, { minLength: 1, maxLength: 8 }),
        fc.array(fc.tuple(nameArb, statusArb), { maxLength: 8 }),
        (nodeNames, taskSpecs) => {
          const g = graph(nodeNames);
          // First task per name wins in the overlay.
          const firstStatusByName = new Map<string, TaskStatus>();
          const tasks = taskSpecs.map(([name, status]) => {
            if (!firstStatusByName.has(name)) {
              firstStatusByName.set(name, status);
            }
            return makeTask({ name, status });
          });

          const overlay = buildTrueDagOverlay(g, tasks);

          // Exactly one overlay node per graph node, order preserved.
          expect(overlay.nodes.map((n) => n.name)).toEqual(nodeNames);

          for (const node of overlay.nodes) {
            if (firstStatusByName.has(node.name)) {
              expect(node.matched).toBe(true);
              expect(node.status).toBe(firstStatusByName.get(node.name));
            } else {
              expect(node.matched).toBe(false);
              expect(node.status).toBeNull();
              expect(node.task).toBeNull();
            }
          }
        },
      ),
    );
  });
});
