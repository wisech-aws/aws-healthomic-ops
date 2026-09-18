import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Node } from 'reactflow';
import App, { Dashboard } from './App';

// Capture the props Cloudscape's AppLayout receives so the shell's split-panel
// slot can be asserted directly (does AppLayout get a `splitPanel` node and
// `splitPanelOpen`?). The mock is a pass-through: it still renders
// `breadcrumbs`, `content`, and — when open — `splitPanel`, so the existing
// content-oriented tests below keep working against it.
const appLayoutProps: Array<Record<string, unknown>> = [];
vi.mock('@cloudscape-design/components/app-layout', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    appLayoutProps.push(props);
    return (
      <div data-testid="app-layout">
        <div data-testid="app-layout-breadcrumbs">
          {props.breadcrumbs as React.ReactNode}
        </div>
        <div data-testid="app-layout-content">
          {props.content as React.ReactNode}
        </div>
        {props.splitPanelOpen ? (
          <div data-testid="app-layout-split-panel">
            {props.splitPanel as React.ReactNode}
          </div>
        ) : null}
      </div>
    );
  },
}));

/** The props from the most recent AppLayout render. */
function lastAppLayoutProps(): Record<string, unknown> {
  return appLayoutProps[appLayoutProps.length - 1];
}

// App renders FleetView and (on selection) RunDetailView. Mock the client so no
// live AppSync config is needed, and mock reactflow so the DAG renders headless
// in jsdom.
vi.mock('./api/client', () => ({
  listRuns: vi.fn().mockResolvedValue({
    items: [
      {
        runId: 'run-1',
        status: 'RUNNING',
        name: 'my-run',
        workflowName: 'my-workflow',
        startedAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        runId: 'run-2',
        status: 'RUNNING',
        name: 'other-run',
        workflowName: 'my-workflow',
        startedAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
    nextToken: null,
  }),
  getRun: vi.fn().mockResolvedValue({
    runId: 'run-1',
    status: 'RUNNING',
    name: 'my-run',
    startedAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }),
  listTasksForRun: vi
    .fn()
    .mockResolvedValue([
      {
        runId: 'run-1',
        taskId: 't1',
        name: 'align',
        status: 'RUNNING',
        startedAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]),
  getStaticGraph: vi.fn().mockResolvedValue(null),
  getRunMetrics: vi
    .fn()
    .mockResolvedValue({ runId: 'run-1', window: null, series: [], error: null }),
  getRunCostEstimate: vi.fn().mockResolvedValue({
    runId: 'run-1',
    lineItems: [],
    total: null,
    currency: null,
    effectiveDate: null,
    partial: false,
    error: null,
  }),
  getErrorExcerpt: vi
    .fn()
    .mockResolvedValue({ found: false, lines: [], truncated: false }),
  onRunUpdated: vi.fn(() => ({ unsubscribe: () => {} })),
  onTaskUpdated: vi.fn(() => ({ unsubscribe: () => {} })),
}));

vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({ nodes }: { nodes: Node[] }) => (
    <div data-testid="reactflow">{nodes.length} nodes</div>
  ),
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));
vi.mock('reactflow/dist/style.css', () => ({}));

// Keep Amplify out of the component tests: mock the config so mock-mode is off
// (we exercise the Dashboard directly) and configureAmplify is a no-op.
vi.mock('./api/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/config')>();
  return {
    ...actual,
    isLocalMockMode: () => false,
    configureAmplify: vi.fn().mockResolvedValue(undefined),
  };
});

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appLayoutProps.length = 0;
  });

  it('renders the dashboard title and the fleet view', async () => {
    render(<Dashboard />);
    // The dashboard title is the Cloudscape TopNavigation identity, not an
    // <h1>; assert it is present by text.
    expect(
      screen.getAllByText(/healthomics workflow dashboard/i).length,
    ).toBeGreaterThan(0);
    expect((await screen.findAllByText('my-workflow')).length).toBeGreaterThanOrEqual(1);
  });

  it('opens the run detail task diagram when a run is selected, and navigates back', async () => {
    render(<Dashboard />);

    // Select the run from the fleet. The workflow cell is a Cloudscape Link.
    const link = await screen.findByRole('link', { name: /view run my-run/i });
    fireEvent.click(link);

    // Run detail view with the task graph appears (layer indicator + graph).
    await screen.findByTestId('layer-indicator');
    await waitFor(() =>
      expect(screen.getByTestId('reactflow')).toBeInTheDocument(),
    );

    // Back returns to the fleet.
    fireEvent.click(screen.getByRole('button', { name: /back to fleet/i }));
    expect((await screen.findAllByText('my-workflow')).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId('layer-indicator')).not.toBeInTheDocument();
  });

  it('gates the app behind a Cognito sign-in against a real backend', async () => {
    // App (not Dashboard) wraps the UI in the Amplify Authenticator when not in
    // mock mode, so an unauthenticated render shows the sign-in form rather than
    // the fleet table.
    render(<App />);
    // The Authenticator renders a Sign in affordance; the fleet table is not
    // shown until authenticated.
    expect(
      await screen.findByRole('button', { name: /sign in/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('Dashboard split-panel slot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appLayoutProps.length = 0;
  });

  it('renders the fleet view with no split panel', async () => {
    render(<Dashboard />);
    // Fleet is the default view and supplies nothing to the slot.
    expect((await screen.findAllByText('my-workflow')).length).toBeGreaterThanOrEqual(1);

    const props = lastAppLayoutProps();
    // "No split panel": the shell hands AppLayout a falsy node and a closed
    // (falsy) open flag and registers no toggle — exactly as before the slot
    // existed. Cloudscape renders no panel for these.
    expect(props.splitPanel).toBeFalsy();
    expect(props.splitPanelOpen).toBeFalsy();
    expect(props.onSplitPanelToggle).toBeUndefined();
    expect(
      screen.queryByTestId('app-layout-split-panel'),
    ).not.toBeInTheDocument();
  });

  it('renders the params compare view with no split panel', async () => {
    render(<Dashboard />);
    await screen.findAllByText('my-workflow');

    // Select exactly two runs and open the parameters comparison. FleetView
    // shows the compare affordance because the shell supplies `onCompareRuns`,
    // and enables it once two runs are checked. Target the per-row selection
    // checkboxes by their accessible names (two runs are seeded in the mock).
    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: /select run my-run for comparison/i,
      }),
    );
    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: /select run other-run for comparison/i,
      }),
    );

    const compareButton = await screen.findByTestId('fleet-compare-button');
    await waitFor(() => expect(compareButton).not.toBeDisabled());
    fireEvent.click(compareButton);

    // The params diff view is now active (breadcrumb "Compare parameters").
    expect(
      (await screen.findAllByText(/compare parameters/i)).length,
    ).toBeGreaterThan(0);

    const props = lastAppLayoutProps();
    // The params view supplies nothing to the slot, so AppLayout gets no panel.
    expect(props.splitPanel).toBeFalsy();
    expect(props.splitPanelOpen).toBeFalsy();
    expect(props.onSplitPanelToggle).toBeUndefined();
    expect(
      screen.queryByTestId('app-layout-split-panel'),
    ).not.toBeInTheDocument();
  });

  it('forwards a supplied splitPanel node and open state to AppLayout', async () => {
    const panel = <div data-testid="my-flyout">flyout body</div>;
    const onToggle = vi.fn();
    render(
      <Dashboard
        splitPanel={panel}
        splitPanelOpen
        onSplitPanelToggle={onToggle}
      />,
    );

    await screen.findAllByText('my-workflow');

    const props = lastAppLayoutProps();
    // AppLayout receives the exact node and the open flag the caller supplied.
    expect(props.splitPanel).toBe(panel);
    expect(props.splitPanelOpen).toBe(true);
    // A toggle handler is wired through (AppLayout gets a function, not the raw
    // callback — the shell adapts the Cloudscape event shape).
    expect(typeof props.onSplitPanelToggle).toBe('function');
    // The panel body is rendered because it is open.
    expect(screen.getByTestId('my-flyout')).toBeInTheDocument();
  });

  it('does not render the split-panel body when splitPanelOpen is false', async () => {
    const panel = <div data-testid="my-flyout">flyout body</div>;
    render(<Dashboard splitPanel={panel} splitPanelOpen={false} />);

    await screen.findAllByText('my-workflow');

    const props = lastAppLayoutProps();
    // The node is still handed to AppLayout, but it is closed.
    expect(props.splitPanel).toBe(panel);
    expect(props.splitPanelOpen).toBe(false);
    expect(screen.queryByTestId('my-flyout')).not.toBeInTheDocument();
  });

  it('adapts AppLayout toggle events to the onSplitPanelToggle open boolean', async () => {
    const onToggle = vi.fn();
    render(
      <Dashboard
        splitPanel={<div>flyout</div>}
        splitPanelOpen
        onSplitPanelToggle={onToggle}
      />,
    );

    await screen.findAllByText('my-workflow');

    const props = lastAppLayoutProps();
    const handler = props.onSplitPanelToggle as (event: {
      detail: { open: boolean };
    }) => void;
    // The shell unwraps `event.detail.open` before calling the caller's toggle.
    handler({ detail: { open: false } });
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});
