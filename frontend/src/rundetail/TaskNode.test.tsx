import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskNode from './TaskNode';
import type { TaskNodeData } from './graphLayout';

// React Flow's Handle needs a flow context; stub Handle/Position so TaskNode
// can render in isolation without a ReactFlowProvider.
vi.mock('reactflow', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

function data(overrides: Partial<TaskNodeData> = {}): TaskNodeData {
  return {
    label: 'align_reads_and_sort_by_coordinate',
    status: 'COMPLETED',
    color: '#1f883d',
    matched: true,
    highlighted: false,
    ...overrides,
  };
}

// Minimal NodeProps shim — TaskNode only reads `data`.
function renderNode(d: TaskNodeData) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<TaskNode data={d} {...({} as any)} />);
}

describe('TaskNode hover tooltip', () => {
  it('shows the full task name in a tooltip on hover and hides it on leave', () => {
    renderNode(data({ label: 'a_very_long_task_name_that_truncates' }));
    const node = screen.getByTestId('task-node');

    // No tooltip until hovered.
    expect(screen.queryByTestId('task-node-tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(node);
    const tip = screen.getByTestId('task-node-tooltip');
    expect(tip).toHaveTextContent('a_very_long_task_name_that_truncates');
    expect(tip).toHaveAttribute('role', 'tooltip');

    fireEvent.mouseLeave(node);
    expect(screen.queryByTestId('task-node-tooltip')).not.toBeInTheDocument();
  });

  it('reflects search-match and dimmed data flags', () => {
    renderNode(data({ searchMatch: true, dimmed: false }));
    expect(screen.getByTestId('task-node')).toHaveAttribute(
      'data-search-match',
      'true',
    );
    expect(screen.getByTestId('task-node')).toHaveAttribute('data-dimmed', 'false');
  });
});
