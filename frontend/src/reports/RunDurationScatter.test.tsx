import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RunDurationScatter, { renderScatterTooltip } from './RunDurationScatter';
import type { ScatterDatum } from './runScatter';

// jsdom reports a zero-size layout, so Recharts' ResponsiveContainer renders no
// SVG under test. Mock it to a fixed-size div so the inner ScatterChart lays
// out and the sr-only open-run buttons (the data-path proxy for markers)
// render. The tooltip renderer is tested directly (Recharts tooltips need
// pointer + layout that jsdom lacks).
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 280 }}>{children}</div>
    ),
  };
});

const POINTS: ScatterDatum[] = [
  { runId: 'run-fast', x: Date.parse('2024-01-02T10:00:00.000Z'), y: 10, status: 'COMPLETED' },
  { runId: 'run-mid', x: Date.parse('2024-01-02T11:00:00.000Z'), y: 20, status: 'COMPLETED' },
  { runId: 'run-slow', x: Date.parse('2024-01-02T12:00:00.000Z'), y: 30, status: 'FAILED' },
];

describe('RunDurationScatter', () => {
  it('renders one open-run affordance per plottable run (data-path proxy for markers)', () => {
    render(<RunDurationScatter points={POINTS} onOpenRun={vi.fn()} />);
    const buttons = screen.getAllByTestId('run-scatter-sr-open');
    expect(buttons).toHaveLength(POINTS.length);
    expect(screen.queryByTestId('run-scatter-empty')).not.toBeInTheDocument();
  });

  it('tooltip renderer surfaces the runId, shared-formatter duration, and status', () => {
    const el = renderScatterTooltip({
      active: true,
      payload: [{ payload: { runId: 'run-x', x: 0, y: 30, status: 'FAILED' } }],
    });
    render(<div>{el}</div>);
    const tip = screen.getByTestId('run-scatter-tooltip');
    expect(tip).toHaveTextContent('run-x');
    // 30 minutes => 0:30:00 via the shared formatter.
    expect(tip).toHaveTextContent('0:30:00');
    expect(tip).toHaveTextContent('FAILED');
  });

  it('tooltip renderer returns null when inactive or payload is empty', () => {
    expect(renderScatterTooltip({ active: false, payload: [] })).toBeNull();
    expect(renderScatterTooltip({ active: true, payload: [] })).toBeNull();
    expect(renderScatterTooltip({ active: true })).toBeNull();
  });

  it('activating a run opens it with that run exact runId', () => {
    const onOpenRun = vi.fn();
    render(<RunDurationScatter points={POINTS} onOpenRun={onOpenRun} />);
    const slow = screen
      .getAllByTestId('run-scatter-sr-open')
      .find((b) => b.textContent?.includes('run-slow'));
    expect(slow).toBeDefined();
    fireEvent.click(slow!);
    expect(onOpenRun).toHaveBeenCalledWith('run-slow');
  });

  it('renders the empty affordance and no markers when there are zero plottable runs', () => {
    render(<RunDurationScatter points={[]} onOpenRun={vi.fn()} />);
    expect(screen.getByTestId('run-scatter-empty')).toHaveTextContent(
      'No timed runs to plot.',
    );
    expect(screen.queryByTestId('run-scatter-sr-open')).not.toBeInTheDocument();
  });
});
