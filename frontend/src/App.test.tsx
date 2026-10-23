import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Node } from 'reactflow';
import App, { Dashboard } from './App';
import { listRuns } from './api/client';
import { createFleetCache } from './fleet/fleetCache';

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

// Stub ReportsView so App-level routing tests don't stand up the real reports
// data layer. New-tab run links in the real view are plain anchors (not in-app
// nav), so the stub only needs to be a lightweight placeholder.
vi.mock('./reports/ReportsView', () => ({
  __esModule: true,
  default: () => <div data-testid="reports-view-stub" />,
}));

vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({ nodes }: { nodes: Node[] }) => (
    <div data-testid="reactflow">{nodes.length} nodes</div>
  ),
  Background: () => null,
  BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));
vi.mock('reactflow/dist/style.css', () => ({}));

// Cloudscape's SplitPanel throws ("can only be used inside app layout") when
// rendered outside a real AppLayout — which our pass-through AppLayout mock is
// not. RunDetailView wraps its logs fly-out in a SplitPanel and hands it to the
// shell slot, so stub SplitPanel to a context-free pass-through that still
// renders its header + children, letting the fly-out content be asserted.
vi.mock('@cloudscape-design/components/split-panel', () => ({
  __esModule: true,
  default: ({
    header,
    children,
  }: {
    header?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div data-testid="split-panel">
      <div data-testid="split-panel-header">{header}</div>
      <div data-testid="split-panel-body">{children}</div>
    </div>
  ),
}));

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

// ---------------------------------------------------------------------------
// QoL #3 — deep-linkable run/task URLs (History API, no router).
// ---------------------------------------------------------------------------
describe('Dashboard deep links (#3)', () => {
  const originalHash = window.location.hash;
  const historySpies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    appLayoutProps.length = 0;
    window.location.hash = '';
  });

  afterEach(() => {
    window.location.hash = originalHash;
    // Restore ONLY spies created within these tests (e.g. history.pushState).
    // Avoid `vi.restoreAllMocks()`, which would also reset the module-level
    // `vi.mock('./api/client')` fns to return `undefined` and crash a later
    // test when a prior test's unmounted RunDetailView resolves a dangling
    // query.
    historySpies.forEach((spy) => spy.mockRestore());
    historySpies.length = 0;
  });

  it('opens the run from an initial #/run/<id> hash on load', async () => {
    window.location.hash = '#/run/run-1';
    render(<Dashboard />);

    // The run detail view (task graph) opens for run-1 without any click.
    await screen.findByTestId('layer-indicator');
    await waitFor(() =>
      expect(screen.getByTestId('reactflow')).toBeInTheDocument(),
    );
  });

  it('opens the deep-linked task logs from #/run/<id>/task/<taskId> when the task exists', async () => {
    window.location.hash = '#/run/run-1/task/t1';
    render(<Dashboard />);

    // Task t1 (name "align") exists in the client mock, so the deep link
    // restores its selection on load: the run opens AND the shell's split-panel
    // slot is populated and open (the task logs fly-out). The fly-out body is a
    // Cloudscape SplitPanel hosted by AppLayout; under the pass-through
    // AppLayout mock we assert the integration contract — AppLayout receives an
    // open split-panel node — rather than SplitPanel's internally-rendered
    // chrome.
    await screen.findByTestId('layer-indicator');
    expect(
      (await screen.findAllByText(/logs — task align/i)).length,
    ).toBeGreaterThanOrEqual(1);
    await waitFor(() => {
      expect(lastAppLayoutProps().splitPanelOpen).toBe(true);
    });
    // The hash reflects the deep-linked task (kept in sync, not fabricated).
    expect(window.location.hash).toBe('#/run/run-1/task/t1');
  });

  it('shows the fleet for an unknown/invalid hash (no crash, no fabrication)', async () => {
    window.location.hash = '#/garbage';
    render(<Dashboard />);

    // Falls back to the fleet list; no run detail opens.
    expect(
      (await screen.findAllByText('my-workflow')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId('layer-indicator')).not.toBeInTheDocument();
  });

  it('ignores a task id that does not exist — run opens with no task selected', async () => {
    window.location.hash = '#/run/run-1/task/does-not-exist';
    render(<Dashboard />);

    // The run opens, but no task logs fly-out appears (never fabricated).
    await screen.findByTestId('layer-indicator');
    expect(screen.queryByText(/logs — task/i)).not.toBeInTheDocument();
  });

  it('pushes the run hash on selection and resets it on back-to-fleet', async () => {
    const pushSpy = vi
      .spyOn(window.history, 'pushState')
      .mockImplementation(() => {});
    historySpies.push(pushSpy);
    window.location.hash = '#/';
    render(<Dashboard />);

    const link = await screen.findByRole('link', { name: /view run my-run/i });
    fireEvent.click(link);

    await screen.findByTestId('layer-indicator');
    // Selecting a run pushed the deep-link hash without a reload.
    expect(pushSpy).toHaveBeenCalledWith(null, '', '#/run/run-1');

    // Back to fleet pushes the fleet hash.
    fireEvent.click(screen.getByRole('button', { name: /back to fleet/i }));
    expect(
      (await screen.findAllByText('my-workflow')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(pushSpy).toHaveBeenCalledWith(null, '', '#/');
  });

  it('restores the view on browser back/forward (popstate)', async () => {
    window.location.hash = '#/run/run-1';
    render(<Dashboard />);
    await screen.findByTestId('layer-indicator');

    // Simulate a browser back to the fleet: change the hash and fire popstate.
    window.location.hash = '#/';
    fireEvent(window, new PopStateEvent('popstate'));

    expect(
      (await screen.findAllByText('my-workflow')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId('layer-indicator')).not.toBeInTheDocument();
  });

  it('opens the Reports view from the top-nav', async () => {
    // Reports run links are now real new-tab anchors (not in-app nav through
    // openRun), so there is no scatter->openRun path to assert. Verify the
    // top-nav still routes to the Reports view.
    window.location.hash = '#/';
    render(<Dashboard />);
    await screen.findAllByText('my-workflow');

    // Open Reports from the top-nav. In jsdom the Cloudscape TopNavigation
    // collapses its utilities into an overflow menu, so click the overflow
    // trigger, then the "Reports" item.
    const overflow = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-haspopup') === 'true');
    expect(overflow).toBeDefined();
    fireEvent.pointerDown(overflow!);
    fireEvent.click(overflow!);
    await waitFor(() => {
      expect(
        document.querySelector('[class*="overflow-menu-list-item"]'),
      ).toBeTruthy();
    });
    const reportsItem = Array.from(
      document.querySelectorAll('[class*="overflow-menu-list-item-text"]'),
    ).find((el) => el.textContent === 'Reports');
    expect(reportsItem).toBeTruthy();
    fireEvent.click(reportsItem!);

    expect(await screen.findByTestId('reports-view-stub')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Fleet cache (stale-while-revalidate across navigation).
// ---------------------------------------------------------------------------
describe('Dashboard fleet cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appLayoutProps.length = 0;
    window.location.hash = '';
  });

  it('returning from a run shows the cached fleet at once and revalidates once', async () => {
    render(<Dashboard />);
    const link = await screen.findByRole('link', { name: /view run my-run/i });
    expect(listRuns).toHaveBeenCalledTimes(1);
    fireEvent.click(link);
    await screen.findByTestId('layer-indicator');

    fireEvent.click(screen.getByRole('button', { name: /back to fleet/i }));
    // Synchronously after the click: cached rows, no blocking spinner.
    expect(screen.getAllByText('my-workflow').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/loading runs/i)).not.toBeInTheDocument();
    // The mount load plus exactly one background revalidation.
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId('fleet-load-progress')).toHaveTextContent(''),
    );
    expect(listRuns).toHaveBeenCalledTimes(2);
  });

  it('sign-out clears the fleet cache', async () => {
    const cache = createFleetCache();
    const onSignOut = vi.fn();
    render(<Dashboard username="u" onSignOut={onSignOut} fleetCache={cache} />);
    await screen.findAllByText('my-workflow');
    expect(cache.size).toBe(1);
    expect(cache.getUi()).not.toBeNull();

    // jsdom collapses the TopNavigation utilities into an overflow menu: open
    // it, open the user item, then click "Sign out".
    const overflow = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-haspopup') === 'true');
    expect(overflow).toBeDefined();
    fireEvent.pointerDown(overflow!);
    fireEvent.click(overflow!);
    const findItem = (text: string) =>
      Array.from(
        document.querySelectorAll('[class*="overflow-menu-list-item-text"]'),
      ).find((el) => el.textContent === text) as HTMLElement | undefined;
    await waitFor(() => expect(findItem('u')).toBeTruthy());
    fireEvent.click(findItem('u')!);
    await waitFor(() => expect(findItem('Sign out')).toBeTruthy());
    fireEvent.click(findItem('Sign out')!);

    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
    expect(cache.getUi()).toBeNull();
  });
});
