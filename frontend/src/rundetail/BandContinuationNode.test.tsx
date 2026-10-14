import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import BandContinuationNode from './BandContinuationNode';
import type { BandContinuationNodeData } from './graphLayout';

// Mirror TaskNode.test.tsx: stub reactflow so the node renders in isolation
// without a ReactFlowProvider. (BandContinuationNode does not import Handle, so
// this is belt-and-suspenders.)
vi.mock('reactflow', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

function renderNode(data: BandContinuationNodeData) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<BandContinuationNode data={data} {...({} as any)} />);
}

describe('BandContinuationNode', () => {
  it('renders the ↩ glyph with an accessible label', () => {
    renderNode({ aria: 'band continues on next row' });
    const node = screen.getByTestId('band-continuation');
    expect(node).toHaveTextContent('↩');
    // Accessible name lives on the role="img" container.
    const labelled = screen.getByRole('img', {
      name: 'band continues on next row',
    });
    expect(labelled).toBe(node);
  });

  it('is non-interactive and non-selectable (pointer-events: none, no button/link)', () => {
    renderNode({ aria: 'band continues on next row' });
    const node = screen.getByTestId('band-continuation');
    expect(node).toHaveStyle({ pointerEvents: 'none' });
    // No interactive affordance is rendered.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
