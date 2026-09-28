import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RunCostPanel, { explainUnavailable } from './RunCostPanel';
import type { CostLineItem, RunCostEstimate } from '../api/types';

/** A computable (priced) compute line item. */
function computeLineItem(overrides: Partial<CostLineItem> = {}): CostLineItem {
  return {
    category: 'COMPUTE',
    usageType: 'omics.c.large',
    resourceType: 'omics.c.large',
    quantity: 2,
    unit: 'instance-hrs',
    ratePerUnit: 0.1,
    estimatedCost: 0.2,
    available: true,
    unavailableReason: null,
    ...overrides,
  };
}

/** An unavailable compute line item (no published rate). */
function unavailableCompute(overrides: Partial<CostLineItem> = {}): CostLineItem {
  return {
    category: 'COMPUTE',
    usageType: 'omics.r.2xlarge',
    resourceType: 'omics.r.2xlarge',
    quantity: null,
    unit: 'instance-hrs',
    ratePerUnit: null,
    estimatedCost: null,
    available: false,
    unavailableReason: 'No published rate for omics.r.2xlarge',
    ...overrides,
  };
}

/** An unavailable DYNAMIC run-storage line item. */
function unavailableDynamicStorage(overrides: Partial<CostLineItem> = {}): CostLineItem {
  return {
    category: 'STORAGE',
    usageType: 'Dynamic Run Storage',
    resourceType: 'Dynamic Run Storage',
    quantity: null,
    unit: 'GB-Hours',
    ratePerUnit: null,
    estimatedCost: null,
    available: false,
    unavailableReason: 'Dynamic run storage usage series unavailable',
    ...overrides,
  };
}

function estimate(overrides: Partial<RunCostEstimate> = {}): RunCostEstimate {
  return {
    runId: 'r1',
    lineItems: [computeLineItem()],
    total: 0.2,
    currency: 'USD',
    effectiveDate: '2024-01-01',
    partial: false,
    error: null,
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof RunCostPanel>> = {}) {
  return render(
    <RunCostPanel
      runId="r1"
      result={estimate()}
      isLoading={false}
      onRefresh={vi.fn()}
      {...props}
    />,
  );
}

describe('RunCostPanel presentation states', () => {
  it('renders the loading state', () => {
    renderPanel({ isLoading: true });
    expect(screen.getByTestId('cost-loading')).toHaveTextContent(/estimating cost/i);
  });

  it('renders the error state with a Retry control', () => {
    const onRefresh = vi.fn();
    renderPanel({ result: estimate({ error: 'boom' }), onRefresh });
    expect(screen.getByTestId('cost-error')).toHaveTextContent('boom');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('renders the unavailable state when no line item is computable', () => {
    renderPanel({ result: estimate({ lineItems: [unavailableCompute()], total: null }) });
    expect(screen.getByTestId('cost-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('cost-ready')).not.toBeInTheDocument();
  });

  it('renders the ready state with a total row and disclaimer', () => {
    renderPanel();
    expect(screen.getByTestId('cost-ready')).toBeInTheDocument();
    expect(screen.getByTestId('cost-table')).toHaveTextContent('$0.2000');
    expect(screen.getByTestId('cost-disclaimer')).toHaveTextContent(/list-price estimate/i);
    // No partial indicator when every line item is computable.
    expect(screen.queryByTestId('cost-partial-indicator')).not.toBeInTheDocument();
  });

  it('shows the partial-total indicator when a line item is unavailable', () => {
    renderPanel({
      result: estimate({
        lineItems: [computeLineItem(), unavailableCompute()],
        partial: true,
      }),
    });
    expect(screen.getByTestId('cost-partial-indicator')).toBeInTheDocument();
  });
});

describe('RunCostPanel unavailable-cell explanation (Option A)', () => {
  it('renders "—" for a DYNAMIC storage line item and reveals the doc-informed reason', () => {
    renderPanel({
      result: estimate({
        lineItems: [computeLineItem(), unavailableDynamicStorage()],
        partial: true,
      }),
    });

    // Honest dash still present in the table.
    expect(screen.getByTestId('cost-table')).toHaveTextContent('—');

    // The reason is discoverable, not shown by default.
    expect(screen.queryByTestId('cost-unavailable-reason')).not.toBeInTheDocument();

    // Open the popover on the first unavailable info affordance.
    const triggers = screen.getAllByRole('button', { name: /why is this unavailable\?/i });
    expect(triggers.length).toBeGreaterThan(0);
    fireEvent.click(triggers[0]);

    const reason = screen.getAllByTestId('cost-unavailable-reason')[0];
    expect(reason).toHaveTextContent(/short runs \(under ~30 minutes\)/i);
    expect(reason).toHaveTextContent(/30\+ minutes/i);
    expect(reason).toHaveTextContent(/not a billing error/i);
  });

  it('surfaces the backend unavailableReason for a compute line item', () => {
    renderPanel({
      result: estimate({
        lineItems: [computeLineItem(), unavailableCompute()],
        partial: true,
      }),
    });

    const triggers = screen.getAllByRole('button', { name: /why is this unavailable\?/i });
    fireEvent.click(triggers[0]);
    expect(screen.getAllByTestId('cost-unavailable-reason')[0]).toHaveTextContent(
      'No published rate for omics.r.2xlarge',
    );
  });

  it('shows real numbers and no unavailable affordance for an available line item', () => {
    renderPanel({ result: estimate({ lineItems: [computeLineItem()] }) });
    expect(screen.getByTestId('cost-table')).toHaveTextContent('$0.2000');
    expect(
      screen.queryByRole('button', { name: /why is this unavailable\?/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('cost-unavailable-info')).not.toBeInTheDocument();
  });
});

describe('explainUnavailable', () => {
  it('returns the doc-informed message for a DYNAMIC run-storage item', () => {
    const msg = explainUnavailable(unavailableDynamicStorage());
    expect(msg).toMatch(/short runs \(under ~30 minutes\)/i);
    expect(msg).toMatch(/30\+ minutes/i);
    expect(msg).toMatch(/not a billing error/i);
  });

  it('detects DYNAMIC storage by reason alone on a null-quantity storage item', () => {
    const item = unavailableDynamicStorage({
      usageType: 'Run Storage',
      resourceType: null,
      unavailableReason: 'Dynamic run storage usage series unavailable',
    });
    expect(explainUnavailable(item)).toMatch(/short runs \(under ~30 minutes\)/i);
  });

  it('falls back to the backend reason when present', () => {
    expect(explainUnavailable(unavailableCompute())).toBe(
      'No published rate for omics.r.2xlarge',
    );
  });

  it('falls back to a generic honest message when no reason is provided', () => {
    const item = unavailableCompute({ unavailableReason: null });
    expect(explainUnavailable(item)).toMatch(/couldn't be priced/i);
    expect(explainUnavailable(item)).toMatch(/never a fabricated \$0/i);
  });
});
