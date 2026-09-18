import { describe, it, expect } from 'vitest';
import { selectLayer } from './selectLayer';
import { makeTask } from './testFactories';
import type { StaticGraph } from './types';

const nonEmptyGraph: StaticGraph = {
  workflowId: 'wf-1',
  nodes: [{ id: 'n0', name: 'a' }],
  edges: [],
};

const emptyGraph: StaticGraph = { workflowId: 'wf-1', nodes: [], edges: [] };

describe('selectLayer', () => {
  it('selects True_DAG when a non-empty static graph exists', () => {
    expect(selectLayer(nonEmptyGraph, [makeTask({ startedAt: null })])).toBe('True_DAG');
  });

  it('prefers True_DAG even when timing data is present', () => {
    expect(selectLayer(nonEmptyGraph, [makeTask({ startedAt: '2024-01-01T00:00:00Z' })])).toBe(
      'True_DAG',
    );
  });

  it('selects Inferred_DAG when no graph but timing data exists', () => {
    expect(selectLayer(null, [makeTask({ startedAt: '2024-01-01T00:00:00Z' })])).toBe(
      'Inferred_DAG',
    );
  });

  it('selects Inferred_DAG when there are tasks but none are timed yet', () => {
    // A live run whose tasks are all STARTING/PENDING (no start time yet) still
    // renders as a structured DAG (untimed tasks in a trailing level) rather
    // than degrading to the flat Timeline with "ordering unavailable".
    expect(selectLayer(null, [makeTask({ startedAt: null })])).toBe('Inferred_DAG');
  });

  it('selects Inferred_DAG for a partially-timed live run', () => {
    // Mirrors a real mid-run nf-core snapshot: some COMPLETED (timed) tasks and
    // several STARTING (untimed) tasks. Must be a DAG, not Timeline.
    expect(
      selectLayer(null, [
        makeTask({ status: 'COMPLETED', startedAt: '2024-01-01T00:00:00Z' }),
        makeTask({ status: 'STARTING', startedAt: null }),
        makeTask({ status: 'STARTING', startedAt: null }),
      ]),
    ).toBe('Inferred_DAG');
  });

  it('selects Timeline_View only when there are no tasks at all', () => {
    expect(selectLayer(null, [])).toBe('Timeline_View');
    expect(selectLayer(undefined, [])).toBe('Timeline_View');
  });

  it('treats an empty static graph as no graph and still shows a DAG for tasks', () => {
    expect(selectLayer(emptyGraph, [makeTask({ startedAt: '2024-01-01T00:00:00Z' })])).toBe(
      'Inferred_DAG',
    );
    expect(selectLayer(emptyGraph, [makeTask({ startedAt: null })])).toBe('Inferred_DAG');
  });
});
